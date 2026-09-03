// electron/field - TCP transport (file_server.py + file_transfer.py).
//
// Node net sockets. Wire-compatible with the Python app: one-byte command
// (0x01 manifest / 0x02 file), big-endian frames, atomic temp-then-rename with
// mtime preserved, per-chunk rate limiting. Server binds a configurable host
// (default all interfaces per spec; the loopback test passes 127.0.0.1 so no
// broad bind is ever executed under test).

import * as net from 'node:net';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { FileHandle } from 'node:fs/promises';
import {
  type Manifest,
  RateLimiter,
  safeJoin,
  BUFFER_SIZE,
  TCP_FILE_PORT,
  CMD_MANIFEST,
  CMD_FILE,
  STATUS_OK,
  encodeManifestResponse,
  encodeFileRequest,
  encodeFileResponseHeader,
  encodeNotFound,
  manifestFromJson,
  WFSYNC_TMP_SUFFIX,
  MAX_MANIFEST_BYTES,
  MAX_FILE_BYTES,
  SOCKET_HIGH_WATER,
  SOCKET_LOW_WATER,
  SOCKET_MAX_BUFFER,
} from '../../core/field';

/** '::ffff:192.168.1.5' → '192.168.1.5'; everything else passes through. */
export function normalizeAddr(a: string): string {
  return a.startsWith('::ffff:') ? a.slice(7) : a;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Thrown by fetchFile when the peer reports the file is absent (status !== 0x00). */
export class RemoteFileNotFoundError extends Error {
  constructor(relPath: string) {
    super(`Remote does not have file: ${relPath}`);
    this.name = 'RemoteFileNotFoundError';
  }
}

/** Buffers a socket's incoming bytes and hands out exact-length reads (recv_exact).
 *  The peer is untrusted, so unread bytes are bounded: the socket is paused above
 *  SOCKET_HIGH_WATER (real backpressure, no data lost) and the connection is
 *  failed outright above SOCKET_MAX_BUFFER, which a well-behaved peer never hits. */
class SocketReader {
  private chunks: Buffer[] = [];
  private buffered = 0;
  private waiter: { n: number; resolve: (b: Buffer) => void; reject: (e: Error) => void } | null = null;
  private err: Error | null = null;
  private ended = false;
  private paused = false;
  private readonly sock: net.Socket;

  constructor(sock: net.Socket) {
    this.sock = sock;
    sock.on('data', (d: Buffer) => {
      this.chunks.push(d);
      this.buffered += d.length;
      if (this.buffered > SOCKET_MAX_BUFFER) {
        this.chunks = [];
        this.buffered = 0;
        this.err = new Error(`peer sent more than ${SOCKET_MAX_BUFFER} unread bytes`);
        try { sock.destroy(); } catch { /* ignore */ }
      } else if (!this.paused && this.buffered > SOCKET_HIGH_WATER) {
        this.paused = true;
        sock.pause();
      }
      this.pump();
    });
    sock.on('end', () => {
      this.ended = true;
      this.pump();
    });
    sock.on('close', () => {
      this.ended = true;
      this.pump();
    });
    sock.on('error', (e: Error) => {
      this.err = e;
      this.pump();
    });
  }

  private take(n: number): Buffer {
    const out = Buffer.allocUnsafe(n);
    let off = 0;
    while (off < n) {
      const c = this.chunks[0];
      const need = n - off;
      if (c.length <= need) {
        c.copy(out, off);
        off += c.length;
        this.chunks.shift();
      } else {
        c.copy(out, off, 0, need);
        this.chunks[0] = c.subarray(need);
        off += need;
      }
    }
    this.buffered -= n;
    if (this.paused && this.buffered < SOCKET_LOW_WATER) {
      this.paused = false;
      this.sock.resume();
    }
    return out;
  }

  private pump(): void {
    const w = this.waiter;
    if (!w) return;
    if (this.buffered >= w.n) {
      this.waiter = null;
      w.resolve(this.take(w.n));
      return;
    }
    if (this.err) {
      this.waiter = null;
      w.reject(this.err);
      return;
    }
    if (this.ended) {
      this.waiter = null;
      w.reject(new Error('Connection closed unexpectedly'));
    }
  }

  readExact(n: number): Promise<Buffer> {
    if (n === 0) return Promise.resolve(Buffer.alloc(0));
    return new Promise((resolve, reject) => {
      if (this.waiter) {
        reject(new Error('concurrent readExact'));
        return;
      }
      this.waiter = { n, resolve, reject };
      this.pump();
    });
  }
}

/** Write with backpressure - resolves when the chunk is flushed to the kernel. */
function writeAsync(sock: net.Socket, data: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    sock.write(data, (err) => (err ? reject(err) : resolve()));
  });
}

