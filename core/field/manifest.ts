// seisconv-core/field - manifest transforms + tombstone helpers (ported from manifest.py)
//
// PURE: no filesystem access. The fs walk (build_manifest) and tombstone I/O
// live in the socket engine (electron/field); this module holds the
// wire-format (JSON) transforms and the in-memory logic that must stay
// bit-compatible with the Python app, so both are independently unit-testable.

import type { FileRecord, Manifest, ManifestEntryInput } from './types';
import { TOMBSTONE_MAX_AGE, WFSYNC_TMP_SUFFIX, WRITE_STABILITY_SEC } from './constants';

/** Serialize a manifest to the on-wire JSON string (manifest_to_json). The
 *  rel_path key is NOT repeated inside the value. */
export function manifestToJson(manifest: Manifest): string {
  const obj: Record<string, { mtime: number; size: number; deleted: boolean }> = {};
  for (const [k, v] of manifest) {
    obj[k] = { mtime: v.mtime, size: v.size, deleted: v.deleted };
  }
  return JSON.stringify(obj);
}

/** Parse the on-wire JSON string into a manifest (manifest_from_json). The key
 *  becomes rel_path on each record. */
export function manifestFromJson(data: string): Manifest {
  const raw = JSON.parse(data) as Record<string, { mtime: number; size: number; deleted: boolean }>;
  const out: Manifest = new Map();
  for (const k of Object.keys(raw)) {
    const v = raw[k];
    out.set(k, { relPath: k, mtime: v.mtime, size: v.size, deleted: v.deleted });
  }
  return out;
}

/**
 * Build a manifest from already-stat'd entries (the fs walk supplies these).
 * Skips names ending in `.wfsync_tmp` and applies the write-stability window:
 * a file whose mtime is within `stabilitySec` of `nowSec` is omitted so peers
 * never pull a half-written / growing file.
 */
export function buildManifestFromEntries(
  entries: ManifestEntryInput[],
  nowSec: number,
  stabilitySec: number = WRITE_STABILITY_SEC,
): Manifest {
  const out: Manifest = new Map();
  for (const e of entries) {
    if (e.relPath.endsWith(WFSYNC_TMP_SUFFIX)) continue;
    if (stabilitySec > 0 && nowSec - e.mtime < stabilitySec) continue;
    out.set(e.relPath, { relPath: e.relPath, mtime: e.mtime, size: e.size, deleted: false });
  }
  return out;
}

/** Overlay tombstones onto a base manifest (Python `manifest.update(tombstones)`)
 *  so a tombstoned path becomes a deleted record even if a stale file exists.
 *  Returns a new map; inputs are not mutated. */
export function mergeManifest(base: Manifest, tombstones: Manifest): Manifest {
  const out = new Map(base);
  for (const [k, v] of tombstones) out.set(k, v);
  return out;
}

/** True iff any record is live (deleted === false). Drives the empty-manifest
 *  anti-wipe guard. */
export function hasLiveRecord(manifest: Manifest): boolean {
  for (const v of manifest.values()) if (!v.deleted) return true;
  return false;
}

// -- tombstone JSON transforms (on-disk shape: { "<rel>": { "mtime": <float> } }) --

/** Convert the on-disk tombstone object to deleted FileRecords (load_tombstones). */
export function tombstonesToRecords(raw: Record<string, { mtime: number }>): Manifest {
  const out: Manifest = new Map();
  for (const k of Object.keys(raw)) {
    out.set(k, { relPath: k, mtime: raw[k].mtime, size: 0, deleted: true });
  }
  return out;
}

/** Serialize deleted FileRecords back to the on-disk tombstone object. */
export function recordsToTombstoneObject(tombstones: Manifest): Record<string, { mtime: number }> {
  const obj: Record<string, { mtime: number }> = {};
  for (const [k, v] of tombstones) obj[k] = { mtime: v.mtime };
  return obj;
}

/**
 * Add/replace a tombstone entry and prune anything older than TOMBSTONE_MAX_AGE
 * (30 days), matching save_tombstone. Pure: takes the existing object + the new
 * entry, returns the pruned object to persist. Prunes with `> cutoff` (Python
 * parity) so an entry pinned exactly at the cutoff is dropped.
 */
export function addTombstoneEntry(
  existing: Record<string, { mtime: number }>,
  relPath: string,
  mtime: number,
  nowSec: number,
): Record<string, { mtime: number }> {
  const data: Record<string, { mtime: number }> = { ...existing, [relPath]: { mtime } };
  const cutoff = nowSec - TOMBSTONE_MAX_AGE;
  const pruned: Record<string, { mtime: number }> = {};
  for (const k of Object.keys(data)) {
    if (data[k].mtime > cutoff) pruned[k] = data[k];
  }
  return pruned;
}

/** Remove a tombstone key (remove_tombstone). Returns the new object (or the
 *  same reference if the key was absent). */
export function removeTombstoneEntry(
  existing: Record<string, { mtime: number }>,
  relPath: string,
): { changed: boolean; data: Record<string, { mtime: number }> } {
  if (!(relPath in existing)) return { changed: false, data: existing };
  const data = { ...existing };
  delete data[relPath];
  return { changed: true, data };
}

export type { FileRecord };
