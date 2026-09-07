// Shared per-machine path resolution: env var > qa/local-paths.json (git-ignored)
// > caller-supplied fallback. Used by qa/harness.mjs AND the standalone
// scripts/test-fuzz.ts, scripts/test-crossformat.ts, scripts/positioning-qc.ts,
// so every consumer resolves its inputs the same way and this is the ONLY place
// that reads qa/local-paths.json. Nothing site-specific lives in this file.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

let cache = null;
/** Parse qa/local-paths.json once (git-ignored, per machine). Returns {} if
 *  absent or unreadable - the file is optional. */
export function loadLocalConfig() {
  if (cache !== null) return cache;
  try {
    cache = JSON.parse(readFileSync(join(__dirname, 'local-paths.json'), 'utf8')) || {};
  } catch {
    cache = {};
  }
  return cache;
}

const splitList = (v) => String(v).split(';').map((s) => s.trim()).filter(Boolean);

/** Resolve one scalar setting: env var (if set and non-empty) > local-paths.json
 *  `key` > `fallback`. A list value in local-paths.json yields its first entry. */
export function resolveValue(key, envVar, fallback = '') {
  const env = process.env[envVar];
  if (env) return env;
  const local = loadLocalConfig();
  const v = Object.prototype.hasOwnProperty.call(local, key) ? local[key] : undefined;
  if (v !== undefined && v !== null && v !== '') return Array.isArray(v) ? String(v[0]) : String(v);
  return fallback;
}

/** Resolve one list setting: env var (';'-separated) > local-paths.json `key`
 *  (array or ';'-separated string) > `fallback`. */
export function resolveList(key, envVar, fallback = []) {
  const env = process.env[envVar];
  if (env) return splitList(env);
  const local = loadLocalConfig();
  const v = Object.prototype.hasOwnProperty.call(local, key) ? local[key] : undefined;
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  if (typeof v === 'string' && v) return splitList(v);
  return fallback;
}
