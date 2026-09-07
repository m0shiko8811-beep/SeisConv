// seisconv-core / render - color maps for variable-density display.
//
// Each maps a normalized amplitude v ∈ [-1, 1] to an [r,g,b] triple.
// Ported verbatim from the SeisConv reference. Pure - no DOM.

export type RGB = [number, number, number];
export type ColorMapName =
  | 'seismic'
  | 'gray'
  | 'amber'
  | 'viridis'
  | 'grayL'
  | 'grayPosBlack'
  | 'grayLPosBlack'
  | 'berlin'
  | 'vik';

/** Anything a colour can be written into by index: an RGBA byte buffer, or a
 *  plain array. Declared structurally so core stays free of DOM types. */
export type RGBSink = Uint8ClampedArray | number[];

/** Writes r,g,b into `out[i..i+2]`. This is the allocation-free form used by
 *  the rasteriser, which colours millions of cells per redraw and must not
 *  allocate a tuple for each one. */
export type ColorWriter = (v: number, out: RGBSink, i: number) => void;

// Each map is implemented ONCE, as a writer. The RGB-returning functions below
// are thin wrappers that allocate a single tuple and call the writer, so the
// readable per-call API and the fast per-cell path can never drift apart:
// there is only one copy of every formula.
function toRGB(write: ColorWriter, v: number): RGB {
  const out: RGB = [0, 0, 0];
  write(v, out, 0);
  return out;
}

/** Red-white-blue (the classic seismic map), written in place. */
export const writeSeismic: ColorWriter = (v, out, i) => {
  if (!Number.isFinite(v)) v = 0; // never let a NaN/Infinity amplitude reach a canvas draw
  if (v >= 0) {
    const f = Math.min(v, 1);
    const c = Math.round(255 * (1 - f));
    out[i] = 255; out[i + 1] = c; out[i + 2] = c;
    return;
  }
  const f = Math.min(-v, 1);
  const c = Math.round(255 * (1 - f));
  out[i] = c; out[i + 1] = c; out[i + 2] = 255;
};

/** Red-white-blue (the classic seismic map). */
export function colorSeismic(v: number): RGB {
  return toRGB(writeSeismic, v);
}

/** Plain linear ramp on sRGB channel values. Kept for backward compatibility;
 * it is NOT perceptually uniform (equal steps in v do not look like equal
 * steps in brightness because sRGB channel values are gamma-encoded, not
 * linear light). Use colorGrayL for a perceptually-uniform grey ramp. */
export const writeGray: ColorWriter = (v, out, i) => {
  const t = Number.isFinite(v) ? Math.max(-1, Math.min(1, v)) : 0;
  const c = Math.round(128 + t * 127);
  out[i] = c; out[i + 1] = c; out[i + 2] = c;
};

export function colorGray(v: number): RGB {
  return toRGB(writeGray, v);
}

/** Perceptually-uniform greyscale: v maps linearly to CIE L* (perceived
 * lightness), which is then converted to linear luminance and finally to a
 * gamma-encoded sRGB channel value. Equal steps in v now look like equal
 * steps in brightness, which a straight sRGB ramp does not give. */
export const writeGrayL: ColorWriter = (v, out, i) => {
  const t = Number.isFinite(v) ? Math.max(-1, Math.min(1, v)) : 0;
  const L = 50 + t * 50; // CIE L*, 0..100
  const y = L > 8 ? Math.pow((L + 16) / 116, 3) : L / 903.3; // relative luminance, 0..1
  const srgb = y <= 0.0031308 ? 12.92 * y : 1.055 * Math.pow(y, 1 / 2.4) - 0.055;
  const c = Math.max(0, Math.min(255, Math.round(srgb * 255)));
  out[i] = c; out[i + 1] = c; out[i + 2] = c;
};

export function colorGrayL(v: number): RGB {
  return toRGB(writeGrayL, v);
}

// colorGray and colorGrayL both put POSITIVE amplitude at white. Classic
// paper-section seismic convention is the opposite: a positive peak prints
// BLACK. Both conventions are in live use, so rather than change the meaning
// of the existing two maps under anyone's feet we add mirrored twins. The
// twins are defined as the original evaluated at -v, so the two can never
// drift apart, and negating v preserves NaN/Infinity so the guards inside the
// originals still do the work. The names carry the convention (PosBlack =
// positive is black) so the picker entry reads on its own.

