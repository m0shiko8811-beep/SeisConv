// seisconv-core/field - WiFiSync wire-protocol constants (ported from config.py)
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

/** Temp-download suffix - files ending in this are skipped everywhere. */
export const WFSYNC_TMP_SUFFIX = '.wfsync_tmp';
/** Tombstone file name (lives in the PARENT of the sync folder). */
export const WFSYNC_TOMBSTONE_FILE = '.wfsync_tombstones.json';

/** Role → beacon byte. */
export const ROLE_TO_BYTE: Record<Role, number> = { both: 0, master: 1, slave: 2 };
/** Beacon byte → role (any other byte, or a legacy 25-byte packet, → "both"). */
export const BYTE_TO_ROLE: Record<number, Role> = { 0: 'both', 1: 'master', 2: 'slave' };

// -- Hostile-peer resource caps -------------------------------------------------
// A peer is any host that answered on the LAN, so every length it declares on the
// wire is attacker-controlled. These ceilings bound what a single connection can
// make the main process allocate (RAM) or write (disk).

/** Max bytes accepted for a peer's JSON manifest response (u32be length). */
export const MAX_MANIFEST_BYTES = 4 * 1024 * 1024; // 4 MiB
/** Max declared size of a single pulled file (u64be size field). */
export const MAX_FILE_BYTES = 16 * 1024 * 1024 * 1024; // 16 GiB
/** Socket reader: pause the socket above this many unread buffered bytes… */
export const SOCKET_HIGH_WATER = 4 * 1024 * 1024;
/** …resume below this, and hard-fail the connection above the absolute ceiling. */
export const SOCKET_LOW_WATER = 1 * 1024 * 1024;
export const SOCKET_MAX_BUFFER = 64 * 1024 * 1024;
