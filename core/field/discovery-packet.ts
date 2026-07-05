// seisconv-core/field — UDP discovery beacon encode/decode (ported from discovery.py)
//
// PURE Buffer codec (no sockets). Beacon layout (26 bytes, big-endian):
//   0  7  MAGIC "WFSYNC1"
//   7  2  tcp_port      (uint16 BE)
//   9  16 instance_id   (16 random bytes)
//   25 1  role_byte     (both=0, master=1, slave=2)
// A 25-byte packet (no role byte) is a legacy client → role "both".

import type { DiscoveryBeacon, Role } from './types';
import { MAGIC } from './constants';
import { roleToByte, byteToRole } from './roles';

/** Build a 26-byte beacon: MAGIC + u16be(tcpPort) + instanceId(16) + roleByte. */
export function encodeBeacon(tcpPort: number, instanceId: Uint8Array, role: Role): Buffer {
  if (instanceId.length !== 16) {
    throw new Error(`instanceId must be 16 bytes, got ${instanceId.length}`);
  }
  const buf = Buffer.alloc(26);
  buf.set(MAGIC, 0); // 7 bytes
  buf.writeUInt16BE(tcpPort & 0xffff, 7);
  buf.set(instanceId, 9); // 16 bytes
  buf.writeUInt8(roleToByte(role), 25);
  return buf;
}

/**
 * Decode a beacon. Returns null (ignore) unless it is exactly 25 or 26 bytes
 * and begins with MAGIC. instanceId is a fresh 16-byte Buffer copy.
 */
export function decodeBeacon(data: Buffer): DiscoveryBeacon | null {
  if (data.length !== 25 && data.length !== 26) return null;
  for (let i = 0; i < 7; i++) {
    if (data[i] !== MAGIC[i]) return null;
  }
  const tcpPort = data.readUInt16BE(7);
  const instanceId = Buffer.from(data.subarray(9, 25));
  const role: Role = data.length === 26 ? byteToRole(data[25]) : 'both';
  return { tcpPort, instanceId, role };
}

/** First-3-octets /24 subnet check (Python `_same_subnet`). Fail-open on parse
 *  error (returns true), matching the original. */
export function sameSubnet(ip1: string, ip2: string): boolean {
  try {
    const a = ip1.slice(0, ip1.lastIndexOf('.'));
    const b = ip2.slice(0, ip2.lastIndexOf('.'));
    if (ip1.lastIndexOf('.') < 0 || ip2.lastIndexOf('.') < 0) return true;
    return a === b;
  } catch {
    return true;
  }
}
