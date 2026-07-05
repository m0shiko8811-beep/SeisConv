// seisconv-core/field — WiFiSync wire-protocol constants (ported from config.py)
//
// These are the exact values used by the live Python WiFiSync app; keeping them
// identical is what makes this TS port interoperable on the same UDP/TCP wire.
// All multi-byte integers on the wire are BIG-ENDIAN. mtime is Unix-epoch
// *seconds* as an IEEE-754 float64 (Python os.stat().st_mtime).

import type { Role } from './types';

export const UDP_BROADCAST_PORT = 47823;
export const TCP_FILE_PORT = 47824;
export const SYNC_INTERVAL_SEC = 5;
export const DISCOVERY_INTERVAL = 2; // seconds between broadcast beacons
export const PEER_TIMEOUT_SEC = 15; // peer expiry after silence
export const BUFFER_SIZE = 65536; // TCP read/write chunk
export const MTIME_TOLERANCE = 2.0; // seconds; mtime equality slack for diff
export const TOMBSTONE_MAX_AGE = 86400 * 30; // 30 days
export const WRITE_STABILITY_SEC = 2.0; // don't advertise a file modified within this window
export const HISTORY_MAX = 500;

/** 7-byte discovery magic "WFSYNC1" (57 46 53 59 4E 43 31). Kept as a
 *  Uint8Array (not a Node Buffer) so this module is side-effect-free at import
 *  time and safe to load in any bundler graph. */
export const MAGIC: Uint8Array = new Uint8Array([0x57, 0x46, 0x53, 0x59, 0x4e, 0x43, 0x31]);

/** Temp-download suffix — files ending in this are skipped everywhere. */
export const WFSYNC_TMP_SUFFIX = '.wfsync_tmp';
/** Tombstone file name (lives in the PARENT of the sync folder). */
export const WFSYNC_TOMBSTONE_FILE = '.wfsync_tombstones.json';

/** Role → beacon byte. */
export const ROLE_TO_BYTE: Record<Role, number> = { both: 0, master: 1, slave: 2 };
/** Beacon byte → role (any other byte, or a legacy 25-byte packet, → "both"). */
export const BYTE_TO_ROLE: Record<number, Role> = { 0: 'both', 1: 'master', 2: 'slave' };