export const writeGrayPosBlack: ColorWriter = (v, out, i) => writeGray(-v, out, i);

/** Linear sRGB grey ramp, positive amplitude to BLACK (paper-section polarity). */
export function colorGrayPosBlack(v: number): RGB {
  return toRGB(writeGrayPosBlack, v);
}

export const writeGrayLPosBlack: ColorWriter = (v, out, i) => writeGrayL(-v, out, i);

/** Perceptually-uniform grey ramp, positive amplitude to BLACK. */
export function colorGrayLPosBlack(v: number): RGB {
  return toRGB(writeGrayLPosBlack, v);
}

export const writeAmber: ColorWriter = (v, out, i) => {
  if (!Number.isFinite(v)) v = 0; // never let a NaN/Infinity amplitude reach a canvas draw
  if (v >= 0) {
    const f = Math.min(v, 1);
    out[i] = 255; out[i + 1] = Math.round(140 * f); out[i + 2] = 0;
    return;
  }
  const f = Math.min(-v, 1);
  out[i] = 0; out[i + 1] = Math.round(212 * f); out[i + 2] = 255;
};

export function colorAmber(v: number): RGB {
  return toRGB(writeAmber, v);
}

// Shared sampler for the 256-entry lookup tables at the bottom of this file.
// v ∈ [-1, 1] maps to t ∈ [0, 1], t is scaled onto 0..255 and the two nearest
// entries are blended. With 256 stops the residual RGB interpolation error is
// under half a channel step, so the sampled curve is the published curve; the
// old 10-stop viridis drifted because its stops were 28 entries apart.
function writeLut(lut: RGB[], v: number, out: RGBSink, i: number): void {
  if (!Number.isFinite(v)) v = 0; // never let a NaN/Infinity amplitude reach a canvas draw
  const t = Math.max(0, Math.min(1, (v + 1) / 2));
  const n = lut.length - 1;
  const pos = t * n;
  const i0 = Math.max(0, Math.min(n, Math.floor(pos)));
  const i1 = Math.min(n, i0 + 1);
  const f = pos - i0;
  const a = lut[i0];
  const b = lut[i1];
  for (let k = 0; k < 3; k++) {
    const c = Math.round(a[k] + f * (b[k] - a[k]));
    out[i + k] = Math.max(0, Math.min(255, Number.isFinite(c) ? c : 0));
  }
}

export const writeViridis: ColorWriter = (v, out, i) => writeLut(VIRIDIS_LUT, v, out, i);
export const writeBerlin: ColorWriter = (v, out, i) => writeLut(BERLIN_LUT, v, out, i);
export const writeVik: ColorWriter = (v, out, i) => writeLut(VIK_LUT, v, out, i);

/** matplotlib's viridis, full 256-entry table. Sequential and perceptually
 * uniform, so it reads magnitude well but hides the SIGN of a sample; for
 * polarity work prefer a diverging map (berlin, vik, seismic). */
export function colorViridis(v: number): RGB {
  return toRGB(writeViridis, v);
}

// The two maps below are diverging: they run dark-blue -> neutral -> dark-red,
// so the sign of the amplitude is what the eye reads first, and they are
// perceptually uniform in CIE L* on each limb, which red-white-blue is not.
// Index 0 of both published tables is the blue end, and t = (v + 1) / 2 puts
// it at v = -1, so positive amplitude comes out red. That matches the polarity
// colorSeismic already uses, which is why the tables are not flipped.

/** Crameri's "berlin": light blue -> near-black -> light red. The dark centre
 * makes small-amplitude (near-zero) samples recede, so events stand out. */
export function colorBerlin(v: number): RGB {
  return toRGB(writeBerlin, v);
}

/** Crameri's "vik": dark blue -> off-white -> dark red. The light centre is
 * the familiar "white is zero" look of a classic seismic display, but with
 * uniform lightness on each limb. */
export function colorVik(v: number): RGB {
  return toRGB(writeVik, v);
}

/** Resolve a map name to its allocation-free writer (defaults to seismic).
 *  A raster cannot change map mid-pass, so the caller resolves ONCE outside
 *  the per-cell loop and the name comparisons disappear from the hot path. */