// -- Client --------------------------------------------------------------------

/** Connect, send 0x01, read u32be length + JSON, parse the manifest. */
export function fetchManifest(peerIp: string, peerPort: number): Promise<Manifest> {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host: peerIp, port: peerPort });
    const reader = new SocketReader(sock);
    let done = false;
    const fail = (e: Error): void => {
      if (done) return;
      done = true;
      sock.destroy();
      reject(e);
    };
    sock.setTimeout(10000, () => fail(new Error(`manifest fetch timed out to ${peerIp}:${peerPort}`)));
    sock.on('error', fail);
    sock.on('connect', () => {
      sock.write(Buffer.from([CMD_MANIFEST]));
      (async () => {
        const lenBuf = await reader.readExact(4);
        const len = lenBuf.readUInt32BE(0);
        if (len > MAX_MANIFEST_BYTES) {
          throw new Error(`peer manifest too large (${len} bytes > ${MAX_MANIFEST_BYTES})`);
        }
        const data = await reader.readExact(len);
        if (done) return;
        done = true;
        resolve(manifestFromJson(data.toString('utf-8')));
        sock.end();
      })().catch(fail);
    });
  });
}

/**
 * Connect, request `relPath`, stream it into `<dest>.wfsync_tmp`, atomically
 * rename over the destination, then set its mtime to the peer's. Returns the
 * pulled file's mtime (epoch seconds). Applies the limiter per chunk.
 */
export function fetchFile(
  peerIp: string,
  peerPort: number,
  relPath: string,
  destFolder: string,
  limiter?: RateLimiter,
): Promise<number> {
  // safeJoin first so a malicious manifest can't write outside the folder.
  const absDest = safeJoin(destFolder, relPath);
  const tmp = absDest + WFSYNC_TMP_SUFFIX;
  return new Promise<number>((resolve, reject) => {
    const sock = net.createConnection({ host: peerIp, port: peerPort });
    const reader = new SocketReader(sock);
    let done = false;
    let fh: FileHandle | null = null;
    const fail = async (e: Error): Promise<void> => {
      if (done) return;
      done = true;
      if (fh) {
        try {
          await fh.close();
        } catch {
          /* ignore */
        }
      }
      try {
        await fsp.unlink(tmp);
      } catch {
        /* ignore */
      }
      sock.destroy();
      reject(e);
    };
    sock.setTimeout(30000, () => void fail(new Error(`file fetch timed out to ${peerIp}:${peerPort}`)));
    sock.on('error', (e) => void fail(e));
    sock.on('connect', () => {
      sock.write(encodeFileRequest(relPath));
      (async () => {
        const status = await reader.readExact(1);
        if (status[0] !== STATUS_OK) throw new RemoteFileNotFoundError(relPath);
        const mtime = (await reader.readExact(8)).readDoubleBE(0);
        const size = Number((await reader.readExact(8)).readBigUInt64BE(0));
        if (!Number.isFinite(size) || size < 0 || size > MAX_FILE_BYTES) {
          throw new Error(`peer declared an implausible file size for '${relPath}': ${size}`);
        }

        await fsp.mkdir(path.dirname(absDest), { recursive: true });
        fh = await fsp.open(tmp, 'w');
        let remaining = size;
        while (remaining > 0) {
          const chunk = await reader.readExact(Math.min(BUFFER_SIZE, remaining));
          await fh.write(chunk);
          remaining -= chunk.length;
          if (limiter) {
            const s = limiter.consume(chunk.length);
            if (s > 0) await sleep(s * 1000);
          }
        }
        await fh.close();
        fh = null;
        await fsp.rename(tmp, absDest);
        await fsp.utimes(absDest, mtime, mtime); // Node takes seconds
        if (done) return;
        done = true;
        sock.end();
        resolve(mtime);
      })().catch((e) => void fail(e as Error));
    });
  });
}

// -- Server ---------------------------------------------------------------------

