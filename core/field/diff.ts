// seisconv-core/field - mtime diff + role logic (ported from sync_engine.compute_diff)
//
// PURE. Reproduces the Python diff exactly for all three modes and the
// empty-manifest anti-wipe guard. mtime comparisons use MTIME_TOLERANCE (2.0 s)
// slack so filesystem rounding never triggers a re-pull loop.

import type { Manifest, SyncMode, SyncPlan } from './types';
import { MTIME_TOLERANCE } from './constants';
import { hasLiveRecord } from './manifest';

/**
 * Compute the sync plan (files to pull, files to delete locally) for `mode`.
 *
 * - "slave": mirror the remote exactly (pull live, delete local extras).
 * - "both":  two-way merge (pull newer, honour remote tombstones, resurrect).
 * - "master": never pulls/deletes - it only serves; compute_diff isn't used.
 */
export function computeDiff(local: Manifest, remote: Manifest, mode: SyncMode = 'both'): SyncPlan {
  const allPaths = new Set<string>([...local.keys(), ...remote.keys()]);
  const toPull: string[] = [];
  const toDeleteLocally: string[] = [];
  const TOL = MTIME_TOLERANCE;

  if (mode === 'slave') {
    for (const p of allPaths) {
      const loc = local.get(p);
      const rem = remote.get(p);
      if (!rem || rem.deleted) {
        if (loc && !loc.deleted) toDeleteLocally.push(p);
      } else {
        if (!loc || loc.deleted) toPull.push(p);
        else if (Math.abs(rem.mtime - loc.mtime) > TOL) toPull.push(p);
      }
    }
    return { toPull, toDeleteLocally };
  }

  // "both" (two-way) mode - and "master" degenerates here but is never diffed.
  for (const p of allPaths) {
    const loc = local.get(p);
    const rem = remote.get(p);

    if (!rem) continue; // we have it / peer doesn't → keep (peer pulls from us)

    if (!loc) {
      if (!rem.deleted) toPull.push(p);
      continue;
    }

    if (rem.mtime > loc.mtime + TOL) {
      if (rem.deleted) toDeleteLocally.push(p);
      else toPull.push(p);
    } else if (loc.deleted && !rem.deleted && rem.mtime > loc.mtime) {
      toPull.push(p); // resurrect: peer's live copy is newer than our tombstone
    }
  }

  return { toPull, toDeleteLocally };
}

/**
 * Empty-manifest anti-wipe guard (sync_engine step 4): if the plan would delete
 * local files but the remote advertises NO live record (deleted-only or empty -
 * e.g. a peer whose drive was unplugged), drop the deletions. Returns a plan
 * with `toDeleteLocally` cleared in that case; otherwise returns `plan` as-is.
 */
export function applyEmptyManifestGuard(plan: SyncPlan, remote: Manifest): SyncPlan {
  if (plan.toDeleteLocally.length > 0 && !hasLiveRecord(remote)) {
    return { toPull: plan.toPull, toDeleteLocally: [] };
  }
  return plan;
}
