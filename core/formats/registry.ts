// seisconv-core — format + writer registry.
//
// The extension point for the platform's growth: adding a new seismic format is
// one module + one `registerFormat(...)` line; adding an output is one
// `registerWriter(...)` line. `parseAny`/the UI/the worker all dispatch through
// here, so nothing else needs to change.

import type { Bytes, ParsedFile, SeismicFormat } from '../types';
import { detectEx } from '../detect';
import { parseSEGY, writeSEGY } from './segy';
import { parseSEGD, writeSEGD } from './segd';
import { parseSEG2, writeSEG2 } from './seg2';
import { parseSU, writeSU } from './su';
import { writeCSV } from './ascii';
import { writeTapeImage } from './tapeimage';

export interface FormatModule {
  id: SeismicFormat;
  parse: (b: Bytes, name?: string) => ParsedFile;
}

export interface WriterDef {
  /** Stable id used by the UI/worker (e.g. 'segy1'). */
  id: string;
  label: string;
  ext: string;
  write: (pf: ParsedFile) => Bytes;
}

const parsers = new Map<SeismicFormat, FormatModule>();
const writers = new Map<string, WriterDef>();

export function registerFormat(m: FormatModule): void {
  parsers.set(m.id, m);
}
export function registerWriter(w: WriterDef): void {
  writers.set(w.id, w);
}
export function getWriter(id: string): WriterDef | undefined {
  return writers.get(id);
}
export function listFormats(): SeismicFormat[] {
  return [...parsers.keys()];
}
export function listWriters(): WriterDef[] {
  return [...writers.values()];
}

/** Detect the format and parse via the registered module. */
export function parseWithRegistry(b: Bytes, name?: string): ParsedFile {
  const { format: id, assumed } = detectEx(b, name);
  const mod = parsers.get(id);
  if (!mod) {
    const errors = id === 'UNKNOWN'
      ? ['Unsupported file: the content matches no known seismic format (SEG-Y / SEG-D / SEG-2 / SU / tape image).']
      : [`No parser registered for ${id} (e.g. TPIMAGE extraction is not yet supported)`];
    return { format: id, revision: 0, bh: {}, traces: [], traceCount: 0, errors };
  }
  const pf = mod.parse(b, name);
  if (assumed)
    pf.errors.unshift(`Unrecognized content — no format signature matched; attempting ${id} because the file is large enough to hold its headers. Results may be unreliable.`);
  return pf;
}

// ── Built-in registrations ──
// Add a format here (after writing its module). Add an output by registering a writer.
// Wrapped (not bare parseSEGY) because parseSEGY's 2nd param is now a sample-trace
// cap, not a filename — the registry's default parse uses the cap's default.
registerFormat({ id: 'SEG-Y', parse: (b) => parseSEGY(b) });
registerFormat({ id: 'SEG-D', parse: parseSEGD });
registerFormat({ id: 'SEG-2', parse: parseSEG2 });
registerFormat({ id: 'SU', parse: parseSU });

registerWriter({ id: 'segy1', label: 'SEG-Y Rev 1', ext: 'sgy', write: (pf) => writeSEGY(pf, 1) });
registerWriter({ id: 'segy0', label: 'SEG-Y Rev 0', ext: 'sgy', write: (pf) => writeSEGY(pf, 0) });
registerWriter({ id: 'segy2', label: 'SEG-Y Rev 2', ext: 'sgy', write: (pf) => writeSEGY(pf, 2) });
registerWriter({ id: 'su', label: 'Seismic Unix', ext: 'su', write: writeSU });
registerWriter({ id: 'seg2', label: 'SEG-2 / .dat', ext: 'dat', write: writeSEG2 });
registerWriter({ id: 'segd1', label: 'SEG-D Rev 1', ext: 'segd', write: (pf) => writeSEGD(pf, false) });
registerWriter({ id: 'segd3', label: 'SEG-D Rev 3', ext: 'segd', write: (pf) => writeSEGD(pf, true) });
registerWriter({ id: 'tpimage', label: 'Tape Image', ext: 'tpimage', write: (pd) => writeTapeImage(pd) });
registerWriter({ id: 'csv', label: 'CSV / ASCII', ext: 'csv', write: writeCSV });
