// electron/field — UDP peer discovery (discovery.py).
//
// UDP 47823 for both send and receive. Broadcast a 26-byte beacon every 2 s
// (after an initial 2-packet burst 0.5 s apart); listen on all interfaces,
// key peers by IP, fire onPeerFound only on first sighting, expire after 15 s
// of silence. Callbacks are exception-isolated (a throwing callback must never
// kill a loop). Not exercised by the loopback test (which uses manual peering),
// but implemented per spec for the real app.

import * as dgram from 'node:dgram';
import {
  type Role,
  UDP_BROADCAST_PORT,
  TCP_FILE_PORT,
  DISCOVERY_INTERVAL,
  PEER_TIMEOUT_SEC,
  encodeBeacon,
  decodeBeacon,
  sameSubnet,
  monotonicNow,
} from '../../core/field';

export type OnPeerFound = (ip: string, port: number, role: Role) => void;
export type OnPeerLost = (ip: string) => void;

export interface DiscoveryOptions {
  instanceId: Uint8Array; // 16 bytes
  onPeerFound: OnPeerFound;
  onPeerLost: OnPeerLost;
  tcpPort?: number;
  bindIp?: string;
  broadcastAddr?: string; // e.g. "192.168.137.255" or "<broadcast>" (255.255.255.255)
  role?: Role;
  onLog?: (msg: string) => void;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class DiscoveryService {
  private readonly instanceId: Uint8Array;
  private readonly onPeerFound: OnPeerFound;
  private readonly onPeerLost: OnPeerLost;
  private readonly tcpPort: number;
  private readonly bindIp: string;
  private readonly broadcastAddr: string;
  private readonly role: Role;
  private readonly log: (msg: string) => void;

  private peerLastSeen = new Map<string, number>();
  private peerPorts = new Map<string, number>();
  private stopped = false;
  private sendSock: dgram.Socket | null = null;
  private listenSock: dgram.Socket | null = null;
  private expireTimer: NodeJS.Timeout | null = null;

  constructor(opts: DiscoveryOptions) {
    this.instanceId = opts.instanceId;
    this.onPeerFound = opts.onPeerFound;
    this.onPeerLost = opts.onPeerLost;
    this.tcpPort = opts.tcpPort ?? TCP_FILE_PORT;
    this.bindIp = opts.bindIp ?? '';
    this.broadcastAddr = opts.broadcastAddr ?? '255.255.255.255';
    this.role = opts.role ?? 'both';
    this.log = opts.onLog ?? (() => {});
  }

  start(): void {
    this.stopped = false;
    this.startListen();
    void this.broadcastLoop();
    this.startExpiry();
  }

  stop(): void {
    this.stopped = true;
    if (this.expireTimer) clearInterval(this.expireTimer);
    this.expireTimer = null;
    try {
      this.sendSock?.close();
    } catch {
      /* ignore */
    }
    try {
      this.listenSock?.close();
    } catch {
      /* ignore */
    }
    this.sendSock = null;
    this.listenSock = null;
  }

  private startListen(): void {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.listenSock = sock;
    sock.on('message', (data, rinfo) => this.onMessage(data, rinfo.address));
    sock.on('error', () => {
      /* keep loop alive */
    });
    sock.bind(UDP_BROADCAST_PORT); // "" = all interfaces
  }

  private onMessage(data: Buffer, peerIp: string): void {
    const beacon = decodeBeacon(data);
    if (!beacon) return;
    if (Buffer.from(this.instanceId).equals(beacon.instanceId)) return; // ignore self
    if (this.bindIp && !sameSubnet(peerIp, this.bindIp)) return;
    const newlySeen = !this.peerLastSeen.has(peerIp);
    this.peerLastSeen.set(peerIp, monotonicNow());
    this.peerPorts.set(peerIp, beacon.tcpPort);
    if (newlySeen) {
      try {
        this.onPeerFound(peerIp, beacon.tcpPort, beacon.role);
      } catch {
        /* a callback error must never kill the listen loop */
      }
    }
  }

  private async broadcastLoop(): Promise<void> {
    const sock = dgram.createSocket({ type: 'udp4' });
    this.sendSock = sock;
    await new Promise<void>((resolve) => {
      if (this.bindIp) sock.bind(0, this.bindIp, () => resolve());
      else sock.bind(0, () => resolve());
    });
    try {
      sock.setBroadcast(true);
    } catch {
      /* ignore */
    }
    const packet = encodeBeacon(this.tcpPort, this.instanceId, this.role);
    const send = (): void => {
      try {
        sock.send(packet, UDP_BROADCAST_PORT, this.broadcastAddr);
      } catch {
        /* ignore */
      }
    };
    // Initial burst: 2 packets 0.5 s apart.
    for (let i = 0; i < 2 && !this.stopped; i++) {
      send();
      await sleep(500);
    }
    while (!this.stopped) {
      send();
      await sleep(DISCOVERY_INTERVAL * 1000);
    }
  }

  private startExpiry(): void {
    this.expireTimer = setInterval(() => {
      const now = monotonicNow();
      for (const ip of [...this.peerLastSeen.keys()]) {
        if (now - (this.peerLastSeen.get(ip) ?? 0) > PEER_TIMEOUT_SEC) {
          this.peerLastSeen.delete(ip);
          this.peerPorts.delete(ip);
          try {
            this.onPeerLost(ip);
          } catch {
            /* a callback error must never kill the expiry loop */
          }
        }
      }
    }, 2000);
  }
}
