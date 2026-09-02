// seisconv-core / gis - GeoTIFF writer.
//
// Writes a baseline, uncompressed, strip-organised TIFF carrying the GeoTIFF
// tags that make it georeferenced:
//   33550 ModelPixelScale   pixel size in CRS units
//   33922 ModelTiepoint     ties raster (0,0) to a CRS coordinate
//   34735 GeoKeyDirectory   the CRS itself (EPSG code, or user-defined + WKT)
//   34737 GeoAsciiParams    citation text / WKT for a user-defined CRS
//   42113 GDAL_NODATA       the nodata value, as ASCII (GDAL's convention)
//
// Two shapes are supported, which is all a survey needs:
//   - single-band Float32, for measured/derived surfaces (fold, elevation)
//   - 3-band uint8 RGB, for rendered imagery (survey layout, basemap mosaic)
//
// Everything is little-endian ('II'), which every reader handles, and IFD
// entries are emitted in ascending tag order as the TIFF spec requires - a
// reader is allowed to reject an out-of-order IFD, and some do.
//
// Pure - no DOM, no Node, no Date.

/** Row order: a GeoTIFF's first row is the NORTH edge (north-up), which is the
 *  opposite of how a bottom-left-origin grid such as the fold map is indexed. */
export const GEOTIFF_NODATA = -9999;

/** Hard cap on output pixels. At 4 bytes/px a 20 000 x 20 000 float raster is
 *  1.6 GB; refusing early beats allocating it and dying. */
export const MAX_GEOTIFF_PIXELS = 120_000_000;

export interface GeoTiffCRS {
  /** EPSG code, when known. The cleanest possible georeference. */
  epsg?: number;
  /** True for a geographic (lat/lon) CRS, false/absent for projected. */
  geographic?: boolean;
  /** WKT, used when there is no EPSG code (written as a user-defined citation). */
  wkt?: string;
  /** Human-readable name for the citation key. */
  name?: string;
}

export interface GeoTiffOptions {
  width: number;
  height: number;
  /** West edge / North edge of the raster, in CRS units (pixel-is-area). */
  originX: number;
  originY: number;
  /** Pixel size in CRS units. Both positive; north-up is implied. */
  pixelSizeX: number;
  pixelSizeY: number;
  crs?: GeoTiffCRS;
  /** Single-band data, row 0 = NORTH row, length width*height. */
  band?: Float32Array;
  /** Interleaved RGB, row 0 = NORTH row, length width*height*3. */
  rgb?: Uint8Array;
  /** Value meaning "no data" in `band`. Written as GDAL_NODATA. */
  nodata?: number;
  /** Free-text description, written as ImageDescription. */
  description?: string;
}

// -- TIFF field types --
const T_BYTE = 1, T_ASCII = 2, T_SHORT = 3, T_LONG = 4, T_DOUBLE = 12;

interface Entry {
  tag: number;
  type: number;
  count: number;
  /** Inline value (fits in 4 bytes) or bytes to place in the trailing blob. */
  inline?: number;
  data?: Uint8Array;
}

function u8(...v: number[]): Uint8Array {
  return Uint8Array.from(v);
}

function shortArray(vals: number[]): Uint8Array {
  const b = new Uint8Array(vals.length * 2);
  const dv = new DataView(b.buffer);
  vals.forEach((v, i) => dv.setUint16(i * 2, v & 0xffff, true));
  return b;
}

function longArray(vals: number[]): Uint8Array {
  const b = new Uint8Array(vals.length * 4);
  const dv = new DataView(b.buffer);
  vals.forEach((v, i) => dv.setUint32(i * 4, v >>> 0, true));
  return b;
}

function doubleArray(vals: number[]): Uint8Array {
  const b = new Uint8Array(vals.length * 8);
  const dv = new DataView(b.buffer);
  vals.forEach((v, i) => dv.setFloat64(i * 8, v, true));
  return b;
}

/** NUL-terminated ASCII, as TIFF requires for type 2. */
function asciiBytes(s: string): Uint8Array {
  const clean = (s || '').replace(/[^\x20-\x7E]/g, ' ');
  const b = new Uint8Array(clean.length + 1);
  for (let i = 0; i < clean.length; i++) b[i] = clean.charCodeAt(i) & 0x7f;
  b[clean.length] = 0;
  return b;
}

/**
 * Build the GeoKeyDirectory (tag 34735) plus its ASCII side table (34737).
 *
 * A known EPSG code is written straight into ProjectedCSTypeGeoKey /
 * GeographicTypeGeoKey, which is unambiguous and what every reader prefers.
 * Without one we mark the CRS user-defined (32767) and put the WKT in the
 * citation - readable by GDAL/QGIS, and honest that the code is unknown, rather
 * than inventing a nearby EPSG code that would silently mislabel the raster.
 */
