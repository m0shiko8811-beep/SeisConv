// seisconv-core / gis - ESRI Shapefile writer (points + PointZ).
//
// Emits the four-file set GIS software expects, as raw bytes:
//   .shp  geometry        .shx  record index
//   .dbf  attribute table .prj  CRS as ESRI WKT (built by ./wkt)
// plus a .cpg declaring the .dbf text encoding.
//
// Pure - no DOM, no Node, no Date. The DBF header carries a "last updated" date,
// so callers pass one in explicitly (`dateYMD`): the parse worker is forbidden
// from calling `new Date()`, and a fixed default also keeps output byte-stable
// for the regression tests.
//
// Byte order is genuinely mixed inside a shapefile - the file code and every
// record header are BIG-endian, everything else is LITTLE-endian. That is the
// format, not a bug.

/** Shape type codes from the ESRI shapefile spec (only the ones we write). */
export const SHP_TYPE_NULL = 0;
export const SHP_TYPE_POINT = 1;
export const SHP_TYPE_POINTZ = 11;

/** ESRI's "no data" sentinel for optional Z/M values. Readers treat any value
 *  smaller than -1e38 as absent. */
export const SHP_NODATA = -1e38;

/** Hard caps. A shapefile's byte length lives in a 32-bit count of 16-bit words,
 *  so the real format ceiling is 2 GB per file; we stop far short of that and
 *  report, rather than emitting a file no reader can open. */
export const MAX_SHAPE_RECORDS = 2_000_000;
/** dBASE III record layout: a 16-bit record length caps the sum of field widths. */
export const MAX_DBF_RECORD_BYTES = 65_535;
/** dBASE field widths (spec limits: name 10 chars, C width 254, N width 18). */
export const MAX_DBF_NAME = 10;
export const MAX_DBF_CHAR_WIDTH = 254;
export const MAX_DBF_NUM_WIDTH = 18;

export interface ShapePoint {
  x: number;
  y: number;
  /** Metres. Only written when the layer is PointZ. */
  z?: number;
}

/** One dBASE column. `C` = text, `N` = number, `D` = date (YYYYMMDD, width 8). */
export interface DbfField {
  name: string;
  type: 'C' | 'N' | 'D';
  length: number;
  decimals?: number;
}

export type DbfValue = string | number | null | undefined;

export interface ShapefileLayer {
  /** Base name, without extension. Sanitised for the file system by the caller. */
  name: string;
  points: ShapePoint[];
  fields: DbfField[];
  /** One row per point, values positionally matching `fields`. */
  rows: DbfValue[][];
  /** ESRI WKT for the .prj. Omitted (or empty) means no .prj is written, which
   *  tells GIS software "unknown CRS" - honest, rather than a guessed default. */
  prj?: string;
  /** Write PointZ (elevation preserved) instead of plain 2-D Point. */
  hasZ?: boolean;
  /** .dbf text encoding declared in the .cpg sidecar. */
  encoding?: string;
  /** Header date as [year, month(1-12), day]. Defaults to a fixed stamp. */
  dateYMD?: [number, number, number];
}

export interface ShapefileOut {
  name: string;
  bytes: Uint8Array;
}

/** Fixed default so worker output is deterministic and `new Date()`-free. */
const DEFAULT_DATE: [number, number, number] = [2026, 1, 1];

function isFiniteNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * Sanitise a dBASE field name: ASCII letters/digits/underscore, uppercase, max
 * 10 bytes, never starting with a digit. Deliberately strict - a name outside
 * this set silently breaks readers rather than erroring.
 */
export function dbfSafeName(raw: string): string {
  let s = (raw || '').toUpperCase().replace(/[^A-Z0-9_]/g, '_').slice(0, MAX_DBF_NAME);
  if (!s) s = 'FIELD';
  if (/^[0-9]/.test(s)) s = ('F' + s).slice(0, MAX_DBF_NAME);
  return s;
}

/** Ensure field names are unique after sanitising (readers key on the name). */
function uniqueNames(fields: DbfField[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const f of fields) {
    let n = dbfSafeName(f.name);
    if (seen.has(n)) {
      for (let i = 2; i < 1000; i++) {
        const cand = (n.slice(0, MAX_DBF_NAME - String(i).length) + i);
        if (!seen.has(cand)) { n = cand; break; }
      }
    }
    seen.add(n);
    out.push(n);
  }
  return out;
}