export function getColorWriter(map: ColorMapName | string): ColorWriter {
  if (map === 'gray') return writeGray;
  if (map === 'grayL') return writeGrayL;
  if (map === 'grayPosBlack') return writeGrayPosBlack;
  if (map === 'grayLPosBlack') return writeGrayLPosBlack;
  if (map === 'amber') return writeAmber;
  if (map === 'viridis') return writeViridis;
  if (map === 'berlin') return writeBerlin;
  if (map === 'vik') return writeVik;
  return writeSeismic;
}

/** Dispatch by name (defaults to seismic). */
export function getColor(v: number, map: ColorMapName | string): RGB {
  return toRGB(getColorWriter(map), v);
}

export type CvdType = 'protanopia' | 'deuteranopia' | 'tritanopia';

// Colour-vision-deficiency simulation matrices from Machado, Oliveira and
// Fernandes, "A Physiologically-based Model for Simulation of Color Vision
// Deficiency", IEEE Transactions on Visualization and Computer Graphics 15(6),
// 2009, pp. 1291-1298. These are the severity 1.0 (full dichromacy) matrices
// of that model; the values below were verified against the tables shipped in
// the colorspacious package (colorspacious.cvd.machado_et_al_2009_matrix, at
// severity 100) and agree to all six published decimals.
//
// Every row sums to 1, which is why a neutral grey survives the transform
// unchanged: a grey has no chromatic content for a missing cone class to lose.
// That property is the cheapest sanity check that the matrices are intact.
const CVD_MATRIX: Record<CvdType, number[][]> = {
  protanopia: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998],
  ],
  deuteranopia: [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.01182, 0.04294, 0.968881],
  ],
  tritanopia: [
    [1.255528, -0.076749, -0.178779],
    [-0.078411, 0.930809, 0.147602],
    [0.004733, 0.691367, 0.3039],
  ],
};

function srgbToLinear(c: number): number {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

function linearToSrgb(y: number): number {
  // Clamp BEFORE the gamma encode. The matrices carry negative entries, so an
  // out-of-gamut result is normal, and Math.pow(negative, 1/2.4) is NaN, which
  // is exactly what must never reach a canvas.
  const c = Math.max(0, Math.min(1, y));
  const s = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(s * 255)));
}

/** Simulate how an [r,g,b] (0..255 sRGB) looks to a viewer with the given
 * colour-vision deficiency. Pure helper so the app can show whether a chosen
 * map still separates positive from negative for a colour-blind reader; it is
 * deliberately not wired to any UI here. The transform is defined on LINEAR
 * light, so the channels are gamma-decoded, mixed, then re-encoded. Unknown
 * deficiency names and non-finite channels return a safe, in-gamut value. */
export function simulateCvd(rgb: RGB, type: CvdType | string): RGB {
  const m = CVD_MATRIX[type as CvdType];
  const clampByte = (c: number) => (Number.isFinite(c) ? Math.max(0, Math.min(255, Math.round(c))) : 0);
  if (!m) return [clampByte(rgb[0]), clampByte(rgb[1]), clampByte(rgb[2])];
  const lin = [
    srgbToLinear(clampByte(rgb[0])),
    srgbToLinear(clampByte(rgb[1])),
    srgbToLinear(clampByte(rgb[2])),
  ];
  return [
    linearToSrgb(m[0][0] * lin[0] + m[0][1] * lin[1] + m[0][2] * lin[2]),
    linearToSrgb(m[1][0] * lin[0] + m[1][1] * lin[1] + m[1][2] * lin[2]),
    linearToSrgb(m[2][0] * lin[0] + m[2][1] * lin[1] + m[2][2] * lin[2]),
  ];
}