function geoKeys(crs?: GeoTiffCRS): { dir: number[]; ascii: string } {
  const keys: [number, number, number, number][] = []; // keyID, tagLoc, count, value
  const geographic = !!crs?.geographic;
  let ascii = '';

  // 1024 GTModelType: 1 = projected, 2 = geographic.
  keys.push([1024, 0, 1, geographic ? 2 : 1]);
  // 1025 GTRasterType: 1 = PixelIsArea (our origin is the outer corner).
  keys.push([1025, 0, 1, 1]);

  const cite = (crs?.name || '') + (crs?.epsg ? '' : crs?.wkt ? (crs?.name ? ' | ' : '') + crs.wkt : '');
  if (cite) {
    // GTCitationGeoKey (1026) points into the ASCII blob; TIFF ASCII keys use
    // '|' as the terminator inside GeoAsciiParams.
    keys.push([1026, 34737, cite.length + 1, ascii.length]);
    ascii += cite + '|';
  }

  if (crs?.epsg && Number.isFinite(crs.epsg)) {
    keys.push(geographic ? [2048, 0, 1, crs.epsg] : [3072, 0, 1, crs.epsg]);
  } else {
    keys.push(geographic ? [2048, 0, 1, 32767] : [3072, 0, 1, 32767]); // user-defined
  }

  keys.sort((a, b) => a[0] - b[0]); // GeoTIFF requires ascending key ids
  const dir: number[] = [1, 1, 0, keys.length]; // version, revision, minor, count
  for (const k of keys) dir.push(k[0], k[1], k[2], k[3]);
  return { dir, ascii };
}

/**
 * Serialise a georeferenced raster to GeoTIFF bytes.
 *
 * Throws on a caller error (no band, wrong array length, over the pixel cap);
 * it never silently truncates, because a half-written raster still opens in GIS
 * and would be trusted.
 */
