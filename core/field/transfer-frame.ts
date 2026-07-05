// seisconv-core/field — TCP frame encode/decode (ported from file_server.py / file_transfer.py)
//
// PURE Buffer codecs (no sockets). One-byte command protocol on TCP 47824:
//   0x01 → manifest request      | response: u32be(len) + jsonBytes
//   0x02 → file request          | request:  0x02 + u16be(pathLen) + pathBytes
//                                | response: status(1) + f64be(mtime) + u64be(size) + payload
// Frame FIELD ORDER is load-bearing: status → mtime → size → payload.

import type { Manifest } from './types';
import { manifestToJson, manifestFromJson } from './manifest';

export const CMD_MANIFEST = 0x01;
export const CMD_FILE = 0x02;
export const STATUS_OK = 0x00;
export const STATUS_NOT_FOUND = 0x01;

/** Client → server: request the manifest (single byte 0x01). */
export function encodeManifestRequest(): Buffer {
  return Buffer.from([CMD_MANIFEST]);
}

/** Server → client: u32be(len) + UTF-8(manifest JSON). */
export function encodeManifestResponse(manifest: Manifest): Buffer {
  const json = Buffer.from(manifestToJson(manifest), 'utf-8');
  const head = Buffer.alloc(4);
  head.writeUInt32BE(json.length, 0);
  return Buffer.concat([head, json]);
}

/** Decode a full manifest-response frame (u32be length prefix + JSON). */
export function decodeManifestResponse(frame: Buffer): Manifest {
  const len = frame.readUInt32BE(0);
  const json = frame.subarray(4, 4 + len).toString('utf-8');
  return manifestFromJson(json);
}

/** Client → server: 0x02 + u16be(pathLen) + UTF-8(relPath) (forward slashes). */
export function encodeFileRequest(relPath: string): Buffer {
  const p = Buffer.from(relPath, 'utf-8');
  const head = Buffer.alloc(3);
  head.writeUInt8(CMD_FILE, 0);
  head.writeUInt16BE(p.length, 1);
  return Buffer.concat([head, p]);
}

/** Decode a file-request frame (expects the leading 0x02 command byte). */
export function decodeFileRequest(frame: Buffer): { relPath: string } {
  const cmd = frame.readUInt8(0);
  if (cmd !== CMD_FILE) throw new Error(`not a file request (cmd=0x${cmd.toString(16)})`);
  const len = frame.readUInt16BE(1);
  return { relPath: frame.subarray(3, 3 + len).toString('utf-8') };
}

/** Server → client success header: status(0x00) + f64be(mtime) + u64be(size). */
export function encodeFileResponseHeader(mtime: number, size: number): Buffer {
  const b = Buffer.alloc(1 + 8 + 8);
  b.writeUInt8(STATUS_OK, 0);
  b.writeDoubleBE(mtime, 1);
  b.writeBigUInt64BE(BigInt(size), 9);
  return b;
}

/** Single status byte (0x01) — file not found / rejected. */
export function encodeNotFound(): Buffer {
  return Buffer.from([STATUS_NOT_FOUND]);
}

/** Decode the 17-byte success header. If status !== 0x00, mtime/size are 0. */
export function decodeFileResponseHeader(b: Buffer): { status: number; mtime: number; size: number } {
  const status = b.readUInt8(0);
  if (status !== STATUS_OK) return { status, mtime: 0, size: 0 };
  const mtime = b.readDoubleBE(1);
  const size = Number(b.readBigUInt64BE(9));
  return { status, mtime, size };
}