/** UTF-8 encode without depending on TextEncoder being present everywhere. */
function utf8(s: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);
    // Combine a surrogate pair into one code point before encoding.
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const lo = s.charCodeAt(i + 1);
      if (lo >= 0xdc00 && lo <= 0xdfff) { c = 0x10000 + ((c - 0xd800) << 10) + (lo - 0xdc00); i++; }
    }
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return out;
}

/**
 * Lay a value into a fixed-width dBASE cell.
 * `C` left-justified, `N`/`D` right-justified, both space-padded, and truncated
 * at a BYTE boundary (never mid-UTF-8-sequence) so a long name can never shift
 * every later column. A number too wide for its field degrades decimals first,
 * then falls back to all-spaces (dBASE's own "empty") rather than writing digits
 * that would be read as a different value.
 */
function dbfCell(v: DbfValue, f: DbfField): number[] {
  const width = f.length;
  if (f.type === 'N') {
    if (!isFiniteNum(v)) {
      const n = Number(v);
      if (!Number.isFinite(n)) return new Array(width).fill(0x20);
      v = n;
    }
    const dp = Math.max(0, Math.min(15, f.decimals || 0));
    for (let d = dp; d >= 0; d--) {
      const s = (v as number).toFixed(d);
      if (s.length <= width) return padLeftAscii(s, width);
    }
    return new Array(width).fill(0x20); // does not fit at any precision
  }
  if (f.type === 'D') {
    const s = String(v ?? '').replace(/[^0-9]/g, '').slice(0, 8);
    return s.length === 8 ? padLeftAscii(s, width) : new Array(width).fill(0x20);
  }
  // 'C': UTF-8, truncated to whole code points, left-justified.
  const bytes = utf8(String(v ?? '').replace(/[\r\n\t]+/g, ' '));
  let n = Math.min(bytes.length, width);
  while (n > 0 && (bytes[n] & 0xc0) === 0x80) n--; // do not cut a continuation byte
  const out = bytes.slice(0, n);
  while (out.length < width) out.push(0x20);
  return out;
}

function padLeftAscii(s: string, width: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < width - s.length; i++) out.push(0x20);
  for (let i = 0; i < s.length && out.length < width; i++) out.push(s.charCodeAt(i) & 0x7f);
  return out;
}

/** Bounding box over the finite points only; all-empty yields zeros. */
function bbox(points: ShapePoint[]): { xMin: number; yMin: number; xMax: number; yMax: number; zMin: number; zMax: number } {
  let xMin = Infinity, yMin = Infinity, xMax = -Infinity, yMax = -Infinity, zMin = Infinity, zMax = -Infinity;
  for (const p of points) {
    if (!isFiniteNum(p.x) || !isFiniteNum(p.y)) continue;
    if (p.x < xMin) xMin = p.x;
    if (p.x > xMax) xMax = p.x;
    if (p.y < yMin) yMin = p.y;
    if (p.y > yMax) yMax = p.y;
    if (isFiniteNum(p.z)) {
      if (p.z < zMin) zMin = p.z;
      if (p.z > zMax) zMax = p.z;
    }
  }
  const fin = (v: number, alt: number) => (Number.isFinite(v) ? v : alt);
  return {
    xMin: fin(xMin, 0), yMin: fin(yMin, 0), xMax: fin(xMax, 0), yMax: fin(yMax, 0),
    zMin: fin(zMin, 0), zMax: fin(zMax, 0),
  };
}

/** The shared 100-byte .shp/.shx header. `fileWords` is the TOTAL file length in
 *  16-bit words, which is what both files store (not bytes). */
