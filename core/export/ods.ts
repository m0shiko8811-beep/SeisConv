// seisconv-core / export - minimal OpenDocument Spreadsheet (.ods) writer.
//
// Builds a small but VALID ODF 1.2 flat spreadsheet (mimetype + manifest +
// content.xml with the table) and returns the zipped .ods bytes. No external
// library - hand-rolled XML zipped with JSZip (passed in by the caller).
//
// Cells are emitted as office:value-type="float" (with office:value) for finite
// numbers, else office:value-type="string" with a <text:p> body.
//
// IMPORTANT: ODF requires the "mimetype" entry be stored FIRST and UNCOMPRESSED.
// We add it first with compression disabled; everything else is deflated.
//
// Pure: no DOM / Electron. Reuses the ZipLike + SheetTable contracts from xlsx.ts
// so a single table shape feeds both writers.

import type { SheetTable } from './xlsx';

/** JSZip-like surface for ODS: per-file compression options + Uint8Array output. */
export interface OdsZipLike {
  file(name: string, data: string, opts?: { compression?: 'STORE' | 'DEFLATE' }): unknown;
  generateAsync(opts: { type: 'uint8array' }): Promise<Uint8Array>;
}

/** XML-escape text for an element body or attribute value. */
function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** True for a finite JS number → an ODF float cell. */
function isNumericCell(v: string | number): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** Sanitize a table name for the table:name attribute. */
function tableName(name: string): string {
  return (name || 'Sheet').replace(/[\\/?*[\]:]/g, ' ').trim() || 'Sheet';
}

/** One <table:table-cell> - float (with office:value) or string (text:p body). */
function cellXml(v: string | number): string {
  if (isNumericCell(v)) {
    return `<table:table-cell office:value-type="float" office:value="${v}"><text:p>${xmlEscape(String(v))}</text:p></table:table-cell>`;
  }
  const text = v == null ? '' : String(v);
  if (text === '') return '<table:table-cell/>';
  return `<table:table-cell office:value-type="string"><text:p>${xmlEscape(text)}</text:p></table:table-cell>`;
}

/** One <table:table-row> from a list of cell values. */
function rowXml(cells: (string | number)[]): string {
  return `<table:table-row>${cells.map(cellXml).join('')}</table:table-row>`;
}

/** Build the <table:table> body for one sheet (header row + data rows). */
function tableXml(table: SheetTable): string {
  const rows: string[] = [];
  rows.push(rowXml(table.header));
  for (const r of table.rows) rows.push(rowXml(r));
  return `<table:table table:name="${xmlEscape(tableName(table.name))}">${rows.join('')}</table:table>`;
}

/** The ODF content.xml document wrapping all tables. */
function contentXml(tables: SheetTable[]): string {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<office:document-content ' +
    'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" ' +
    'xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" ' +
    'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" ' +
    'office:version="1.2">' +
    '<office:body><office:spreadsheet>' +
    tables.map(tableXml).join('') +
    '</office:spreadsheet></office:body>' +
    '</office:document-content>'
  );
}

/** META-INF/manifest.xml - declares the package contents for an ODS. */
function manifestXml(): string {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2">' +
    '<manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.spreadsheet"/>' +
    '<manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>' +
    '</manifest:manifest>'
  );
}

/**
 * Build a minimal valid .ods from one or more table sheets and return the zipped
 * bytes. `zip` is a fresh JSZip-like instance supplied by the caller; the
 * mimetype part is stored uncompressed and first, per the ODF spec.
 */
export async function buildOds(tables: SheetTable[], zip: OdsZipLike): Promise<Uint8Array> {
  const sheets = tables.length ? tables : [{ name: 'Sheet1', header: [], rows: [] }];
  // mimetype MUST be the first entry and stored uncompressed.
  zip.file('mimetype', 'application/vnd.oasis.opendocument.spreadsheet', { compression: 'STORE' });
  zip.file('META-INF/manifest.xml', manifestXml());
  zip.file('content.xml', contentXml(sheets));
  return zip.generateAsync({ type: 'uint8array' });
}
