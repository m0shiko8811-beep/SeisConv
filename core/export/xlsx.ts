// seisconv-core / export - minimal OOXML (.xlsx) spreadsheet writer.
//
// Builds a small but VALID Office Open XML SpreadsheetML workbook from a plain
// table (header row + data rows) and returns the zipped .xlsx bytes. No external
// spreadsheet library - just hand-rolled XML zipped with JSZip (already a dep).
//
// Cells are emitted as either number cells (t omitted, <v>) or inline-string
// cells (t="inlineStr", <is><t>), so there is no shared-strings table to manage.
// Optionally a second "Project" sheet carries the project-header key/value pairs.
//
// Pure: no DOM / Electron. The caller passes its own JSZip instance so this core
// module stays free of a hard dependency on the zipper's typings.

/** Anything JSZip-like: enough surface to add files and emit a Uint8Array. */
export interface ZipLike {
  file(name: string, data: string | Uint8Array): unknown;
  generateAsync(opts: { type: 'uint8array' }): Promise<Uint8Array>;
}

/** A single table sheet: a tab name, a header row, and the data rows. */
export interface SheetTable {
  /** Worksheet tab name (sanitized to Excel's 31-char / illegal-char rules). */
  name: string;
  /** Column header labels (becomes worksheet row 1, all inline strings). */
  header: string[];
  /** Data rows; each cell is a string (→ inlineStr) or number (→ numeric cell). */
  rows: (string | number)[][];
}

/** XML-escape text for use inside an element body (<t>…</t>) or an attribute. */
function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Sanitize a worksheet name: strip the chars Excel forbids and cap at 31 chars. */
function sheetName(name: string): string {
  const cleaned = (name || 'Sheet').replace(/[\\/?*[\]:]/g, ' ').trim() || 'Sheet';
  return cleaned.slice(0, 31);
}

/** Column letter for a 0-based column index (0→A, 26→AA, …). */
export function colLetter(idx: number): string {
  let n = idx + 1;
  let s = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** True for a finite JS number that should render as an Excel numeric cell. */
function isNumericCell(v: string | number): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** Build one <c> cell at (col, row1) - numeric or inline string. */
function cellXml(col: number, row1: number, v: string | number): string {
  const ref = `${colLetter(col)}${row1}`;
  if (isNumericCell(v)) return `<c r="${ref}"><v>${v}</v></c>`;
  const text = v == null ? '' : String(v);
  // preserve leading/trailing whitespace so padded field values survive a round-trip
  return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(text)}</t></is></c>`;
}

/** Build the <worksheet> XML for one table (header row + data rows). */
function sheetXml(table: SheetTable): string {
  const lines: string[] = [];
  // Header is worksheet row 1.
  let row1 = 1;
  const headerCells = table.header.map((h, c) => cellXml(c, row1, h)).join('');
  lines.push(`<row r="${row1}">${headerCells}</row>`);
  // Data rows follow.
  for (const row of table.rows) {
    row1++;
    const cells = row.map((v, c) => cellXml(c, row1, v)).join('');
    lines.push(`<row r="${row1}">${cells}</row>`);
  }
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<sheetData>' +
    lines.join('') +
    '</sheetData>' +
    '</worksheet>'
  );
}

/** [Content_Types].xml - declares the parts present in the package. */
function contentTypesXml(sheetCount: number): string {
  const overrides: string[] = [];
  overrides.push('<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>');
  for (let i = 1; i <= sheetCount; i++) {
    overrides.push(`<Override PartName="/xl/worksheets/sheet${i}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`);
  }
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    overrides.join('') +
    '</Types>'
  );
}

/** Package root _rels/.rels - points at the workbook part. */
function rootRelsXml(): string {
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
    '</Relationships>'
  );
}

