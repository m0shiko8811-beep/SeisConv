// seisconv-core - GOLDEN projection vectors, computed by PROJ (pyproj).
//
// Frozen reference values for core/projections.ts. Each entry is a real EPSG
// CRS; each point is [lat, lon, easting, northing] with the coordinates as
// PROJ produces them from the CRS's OWN geodetic CRS, so the numbers test the
// PROJECTION maths alone and no datum transformation is involved.
//
// Regenerate only if the supported-method list changes, and say so in the PR:
// these are the external check on our own arithmetic, so they must come from
// PROJ and never be "corrected" to match our output.

export interface GoldenProjCase {
  code: string;
  name: string;
  method: string;
  why: string;
  /** [lat, lon, E, N] */
  pts: [number, number, number, number][];
}

export const GOLDEN_PROJ: GoldenProjCase[] = [
  {
    code: '2154', method: 'LCC',
    name: "RGF93 v1 / Lambert-93",
    why: "LCC 2SP, France Lambert-93",
    pts: [
      [46.5, 3.0, 700000.0, 6600000.0],
      [47.75, 4.75, 831119.183782, 6740298.276587],
      [45.25, 1.25, 562727.67948, 6462705.528914],
    ],
  },
  {
    code: '3034', method: 'LCC',
    name: "ETRS89-extended / LCC Europe",
    why: "LCC 2SP, Europe",
    pts: [
      [52.0, 10.0, 4000000.0, 2800000.0],
      [53.25, 11.75, 4112885.581484, 2935722.574566],
      [50.75, 8.25, 3880751.88395, 2667115.131412],
    ],
  },
  {
    code: '2285', method: 'LCC',
    name: "NAD83 / Washington North (ftUS)",
    why: "LCC 2SP in US survey feet",
    pts: [
      [47.0, -120.833333333, 1640416.667, 0.0],
      [48.25, -119.083333333, 2066740.637019, 460813.093797],
      [45.75, -122.583333333, 1193355.027212, -450973.30691],
    ],
  },
  {
    code: '3395', method: 'MERC',
    name: "WGS 84 / World Mercator",
    why: "Mercator variant A, World Mercator",
    pts: [
      [0.0, 0.0, 0.0, 0.0],
      [1.25, 1.75, 194809.108888, 138228.957359],
      [-1.25, -1.75, -194809.108888, -138228.957359],
    ],
  },
  {
    code: '3857', method: 'MERC',
    name: "WGS 84 / Pseudo-Mercator",
    why: "Mercator on a SPHERE (Pseudo-Mercator)",
    pts: [
      [0.0, 0.0, 0.0, 0.0],
      [1.25, 1.75, 194809.108888, 139160.40317],
      [-1.25, -1.75, -194809.108888, -139160.40317],
    ],
  },
  {
    code: '5331', method: 'MERC',
    name: "Makassar (Jakarta) / NEIEZ",
    why: "Mercator from the Jakarta prime meridian",
    pts: [
      [0.0, 3.192280556, 3900000.0, 900000.0],
      [1.25, 4.942280556, 4094202.152074, 1037801.059619],
      [-1.25, 1.442280556, 3705797.847926, 762198.940381],
    ],
  },
  {
    code: '2099', method: 'CASS',
    name: "Qatar 1948 / Qatar Grid",
    why: "Cassini-Soldner, Qatar",
    pts: [
      [25.382361111, 50.761388889, 100000.0, 100000.0],
      [26.632361111, 52.511388889, 274253.596609, 239679.912528],
      [24.132361111, 49.011388889, -77880.127331, -37352.095705],
    ],
  },
  {
    code: '3377', method: 'CASS',
    name: "GDM2000 / Johor Grid",
    why: "Cassini-Soldner, Johor",
    pts: [
      [2.121679744, 103.427936236, -14810.562, 8758.32],
      [3.371679744, 105.177936236, 179663.483193, 147154.145751],
      [0.871679744, 101.677936236, -209597.270327, -129415.254314],
    ],
  },
  {
    code: '5070', method: 'AEA',
    name: "NAD83 / Conus Albers",
    why: "Albers Equal Area, Conus",
    pts: [
      [23.0, -96.0, 0.0, 0.0],
      [24.25, -94.25, 180320.298994, 137806.693927],
      [21.75, -97.75, -185322.602117, -133811.09954],
    ],
  },
  {
    code: '3577', method: 'AEA',
    name: "GDA94 / Australian Albers",
    why: "Albers Equal Area, Australia",
    pts: [
      [0.0, 132.0, 0.0, 0.0],
      [1.25, 133.75, 213392.484506, 125220.920379],
      [-1.25, 130.25, -209907.652947, -129167.361009],
    ],
  },
  {
    code: '3035', method: 'LAEA',
    name: "ETRS89-extended / LAEA Europe",
    why: "Lambert Azimuthal Equal Area, Europe",
    pts: [
      [52.0, 10.0, 4321000.0, 3210000.0],
      [53.25, 11.75, 4437806.972559, 3350502.787731],
      [50.75, 8.25, 4197504.225117, 3072407.959626],
    ],
  },
  {
    code: '6931', method: 'LAEA',
    name: "WGS 84 / NSIDC EASE-Grid 2.0 North",
    why: "Lambert Azimuthal Equal Area, North Pole",
    pts: [
      [85.0, 0.0, 0.0, -558278.407522],
      [85.0, 1.75, 17048.992523, -558018.021357],
      [88.75, -1.75, -4263.618693, -139549.364219],
    ],
  },
  {
    code: '3031', method: 'STERE',
    name: "WGS 84 / Antarctic Polar Stereographic",
    why: "Polar Stereographic, Antarctic",
    pts: [
      [-85.0, 0.0, 0.0, 543593.298107],
      [-88.75, 1.75, 4147.762918, 135757.374149],
      [-85.0, -1.75, -16600.531115, 543339.761212],
    ],
  },
  {
    code: '3413', method: 'STERE',
    name: "WGS 84 / NSIDC Sea Ice Polar Stereographic North",
    why: "Polar Stereographic variant B, Arctic",
    pts: [
      [85.0, -45.0, 0.0, -541966.700613],
      [85.0, -43.25, 16550.857246, -541713.922378],
      [88.75, -46.75, -4135.351542, -135351.146542],
    ],
  },
  {
    code: '28992', method: 'STEREA',
    name: "Amersfoort / RD New",
    why: "Oblique Stereographic, Netherlands RD New",
    pts: [
      [52.156160556, 5.387638889, 155000.0, 463000.0],
      [53.406160556, 7.137638889, 271365.292228, 603494.713275],
      [50.906160556, 3.637638889, 31926.205874, 325421.964129],
    ],
  },
  {
    code: '31600', method: 'STEREA',
    name: "Dealul Piscului 1930 / Stereo 33",
    why: "Oblique Stereographic, Romania Stereo 33",
    pts: [
      [45.9, 25.392465889, 500000.0, 500000.0],
      [47.15, 27.142465889, 632696.806104, 640386.548163],
      [44.65, 23.642465889, 361209.492564, 362621.01615],
    ],
  },
];