export function writeGeoTIFF(opts: GeoTiffOptions): Uint8Array {
  const width = Math.floor(opts.width);
  const height = Math.floor(opts.height);
  if (!(width > 0 && height > 0)) throw new Error(`GeoTIFF needs a positive size, got ${opts.width}x${opts.height}`);
  if (width * height > MAX_GEOTIFF_PIXELS) {
    throw new Error(`GeoTIFF would be ${width}x${height} = ${(width * height / 1e6).toFixed(1)} Mpx, over the ${(MAX_GEOTIFF_PIXELS / 1e6).toFixed(0)} Mpx cap. Use a coarser resolution.`);
  }
  const isRGB = !!opts.rgb;
  if (!isRGB && !opts.band) throw new Error('GeoTIFF needs either `band` (Float32) or `rgb` (Uint8)');
  const samples = isRGB ? 3 : 1;
  const bytesPerSample = isRGB ? 1 : 4;
  const expect = width * height * samples;
  const got = isRGB ? opts.rgb!.length : opts.band!.length;
  if (got !== expect) throw new Error(`GeoTIFF pixel data is ${got} values, expected ${expect} for ${width}x${height}x${samples}`);

  // Pixel payload, one strip per RowsPerStrip block. Strips keep peak memory and
  // reader buffers sane on a large raster; one giant strip is legal but hostile.
  const rowBytes = width * samples * bytesPerSample;
  const targetStripBytes = 1 << 20; // ~1 MB per strip
  const rowsPerStrip = Math.max(1, Math.min(height, Math.floor(targetStripBytes / Math.max(1, rowBytes)) || 1));
  const numStrips = Math.ceil(height / rowsPerStrip);

  const pixelBytes = new Uint8Array(rowBytes * height);
  if (isRGB) {
    pixelBytes.set(opts.rgb!);
  } else {
    const dv = new DataView(pixelBytes.buffer);
    const b = opts.band!;
    for (let i = 0; i < b.length; i++) dv.setFloat32(i * 4, b[i], true);
  }

  const { dir, ascii } = geoKeys(opts.crs);

  // Strip offsets are only known once the layout is fixed, so they are patched
  // after the header/IFD sizes are computed (below).
  const stripByteCounts: number[] = [];
  for (let s = 0; s < numStrips; s++) {
    const rows = Math.min(rowsPerStrip, height - s * rowsPerStrip);
    stripByteCounts.push(rows * rowBytes);
  }

  const entries: Entry[] = [];
  const add = (tag: number, type: number, count: number, value: number | Uint8Array) => {
    if (value instanceof Uint8Array) entries.push({ tag, type, count, data: value });
    else entries.push({ tag, type, count, inline: value });
  };

  add(256, T_LONG, 1, width);                                    // ImageWidth
  add(257, T_LONG, 1, height);                                   // ImageLength
  add(258, T_SHORT, samples, isRGB ? shortArray([8, 8, 8]) : shortArray([32])); // BitsPerSample
  add(259, T_SHORT, 1, 1);                                       // Compression: none
  add(262, T_SHORT, 1, isRGB ? 2 : 1);                           // Photometric: RGB / BlackIsZero
  if (opts.description) add(270, T_ASCII, asciiBytes(opts.description).length, asciiBytes(opts.description)); // ImageDescription
  add(273, T_LONG, numStrips, longArray(new Array(numStrips).fill(0))); // StripOffsets (patched)
  add(277, T_SHORT, 1, samples);                                 // SamplesPerPixel
  add(278, T_LONG, 1, rowsPerStrip);                             // RowsPerStrip
  add(279, T_LONG, numStrips, longArray(stripByteCounts));       // StripByteCounts
  add(284, T_SHORT, 1, 1);                                       // PlanarConfiguration: chunky
  add(339, T_SHORT, samples, isRGB ? shortArray([1, 1, 1]) : shortArray([3])); // SampleFormat: uint / IEEE float
  add(33550, T_DOUBLE, 3, doubleArray([opts.pixelSizeX, opts.pixelSizeY, 0]));  // ModelPixelScale
  // ModelTiepoint: raster (0,0,0) -> CRS (originX, originY, 0). With
  // PixelIsArea, that is the OUTER corner of the top-left pixel.
  add(33922, T_DOUBLE, 6, doubleArray([0, 0, 0, opts.originX, opts.originY, 0]));
  add(34735, T_SHORT, dir.length, shortArray(dir));              // GeoKeyDirectory
  if (ascii) add(34737, T_ASCII, ascii.length, asciiBytes(ascii).subarray(0, ascii.length)); // GeoAsciiParams
  if (!isRGB) {
    const nd = asciiBytes(String(opts.nodata ?? GEOTIFF_NODATA));
    add(42113, T_ASCII, nd.length, nd);                          // GDAL_NODATA
  }

  entries.sort((a, b) => a.tag - b.tag); // TIFF requires ascending tag order

  // -- Layout: header | IFD | out-of-line entry values | pixel strips --
  const headerSize = 8;
  const ifdSize = 2 + entries.length * 12 + 4;
  let blobSize = 0;
  for (const e of entries) {
    if (e.data && e.data.length > 4) blobSize += e.data.length + (e.data.length & 1); // word-aligned
  }
  const pixelStart = headerSize + ifdSize + blobSize;

  const stripOffsets: number[] = [];
  let so = pixelStart;
  for (const bc of stripByteCounts) { stripOffsets.push(so); so += bc; }
  // Patch StripOffsets now that the payload position is known.
  const soEntry = entries.find((e) => e.tag === 273)!;
  soEntry.data = longArray(stripOffsets);
  if (numStrips === 1) { soEntry.inline = stripOffsets[0]; soEntry.data = undefined; }

  const total = pixelStart + pixelBytes.length;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);

  // TIFF header: little-endian, magic 42, IFD immediately after.
  out.set(u8(0x49, 0x49), 0); // 'II'
  dv.setUint16(2, 42, true);
  dv.setUint32(4, headerSize, true);

  dv.setUint16(headerSize, entries.length, true);
  let ep = headerSize + 2;
  let bp = headerSize + ifdSize;
  for (const e of entries) {
    dv.setUint16(ep, e.tag, true);
    dv.setUint16(ep + 2, e.type, true);
    dv.setUint32(ep + 4, e.count, true);
    if (e.data && e.data.length > 4) {
      dv.setUint32(ep + 8, bp, true);
      out.set(e.data, bp);
      bp += e.data.length + (e.data.length & 1);
    } else if (e.data) {
      // <=4 bytes live inside the entry, left-packed.
      out.set(e.data, ep + 8);
    } else {
      // A SHORT value occupies the FIRST half of the 4-byte field in a
      // little-endian file; writing it as a LONG would be read as a huge number
      // by a strict reader.
      if (e.type === T_SHORT) dv.setUint16(ep + 8, (e.inline ?? 0) & 0xffff, true);
      else if (e.type === T_BYTE) out[ep + 8] = (e.inline ?? 0) & 0xff;
      else dv.setUint32(ep + 8, (e.inline ?? 0) >>> 0, true);
    }
    ep += 12;
  }
  dv.setUint32(ep, 0, true); // no next IFD

  out.set(pixelBytes, pixelStart);
  return out;
}
