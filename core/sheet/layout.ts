// seisconv-core / sheet - turn a Parameters Sheet into styled workbook sheets.
//
// Sheets: `Parameters` (a one-page, label / value / unit layout in three column
// groups, title row merged, one bold band per section, derived values marked),
// then `Area` and `Map` only when coordinates were given, then `About`.
// Numbers are written as numbers and dates as real dates; the unit always sits
// in its own column.
//
// Pure: no DOM / Electron. The caller supplies the date, the version, the area
// coordinates (already converted) and the map PNG.

import type { StyledCellLike, StyledSheet, CellStyle } from '../export/xlsx';
import { deriveSheet, crossChecks, fmtNum, type ParamSheet } from './model';
import { SURVEY_GEOMETRIES, sourceKind } from './lists';
import { coordLines, lineMismatch } from './reconcile';

export interface AreaPoint {
  id: string;
  group?: string;
  /** As typed, in the input CRS (lon / lat for a geographic CRS). */
  x: number;
  y: number;
  /** Metric grid coordinates (null when unknown). */
  e: number | null;
  n: number | null;
  lat: number | null;
  lon: number | null;
}

export interface AreaInfo {
  crsCode: string;
  crsName: string;
  /** The metric grid E / N are given in (equals the input CRS when projected). */
  gridCode: string;
  gridName: string;
  points: AreaPoint[];
  closed: boolean;
  /** Closed outline only: enclosed area, m2. */
  areaM2: number | null;
  /** Outline perimeter or total line length, m. */
  lengthM: number | null;
  extent: { minE: number; minN: number; maxE: number; maxN: number } | null;
}

export interface MapInfo {
  /** Encoded map picture: JPEG over a photo basemap, PNG otherwise. */
  data: Uint8Array;
  format: 'png' | 'jpeg';
  widthPx: number;
  heightPx: number;
  /** Basemap attribution, '' for no basemap. */
  attribution: string;
  /** Visible note (offline, missing tiles), '' when none. */
  note: string;
}

export interface LayoutMeta {
  version: string;
  /** YYYY-MM-DD, from the renderer clock. */
  preparedDate: string;
  /** Human time stamp for the About sheet. */
  generatedAt: string;
}

// -- styles ---------------------------------------------------------------------

const NAVY = '1F4E79';
const S_TITLE: CellStyle = { bold: true, size: 16, color: NAVY };
const S_SUB: CellStyle = { italic: true, color: '595959' };
const S_SECTION: CellStyle = { bold: true, size: 12, color: 'FFFFFF', fill: NAVY };
const S_LABEL: CellStyle = { bold: true, color: '262626', fill: 'F2F2F2', border: true };
const S_VALUE: CellStyle = { border: true, align: 'left' };
const S_DERIVED: CellStyle = { border: true, italic: true, fill: 'E8F3F3', align: 'left' };
const S_UNIT: CellStyle = { border: true, color: '595959' };
const S_DATE: CellStyle = { border: true, numFmt: 'yyyy-mm-dd', align: 'left' };
const S_HEAD: CellStyle = { bold: true, fill: 'D9E2EC', border: true };
const S_CELL: CellStyle = { border: true };
const S_WARN: CellStyle = { color: '9C5700', wrap: true };
const S_NOTE: CellStyle = { italic: true, color: '595959', wrap: true };

/** Excel date serial (days since 1899-12-30) for a YYYY-MM-DD string. */
export function excelDateSerial(iso: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
  if (!m) return null;
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  if (!Number.isFinite(t)) return null;
  return Math.round(t / 86400000) + 25569;
}

type Val = string | number | null;
interface Field { label: string; value: Val; unit?: string; derived?: boolean; date?: boolean }

const round = (v: number | null, d = 3): number | null => (v == null || !Number.isFinite(v) ? null : Number(v.toFixed(d)));
const txt = (s: string): string => (s || '').trim();

