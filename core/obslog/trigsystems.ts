// seisconv-core - Observer Log "Trigger system" registry (pure, testable logic).
//
// A "Trigger system" is a named preset that bundles the Trigger-Watch sources +
// File#/SP auto-number behaviour for ONE recording system, so the observer picks
// a single dropdown entry instead of wiring individual sources by hand. The
// registry is EXTENSIBLE: a future recording system is added as one more
// TRIGGER_SYSTEMS entry (see the "HOW TO ADD A TRIGGER SYSTEM" note below) - the
// renderer builds the selector and applies each entry's `defaults` straight from
// this array, so no UI is rewired.
//
// This module holds ONLY data + pure selection/migration logic - no DOM, no
// Electron, no I/O - so it is unit-tested and reused by the renderer.

/** File#/FFID numbering mode (shared with the row logic in core/obslog/autonum):
 *   counter   - +1 each trigger, reads no file (generic, no recorder sync).
 *   reconcile - counter value instantly, then corrected from the recorder's .dat.
 *   real      - blank until the recorder's .dat lands, then filled from it. */
export type TrigFileMode = 'counter' | 'reconcile' | 'real';

/** Identifier of a trigger system. Add new ids here as systems are added. */
export type TrigSystemId = 'geode' | 'generic';

/** Canonical default folders for the Geometrics Geode (SCS) system. */
export const TRIG_TEMPCOM_DEFAULT_DIR = 'C:\\GeometricsSurveysAndSettings\\SC\\TempCom';
export const TRIG_SCFILES_DEFAULT_DIR = 'C:\\SC_Files';

// -- Geode File#-sync modes (the per-survey "File# mode" on the Geode system) --
// Both keep the Observer-Log File# in sync with SCS's REAL recorder file number
// read from the landed .dat; they differ only in what shows on the trigger:
//   seed  → "Seed + auto-correct" (reconcile): the observer seeds SCS's current
//           File# once; every trigger shows it INSTANTLY (counter from the seed)
//           and auto-corrects from the real .dat File# when it lands.
//   file  → "Read from file" (real): blank on the trigger, then filled with
//           SCS's exact number read from the .dat when it lands.
export type GeodeFileSyncId = 'seed' | 'file';
export interface GeodeFileSyncChoice {
  id: GeodeFileSyncId;
  fileMode: Extract<TrigFileMode, 'reconcile' | 'real'>;
  label: string;
  hint: string;
}
export const GEODE_FILE_SYNC_MODES: GeodeFileSyncChoice[] = [
  {
    id: 'seed',
    fileMode: 'reconcile',
    label: 'Seed + auto-correct',
    hint: 'Enter SCS’s current/next File# once; every Geode trigger shows it instantly (counter from the seed) and auto-corrects from the real .dat File# when it lands (a mismatch is flagged).',
  },
  {
    id: 'file',
    fileMode: 'real',
    label: 'Read from file',
    hint: 'File# is blank on the trigger, then filled with SCS’s exact number read from the .dat when it lands in SC_Files.',
  },
];

/** Map a Geode File#-sync choice id → the underlying autonum File# mode. Unknown
 *  ids fall back to the seed+auto-correct default. */
export function geodeFileMode(choiceId: string | null | undefined): Extract<TrigFileMode, 'reconcile' | 'real'> {
  return choiceId === 'file' ? 'real' : 'reconcile';
}
/** Reverse: which Geode File#-sync choice id an autonum File# mode corresponds
 *  to. Any non-'real' mode (incl. the generic 'counter') maps to seed. */
export function geodeFileSyncId(mode: TrigFileMode | string | null | undefined): GeodeFileSyncId {
  return mode === 'real' ? 'file' : 'seed';
}

// -- The trigger-system registry ---------------------------------------------

/** The fields a trigger system configures "under the hood" when it is selected.
 *  Every field is OPTIONAL - an omitted field leaves the user's current value
 *  untouched. This keeps the registry decoupled from the full renderer config
 *  shape (only the fields a system actually presets are listed). */
