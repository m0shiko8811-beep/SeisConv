// electron/field - WiFiSync socket-engine barrel.
//
// The integration layer (Electron main + IPC + UI, wired by the next agent)
// imports from here. Pure algorithms live in core/field and are re-exported
// through the main `core` barrel; this module adds the Node-only engine.

export { SyncEngine } from './engine';
export type {
  SyncEngineOptions,
  OnLog,
  OnSyncResult,
  OnFileEvent,
  FileEventKind,
} from './engine';

export { FileServer, fetchManifest, fetchFile, RemoteFileNotFoundError } from './transport';
export type { FileServerOptions } from './transport';

export { DiscoveryService } from './discovery';
export type { DiscoveryOptions, OnPeerFound, OnPeerLost } from './discovery';

export { FolderWatcher } from './watcher';

export {
  buildManifest,
  loadTombstonesSync,
  saveTombstone,
  removeTombstone,
  isFile,
  pathExists,
  HistoryLog,
  loadSettings,
  saveSettings,
  DEFAULT_SETTINGS,
} from './fsutil';
export type { HistoryEntry, WifiSyncSettings } from './fsutil';

export * as windows from './windows';