/** Three label / value / unit groups per row, plus one-column spacers. */
const GROUP_COLS = 4; // label, value, unit, spacer
const NCOLS = GROUP_COLS * 3 - 1; // A..K
const lastCol = 'K';

class Grid {
  rows: StyledCellLike[][] = [];
  merges: string[] = [];
  heights: Record<number, number> = {};
  get r(): number { return this.rows.length; }
  blank(): void { this.rows.push([]); }
  section(title: string): void {
    const row: StyledCellLike[] = [{ v: title, s: S_SECTION }];
    for (let c = 1; c < NCOLS; c++) row.push({ v: '', s: S_SECTION });
    this.merges.push(`A${this.r + 1}:${lastCol}${this.r + 1}`);
    this.rows.push(row);
    this.heights[this.r - 1] = 18;
  }
  line(text: string, s: CellStyle = S_NOTE): void {
    this.merges.push(`A${this.r + 1}:${lastCol}${this.r + 1}`);
    this.rows.push([{ v: text, s }]);
    const lines = Math.ceil(text.length / 150);
    if (lines > 1) this.heights[this.r - 1] = Math.min(400, 15 * lines);
  }
  fields(fs: (Field | null)[]): void {
    for (let i = 0; i < fs.length; i += 3) {
      const row: StyledCellLike[] = [];
      for (let k = 0; k < 3; k++) {
        const f = fs[i + k];
        if (!f) { row.push(null, null, null); if (k < 2) row.push(null); continue; }
        const lbl = f.derived ? `${f.label} (derived)` : f.label;
        let v: StyledCellLike;
        if (f.date) {
          const serial = typeof f.value === 'string' ? excelDateSerial(f.value) : null;
          v = serial != null ? { v: serial, s: S_DATE } : { v: '', s: S_VALUE };
        } else {
          v = { v: f.value ?? '', s: f.derived ? S_DERIVED : S_VALUE };
        }
        row.push({ v: lbl, s: S_LABEL }, v, { v: f.unit ?? '', s: S_UNIT });
        if (k < 2) row.push(null);
      }
      this.rows.push(row);
    }
  }
}

const geomLabel = (g: string): string => SURVEY_GEOMETRIES.find((x) => x.value === g)?.label ?? g;