export interface TrigSystemDefaults {
  /** Per-source enable overrides (a key omitted = leave that source as-is).
   *  `scstrig` is the Geode TempCom passive trigger; folder/udp/serial/scslog
   *  are the generic sources. */
  sources?: Partial<Record<'folder' | 'udp' | 'serial' | 'scslog' | 'scstrig', boolean>>;
  /** TempCom (scstrig) folder to seed when the field is empty. */
  scstrigDir?: string;
  /** Recorder save folder read for File# reconcile/real. */
  scFilesDir?: string;
  /** Auto-number / File#-sync defaults. */
  autonum?: { enabled?: boolean; fileMode?: TrigFileMode };
}

export interface TrigSystem {
  id: TrigSystemId;
  label: string;
  description: string;
  defaults: TrigSystemDefaults;
}

// HOW TO ADD A TRIGGER SYSTEM (extensible - no UI rewiring required):
//   1. add its id to the `TrigSystemId` union above;
//   2. push one more `{ id, label, description, defaults }` entry into the array
//      below;
//   3. (optional) point its `defaults` at the sources / folders / File# mode it
//      should preset when chosen.
// The renderer builds the Trigger-system <select> straight from TRIGGER_SYSTEMS
// and applies the chosen entry's `defaults`, so a new system needs no other UI
// work. Runtime triggering still fires on the trigger EVENT, never on a file.
export const TRIGGER_SYSTEMS: TrigSystem[] = [
  {
    id: 'geode',
    label: 'Geometrics Geode (SCS)',
    description:
      'Geometrics Geode recorder driven by the SCS software. Triggers on the SCS TempCom event (passive, file-independent - it fires even for shots that are never saved) and keeps the Observer-Log File# in sync with SCS’s real recorder file number, read from the .dat in the SC_Files save folder.',
    defaults: {
      sources: { scstrig: true, folder: false, udp: false, serial: false, scslog: false },
      scstrigDir: TRIG_TEMPCOM_DEFAULT_DIR,
      scFilesDir: TRIG_SCFILES_DEFAULT_DIR,
      autonum: { enabled: true, fileMode: 'reconcile' }, // File# synced to SCS (seed + auto-correct)
    },
  },
  {
    id: 'generic',
    label: 'Advanced / generic sources',
    description:
      'Wire the generic sources yourself - watch the acquisition folder, a UDP listener, a serial trigger box, or tail the SCS survey log. For non-Geode setups; Auto-number stays available.',
    defaults: {
      // No forced sources: a generic setup is whatever the observer enables.
    },
  },
];

/** The default system for a fresh install / an unrecognised stored id. `generic`
 *  preserves the historical folder-watch default so nothing changes for users
 *  who never touch the selector. */
export const DEFAULT_TRIG_SYSTEM: TrigSystemId = 'generic';

/** True when `id` is a known trigger-system id. */
export function isTrigSystemId(id: unknown): id is TrigSystemId {
  return typeof id === 'string' && TRIGGER_SYSTEMS.some((s) => s.id === id);
}

/** Look up a system by id, falling back to the DEFAULT_TRIG_SYSTEM entry for an
 *  unknown / missing id (never returns undefined). */
export function resolveTrigSystem(id: string | null | undefined): TrigSystem {
  return (
    TRIGGER_SYSTEMS.find((s) => s.id === id) ??
    TRIGGER_SYSTEMS.find((s) => s.id === DEFAULT_TRIG_SYSTEM) ??
    TRIGGER_SYSTEMS[0]
  );
}

/**
 * Migrate a persisted config's trigger-system id (old → new). Older saved configs
 * predate the selector and carry no `system` field: a config that already had the
 * SCS TempCom (scstrig) source enabled is treated as the Geode system, so those
 * users keep exactly their behaviour; everything else defaults to `generic`
 * (which preserves the historical folder-watch default). A valid stored id is
 * kept verbatim.
 */
export function migrateTrigSystemId(rawSystem: unknown, hadScstrigEnabled: boolean): TrigSystemId {
  if (isTrigSystemId(rawSystem)) return rawSystem;
  return hadScstrigEnabled ? 'geode' : DEFAULT_TRIG_SYSTEM;
}
