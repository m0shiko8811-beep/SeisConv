// seisconv-core/field — WiFiSync shared types (ported from manifest.py / sync_engine.py)

/** Sync/negotiation role. "both" = two-way (default), "master" = serve only,
 *  "slave" = mirror the master. */
export type Role = 'both' | 'master' | 'slave';

/** A sync engine's operating mode (identical set to Role). */
export type SyncMode = Role;

/** One manifest record (ported from Python dataclass FileRecord).
 *  `mtime` is Unix-epoch seconds (float64). `size` is bytes. */
export interface FileRecord {
  relPath: string;
  mtime: number;
  size: number;
  deleted: boolean;
}

/** A manifest is keyed by rel_path (forward-slash separated). */
export type Manifest = Map<string, FileRecord>;

/** Result of compute_diff: files to pull from the peer and files to delete locally. */
export interface SyncPlan {
  toPull: string[];
  toDeleteLocally: string[];
}

/** Decoded discovery beacon. */
export interface DiscoveryBeacon {
  tcpPort: number;
  instanceId: Buffer;
  role: Role;
}

/** Input to buildManifestFromEntries — one already-stat'd file. */
export interface ManifestEntryInput {
  relPath: string;
  mtime: number; // Unix-epoch seconds
  size: number;
}