/** The `Parameters` sheet. */
export function parametersSheet(m: ParamSheet, area: AreaInfo | null, meta: LayoutMeta): StyledSheet {
  const d = deriveSheet(m);
  const j = m.job, g = m.geom, s = m.source, r = m.receiver, rec = m.recording, t = m.totals;
  const G = new Grid();
  G.rows.push([{ v: 'Parameter Sheet', s: S_TITLE }]);
  G.merges.push(`A1:${lastCol}1`);
  G.heights[0] = 24;
  G.line(`${txt(j.jobType) || 'Job'}${txt(j.prospect) ? ` - ${txt(j.prospect)}` : ''}. Planned (dry) values, not field measurements. Derived values are nominal.`, S_SUB);
  G.blank();

  G.section('Job');
  G.fields([
    { label: 'Job type', value: txt(j.jobType) },
    { label: 'Survey geometry', value: geomLabel(j.geometry) },
    { label: 'Target depth', value: j.targetDepthM, unit: 'm' },
    { label: 'Client', value: txt(j.client) },
    { label: 'Contractor', value: txt(j.contractor) },
    { label: 'Manager', value: txt(j.manager) },
    { label: 'Prospect', value: txt(j.prospect) },
    { label: 'Crew #', value: txt(j.crew) },
    { label: 'Observer', value: txt(j.observer) },
    { label: 'Job number', value: txt(j.jobNumber) },
    { label: 'Start date', value: j.startDate, date: true },
    { label: 'End date', value: j.endDate, date: true },
    { label: 'Prepared by', value: txt(j.preparedBy) },
    { label: 'Revision', value: txt(j.revision) },
    { label: 'Date prepared', value: meta.preparedDate, date: true },
  ]);
  if (txt(j.notes)) G.line(`Notes: ${txt(j.notes)}`);
  G.blank();

  G.section('Geometry');
  const geo: (Field | null)[] = [
    { label: 'RX point interval', value: g.rxIntervalM, unit: 'm' },
    { label: 'SX point interval', value: g.sxIntervalM, unit: 'm' },
    { label: 'Line length', value: g.lineLengthM, unit: 'm' },
    { label: 'Spread type', value: txt(g.spreadType) },
    { label: 'Spread', value: txt(g.spread) },
    { label: 'Active channels', value: g.activeChannels },
    { label: 'High flag live', value: g.highFlagLive },
    { label: 'Low flag live', value: g.lowFlagLive },
    { label: 'Source offset', value: g.sourceOffsetM, unit: 'm' },
    { label: 'Receiver table', value: txt(g.receiverTable) },
    { label: 'Receiver array', value: txt(g.receiverArray) },
    { label: 'Lines', value: d.lineCount, derived: true },
    { label: 'Stations per line (max)', value: d.maxStations, derived: true },
    { label: 'Spread length', value: round(d.spreadLengthM), unit: 'm', derived: true },
    { label: 'Total line length', value: round(d.totalLengthM), unit: 'm', derived: true },
  ];
  if (j.geometry === '2D') geo.push({ label: 'Nominal fold', value: round(d.fold2d, 2), derived: true }, null, null);
  if (j.geometry === '3D') {
    geo.push(
      { label: 'Receiver line interval', value: g.rliM, unit: 'm' },
      { label: 'Source line interval', value: g.sliM, unit: 'm' },
      { label: 'Receiver line azimuth', value: g.azimuthDeg, unit: 'deg' },
      { label: 'Receiver lines', value: g.rxLines },
      { label: 'Source lines', value: g.sxLines },
      { label: 'Patch (lines x channels)', value: g.patchLines != null && g.patchChannelsPerLine != null ? `${g.patchLines} x ${g.patchChannelsPerLine}` : '' },
      { label: 'Bin size', value: d.binInlineM != null && d.binCrosslineM != null ? `${fmtNum(d.binInlineM)} x ${fmtNum(d.binCrosslineM)}` : '', unit: 'm', derived: true },
      { label: 'Nominal fold (in x cross)', value: d.fold3dInline != null && d.fold3dCrossline != null ? `${fmtNum(d.fold3dInline, 2)} x ${fmtNum(d.fold3dCrossline, 2)}` : '', derived: true },
      { label: 'Nominal fold', value: round(d.fold3d, 2), derived: true },
    );
  }
  G.fields(geo);
  if (d.lines.length) {
    G.rows.push([
      { v: 'Line', s: S_HEAD }, { v: 'Length', s: S_HEAD }, { v: 'Unit', s: S_HEAD }, null,
      { v: 'Stations (derived)', s: S_HEAD }, { v: 'Shots (derived)', s: S_HEAD },
    ]);
    for (const l of d.lines) {
      G.rows.push([
        { v: l.name, s: S_CELL }, { v: l.lengthM ?? '', s: S_CELL }, { v: 'm', s: S_UNIT }, null,
        { v: l.stations ?? '', s: S_DERIVED }, { v: l.shots ?? '', s: S_DERIVED },
      ]);
    }
  }
  G.blank();

  G.section('Recording');
  G.fields([
    { label: 'Instrument', value: txt(rec.instrumentMfr) },
    { label: 'Instrument model', value: txt(rec.instrumentModel) },
    { label: 'Data format', value: txt(rec.dataFormat) },
    { label: 'Sample rate', value: rec.sampleRateMs, unit: 'ms' },
    { label: 'Record length', value: rec.recordLengthS, unit: 's' },
    { label: 'Nyquist', value: round(d.nyquistHz, 2), unit: 'Hz', derived: true },
    { label: 'Low cut', value: rec.lowCutHz ?? 'None', unit: rec.lowCutHz != null ? 'Hz' : '' },
    { label: 'High cut', value: rec.highCutAntiAlias ? 'Anti-alias' : (rec.highCutHz ?? 'None'), unit: !rec.highCutAntiAlias && rec.highCutHz != null ? 'Hz' : '' },
    { label: 'Notch filter', value: rec.notchHz ?? 'None', unit: rec.notchHz != null ? 'Hz' : '' },
    { label: 'Pre-amp gain', value: rec.preampGainDb, unit: 'dB' },
    { label: 'Correlation', value: txt(rec.correlation) },
    { label: 'Coordinate system', value: txt(rec.coordSystem) },
    { label: 'Aux trace 1', value: txt(rec.aux[0]) },
    { label: 'Aux trace 2', value: txt(rec.aux[1]) },
    { label: 'Samples per trace', value: d.samplesPerTrace, derived: true },
    { label: 'Aux trace 3', value: txt(rec.aux[2]) },
    { label: 'Aux trace 4', value: txt(rec.aux[3]) },
    null,
  ]);
  G.blank();

  G.section('Source');
  const kind = sourceKind(s.type);
  const src: (Field | null)[] = [
    { label: 'Source type', value: txt(s.type) },
    { label: 'Trigger system', value: txt(s.trigger) },
    { label: 'Energy source', value: txt(s.energy) },
    { label: 'Manufacturer', value: txt(s.manufacturer) },
    { label: 'Model', value: txt(s.model) },
    { label: 'Source wave type', value: txt(s.waveType) },
    { label: kind === 'vibrator' ? 'Peak force' : 'Unit weight', value: s.unitWeight, unit: s.unitWeight != null ? s.unitWeightUnit : '' },
    { label: 'Plate type', value: txt(s.plate) },
    { label: 'Stack', value: s.stack },
    { label: 'Source array', value: txt(s.array) },
    null, null,
  ];
  if (kind === 'vibrator') {
    src.push(
      { label: 'Sweep start', value: s.sweepStartHz, unit: 'Hz' },
      { label: 'Sweep end', value: s.sweepEndHz, unit: 'Hz' },
      { label: 'Sweep length', value: s.sweepLengthS, unit: 's' },
      { label: 'Sweep tapers', value: s.sweepTaperS, unit: 's' },
      { label: 'Sweep type', value: txt(s.sweepType) },
      { label: 'Fleet size', value: s.fleetSize },
    );
  }
  if (kind === 'impulsive') {
    src.push(
      { label: 'Size', value: txt(s.impSize) },
      { label: 'Depth', value: s.impDepthM, unit: 'm' },
      { label: 'Pattern', value: txt(s.impPattern) },
      { label: 'Count per point', value: s.impCount },
      null, null,
    );
  }
  G.fields(src);
  if (txt(s.comments)) G.line(`Source comments: ${txt(s.comments)}`);
  G.blank();

  G.section('Receiver');
  G.fields([
    { label: 'Manufacturer', value: txt(r.manufacturer) },
    { label: 'Model', value: txt(r.model) },
    { label: 'Natural frequency', value: r.naturalFreqHz, unit: 'Hz' },
    { label: 'Geophone type', value: txt(r.geophoneType) },
    { label: 'Phones per station', value: r.phonesPerStation },
    { label: 'Receiver interval', value: g.rxIntervalM, unit: 'm' },
  ]);
  if (txt(r.comments)) G.line(`Receiver comments: ${txt(r.comments)}`);
  G.blank();

  G.section('Totals and conditions');
  G.fields([
    { label: 'Total shots', value: t.totalShots },
    { label: 'Total shots', value: d.shots, derived: true },
    { label: 'Weather / noise', value: txt(t.weather) },
    { label: 'Total files', value: t.totalFiles },
    { label: 'Total files', value: d.files, derived: true },
    null,
  ]);
  G.blank();

  G.section('Survey area');
  if (!area) {
    G.line('Survey area: not provided', { bold: true });
  } else {
    G.fields([
      { label: 'Coordinate system', value: area.crsCode ? `${area.crsName} (${area.crsCode})` : area.crsName },
      { label: 'Points', value: area.points.length },
      { label: area.closed ? 'Area' : 'Extent area', value: area.areaM2 != null ? round(area.areaM2 / 1e6, 4) : '', unit: 'km2', derived: true },
    ]);
    G.line('Every point with Easting, Northing, latitude and longitude is on the Area sheet; the map is on the Map sheet.');
  }
  const checks = crossChecks(m).warnings.map((w) => w.msg);
  // The Geometry lines and the coordinate list must describe the same lines.
  if (area) {
    const diff = lineMismatch(m.geom.lines, coordLines(area.points));
    if (diff) checks.push(`Lines do not match the coordinates: ${diff}`);
  }
  if (checks.length) {
    G.blank();
    G.section('Plan checks');
    for (const w of checks.slice(0, 30)) G.line(`Check: ${w}`, S_WARN);
  }

  return {
    name: 'Parameters',
    rows: G.rows,
    cols: [22, 24, 6, 2, 22, 24, 6, 2, 24, 24, 6],
    merges: G.merges,
    rowHeights: G.heights,
    landscape: true,
    // One printed A4 page, like the hand-kept Template sheet.
    fitPage: true,
    printArea: true,
  };
}

