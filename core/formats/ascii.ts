// seisconv-core - CSV / ASCII export (WRITE-only)
//
// Tabular text dump of trace samples for inspection in a spreadsheet or any
// CSV-aware tool. There is no CSV reader: this is a one-way QC/export path.
//
// CAVEAT (approximate): this is a lossy text view, not a faithful seismic
// container - trace headers are dropped and only sample amplitudes are written,
// one column per trace. Columns are capped at 256 traces (noted in the
// preamble) so very wide gathers don't produce unwieldy files. `time_ms` is
// derived from the binary-header sample interval (microseconds → ms), so it is
// uniform across all traces even if individual traces differ in length.

import type { Bytes, ParsedFile } from '../types';

/** Maximum number of trace columns written; extras are truncated (noted in preamble). */
const MAX_CSV_TRACES = 256;

export function writeCSV(pd: ParsedFile): Bytes {
  const allTraces = pd.traces || [];
  const total = allTraces.length;
  const traces = allTraces.slice(0, MAX_CSV_TRACES);
  const nCols = traces.length;

  // sampleInt is microseconds (SEG-Y convention); 0/undefined → blank time col.
  const si = pd.bh?.sampleInt || 0;

  // Longest trace drives the row count so no trace is clipped.
  let maxSamples = 0;
  for (const t of traces) maxSamples = Math.max(maxSamples, t.nSamples || 0);

  const lines: string[] = [];

  // -- '#'-comment preamble --
  lines.push('# SeisConv CSV export');
  lines.push(`# source format: ${pd.format || 'unknown'}`);
  lines.push(`# traceCount: ${total}`);
  lines.push(`# sampleInt us: ${si}`);
  lines.push(`# samplesPerTrace: ${maxSamples}`);
  if (total > MAX_CSV_TRACES) {
    lines.push(`# NOTE: truncated to first ${MAX_CSV_TRACES} of ${total} traces`);
  }

  // -- header row --
  const header: string[] = ['sample', 'time_ms'];
  for (let c = 0; c < nCols; c++) header.push('t' + (c + 1));
  lines.push(header.join(','));

  // -- data rows: one per sample index --
  for (let i = 0; i < maxSamples; i++) {
    const row: string[] = [];
    row.push(String(i));
    // i * sampleInt(us) / 1000 → milliseconds. Blank when no sample interval.
    row.push(si ? String((i * si) / 1000) : '');
    for (let c = 0; c < nCols; c++) {
      const s = traces[c].samples;
      // empty cell when the trace is shorter than i, or its samples were dropped.
      row.push(s && i < s.length ? String(s[i]) : '');
    }
    lines.push(row.join(','));
  }

  return new TextEncoder().encode(lines.join('\n') + '\n');
}