function shpHeader(fileWords: number, shapeType: number, bb: ReturnType<typeof bbox>): Uint8Array {
  const buf = new ArrayBuffer(100);
  const dv = new DataView(buf);
  dv.setInt32(0, 9994, false); // file code, big-endian
  for (let o = 4; o < 24; o += 4) dv.setInt32(o, 0, false); // 5 unused
  dv.setInt32(24, fileWords, false); // big-endian, in 16-bit words
  dv.setInt32(28, 1000, true); // version
  dv.setInt32(32, shapeType, true);
  dv.setFloat64(36, bb.xMin, true);
  dv.setFloat64(44, bb.yMin, true);
  dv.setFloat64(52, bb.xMax, true);
  dv.setFloat64(60, bb.yMax, true);
  const hasZ = shapeType === SHP_TYPE_POINTZ;
  dv.setFloat64(68, hasZ ? bb.zMin : 0, true);
  dv.setFloat64(76, hasZ ? bb.zMax : 0, true);
  dv.setFloat64(84, 0, true); // Mmin - we write no measures
  dv.setFloat64(92, 0, true); // Mmax
  return new Uint8Array(buf);
}

/**
 * Build the .shp and .shx byte arrays for a point layer.
 * A point whose X or Y is not finite is written as a NULL shape (type 0) rather
 * than dropped, so record N of the .shp always lines up with row N of the .dbf.
 * Breaking that 1:1 pairing is the classic way to silently mis-attribute a whole
 * survey, so it is preserved even for garbage input.
 */
export function buildShpShx(points: ShapePoint[], hasZ: boolean): { shp: Uint8Array; shx: Uint8Array } {
  const shapeType = hasZ ? SHP_TYPE_POINTZ : SHP_TYPE_POINT;
  const contentBytes = hasZ ? 36 : 20; // shape type int + 2 or 4 doubles
  const nullContentBytes = 4; // a NULL shape is just its type int
  const bb = bbox(points);

  // Two passes: size the buffers exactly, then fill. Avoids growing arrays over
  // a survey with hundreds of thousands of stations.
  let bodyBytes = 0;
  for (const p of points) {
    const ok = isFiniteNum(p.x) && isFiniteNum(p.y);
    bodyBytes += 8 + (ok ? contentBytes : nullContentBytes);
  }

  const shp = new Uint8Array(100 + bodyBytes);
  const shx = new Uint8Array(100 + points.length * 8);
  const shpDv = new DataView(shp.buffer);
  const shxDv = new DataView(shx.buffer);

  shp.set(shpHeader((100 + bodyBytes) / 2, shapeType, bb), 0);
  shx.set(shpHeader((100 + points.length * 8) / 2, shapeType, bb), 0);

  let off = 100;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const ok = isFiniteNum(p.x) && isFiniteNum(p.y);
    const content = ok ? contentBytes : nullContentBytes;
    // Record header: 1-based record number + content length in 16-bit words, both big-endian.
    shpDv.setInt32(off, i + 1, false);
    shpDv.setInt32(off + 4, content / 2, false);
    // .shx entry: offset of this record's HEADER, in words, plus the same length.
    shxDv.setInt32(100 + i * 8, off / 2, false);
    shxDv.setInt32(100 + i * 8 + 4, content / 2, false);

    const c = off + 8;
    if (!ok) {
      shpDv.setInt32(c, SHP_TYPE_NULL, true);
    } else {
      shpDv.setInt32(c, shapeType, true);
      shpDv.setFloat64(c + 4, p.x, true);
      shpDv.setFloat64(c + 12, p.y, true);
      if (hasZ) {
        shpDv.setFloat64(c + 20, isFiniteNum(p.z) ? p.z : 0, true);
        shpDv.setFloat64(c + 28, SHP_NODATA, true); // measure: none
      }
    }
    off += 8 + content;
  }
  return { shp, shx };
}

/** Clamp a field spec to what dBASE III can actually represent. */
function normaliseField(f: DbfField, name: string): DbfField {
  if (f.type === 'D') return { name, type: 'D', length: 8, decimals: 0 };
  if (f.type === 'N') {
    const length = Math.max(1, Math.min(MAX_DBF_NUM_WIDTH, Math.floor(f.length) || 1));
    // A decimal point plus at least one integer digit must fit alongside the decimals.
    const decimals = Math.max(0, Math.min(f.decimals || 0, Math.max(0, length - 2)));
    return { name, type: 'N', length, decimals };
  }
  return { name, type: 'C', length: Math.max(1, Math.min(MAX_DBF_CHAR_WIDTH, Math.floor(f.length) || 1)), decimals: 0 };
}