/** The `Area` sheet: every point with E, N, latitude, longitude. */
export function areaSheet(area: AreaInfo): StyledSheet {
  const rows: StyledCellLike[][] = [];
  rows.push([{ v: 'Survey area', s: S_TITLE }]);
  rows.push([{ v: 'Coordinate system of the list', s: S_LABEL }, { v: area.crsCode ? `${area.crsName} (${area.crsCode})` : area.crsName, s: S_VALUE }]);
  rows.push([{ v: 'Easting / Northing in', s: S_LABEL }, { v: area.gridCode ? `${area.gridName} (${area.gridCode})` : area.gridName, s: S_VALUE }]);
  rows.push([{ v: area.closed ? 'Enclosed area (km2)' : 'Extent area (km2)', s: S_LABEL }, { v: area.areaM2 != null ? round(area.areaM2 / 1e6, 4) : '', s: S_DERIVED }]);
  rows.push([{ v: area.closed ? 'Perimeter (m)' : 'Total line length (m)', s: S_LABEL }, { v: round(area.lengthM, 1) ?? '', s: S_DERIVED }]);
  const ex = area.extent;
  rows.push([{ v: 'Extent E (min / max)', s: S_LABEL }, { v: ex ? round(ex.minE, 2) : '', s: { ...S_DERIVED, numFmt: '0.00' } }, { v: ex ? round(ex.maxE, 2) : '', s: { ...S_DERIVED, numFmt: '0.00' } }]);
  rows.push([{ v: 'Extent N (min / max)', s: S_LABEL }, { v: ex ? round(ex.minN, 2) : '', s: { ...S_DERIVED, numFmt: '0.00' } }, { v: ex ? round(ex.maxN, 2) : '', s: { ...S_DERIVED, numFmt: '0.00' } }]);
  rows.push([]);
  const head = ['#', 'Point', 'Line', 'Easting (m)', 'Northing (m)', 'Latitude', 'Longitude'];
  rows.push(head.map((h) => ({ v: h, s: S_HEAD })));
  const headerRow = rows.length;
  area.points.forEach((p, i) => {
    rows.push([
      { v: i + 1, s: S_CELL },
      { v: p.id, s: S_CELL },
      { v: p.group ?? '', s: S_CELL },
      { v: round(p.e, 3) ?? '', s: { ...S_CELL, numFmt: '0.00' } },
      { v: round(p.n, 3) ?? '', s: { ...S_CELL, numFmt: '0.00' } },
      { v: round(p.lat, 8) ?? '', s: { ...S_CELL, numFmt: '0.000000' } },
      { v: round(p.lon, 8) ?? '', s: { ...S_CELL, numFmt: '0.000000' } },
    ]);
  });
  return {
    name: 'Area',
    rows,
    cols: [26, 22, 16, 16, 16, 13, 13],
    merges: ['A1:G1'],
    freezeRows: headerRow,
    rowHeights: { 0: 22 },
    fitWidth: true,
    printArea: true,
  };
}

