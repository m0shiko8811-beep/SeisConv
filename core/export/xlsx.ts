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
  file(name: string, data: string): unknown;
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
