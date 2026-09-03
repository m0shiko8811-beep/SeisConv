// seisconv-core - GOLDEN Transverse Mercator / UTM / geographic vectors, computed by PROJ.
//
// Companion to ./golden-proj.ts, which covers only the EXTRA projection methods
// (LCC, Mercator, Cassini, Albers, LAEA, Stereographic) and calls projectForward
// directly. That left the busiest path in the app - the TM/UTM/GEO dispatch in
// core/coords.ts - with no external reference at all, which is how a hardcoded
// WGS 84 ellipsoid, a dropped Helmert tie, an ignored linear unit and an ignored
// prime meridian all survived in it at once.
//
// These cases therefore drive latLonToProj/projToLatLon (the real entry points),
// from WGS 84, using the registry's OWN parameters. PROJ was given the identical
// parameters as a proj4 string (including +towgs84, +pm and +to_meter), so a
// mismatch is our arithmetic and nothing else. E/N are in the CRS's own linear
// unit, exactly as the app reports them.
//
// Regenerate only from PROJ, and never by 'correcting' them to match our output.

export interface GoldenTmCase {
  code: string;
  why: string;
  /** The proj4 definition PROJ was driven with, for reproducibility. */
  proj4: string;
  /** Extra inverse tolerance in metres, where a linearised inverse legitimately
   *  costs more than the default 1 mm. */
  invTolM?: number;
  /** [latWGS84, lonWGS84, E, N] */
  pts: [number, number, number, number][];
}