/** The `Map` sheet: the map picture with its attribution under the title. */
export function mapSheet(map: MapInfo, title: string): StyledSheet {
  const rows: StyledCellLike[][] = [
    [{ v: title, s: S_TITLE }],
    [{ v: map.attribution ? `Basemap: ${map.attribution}` : 'No basemap (outline and coordinate grid only).', s: S_NOTE }],
    [{ v: map.note || '', s: S_WARN }],
  ];
  return {
    name: 'Map',
    rows,
    cols: [14, 14, 14, 14, 14, 14, 14, 14, 14, 14, 14, 14],
    merges: ['A1:L1', 'A2:L2', 'A3:L3'],
    rowHeights: { 0: 22 },
    image: { data: map.data, format: map.format, widthPx: map.widthPx, heightPx: map.heightPx, displayWidthPx: 1040, col: 0, row: 4, name: 'Survey area map' },
    landscape: true,
    fitWidth: true,
  };
}

/** The `About` sheet. */
export function aboutSheet(m: ParamSheet, map: MapInfo | null, meta: LayoutMeta): StyledSheet {
  const kv = (k: string, v: StyledCellLike): StyledCellLike[] => [{ v: k, s: S_LABEL }, v];
  const rows: StyledCellLike[][] = [
    [{ v: 'About this sheet', s: S_TITLE }],
    kv('Made with', { v: `SeisConv ${meta.version}`, s: S_VALUE }),
    kv('Generated', { v: meta.generatedAt, s: S_VALUE }),
    kv('Date prepared', excelDateSerial(meta.preparedDate) != null ? { v: excelDateSerial(meta.preparedDate), s: S_DATE } : { v: meta.preparedDate, s: S_VALUE }),
    kv('Revision', { v: txt(m.job.revision), s: S_VALUE }),
    kv('Prepared by', { v: txt(m.job.preparedBy), s: S_VALUE }),
    [],
    [{ v: 'Every value in this workbook is PLANNED (dry): typed or derived before the survey, not measured in the field.', s: S_NOTE }],
    [{ v: 'Derived values (marked "derived") are nominal: stations, shots and files from the line lengths and intervals, fold from channels and intervals.', s: S_NOTE }],
    [{ v: 'Latitude / longitude are WGS 84, converted from the listed coordinate system.', s: S_NOTE }],
    [],
    kv('Basemap', { v: map ? (map.attribution || 'No basemap') : 'No map (no survey area given)', s: S_VALUE }),
  ];
  return {
    name: 'About',
    rows,
    cols: [22, 90],
    merges: ['A1:B1', 'A8:B8', 'A9:B9', 'A10:B10'],
    rowHeights: { 0: 22 },
  };
}

/** The whole workbook, in sheet order. `area` / `map` null = "No area yet". */
export function buildSheetWorkbook(m: ParamSheet, area: AreaInfo | null, map: MapInfo | null, meta: LayoutMeta): StyledSheet[] {
  const out: StyledSheet[] = [parametersSheet(m, area, meta)];
  if (area) {
    out.push(areaSheet(area));
    if (map) out.push(mapSheet(map, `Survey area map - ${txt(m.job.prospect) || txt(m.job.jobType) || 'job'}`));
  }
  out.push(aboutSheet(m, area ? map : null, meta));
  return out;
}
