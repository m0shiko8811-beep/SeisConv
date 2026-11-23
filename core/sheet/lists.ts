// seisconv-core / sheet - dropdown lists for the Parameters Sheet wizard.
//
// Generic field vocabulary for planning a seismic job (mostly shallow engineering
// work: refraction, MASW, SH reflection, downhole, plus vibroseis 2D and 3D).
// Every list is a SUGGESTION: the wizard offers it as a dropdown, and free typing
// stays allowed exactly as in a hand-kept sheet. No client names, sites or real
// job examples live here (privacy); the Client field remembers values locally.
//
// Pure data: no DOM / Electron.

/** The job types, in the order a planner meets them. Job Type is the first and
 *  central choice of the wizard: picking one fills the presets (presets.ts). */
export const JOB_TYPES: readonly string[] = [
  'Seismic Refraction (P-wave)',
  'Seismic Refraction (S-wave / SH)',
  'MASW (Active)',
  'ReMi / Passive MASW',
  'Shallow 2D Reflection (P)',
  'Shallow 2D Reflection (SH)',
  'Refraction Tomography',
  'Downhole',
  'Crosshole',
  'HVSR (Nakamura)',
  'Vibroseis 2D Reflection',
  '3D Reflection',
  'Fault Investigation (High-Res)',
  'Vs30 Site Classification (SI 413)',
];

/** Survey geometry: drives which Geometry fields the wizard shows. */
export type SurveyGeometry = '2D' | '3D' | 'borehole' | 'point';
export const SURVEY_GEOMETRIES: readonly { value: SurveyGeometry; label: string }[] = [
  { value: '2D', label: '2D line(s)' },
  { value: '3D', label: '3D grid' },
  { value: 'borehole', label: 'Borehole / downhole' },
  { value: 'point', label: 'Passive / point' },
];

/** Point intervals, metres (receiver and source). */
export const INTERVALS_M: readonly number[] = [0.5, 1, 1.5, 2, 2.5, 3, 4, 5, 10, 12.5, 15, 20, 25, 50];

export const SPREAD_TYPES: readonly string[] = [
  'End-on',
  'Split-spread (symmetric)',
  'Split-spread (asymmetric)',
  'Off-end',
  'Roll-along',
  'Fixed spread',
  'Land streamer',
  'Orthogonal',
  'N/A',
];

export const SPREADS: readonly string[] = ['All line live', 'Fixed spread', 'Roll-along', 'Partial live'];

export const CHANNELS: readonly number[] = [3, 12, 24, 48, 72, 96, 120, 144, 192, 240, 360, 480, 960];

/** Sample intervals, milliseconds. */
export const SAMPLE_RATES_MS: readonly number[] = [0.0625, 0.125, 0.25, 0.5, 1, 2, 4];

/** Record lengths, seconds (10 and 30 minutes are passive records). */
export const RECORD_LENGTHS_S: readonly number[] = [0.25, 0.5, 1, 2, 3, 4, 6, 8, 30, 60, 600, 1800];

/** Low-cut corner frequencies, Hz. `null` means no low-cut ("None"). */
export const LOW_CUTS_HZ: readonly (number | null)[] = [null, 2, 4.5, 8, 10, 15, 30, 50, 100];

/** High-cut corner frequencies, Hz. `null` means none; the anti-alias choice is
 *  a separate flag on the model (it follows the sample rate). */
export const HIGH_CUTS_HZ: readonly (number | null)[] = [null, 125, 250, 500, 1000, 2000];

export const NOTCH_HZ: readonly (number | null)[] = [null, 50, 60];

export const GAINS_DB: readonly number[] = [0, 6, 12, 18, 24, 30, 36, 48];

export const DATA_FORMATS: readonly string[] = ['SEG-Y', 'SEG-D', 'SEG-2', 'miniSEED', 'SAF'];

/** Coordinate systems a sheet is usually written in. `code` is the EPSG code the
 *  coordinate engine resolves; '' is a local grid (no geographic position). */
export const COORD_SYSTEMS: readonly { label: string; code: string }[] = [
  { label: 'UTM 36N (WGS84)', code: 'EPSG:32636' },
  { label: 'ITM (Israel TM Grid)', code: 'EPSG:2039' },
  { label: 'ICS (Old Israeli Grid)', code: 'EPSG:28193' },
  { label: 'WGS84 Geographic', code: 'EPSG:4326' },
  { label: 'Local Grid', code: '' },
];

/** What kind of source a type is - decides which source fields are shown. */
export type SourceKind = 'surface' | 'vibrator' | 'impulsive' | 'passive' | 'other';

/** Source types with their kind. The buried impulsive kind is kept generic
 *  (size, depth, pattern, count per point) on purpose. */