/**
 * Build the .dbf attribute table. `rows` shorter than `fields` are padded with
 * blanks; extra values are ignored. Row count is authoritative from `rows`, so
 * callers must pass exactly one row per shape record.
 */
export function buildDbf(fields: DbfField[], rows: DbfValue[][], dateYMD: [number, number, number]): Uint8Array {
  const names = uniqueNames(fields);
  const fs = fields.map((f, i) => normaliseField(f, names[i]));
  const recLen = 1 + fs.reduce((a, f) => a + f.length, 0);
  if (recLen > MAX_DBF_RECORD_BYTES) throw new Error(`DBF record too wide (${recLen} bytes, max ${MAX_DBF_RECORD_BYTES})`);

  const headerLen = 32 + 32 * fs.length + 1;
  const out = new Uint8Array(headerLen + rows.length * recLen + 1);
  const dv = new DataView(out.buffer);

  out[0] = 0x03; // dBASE III without a memo file
  out[1] = Math.max(0, Math.min(255, dateYMD[0] - 1900));
  out[2] = Math.max(1, Math.min(12, dateYMD[1]));
  out[3] = Math.max(1, Math.min(31, dateYMD[2]));
  dv.setUint32(4, rows.length, true);
  dv.setUint16(8, headerLen, true);
  dv.setUint16(10, recLen, true);
  // bytes 12..31 stay zero (reserved / transaction / encryption flags)

  fs.forEach((f, i) => {
    const base = 32 + i * 32;
    const nm = f.name;
    for (let c = 0; c < nm.length && c < MAX_DBF_NAME; c++) out[base + c] = nm.charCodeAt(c) & 0x7f;
    // bytes up to base+10 stay 0 (the name's null terminator / padding)
    out[base + 11] = f.type.charCodeAt(0);
    out[base + 16] = f.length;
    out[base + 17] = f.decimals || 0;
  });
  out[32 + 32 * fs.length] = 0x0d; // field-descriptor terminator

  let off = headerLen;
  for (const row of rows) {
    out[off++] = 0x20; // deletion flag: not deleted
    for (let i = 0; i < fs.length; i++) {
      const cell = dbfCell(row ? row[i] : undefined, fs[i]);
      for (let b = 0; b < fs[i].length; b++) out[off + b] = cell[b];
      off += fs[i].length;
    }
  }
  out[off] = 0x1a; // EOF
  return out;
}

/**
 * Write one complete shapefile set. Returns the byte payloads to hand to the
 * save/ZIP layer, in a stable order (.shp, .shx, .dbf, .prj, .cpg).
 *
 * Throws only on caller error (row/point count mismatch, over-cap layer);
 * malformed individual coordinates degrade to NULL shapes, never an exception.
 */
export function writeShapefile(layer: ShapefileLayer): ShapefileOut[] {
  const points = layer.points || [];
  const rows = layer.rows || [];
  if (points.length > MAX_SHAPE_RECORDS) throw new Error(`Layer "${layer.name}" has ${points.length} points, over the ${MAX_SHAPE_RECORDS} cap.`);
  if (rows.length !== points.length) throw new Error(`Layer "${layer.name}": ${rows.length} attribute rows for ${points.length} points - they must match 1:1.`);

  const base = (layer.name || 'layer').replace(/[^A-Za-z0-9_.-]/g, '_') || 'layer';
  const hasZ = !!layer.hasZ;
  const { shp, shx } = buildShpShx(points, hasZ);
  const dbf = buildDbf(layer.fields || [], rows, layer.dateYMD || DEFAULT_DATE);

  const out: ShapefileOut[] = [
    { name: base + '.shp', bytes: shp },
    { name: base + '.shx', bytes: shx },
    { name: base + '.dbf', bytes: dbf },
  ];
  if (layer.prj && layer.prj.trim()) out.push({ name: base + '.prj', bytes: new Uint8Array(utf8(layer.prj.trim())) });
  out.push({ name: base + '.cpg', bytes: new Uint8Array(utf8(layer.encoding || 'UTF-8')) });
  return out;
}
