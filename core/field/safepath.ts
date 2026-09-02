// seisconv-core/field - path-containment guard (ported from manifest.safe_join)
//
// Joins a peer-supplied relative path onto `root` and guarantees the result
// stays inside `root`. Rejects absolute paths, drive letters, UNC paths, and
// `..` sequences that would escape the sync folder. Applied on EVERY server
// file read, every client write destination, and every local delete /
// tombstone-originate. Behaviour matches the Python original byte-for-byte:
// case-sensitive prefix comparison against `absRoot + sep`.

import * as path from 'node:path';

/** Thrown when a relative path would escape the sync root (Python ValueError). */
export class PathEscapeError extends Error {
  constructor(relPath: string) {
    super(`path escapes sync root: ${JSON.stringify(relPath)}`);
    this.name = 'PathEscapeError';
  }
}

/**
 * Resolve `relPath` under `root`, throwing {@link PathEscapeError} if it escapes.
 * Mirrors Python: `rel.replace('/', os.sep)` → `abspath(join(absRoot, rel))`,
 * then require `candidate === absRoot || candidate.startsWith(absRoot + sep)`.
 */
export function safeJoin(root: string, relPath: string): string {
  const rel = relPath.split('/').join(path.sep);
  const absRoot = path.resolve(root);
  const candidate = path.resolve(absRoot, rel);
  if (candidate !== absRoot && !candidate.startsWith(absRoot + path.sep)) {
    throw new PathEscapeError(relPath);
  }
  return candidate;
}

/** True iff `relPath` resolves safely under `root` (never throws). */
export function validateRelPath(root: string, relPath: string): boolean {
  try {
    safeJoin(root, relPath);
    return true;
  } catch {
    return false;
  }
}