// ---------------------------------------------------------------------------
// Published lookup tables. Declared last only to keep them out of the way; a
// module-scope const is initialised before any of the functions above can run.
//
// VIRIDIS_LUT: matplotlib 3.10.9, lib/matplotlib/_cm_listed.py, _viridis_data,
// all 256 entries, each channel rounded from the published float to 0..255.
// Endpoints are unchanged from the previous 10-stop table: #440154 and #fde725.
//
// BERLIN_LUT and VIK_LUT: Fabio Crameri, "Scientific colour maps", Zenodo,
// doi:10.5281/zenodo.1243862 (see also Crameri, Shephard and Heron, Nature
// Communications 11, 5444, 2020). berlin was taken from matplotlib 3.10.9
// _cm_listed.py _berlin_data, vik from the cmcrameri 1.10 package's own copy
// of Crameri's vik.txt. As a provenance check, matplotlib's berlin and
// cmcrameri's berlin.txt were compared entry by entry: they are the same file
// (max difference 5e-6 in float, identical after rounding to 8-bit), so the
// two sources are one published release, not two approximations.
// ---------------------------------------------------------------------------
const VIRIDIS_LUT: RGB[] = [
  [68, 1, 84],
  [68, 2, 86],
  [69, 4, 87],
  [69, 5, 89],
  [70, 7, 90],
  [70, 8, 92],
  [70, 10, 93],
  [70, 11, 94],
  [71, 13, 96],
  [71, 14, 97],
  [71, 16, 99],
  [71, 17, 100],
  [71, 19, 101],
  [72, 20, 103],
  [72, 22, 104],
  [72, 23, 105],
  [72, 24, 106],
  [72, 26, 108],
  [72, 27, 109],
  [72, 28, 110],
  [72, 29, 111],
  [72, 31, 112],
  [72, 32, 113],
  [72, 33, 115],
  [72, 35, 116],
  [72, 36, 117],
  [72, 37, 118],
  [72, 38, 119],
  [72, 40, 120],
  [72, 41, 121],
  [71, 42, 122],
  [71, 44, 122],
  [71, 45, 123],
  [71, 46, 124],
  [71, 47, 125],
  [70, 48, 126],
  [70, 50, 126],
  [70, 51, 127],
  [70, 52, 128],
  [69, 53, 129],
  [69, 55, 129],
  [69, 56, 130],
  [68, 57, 131],
  [68, 58, 131],
  [68, 59, 132],
  [67, 61, 132],
  [67, 62, 133],
  [66, 63, 133],
  [66, 64, 134],
  [66, 65, 134],
  [65, 66, 135],
  [65, 68, 135],
  [64, 69, 136],
  [64, 70, 136],
  [63, 71, 136],
  [63, 72, 137],
  [62, 73, 137],
  [62, 74, 137],
  [62, 76, 138],
  [61, 77, 138],
  [61, 78, 138],
  [60, 79, 138],
  [60, 80, 139],
  [59, 81, 139],
  [59, 82, 139],
  [58, 83, 139],
  [58, 84, 140],
  [57, 85, 140],
  [57, 86, 140],
  [56, 88, 140],
  [56, 89, 140],
  [55, 90, 140],
  [55, 91, 141],
  [54, 92, 141],
  [54, 93, 141],
  [53, 94, 141],
  [53, 95, 141],
  [52, 96, 141],
  [52, 97, 141],
  [51, 98, 141],
  [51, 99, 141],
  [50, 100, 142],
  [50, 101, 142],
  [49, 102, 142],
  [49, 103, 142],
  [49, 104, 142],
  [48, 105, 142],
  [48, 106, 142],
  [47, 107, 142],
  [47, 108, 142],
  [46, 109, 142],
  [46, 110, 142],
  [46, 111, 142],
  [45, 112, 142],
  [45, 113, 142],
  [44, 113, 142],
  [44, 114, 142],
  [44, 115, 142],
  [43, 116, 142],
  [43, 117, 142],
  [42, 118, 142],
  [42, 119, 142],
  [42, 120, 142],
  [41, 121, 142],
  [41, 122, 142],
  [41, 123, 142],
  [40, 124, 142],
  [40, 125, 142],
  [39, 126, 142],
  [39, 127, 142],
  [39, 128, 142],
  [38, 129, 142],
  [38, 130, 142],
  [38, 130, 142],
  [37, 131, 142],
  [37, 132, 142],
  [37, 133, 142],
  [36, 134, 142],
  [36, 135, 142],
  [35, 136, 142],
  [35, 137, 142],
  [35, 138, 141],
  [34, 139, 141],
  [34, 140, 141],
  [34, 141, 141],
  [33, 142, 141],
  [33, 143, 141],
  [33, 144, 141],
  [33, 145, 140],
  [32, 146, 140],
  [32, 146, 140],
  [32, 147, 140],
  [31, 148, 140],
  [31, 149, 139],
  [31, 150, 139],
  [31, 151, 139],
  [31, 152, 139],
  [31, 153, 138],
  [31, 154, 138],
  [30, 155, 138],
  [30, 156, 137],
  [30, 157, 137],
  [31, 158, 137],
  [31, 159, 136],
  [31, 160, 136],
  [31, 161, 136],
  [31, 161, 135],
  [31, 162, 135],
  [32, 163, 134],
  [32, 164, 134],
  [33, 165, 133],
  [33, 166, 133],
  [34, 167, 133],
  [34, 168, 132],
  [35, 169, 131],
  [36, 170, 131],
  [37, 171, 130],
  [37, 172, 130],
  [38, 173, 129],
  [39, 173, 129],
  [40, 174, 128],
  [41, 175, 127],
  [42, 176, 127],
  [44, 177, 126],
  [45, 178, 125],
  [46, 179, 124],
  [47, 180, 124],
  [49, 181, 123],
  [50, 182, 122],
  [52, 182, 121],
  [53, 183, 121],
  [55, 184, 120],
  [56, 185, 119],
  [58, 186, 118],
  [59, 187, 117],
  [61, 188, 116],
  [63, 188, 115],
  [64, 189, 114],
  [66, 190, 113],
  [68, 191, 112],
  [70, 192, 111],
  [72, 193, 110],
  [74, 193, 109],
  [76, 194, 108],
  [78, 195, 107],
  [80, 196, 106],
  [82, 197, 105],
  [84, 197, 104],
  [86, 198, 103],
  [88, 199, 101],
  [90, 200, 100],
  [92, 200, 99],
  [94, 201, 98],
  [96, 202, 96],
  [99, 203, 95],
  [101, 203, 94],
  [103, 204, 92],
  [105, 205, 91],
  [108, 205, 90],
  [110, 206, 88],
  [112, 207, 87],
  [115, 208, 86],
  [117, 208, 84],
  [119, 209, 83],
  [122, 209, 81],
  [124, 210, 80],
  [127, 211, 78],
  [129, 211, 77],
  [132, 212, 75],
  [134, 213, 73],
  [137, 213, 72],
  [139, 214, 70],
  [142, 214, 69],
  [144, 215, 67],
  [147, 215, 65],
  [149, 216, 64],
  [152, 216, 62],
  [155, 217, 60],
  [157, 217, 59],
  [160, 218, 57],
  [162, 218, 55],
  [165, 219, 54],
  [168, 219, 52],
  [170, 220, 50],
  [173, 220, 48],
  [176, 221, 47],
  [178, 221, 45],
  [181, 222, 43],
  [184, 222, 41],
  [186, 222, 40],
  [189, 223, 38],
  [192, 223, 37],
  [194, 223, 35],
  [197, 224, 33],
  [200, 224, 32],
  [202, 225, 31],
  [205, 225, 29],
  [208, 225, 28],
  [210, 226, 27],
  [213, 226, 26],
  [216, 226, 25],
  [218, 227, 25],
  [221, 227, 24],
  [223, 227, 24],
  [226, 228, 24],
  [229, 228, 25],
  [231, 228, 25],
  [234, 229, 26],
  [236, 229, 27],
  [239, 229, 28],
  [241, 229, 29],
  [244, 230, 30],
  [246, 230, 32],
  [248, 230, 33],
  [251, 231, 35],
  [253, 231, 37],
];