export const GOLDEN_TM: GoldenTmCase[] = [
  {
    code: "32636",
    why: "UTM zone 36 north",
    proj4: "+proj=utm +zone=36 +a=6378137 +rf=298.257223563 +no_defs",
    pts: [
      [32.0853, 34.7818, 668156.435264, 3551279.766754],
      [0, 33, 500000, 0],
      [60, 34.5, 583661.746882, 6652359.681928],
    ],
  },
  {
    code: "32736",
    why: "UTM zone 36, SOUTHERN hemisphere",
    proj4: "+proj=utm +zone=36 +south +a=6378137 +rf=298.257223563 +no_defs",
    pts: [
      [-26.2041, 33, 500000, 7101713.057116],
      [-1, 34, 611263.812279, 9889452.8943],
      [-45, 35, 657630.64073, 5015103.828728],
    ],
  },
  {
    code: "32601",
    why: "UTM zone 1, just east of the antimeridian",
    proj4: "+proj=utm +zone=1 +a=6378137 +rf=298.257223563 +no_defs",
    pts: [
      [60, -177, 500000, 6651411.190363],
      [10, -179.5, 225928.946613, 1106451.278254],
    ],
  },
  {
    code: "32760",
    why: "UTM zone 60 south, just west of the antimeridian",
    proj4: "+proj=utm +zone=60 +south +a=6378137 +rf=298.257223563 +no_defs",
    pts: [
      [-40, 177, 500000, 5572242.781262],
    ],
  },
  {
    code: "32633",
    why: "UTM zone 33, on and just off the equator",
    proj4: "+proj=utm +zone=33 +a=6378137 +rf=298.257223563 +no_defs",
    pts: [
      [52, 15, 500000, 5761038.21259],
      [0, 15, 500000, 0],
    ],
  },
  {
    code: "32631",
    why: "UTM zone 31, straddling the prime meridian",
    proj4: "+proj=utm +zone=31 +a=6378137 +rf=298.257223563 +no_defs",
    pts: [
      [50, -0.5, 249192.239358, 5544502.325708],
      [50, 0.5, 320842.135809, 5541625.749826],
    ],
  },
  {
    code: "32637",
    why: "UTM zone 37, at the 36/37 zone boundary",
    proj4: "+proj=utm +zone=37 +a=6378137 +rf=298.257223563 +no_defs",
    pts: [
      [32, 36, 216576.773475, 3544369.909539],
    ],
  },
  {
    code: "32636",
    why: "UTM zone 36, the same point in the neighbouring zone",
    proj4: "+proj=utm +zone=36 +a=6378137 +rf=298.257223563 +no_defs",
    pts: [
      [32, 36, 783423.226525, 3544369.909539],
    ],
  },
  {
    code: "32736",
    why: "UTM zone 36 south, high southern latitude",
    proj4: "+proj=utm +zone=36 +south +a=6378137 +rf=298.257223563 +no_defs",
    pts: [
      [-70, 33, 500000, 2234126.864521],
    ],
  },
  {
    code: "32636",
    why: "UTM zone 36 north, high northern latitude",
    proj4: "+proj=utm +zone=36 +a=6378137 +rf=298.257223563 +no_defs",
    pts: [
      [70, 33, 500000, 7765873.135479],
    ],
  },
  {
    code: "23036",
    why: "ED50 / UTM zone 36N: UTM on the International 1924 ellipsoid + a datum shift",
    proj4: "+proj=utm +zone=36 +a=6378388 +rf=297 +towgs84=-87,-98,-121,0,0,0,0 +no_defs",
    pts: [
      [32.0853, 34.7818, 668192.64825, 3551450.711089],
      [36, 33.5, 545099.107811, 3984238.342325],
    ],
  },
  {
    code: "23239",
    why: "Fahud / UTM zone 39N (Oman): UTM on Clarke 1880 + a datum shift",
    proj4: "+proj=utm +zone=39 +a=6378249.145 +rf=293.465 +towgs84=-345,3,223,0,0,0,0 +no_defs",
    pts: [
      [22, 51, 499730.106899, 2432576.511992],
      [19.5, 52.5, 657140.138194, 2156592.638371],
    ],
  },
  {
    code: "9356",
    why: "KSA-GRF17 / UTM zone 36N: a ROTATION-ONLY Helmert tie",
    proj4: "+proj=utm +zone=36 +a=6378137 +rf=298.257222101 +towgs84=0,0,0,-8.393,0.749,-10.276,0 +no_defs",
    // wgs84ToLocal inverts the Helmert by transposing the rotation matrix rather
    // than inverting it. For this 10-arcsec rotation that costs 13 mm, which is
    // deliberate and far inside any survey requirement.
    invTolM: 0.02,
    pts: [
      [24.7, 34.5, 651945.006099, 2732728.18259],
    ],
  },
  {
    code: "2039",
    why: "ITM (Israel TM): TM + a 7-parameter Helmert",
    proj4: "+proj=tmerc +lat_0=31.734393611111 +lon_0=35.204516944444 +k_0=1.0000067 +x_0=219529.584 +y_0=626907.39 +a=6378137 +rf=298.257222101 +towgs84=23.772,17.49,17.859,0.3132,1.85274,-1.67299,-5.4262 +no_defs",
    pts: [
      [32.0853, 34.7818, 179687.023817, 665937.859886],
      [31, 35, 200061.848878, 545539.322124],
    ],
  },
  {
    code: "2222",
    why: "NAD83 / Arizona East (ft): a TM grid in FEET",
    proj4: "+proj=tmerc +lat_0=31 +lon_0=-110.16666666667 +k_0=0.9999 +x_0=213360 +y_0=0 +a=6378137 +rf=298.257222101 +to_meter=0.3048 +no_defs",
    pts: [
      [33, -110.166666666667, 700000.000001, 727531.30674],
      [34.5, -109.5, 900856.400696, 1273994.428464],
    ],
  },
  {
    code: "2136",
    why: "Accra / Ghana National Grid: TM in feet AND datum-shifted",
    proj4: "+proj=tmerc +lat_0=4.6666666666667 +lon_0=-1 +k_0=0.99975 +x_0=274319.73916336 +y_0=0 +a=6378300 +rf=296 +to_meter=0.30479971018151 +towgs84=-199,32,322,0,0,0,0 +no_defs",
    pts: [
      [6, -1, 899906.446923, 482603.994893],
    ],
  },
  {
    code: "27391",
    why: "NGO 1948 (Oslo) / NGO zone I: TM on a non-Greenwich prime meridian",
    proj4: "+proj=tmerc +lat_0=58 +lon_0=-4.6666666666667 +k_0=1 +x_0=0 +y_0=0 +a=6377492.018 +rf=299.1528128 +pm=10.72291666667 +no_defs",
    pts: [
      [59, 5.5, -31966.930702, 111507.962346],
      [60.5, 6.5, 24383.886044, 278551.836441],
    ],
  },
  {
    code: "20790",
    why: "Lisbon (Lisbon) / Portuguese National Grid: TM on a non-Greenwich PM",
    proj4: "+proj=tmerc +lat_0=39.666666666667 +lon_0=1 +k_0=1 +x_0=200000 +y_0=300000 +a=6378388 +rf=297 +pm=-9.131906111111 +no_defs",
    pts: [
      [39, -8, 211427.06804, 225991.639803],
    ],
  },
];