export interface FileServerOptions {
  folder: string;
  /** Returns the merged manifest to serve (get_manifest_fn). May be async. */
  getManifest: () => Manifest | Promise<Manifest>;
  port?: number;
  /** Bind host. undefined → all interfaces (spec default). Tests pass '127.0.0.1'. */
  host?: string;
  limiter?: RateLimiter;
  /** Optional per-connection allowlist. Returning false closes the connection
   *  before any manifest or file byte leaves this machine, so an un-approved host
   *  on the same hotspot cannot enumerate or read the shared folder. A bare TCP
   *  connect still succeeds, which keeps peer probing/scanning working. */
  isPeerAllowed?: (remoteAddress: string) => boolean;
  onLog?: (msg: string) => void;
}

export class FileServer {
  private server: net.Server | null = null;
  private readonly log: (msg: string) => void;
  private readonly port: number;

  constructor(private readonly opts: FileServerOptions) {
    this.log = opts.onLog ?? (() => {});
    this.port = opts.port ?? TCP_FILE_PORT;
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = net.createServer((conn) => {
        conn.setTimeout(120000, () => conn.destroy());
        const gate = this.opts.isPeerAllowed;
        if (gate) {
          const addr = normalizeAddr(conn.remoteAddress ?? '');
          if (!gate(addr)) {
            this.log(`Refused un-approved peer ${addr || '(unknown)'} - approve it in WiFiSync to share.`);
            conn.destroy();
            return;
          }
        }
        this.handle(conn).catch((e) => this.log(`Error handling client: ${e}`));
      });
      server.on('error', reject);
      const listenOpts = this.opts.host !== undefined ? { port: this.port, host: this.opts.host } : { port: this.port };
      server.listen(listenOpts, () => {
        this.server = server;
        this.log(`File server listening on port ${this.port}`);
        resolve();
      });
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) this.server.close(() => resolve());
      else resolve();
    });
  }

  /** Actual bound port (useful when port 0 is requested for a test). */
  address(): net.AddressInfo | null {
    const a = this.server?.address();
    return a && typeof a === 'object' ? a : null;
  }

  private async handle(conn: net.Socket): Promise<void> {
    const reader = new SocketReader(conn);
    let cmd: Buffer;
    try {
      cmd = await reader.readExact(1);
    } catch {
      conn.destroy();
      return;
    }
    if (cmd[0] === CMD_MANIFEST) {
      await this.sendManifest(conn);
    } else if (cmd[0] === CMD_FILE) {
      await this.sendFile(conn, reader);
    } else {
      this.log(`Unknown command byte: 0x${cmd[0].toString(16)}`);
      conn.end();
    }
  }

  private async sendManifest(conn: net.Socket): Promise<void> {
    const manifest = await this.opts.getManifest();
    await writeAsync(conn, encodeManifestResponse(manifest));
    conn.end();
  }

  private async sendFile(conn: net.Socket, reader: SocketReader): Promise<void> {
    const lenBuf = await reader.readExact(2);
    const pathLen = lenBuf.readUInt16BE(0);
    const relPath = (await reader.readExact(pathLen)).toString('utf-8');

    let absPath: string;
    try {
      absPath = safeJoin(this.opts.folder, relPath);
    } catch {
      await writeAsync(conn, encodeNotFound());
      this.log(`SECURITY: rejected out-of-root file request: ${JSON.stringify(relPath)}`);
      conn.end();
      return;
    }

    let st;
    try {
      st = await fsp.stat(absPath);
      if (!st.isFile()) throw new Error('not a regular file');
    } catch {
      await writeAsync(conn, encodeNotFound());
      this.log(`Requested file not found: ${relPath}`);
      conn.end();
      return;
    }

    const mtime = st.mtimeMs / 1000;
    await writeAsync(conn, encodeFileResponseHeader(mtime, st.size));
    const fh = await fsp.open(absPath, 'r');
    try {
      const buf = Buffer.allocUnsafe(BUFFER_SIZE);
      let sent = 0;
      for (;;) {
        const { bytesRead } = await fh.read(buf, 0, BUFFER_SIZE, null);
        if (bytesRead <= 0) break;
        await writeAsync(conn, Buffer.from(buf.subarray(0, bytesRead)));
        sent += bytesRead;
        if (this.opts.limiter) {
          const s = this.opts.limiter.consume(bytesRead);
          if (s > 0) await sleep(s * 1000);
        }
      }
      this.log(`Sent ${relPath} (${sent} bytes)`);
    } finally {
      await fh.close();
      conn.end();
    }
  }
}