export const SOURCE_TYPES: readonly { label: string; kind: SourceKind }[] = [
  { label: 'Sledge Hammer', kind: 'surface' },
  { label: 'Weight Drop', kind: 'surface' },
  { label: 'Accelerated Weight Drop (AWD)', kind: 'surface' },
  { label: 'S-wave Hammer (Beam)', kind: 'surface' },
  { label: 'Vibroseis', kind: 'vibrator' },
  { label: 'Mini-Vibroseis', kind: 'vibrator' },
  { label: 'Electro-dynamic Shaker (ElViS)', kind: 'vibrator' },
  { label: 'Seismic Gun', kind: 'impulsive' },
  { label: 'Buried impulsive source', kind: 'impulsive' },
  { label: 'Sparker', kind: 'impulsive' },
  { label: 'Airgun', kind: 'impulsive' },
  { label: 'Ambient Noise (Passive)', kind: 'passive' },
];

/** The kind of a (possibly free-typed) source type; unknown text is 'other'. */
export function sourceKind(label: string): SourceKind {
  const t = (label || '').trim().toLowerCase();
  if (!t) return 'other';
  const hit = SOURCE_TYPES.find((s) => s.label.toLowerCase() === t);
  if (hit) return hit.kind;
  if (/vib|shaker|sweep/.test(t)) return 'vibrator';
  if (/passive|ambient|noise/.test(t)) return 'passive';
  if (/hammer|weight|drop|awd|beam/.test(t)) return 'surface';
  return 'other';
}

export const TRIGGER_SYSTEMS: readonly string[] = [
  'Hammer Switch (Trigger)',
  'Geophone Trigger',
  'Source Link',
  'Shot Pro',
  'Boom Box',
  'Vib Pro',
  'Pelton Advance II',
  'Force III',
  'Manual / Free run',
];

export const SOURCE_MANUFACTURERS: readonly string[] = ['Universal', 'Generic', 'INOVA', 'Sercel', 'IVI', 'Geometrics', 'Geosym', 'Local made'];

export const WAVE_TYPES: readonly string[] = [
  'P-wave',
  'SH-wave',
  'SV-wave',
  'P + SH',
  'P + SV',
  'Surface wave (Rayleigh)',
  'Surface wave (Love)',
  'Passive / Ambient',
];

export const CORRELATION: readonly string[] = ['Yes', 'No', 'N/A'];

export const STACKS: readonly number[] = [1, 2, 3, 4, 5, 6, 8, 10, 16, 20];

export const PLATES: readonly string[] = [
  'Aluminum plate',
  'Steel plate',
  'HDPE / Rubber plate',
  'S-wave beam (wood/steel)',
  'Borehole source',
  'N/A',
];

/** Recording-system / sensor manufacturers and their models. The model list is
 *  DEPENDENT on the manufacturer, so a model is always spelled one way. */
export const MANUFACTURER_MODELS: Readonly<Record<string, readonly string[]>> = {
  Inova: ['G3i', 'Hawk', 'Quantum', 'Scorpion', 'Aries II'],
  Geometrics: ['Geode', 'StrataVisor NZXP', 'SmartSeis ST', 'Atom'],
  Sercel: ['428XL', '508XT', 'WiNG', 'Unite'],
  DMT: ['SUMMIT X One', 'SUMMIT M'],
  Seistronix: ['RAS-24', 'EX-6'],
  Geospace: ['GSR', 'GCL', 'GSX'],
};
export const MANUFACTURERS: readonly string[] = Object.keys(MANUFACTURER_MODELS);

/** Models offered for a manufacturer (case-insensitive), [] for a free-typed one. */
export function modelsFor(manufacturer: string): readonly string[] {
  const t = (manufacturer || '').trim().toLowerCase();
  for (const k of MANUFACTURERS) if (k.toLowerCase() === t) return MANUFACTURER_MODELS[k];
  return [];
}

/** Phones per station (string / station). */
export const PHONES_PER_STATION: readonly number[] = [1, 2, 3, 6, 12];

/** Geophone natural frequencies, Hz. */
export const GEOPHONE_FREQS_HZ: readonly number[] = [2, 4.5, 10, 14, 28, 40, 100];

export const GEOPHONE_TYPES: readonly string[] = [
  'Vertical (Z)',
  'Horizontal (H)',
  '3-Component (3C)',
  'Borehole 3C',
  'Hydrophone',
  'Land Streamer (Z)',
  'Land Streamer (H)',
  'Nodes',
];

/** True when a geophone type records horizontal motion (SH work needs it). */
export function isHorizontalPhone(type: string): boolean {
  const t = (type || '').toLowerCase();
  return /horizontal|\(h\)|3c|3-component/.test(t);
}

export const AUX_CHANNELS: readonly string[] = ['Time Break', 'Uphole', 'Pilot / Reference Sweep', 'Confirmation TB', 'None'];

export const WEATHER: readonly string[] = [
  'Clear / Calm',
  'Windy',
  'Rain',
  'Hot',
  'Traffic noise',
  'Industrial noise',
  'Construction nearby',
];

export const SWEEP_TYPES: readonly string[] = ['Linear', 'Logarithmic'];