const BERLIN_LUT: RGB[] = [
  [158, 176, 255],
  [156, 176, 254],
  [154, 176, 253],
  [152, 175, 252],
  [149, 175, 251],
  [147, 175, 250],
  [145, 174, 249],
  [142, 174, 247],
  [140, 174, 246],
  [138, 174, 245],
  [135, 173, 244],
  [133, 173, 243],
  [130, 173, 242],
  [128, 172, 241],
  [126, 172, 240],
  [123, 172, 238],
  [121, 171, 237],
  [118, 171, 236],
  [116, 170, 235],
  [113, 170, 233],
  [111, 169, 232],
  [108, 169, 230],
  [106, 168, 229],
  [103, 168, 227],
  [101, 167, 226],
  [98, 166, 224],
  [96, 165, 223],
  [93, 165, 221],
  [91, 164, 219],
  [88, 163, 217],
  [86, 162, 215],
  [84, 160, 213],
  [81, 159, 211],
  [79, 158, 209],
  [77, 157, 207],
  [75, 155, 205],
  [72, 154, 202],
  [70, 152, 200],
  [68, 151, 198],
  [67, 149, 195],
  [65, 148, 193],
  [63, 146, 190],
  [62, 144, 188],
  [60, 142, 185],
  [59, 141, 183],
  [57, 139, 180],
  [56, 137, 178],
  [55, 135, 175],
  [54, 133, 173],
  [53, 132, 170],
  [51, 130, 168],
  [50, 128, 166],
  [50, 126, 163],
  [49, 124, 161],
  [48, 122, 158],
  [47, 120, 156],
  [46, 118, 153],
  [45, 117, 151],
  [44, 115, 148],
  [44, 113, 146],
  [43, 111, 143],
  [42, 109, 141],
  [41, 107, 139],
  [41, 105, 136],
  [40, 104, 134],
  [39, 102, 131],
  [39, 100, 129],
  [38, 98, 127],
  [37, 96, 124],
  [36, 94, 122],
  [36, 93, 120],
  [35, 91, 117],
  [34, 89, 115],
  [34, 87, 113],
  [33, 85, 110],
  [32, 84, 108],
  [32, 82, 106],
  [31, 80, 104],
  [30, 78, 101],
  [30, 77, 99],
  [29, 75, 97],
  [28, 73, 95],
  [28, 71, 92],
  [27, 70, 90],
  [26, 68, 88],
  [26, 66, 86],
  [25, 65, 83],
  [25, 63, 81],
  [24, 61, 79],
  [23, 60, 77],
  [23, 58, 75],
  [22, 56, 73],
  [22, 55, 71],
  [21, 53, 68],
  [21, 51, 66],
  [20, 50, 64],
  [20, 48, 62],
  [19, 47, 60],
  [19, 45, 58],
  [18, 44, 56],
  [18, 42, 54],
  [18, 41, 52],
  [17, 39, 50],
  [17, 38, 48],
  [17, 36, 46],
  [17, 35, 44],
  [17, 33, 42],
  [17, 32, 40],
  [16, 31, 38],
  [16, 29, 37],
  [16, 28, 35],
  [17, 27, 33],
  [17, 26, 32],
  [17, 25, 30],
  [17, 24, 28],
  [17, 22, 27],
  [17, 21, 25],
  [17, 20, 24],
  [17, 19, 23],
  [18, 18, 21],
  [18, 18, 20],
  [19, 17, 18],
  [20, 16, 17],
  [20, 15, 16],
  [21, 14, 14],
  [22, 14, 13],
  [23, 13, 11],
  [24, 12, 10],
  [25, 12, 9],
  [26, 12, 8],
  [27, 11, 7],
  [28, 11, 6],
  [29, 11, 5],
  [30, 11, 4],
  [32, 11, 4],
  [33, 11, 3],
  [34, 12, 2],
  [35, 12, 2],
  [36, 12, 2],
  [37, 12, 1],
  [38, 13, 1],
  [39, 13, 1],
  [40, 13, 1],
  [42, 14, 1],
  [43, 14, 1],
  [44, 14, 0],
  [45, 14, 0],
  [47, 14, 0],
  [48, 15, 0],
  [49, 15, 0],
  [51, 15, 0],
  [52, 15, 0],
  [53, 16, 0],
  [55, 16, 0],
  [56, 16, 0],
  [57, 17, 0],
  [59, 17, 0],
  [60, 17, 1],
  [62, 18, 1],
  [63, 18, 1],
  [65, 18, 1],
  [66, 19, 1],
  [68, 19, 1],
  [69, 20, 1],
  [71, 20, 1],
  [72, 21, 2],
  [74, 21, 2],
  [75, 22, 2],
  [77, 22, 2],
  [79, 23, 3],
  [80, 24, 3],
  [82, 24, 4],
  [84, 25, 5],
  [86, 26, 5],
  [87, 27, 6],
  [89, 28, 7],
  [91, 29, 8],
  [93, 30, 9],
  [95, 31, 10],
  [97, 32, 11],
  [99, 33, 12],
  [101, 35, 14],
  [104, 36, 15],
  [106, 37, 16],
  [108, 39, 17],
  [110, 40, 19],
  [112, 42, 20],
  [115, 43, 22],
  [117, 45, 23],
  [119, 47, 25],
  [121, 48, 27],
  [123, 50, 28],
  [125, 52, 30],
  [128, 54, 32],
  [130, 55, 34],
  [132, 57, 36],
  [134, 59, 38],
  [136, 61, 40],
  [138, 63, 42],
  [140, 64, 44],
  [142, 66, 46],
  [144, 68, 48],
  [146, 70, 50],
  [148, 72, 52],
  [150, 74, 54],
  [152, 76, 57],
  [154, 77, 59],
  [156, 79, 61],
  [158, 81, 63],
  [160, 83, 65],
  [162, 85, 68],
  [164, 87, 70],
  [166, 89, 72],
  [168, 90, 74],
  [170, 92, 76],
  [172, 94, 79],
  [174, 96, 81],
  [176, 98, 83],
  [178, 100, 85],
  [180, 102, 88],
  [182, 104, 90],
  [184, 106, 92],
  [186, 107, 95],
  [188, 109, 97],
  [190, 111, 99],
  [192, 113, 101],
  [194, 115, 104],
  [196, 117, 106],
  [198, 119, 108],
  [200, 121, 111],
  [202, 123, 113],
  [204, 125, 115],
  [206, 127, 118],
  [208, 129, 120],
  [210, 131, 122],
  [213, 133, 125],
  [215, 135, 127],
  [217, 137, 130],
  [219, 139, 132],
  [221, 141, 134],
  [223, 143, 137],
  [225, 145, 139],
  [227, 147, 142],
  [229, 149, 144],
  [231, 151, 146],
  [234, 153, 149],
  [236, 155, 151],
  [238, 157, 154],
  [240, 159, 156],
  [242, 161, 159],
  [244, 163, 161],
  [246, 165, 163],
  [249, 167, 166],
  [251, 169, 168],
  [253, 171, 171],
  [255, 173, 173],
];

