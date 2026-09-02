# Freeze a compact set of PROJ-computed golden vectors into a TS fixture, so
# core/__tests__ can check the projection engine WITHOUT pyproj installed.
#
#   pip install pyproj && python scripts/gen-golden-proj.py
#
# Run this ONLY when the supported-projection list changes, and say so in the
# commit: these values are the independent check on our own arithmetic, so they
# must come from PROJ and must never be "corrected" to match our output.
import json
from pyproj import CRS, Transformer

reg = json.load(open('core/sps/epsg-registry.json'))
rows = {r['c']: r for r in reg['rows']}

# Two representative, widely-used CRSs per method, chosen to exercise the
# variants: LCC 2SP + 1SP, Mercator A + B(sphere), polar + oblique stereographic,
# conic + azimuthal equal-area, and a feet-based grid for the unit scaling.
PICKS = [
    ('2154',  'LCC 2SP, France Lambert-93'),
    ('3034',  'LCC 2SP, Europe'),
    ('2285',  'LCC 2SP in US survey feet'),
    ('3395',  'Mercator variant A, World Mercator'),
    ('3857',  'Mercator on a SPHERE (Pseudo-Mercator)'),
    ('5331',  'Mercator from the Jakarta prime meridian'),
    ('2099',  'Cassini-Soldner, Qatar'),
    ('3377',  'Cassini-Soldner, Johor'),
    ('5070',  'Albers Equal Area, Conus'),
    ('3577',  'Albers Equal Area, Australia'),
    ('3035',  'Lambert Azimuthal Equal Area, Europe'),
    ('6931',  'Lambert Azimuthal Equal Area, North Pole'),
    ('3031',  'Polar Stereographic, Antarctic'),
    ('3413',  'Polar Stereographic variant B, Arctic'),
    ('28992', 'Oblique Stereographic, Netherlands RD New'),
    ('31600', 'Oblique Stereographic, Romania Stereo 33'),
]

out = []
for code, why in PICKS:
    r = rows[code]
    crs = CRS.from_epsg(int(code))
    geo = crs.geodetic_crs
    fwd = Transformer.from_crs(geo, crs, always_xy=True)
    lat0 = r.get('lat0') or 0
    lon0 = (r.get('lon0') or 0)
    pts = []
    for dLat, dLon in [(0.0, 0.0), (1.25, 1.75), (-1.25, -1.75)]:
        lat, lon = lat0 + dLat, lon0 + dLon
        if abs(lat) > 89:
            lat = 85.0 if lat > 0 else -85.0
        E, N = fwd.transform(lon, lat)
        if not (abs(E) < 1e12 and abs(N) < 1e12):
            continue
        pts.append((round(lat, 9), round(lon, 9), round(E, 6), round(N, 6)))
    out.append({'code': code, 'why': why, 'method': r['m'], 'name': r['n'], 'pts': pts})

lines = [
    '// seisconv-core - GOLDEN projection vectors, computed by PROJ (pyproj).',
    '//',
    '// Frozen reference values for core/projections.ts. Each entry is a real EPSG',
    '// CRS; each point is [lat, lon, easting, northing] with the coordinates as',
    '// PROJ produces them from the CRS\'s OWN geodetic CRS, so the numbers test the',
    '// PROJECTION maths alone and no datum transformation is involved.',
    '//',
    '// Regenerate only if the supported-method list changes, and say so in the PR:',
    '// these are the external check on our own arithmetic, so they must come from',
    '// PROJ and never be "corrected" to match our output.',
    '',
    'export interface GoldenProjCase {',
    '  code: string;',
    '  name: string;',
    '  method: string;',
    '  why: string;',
    '  /** [lat, lon, E, N] */',
    '  pts: [number, number, number, number][];',
    '}',
    '',
    'export const GOLDEN_PROJ: GoldenProjCase[] = [',
]
for o in out:
    lines.append('  {')
    lines.append(f"    code: '{o['code']}', method: '{o['method']}',")
    lines.append(f"    name: {json.dumps(o['name'])},")
    lines.append(f"    why: {json.dumps(o['why'])},")
    lines.append('    pts: [')
    for p in o['pts']:
        lines.append(f'      [{p[0]}, {p[1]}, {p[2]}, {p[3]}],')
    lines.append('    ],')
    lines.append('  },')
lines.append('];')
lines.append('')
open('core/__tests__/golden-proj.ts', 'w', encoding='utf-8').write('\n'.join(lines))
print('wrote core/__tests__/golden-proj.ts with', len(out), 'CRSs and', sum(len(o['pts']) for o in out), 'points')
