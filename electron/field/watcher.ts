// electron/field — file watcher (watchdog Observer equivalent via fs.watch).
//
// on_change mode: recursive watch on the folder. The ignore rule matches the
// Python handler everywhere: skip paths whose basename ends `.wfsync_tmp` or
// equals `.wfsync_tombstones.json`. A create/modify sets the change trigger
// (immediate sync); a delete reports an authoritative local deletion.
//
// fs.watch conflates create+delete into a 'rename' event and gives no
// is_directory flag, so we probe existence to distinguish them. If a recursive
// watch is unavailable, start() no-ops and the engine falls back to polling.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { WFSYNC_TMP_SUFFIX, WFSYNC_TOMBSTONE_FILE } from '../../core/field';

export class FolderWatcher {
  private watcher: fs.FSWatcher | null = null;

  constructor(
    private readonly folder: string,
    private readonly onChange: () => void,
    private readonly onDelete: (relPath: string) => void,
    private readonly onLog: (msg: string) => void = () => {},
  ) {}

  /** @returns true if a recursive watcher was established, false → poll fallback. */
  start(): boolean {
    try {
      this.watcher = fs.watch(this.folder, { recursive: true }, (event, filename) => {
        if (!filename) return;
        const fname = filename.toString();
        const base = path.basename(fname);
        if (base.endsWith(WFSYNC_TMP_SUFFIX) || base === WFSYNC_TOMBSTONE_FILE) return;
        const abs = path.join(this.folder, fname);
        const rel = fname.split(path.sep).join('/');
        try {
          if (fs.existsSync(abs)) {
            this.onChange();
          } else {
            // 'rename' with the path now gone → deletion (or move source).
            this.onDelete(rel);
          }
        } catch {
          this.onChange();
        }
      });
      return true;
    } catch (e) {
      this.onLog(`File watcher unavailable: ${e} — falling back to polling`);
      this.watcher = null;
      return false;
    }
  }

  stop(): void {
    try {
      this.watcher?.close();
    } catch {
      /* ignore */
    }
    this.watcher = null;
  }
}