const VIK_LUT: RGB[] = [
  [0, 18, 97],
  [1, 20, 98],
  [1, 21, 99],
  [1, 23, 100],
  [1, 24, 101],
  [1, 26, 102],
  [2, 28, 103],
  [2, 29, 104],
  [2, 31, 105],
  [2, 32, 106],
  [2, 34, 107],
  [2, 35, 108],
  [2, 37, 109],
  [2, 39, 110],
  [2, 40, 111],
  [2, 42, 112],
  [2, 43, 113],
  [2, 45, 114],
  [2, 46, 115],
  [2, 48, 116],
  [2, 49, 117],
  [2, 51, 118],
  [2, 52, 119],
  [2, 54, 120],
  [2, 55, 121],
  [2, 57, 122],
  [2, 58, 123],
  [3, 60, 124],
  [3, 62, 125],
  [3, 63, 126],
  [3, 65, 127],
  [3, 66, 128],
  [3, 68, 129],
  [3, 69, 130],
  [3, 71, 131],
  [3, 73, 132],
  [3, 74, 133],
  [4, 76, 134],
  [4, 77, 135],
  [4, 79, 136],
  [5, 81, 137],
  [5, 82, 138],
  [6, 84, 139],
  [6, 86, 140],
  [7, 87, 141],
  [8, 89, 143],
  [9, 91, 144],
  [11, 93, 145],
  [12, 94, 146],
  [14, 96, 147],
  [16, 98, 148],
  [17, 100, 150],
  [19, 102, 151],
  [21, 103, 152],
  [23, 105, 153],
  [25, 107, 154],
  [28, 109, 156],
  [30, 111, 157],
  [32, 113, 158],
  [35, 115, 160],
  [37, 117, 161],
  [40, 119, 162],
  [43, 121, 164],
  [45, 123, 165],
  [48, 125, 166],
  [51, 127, 168],
  [54, 129, 169],
  [57, 131, 171],
  [60, 133, 172],
  [63, 135, 173],
  [66, 137, 175],
  [69, 139, 176],
  [72, 141, 178],
  [75, 144, 179],
  [78, 146, 180],
  [81, 148, 182],
  [84, 150, 183],
  [87, 152, 185],
  [90, 154, 186],
  [93, 156, 187],
  [97, 158, 189],
  [100, 160, 190],
  [103, 162, 192],
  [106, 164, 193],
  [109, 166, 194],
  [113, 168, 196],
  [116, 170, 197],
  [119, 172, 198],
  [122, 174, 200],
  [125, 176, 201],
  [128, 178, 202],
  [132, 180, 204],
  [135, 182, 205],
  [138, 184, 206],
  [141, 186, 208],
  [144, 188, 209],
  [148, 190, 210],
  [151, 192, 212],
  [154, 194, 213],
  [157, 196, 214],
  [160, 197, 216],
  [163, 199, 217],
  [167, 201, 218],
  [170, 203, 220],
  [173, 205, 221],
  [176, 207, 222],
  [179, 209, 223],
  [182, 211, 225],
  [186, 213, 226],
  [189, 214, 227],
  [192, 216, 228],
  [195, 218, 229],
  [198, 219, 230],
  [201, 221, 231],
  [204, 223, 232],
  [207, 224, 232],
  [210, 225, 233],
  [213, 227, 233],
  [216, 228, 233],
  [219, 229, 233],
  [222, 230, 233],
  [224, 230, 233],
  [226, 231, 232],
  [229, 231, 232],
  [231, 231, 231],
  [232, 231, 229],
  [234, 230, 228],
  [235, 230, 226],
  [236, 229, 224],
  [237, 228, 222],
  [238, 227, 220],
  [238, 225, 218],
  [238, 224, 216],
  [238, 222, 213],
  [238, 221, 211],
  [238, 219, 208],
  [238, 217, 205],
  [237, 215, 203],
  [237, 213, 200],
  [236, 211, 197],
  [236, 209, 195],
  [235, 208, 192],
  [234, 206, 189],
  [233, 204, 186],
  [233, 202, 184],
  [232, 200, 181],
  [231, 198, 178],
  [230, 196, 176],
  [229, 193, 173],
  [228, 191, 170],
  [228, 190, 168],
  [227, 188, 165],
  [226, 186, 162],
  [225, 184, 160],
  [224, 182, 157],
  [223, 180, 154],
  [223, 178, 152],
  [222, 176, 149],
  [221, 174, 147],
  [220, 172, 144],
  [219, 170, 141],
  [219, 168, 139],
  [218, 166, 136],
  [217, 164, 134],
  [216, 162, 131],
  [215, 160, 129],
  [214, 159, 126],
  [214, 157, 124],
  [213, 155, 121],
  [212, 153, 119],
  [211, 151, 116],
  [211, 149, 114],
  [210, 148, 112],
  [209, 146, 109],
  [208, 144, 107],
  [207, 142, 104],
  [207, 140, 102],
  [206, 139, 100],
  [205, 137, 97],
  [204, 135, 95],
  [204, 133, 93],
  [203, 131, 90],
  [202, 130, 88],
  [201, 128, 86],
  [201, 126, 83],
  [200, 124, 81],
  [199, 123, 79],
  [198, 121, 76],
  [198, 119, 74],
  [197, 117, 72],
  [196, 116, 69],
  [195, 114, 67],
  [194, 112, 65],
  [194, 110, 63],
  [193, 109, 60],
  [192, 107, 58],
  [191, 105, 56],
  [190, 103, 54],
  [190, 101, 51],
  [189, 100, 49],
  [188, 98, 47],
  [187, 96, 45],
  [186, 94, 42],
  [184, 92, 40],
  [183, 90, 38],
  [182, 88, 36],
  [181, 85, 33],
  [179, 83, 31],
  [178, 81, 29],
  [176, 79, 27],
  [175, 76, 24],
  [173, 74, 22],
  [171, 72, 20],
  [169, 69, 18],
  [167, 67, 16],
  [165, 64, 15],
  [163, 62, 13],
  [161, 60, 11],
  [159, 57, 10],
  [156, 55, 9],
  [154, 53, 8],
  [152, 51, 7],
  [150, 49, 7],
  [148, 47, 6],
  [145, 45, 6],
  [143, 43, 6],
  [141, 41, 6],
  [139, 39, 6],
  [137, 38, 6],
  [135, 36, 6],
  [133, 34, 6],
  [131, 33, 6],
  [129, 31, 6],
  [127, 30, 6],
  [126, 29, 6],
  [124, 27, 6],
  [122, 26, 6],
  [120, 24, 6],
  [118, 23, 6],
  [116, 21, 6],
  [115, 20, 6],
  [113, 19, 7],
  [111, 17, 7],
  [109, 16, 7],
  [108, 14, 7],
  [106, 13, 7],
  [104, 12, 7],
  [103, 10, 7],
  [101, 9, 7],
  [99, 7, 7],
  [98, 6, 7],
  [96, 4, 8],
  [94, 3, 8],
  [93, 2, 8],
  [91, 1, 8],
  [89, 0, 8],
];