/** xl/workbook.xml - lists each sheet with a name + r:id. */
function workbookXml(tables: SheetTable[]): string {
  const sheets = tables
    .map((t, i) => `<sheet name="${xmlEscape(sheetName(t.name))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
    .join('');
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    `<sheets>${sheets}</sheets>` +
    '</workbook>'
  );
}

/** xl/_rels/workbook.xml.rels - maps each rId to its worksheet part. */
function workbookRelsXml(sheetCount: number): string {
  const rels: string[] = [];
  for (let i = 1; i <= sheetCount; i++) {
    rels.push(`<Relationship Id="rId${i}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i}.xml"/>`);
  }
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    rels.join('') +
    '</Relationships>'
  );
}

/**
 * Build a minimal valid .xlsx from one or more table sheets and return the
 * zipped bytes. `zip` is a fresh JSZip-like instance supplied by the caller.
 */
export async function buildXlsx(tables: SheetTable[], zip: ZipLike): Promise<Uint8Array> {
  const sheets = tables.length ? tables : [{ name: 'Sheet1', header: [], rows: [] }];
  zip.file('[Content_Types].xml', contentTypesXml(sheets.length));
  zip.file('_rels/.rels', rootRelsXml());
  zip.file('xl/workbook.xml', workbookXml(sheets));
  zip.file('xl/_rels/workbook.xml.rels', workbookRelsXml(sheets.length));
  sheets.forEach((t, i) => zip.file(`xl/worksheets/sheet${i + 1}.xml`, sheetXml(t)));
  return zip.generateAsync({ type: 'uint8array' });
}

// ---------------------------------------------------------------------------
// Styled workbook (Parameters Sheet)
//
// A second, separate entry point. buildXlsx above is left byte-for-byte as it
// was (the observer-log export depends on it); everything below is additive:
// column widths, merged ranges, bold / filled / bordered cells, number formats,
// a frozen header, print setup and ONE embedded PNG per sheet via a drawing part.
// ---------------------------------------------------------------------------

/** Visual style of one cell. Colours are 6-digit RGB hex ("1F4E79"). */
export interface CellStyle {
  bold?: boolean;
  italic?: boolean;
  /** Font size in points (default 11). */
  size?: number;
  color?: string;
  fill?: string;
  border?: boolean;
  /** Excel number format code, e.g. "0", "0.00", "yyyy-mm-dd". */
  numFmt?: string;
  wrap?: boolean;
  align?: 'left' | 'center' | 'right';
}
export type StyledValue = string | number | null | undefined;
export interface StyledCell { v: StyledValue; s?: CellStyle }
export type StyledCellLike = StyledValue | StyledCell;

export interface StyledImage {
  /** Encoded picture bytes, PNG or JPEG (see `format`). */
  data: Uint8Array;
  /** Default 'png'. A photo basemap is far smaller as JPEG. */
  format?: 'png' | 'jpeg';
  /** Pixel size of the PNG (aspect ratio of the placed picture). */
  widthPx: number;
  heightPx: number;
  /** Displayed width in screen pixels (96 dpi); height follows the aspect. */
  displayWidthPx?: number;
  /** Offset of the picture inside its anchor cell, screen pixels. */
  offsetXPx?: number;
  offsetYPx?: number;
  /** 0-based anchor cell. */
  col: number;
  row: number;
  name?: string;
}

export interface StyledSheet {
  name: string;
  /** Row-major from A1; null / undefined / '' cells are left empty. */
  rows: StyledCellLike[][];
  /** Column widths in characters, from column A. */
  cols?: number[];
  /** Merged ranges in A1 form ("A1:I1"). */
  merges?: string[];
  /** Rows frozen at the top (0 = none). */
  freezeRows?: number;
  /** Row heights in points, keyed by 0-based row index. */
  rowHeights?: Record<number, number>;
  image?: StyledImage;
  /** Further pictures on the same sheet (one drawing part holds them all). */
  images?: StyledImage[];
  landscape?: boolean;
  /** Fit the printout to one page wide. */
  fitWidth?: boolean;
  /** Fit the printout to ONE page (wide and tall); implies fitWidth. */
  fitPage?: boolean;
  /** Set the print area to the used range (A1 to the last used cell). */
  printArea?: boolean;
  /** Printed footer, in Excel header/footer codes (&L left, &R right, &P page). */
  footer?: string;
  /** Hide the on-screen gridlines (a form-like sheet). */
  hideGrid?: boolean;
}

/** Excel's limit for one cell's text. */
export const XLSX_MAX_CELL_TEXT = 32767;

/** Remove characters XML 1.0 cannot carry and cap at Excel's cell limit. */
export function xlsxCleanText(s: string): string {
  // eslint-disable-next-line no-control-regex
  return String(s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '').slice(0, XLSX_MAX_CELL_TEXT);
}

const BUILTIN_NUMFMT: Record<string, number> = { General: 0, '0': 1, '0.00': 2, '#,##0': 3, '#,##0.00': 4, '0%': 9, '@': 49 };
const hex6 = (c: string | undefined): string | undefined => (c && /^[0-9A-Fa-f]{6}$/.test(c) ? c.toUpperCase() : undefined);

/** Collects unique fonts / fills / borders / formats / xfs as cells ask for them. */
class StyleBook {
  fonts: string[] = ['<font><sz val="11"/><name val="Calibri"/><family val="2"/></font>'];
  fills: string[] = ['<fill><patternFill patternType="none"/></fill>', '<fill><patternFill patternType="gray125"/></fill>'];
  borders: string[] = ['<border><left/><right/><top/><bottom/><diagonal/></border>'];
  numFmts: { id: number; code: string }[] = [];
  xfs: string[] = ['<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'];
  private xfIndex = new Map<string, number>();

  private idx(list: string[], xml: string): number {
    const i = list.indexOf(xml);
    if (i >= 0) return i;
    list.push(xml);
    return list.length - 1;
  }

  /** The cellXfs index for a style (0 = default). */
  xf(s: CellStyle | undefined): number {
    if (!s) return 0;
    const key = JSON.stringify([s.bold, s.italic, s.size, hex6(s.color), hex6(s.fill), s.border, s.numFmt, s.wrap, s.align]);
    const hit = this.xfIndex.get(key);
    if (hit != null) return hit;
    const size = typeof s.size === 'number' && Number.isFinite(s.size) && s.size >= 6 && s.size <= 48 ? s.size : 11;
    const color = hex6(s.color);
    const font = `<font>${s.bold ? '<b/>' : ''}${s.italic ? '<i/>' : ''}<sz val="${size}"/>${color ? `<color rgb="FF${color}"/>` : ''}<name val="Calibri"/><family val="2"/></font>`;
    const fontId = this.idx(this.fonts, font);
    const fill = hex6(s.fill);
    const fillId = fill ? this.idx(this.fills, `<fill><patternFill patternType="solid"><fgColor rgb="FF${fill}"/><bgColor indexed="64"/></patternFill></fill>`) : 0;
    const side = (n: string) => `<${n} style="thin"><color rgb="FFBFBFBF"/></${n}>`;
    const borderId = s.border ? this.idx(this.borders, `<border>${side('left')}${side('right')}${side('top')}${side('bottom')}<diagonal/></border>`) : 0;
    let numFmtId = 0;
    if (s.numFmt) {
      if (s.numFmt in BUILTIN_NUMFMT) numFmtId = BUILTIN_NUMFMT[s.numFmt];
      else {
        const code = s.numFmt.slice(0, 60);
        const have = this.numFmts.find((f) => f.code === code);
        if (have) numFmtId = have.id;
        else { numFmtId = 164 + this.numFmts.length; this.numFmts.push({ id: numFmtId, code }); }
      }
    }
    const align = s.wrap || s.align
      ? `<alignment${s.align ? ` horizontal="${s.align}"` : ''} vertical="center"${s.wrap ? ' wrapText="1"' : ''}/>`
      : '';
    const xf = `<xf numFmtId="${numFmtId}" fontId="${fontId}" fillId="${fillId}" borderId="${borderId}" xfId="0"`
      + `${numFmtId ? ' applyNumberFormat="1"' : ''}${fontId ? ' applyFont="1"' : ''}${fillId ? ' applyFill="1"' : ''}${borderId ? ' applyBorder="1"' : ''}`
      + (align ? ` applyAlignment="1">${align}</xf>` : '/>');
    this.xfs.push(xf);
    const id = this.xfs.length - 1;
    this.xfIndex.set(key, id);
    return id;
  }

  xml(): string {
    const nf = this.numFmts.length
      ? `<numFmts count="${this.numFmts.length}">${this.numFmts.map((f) => `<numFmt numFmtId="${f.id}" formatCode="${xmlEscape(f.code)}"/>`).join('')}</numFmts>`
      : '';
    return (
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      nf +
      `<fonts count="${this.fonts.length}">${this.fonts.join('')}</fonts>` +
      `<fills count="${this.fills.length}">${this.fills.join('')}</fills>` +
      `<borders count="${this.borders.length}">${this.borders.join('')}</borders>` +
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      `<cellXfs count="${this.xfs.length}">${this.xfs.join('')}</cellXfs>` +
      '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
      '</styleSheet>'
    );
  }
}

const A1_RANGE = /^[A-Z]{1,3}[1-9]\d{0,6}(:[A-Z]{1,3}[1-9]\d{0,6})?$/;

function styledCellXml(col: number, row1: number, c: StyledCellLike, book: StyleBook): string {
  const cell: StyledCell = c != null && typeof c === 'object' ? c : { v: c as StyledValue };
  const s = book.xf(cell.s);
  const sa = s ? ` s="${s}"` : '';
  const ref = `${colLetter(col)}${row1}`;
  const v = cell.v;
  if (typeof v === 'number' && Number.isFinite(v)) return `<c r="${ref}"${sa}><v>${v}</v></c>`;
  const text = v == null || typeof v === 'number' ? '' : xlsxCleanText(v);
  if (!text) return s ? `<c r="${ref}"${sa}/>` : '';
  return `<c r="${ref}"${sa} t="inlineStr"><is><t xml:space="preserve">${xmlEscape(text)}</t></is></c>`;
}

function styledSheetXml(t: StyledSheet, book: StyleBook, first: boolean, drawingRid: string | null): string {
  const rows = t.rows.slice(0, 100000);
  let maxCol = 0;
  for (const r of rows) maxCol = Math.max(maxCol, r.length);
  const parts: string[] = [];
  if (t.fitWidth || t.fitPage) parts.push('<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>');
  parts.push(`<dimension ref="A1:${colLetter(Math.max(0, maxCol - 1))}${Math.max(1, rows.length)}"/>`);
  const fr = Math.max(0, Math.min(1000, Math.floor(t.freezeRows || 0)));
  const pane = fr > 0 ? `<pane ySplit="${fr}" topLeftCell="A${fr + 1}" activePane="bottomLeft" state="frozen"/>` : '';
  parts.push(`<sheetViews><sheetView${t.hideGrid ? ' showGridLines="0"' : ''}${first ? ' tabSelected="1"' : ''} workbookViewId="0">${pane}</sheetView></sheetViews>`);
  parts.push('<sheetFormatPr defaultRowHeight="15"/>');
  const widths = (t.cols || []).slice(0, 200);
  if (widths.length) {
    parts.push('<cols>' + widths.map((w, i) => {
      const ww = Number.isFinite(w) && w > 0 ? Math.min(255, w) : 9;
      return `<col min="${i + 1}" max="${i + 1}" width="${ww}" customWidth="1"/>`;
    }).join('') + '</cols>');
  }
  const body: string[] = [];
  rows.forEach((r, ri) => {
    const cells = r.slice(0, 16384).map((c, ci) => styledCellXml(ci, ri + 1, c, book)).join('');
    const h = t.rowHeights?.[ri];
    const ht = typeof h === 'number' && Number.isFinite(h) && h > 0 && h <= 409 ? ` ht="${h}" customHeight="1"` : '';
    if (cells || ht) body.push(`<row r="${ri + 1}"${ht}>${cells}</row>`);
  });
  parts.push(`<sheetData>${body.join('')}</sheetData>`);
  const merges = (t.merges || []).filter((m) => A1_RANGE.test(m)).slice(0, 1000);
  if (merges.length) parts.push(`<mergeCells count="${merges.length}">${merges.map((m) => `<mergeCell ref="${m}"/>`).join('')}</mergeCells>`);
  parts.push('<pageMargins left="0.5" right="0.5" top="0.6" bottom="0.6" header="0.3" footer="0.3"/>');
  const fit = t.fitPage ? ' fitToWidth="1" fitToHeight="1"' : t.fitWidth ? ' fitToWidth="1" fitToHeight="0"' : '';
  parts.push(`<pageSetup paperSize="9" orientation="${t.landscape ? 'landscape' : 'portrait'}"${fit}/>`);
  if (t.footer) parts.push(`<headerFooter><oddFooter>${xmlEscape(xlsxCleanText(t.footer).slice(0, 250))}</oddFooter></headerFooter>`);
  if (drawingRid) parts.push(`<drawing r:id="${drawingRid}"/>`);
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    parts.join('') +
    '</worksheet>'
  );
}

/** EMU per screen pixel at 96 dpi. */
const EMU_PER_PX = 9525;

const PX_EMU = (px: number) => Math.round(Math.max(0, Math.min(10000, Number.isFinite(px) ? px : 0)) * EMU_PER_PX);

/** One <xdr:oneCellAnchor> picture; `n` is its 1-based index in the drawing
 *  (shape id n + 1, relationship rId<n>). */
function anchorXml(img: StyledImage, n: number): string {
  const w = Math.max(1, Math.round(img.widthPx)), h = Math.max(1, Math.round(img.heightPx));
  const dw = img.displayWidthPx && img.displayWidthPx > 0 ? img.displayWidthPx : w;
  const cx = Math.round(dw * EMU_PER_PX);
  const cy = Math.round(((dw * h) / w) * EMU_PER_PX);
  const col = Math.max(0, Math.floor(img.col)), row = Math.max(0, Math.floor(img.row));
  return (
    '<xdr:oneCellAnchor>' +
    `<xdr:from><xdr:col>${col}</xdr:col><xdr:colOff>${PX_EMU(img.offsetXPx ?? 0)}</xdr:colOff><xdr:row>${row}</xdr:row><xdr:rowOff>${PX_EMU(img.offsetYPx ?? 0)}</xdr:rowOff></xdr:from>` +
    `<xdr:ext cx="${cx}" cy="${cy}"/>` +
    '<xdr:pic>' +
    `<xdr:nvPicPr><xdr:cNvPr id="${n + 1}" name="${xmlEscape(xlsxCleanText(img.name || `Picture ${n}`).slice(0, 60))}"/><xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr>` +
    `<xdr:blipFill><a:blip xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:embed="rId${n}"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill>` +
    `<xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr>` +
    '</xdr:pic>' +
    '<xdr:clientData/>' +
    '</xdr:oneCellAnchor>'
  );
}

function drawingXml(imgs: StyledImage[]): string {
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" ' +
    'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">' +
    imgs.map((im, k) => anchorXml(im, k + 1)).join('') +
    '</xdr:wsDr>'
  );
}

const REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const relsXml = (rels: string[]) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${REL_NS}">${rels.join('')}</Relationships>`;

/** True for bytes that start with the JPEG SOI marker. */
export function isJpeg(b: Uint8Array): boolean {
  return b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
}

/** The used range of a sheet as an absolute A1 reference, for a print area. */
function usedRangeRef(t: StyledSheet): string {
  let maxCol = 0;
  for (const r of t.rows) maxCol = Math.max(maxCol, r.length);
  const rows = Math.max(1, Math.min(t.rows.length, 100000));
  return `$A$1:$${colLetter(Math.max(0, maxCol - 1))}$${rows}`;
}

/** <definedNames> with one _xlnm.Print_Area per sheet that asks for it. */
function printAreas(sheets: StyledSheet[], names: string[]): string {
  const defs = sheets
    .map((s, i) => (s.printArea ? `<definedName name="_xlnm.Print_Area" localSheetId="${i}">'${xmlEscape(names[i].replace(/'/g, "''"))}'!${usedRangeRef(s)}</definedName>` : ''))
    .filter(Boolean);
  return defs.length ? `<definedNames>${defs.join('')}</definedNames>` : '';
}

/** True for bytes that start with the PNG signature. */
export function isPng(b: Uint8Array): boolean {
  return b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a;
}

/**
 * Build a styled .xlsx (widths, merges, styles, number formats, frozen rows,
 * print setup, one PNG per sheet) and return the zipped bytes. Sheet names are
 * sanitized and made unique; an image that is not a PNG is left out.
 */
export async function buildStyledXlsx(sheetsIn: StyledSheet[], zip: ZipLike): Promise<Uint8Array> {
  const sheets = (sheetsIn.length ? sheetsIn : [{ name: 'Sheet1', rows: [] } as StyledSheet]).slice(0, 50);
  const book = new StyleBook();
  const used = new Set<string>();
  const names = sheets.map((s, i) => {
    let n = sheetName(s.name);
    while (used.has(n.toLowerCase())) n = sheetName(`${n.slice(0, 27)} ${i + 1}`);
    used.add(n.toLowerCase());
    return n;
  });
  let drawings = 0;
  let media = 0;
  let hasPng = false, hasJpeg = false;
  const sheetXmls: string[] = [];
  const valid = (im: StyledImage | undefined): im is StyledImage =>
    !!im && im.data instanceof Uint8Array && (im.format === 'jpeg' ? isJpeg(im.data) : isPng(im.data));
  sheets.forEach((s, i) => {
    // Every valid picture of the sheet goes into ONE drawing part; each gets its
    // own media file (numbered across the workbook), shape id and rId.
    const imgs = [s.image, ...(s.images ?? [])].filter(valid).slice(0, 20);
    let rid: string | null = null;
    if (imgs.length) {
      drawings++;
      rid = 'rId1';
      const picRels: string[] = [];
      imgs.forEach((img, k) => {
        const ext = img.format === 'jpeg' ? 'jpeg' : 'png';
        if (ext === 'jpeg') hasJpeg = true; else hasPng = true;
        media++;
        zip.file(`xl/media/image${media}.${ext}`, img.data);
        picRels.push(`<Relationship Id="rId${k + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image${media}.${ext}"/>`);
      });
      zip.file(`xl/drawings/drawing${drawings}.xml`, drawingXml(imgs));
      zip.file(`xl/drawings/_rels/drawing${drawings}.xml.rels`, relsXml(picRels));
      zip.file(`xl/worksheets/_rels/sheet${i + 1}.xml.rels`, relsXml([
        `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing${drawings}.xml"/>`,
      ]));
    }
    sheetXmls.push(styledSheetXml(s, book, i === 0, rid));
  });

  const overrides: string[] = [
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>',
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>',
  ];
  for (let i = 1; i <= sheets.length; i++) overrides.push(`<Override PartName="/xl/worksheets/sheet${i}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`);
  for (let d = 1; d <= drawings; d++) overrides.push(`<Override PartName="/xl/drawings/drawing${d}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>`);
  zip.file('[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    (hasPng ? '<Default Extension="png" ContentType="image/png"/>' : '') +
    (hasJpeg ? '<Default Extension="jpeg" ContentType="image/jpeg"/>' : '') +
    overrides.join('') +
    '</Types>');
  zip.file('_rels/.rels', rootRelsXml());
  zip.file('xl/workbook.xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    '<bookViews><workbookView activeTab="0"/></bookViews>' +
    `<sheets>${names.map((n, i) => `<sheet name="${xmlEscape(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>` +
    printAreas(sheets, names) +
    '</workbook>');
  const wbRels: string[] = [];
  for (let i = 1; i <= sheets.length; i++) wbRels.push(`<Relationship Id="rId${i}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i}.xml"/>`);
  wbRels.push(`<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`);
  zip.file('xl/_rels/workbook.xml.rels', relsXml(wbRels));
  // Styles last: the sheets above registered every style they use.
  sheetXmls.forEach((x, i) => zip.file(`xl/worksheets/sheet${i + 1}.xml`, x));
  zip.file('xl/styles.xml', book.xml());
  return zip.generateAsync({ type: 'uint8array' });
}
