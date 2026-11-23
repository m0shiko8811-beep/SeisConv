// seisconv-core / sheet - recommended defaults per job type.
//
// Choosing a Job Type in the Parameters Sheet wizard fills these values; every
// one stays editable. A planner's own table gives most recommendations as RANGES
// ("1-2.5 m", "4-8 per polarity"), so each preset carries ONE numeric default the
// form can hold as a real number, plus the recommended range as a text hint shown
// next to the field. The hint is never written as the value.
//
// Pure data: no DOM / Electron.

import type { SurveyGeometry } from './lists';

export interface JobPreset {
  jobType: string;
  geometry: SurveyGeometry;
  waveType: string;
  rxIntervalM: number | null;
  sxIntervalM: number | null;
  sourceOffsetM: number | null;
  sampleRateMs: number;
  recordLengthS: number;
  /** null = no low-cut. */
  lowCutHz: number | null;
  sourceType: string;
  stack: number;
  geophoneFreqHz: number;
  geophoneType: string;
  spreadType: string;
  channels: number;
  /** Vibroseis sweep defaults (vibrator sources only). */
  sweep?: { startHz: number; endHz: number; lengthS: number; taperS: number; type: string };
  /** The recommended ranges, as text, keyed by the model field they describe. */
  hints: Partial<Record<'rxInterval' | 'sxInterval' | 'sampleRate' | 'recordLength' | 'lowCut' | 'source' | 'stack' | 'geophoneFreq' | 'geophoneType' | 'spreadType' | 'channels', string>>;
  /** One-line planning note for the job type. */
  note: string;
}

export const JOB_PRESETS: readonly JobPreset[] = [
  {
    jobType: 'Seismic Refraction (P-wave)', geometry: '2D', waveType: 'P-wave',
    rxIntervalM: 5, sxIntervalM: 15, sourceOffsetM: null, sampleRateMs: 0.25, recordLengthS: 0.5, lowCutHz: null,
    sourceType: 'Sledge Hammer', stack: 4, geophoneFreqHz: 14, geophoneType: 'Vertical (Z)', spreadType: 'Split-spread (symmetric)', channels: 48,
    hints: { rxInterval: '5 m', sxInterval: '15-30 m (every 3-6 receivers)', sampleRate: '0.25 ms', recordLength: '0.5 s', lowCut: 'None', source: 'Sledge hammer / weight drop', stack: '4-8', geophoneFreq: '10-14 Hz', geophoneType: 'Vertical (Z)', spreadType: 'Split-spread + off-end shots', channels: '24-48' },
    note: 'Shots at both ends, centre and off-ends (at least one spread length).',
  },
  {
    jobType: 'Seismic Refraction (S-wave / SH)', geometry: '2D', waveType: 'SH-wave',
    rxIntervalM: 2, sxIntervalM: 10, sourceOffsetM: null, sampleRateMs: 0.25, recordLengthS: 1, lowCutHz: null,
    sourceType: 'S-wave Hammer (Beam)', stack: 5, geophoneFreqHz: 14, geophoneType: 'Horizontal (H)', spreadType: 'Split-spread (symmetric)', channels: 24,
    hints: { rxInterval: '2-5 m', sxInterval: '10-25 m', sampleRate: '0.25 ms', recordLength: '1.0 s', lowCut: 'None', source: 'S-wave hammer (beam)', stack: '5-10 per polarity', geophoneFreq: '10-14 Hz', geophoneType: 'Horizontal (H)', spreadType: 'Split-spread', channels: '24-48' },
    note: 'Record left and right hits; subtract them to enhance SH.',
  },
  {
    jobType: 'MASW (Active)', geometry: '2D', waveType: 'Surface wave (Rayleigh)',
    rxIntervalM: 1, sxIntervalM: 5, sourceOffsetM: 5, sampleRateMs: 0.5, recordLengthS: 1, lowCutHz: null,
    sourceType: 'Sledge Hammer', stack: 5, geophoneFreqHz: 4.5, geophoneType: 'Vertical (Z)', spreadType: 'End-on', channels: 24,
    hints: { rxInterval: '1-2 m', sxInterval: 'Off-end 5-10 m', sampleRate: '0.5 ms', recordLength: '1.0 s', lowCut: 'None', source: 'Sledge hammer / AWD', stack: '5-10', geophoneFreq: '4.5 Hz', geophoneType: 'Vertical (Z)', spreadType: 'End-on (forward and reverse)', channels: '24-48' },
    note: 'Array length about 2-3x the target depth; shoot both ends.',
  },
  {
    jobType: 'ReMi / Passive MASW', geometry: '2D', waveType: 'Passive / Ambient',
    rxIntervalM: 2, sxIntervalM: null, sourceOffsetM: null, sampleRateMs: 2, recordLengthS: 30, lowCutHz: null,
    sourceType: 'Ambient Noise (Passive)', stack: 10, geophoneFreqHz: 4.5, geophoneType: 'Vertical (Z)', spreadType: 'Fixed spread', channels: 24,
    hints: { rxInterval: '2-5 m', sxInterval: 'N/A', sampleRate: '2 ms', recordLength: '30 s', lowCut: 'None', source: 'Ambient noise (passive)', stack: '10-20 records', geophoneFreq: '4.5 Hz', geophoneType: 'Vertical (Z)', spreadType: 'Fixed linear / L-shape', channels: '24-48' },
    note: 'Record during traffic hours; at least 10 records of 30 s.',
  },
  {
    jobType: 'Shallow 2D Reflection (P)', geometry: '2D', waveType: 'P-wave',
    rxIntervalM: 2, sxIntervalM: 4, sourceOffsetM: null, sampleRateMs: 0.25, recordLengthS: 0.5, lowCutHz: 15,
    sourceType: 'Weight Drop', stack: 2, geophoneFreqHz: 28, geophoneType: 'Vertical (Z)', spreadType: 'Split-spread (symmetric)', channels: 120,
    hints: { rxInterval: '1-2.5 m', sxInterval: '2-5 m', sampleRate: '0.25 ms', recordLength: '0.5 s', lowCut: '15-30 Hz', source: 'Weight drop / seismic gun', stack: '2-4', geophoneFreq: '28-40 Hz', geophoneType: 'Vertical (Z)', spreadType: 'Split-spread / roll-along', channels: '96-240' },
    note: 'Target fold at least 24; keep near offsets short.',
  },
  {
    jobType: 'Shallow 2D Reflection (SH)', geometry: '2D', waveType: 'SH-wave',
    rxIntervalM: 1, sxIntervalM: 2, sourceOffsetM: null, sampleRateMs: 0.5, recordLengthS: 1, lowCutHz: null,
    sourceType: 'S-wave Hammer (Beam)', stack: 4, geophoneFreqHz: 14, geophoneType: 'Horizontal (H)', spreadType: 'Land streamer', channels: 48,
    hints: { rxInterval: '1 m', sxInterval: '2 m', sampleRate: '0.5 ms', recordLength: '1.0 s', lowCut: 'None', source: 'S-wave hammer / ElViS', stack: '4-8 per polarity', geophoneFreq: '10-14 Hz', geophoneType: 'Horizontal (H)', spreadType: 'Land streamer / roll-along', channels: '48-120' },
    note: 'High resolution in soft sediments; record both polarities.',
  },
  {
    jobType: 'Refraction Tomography', geometry: '2D', waveType: 'P-wave',
    rxIntervalM: 5, sxIntervalM: 15, sourceOffsetM: null, sampleRateMs: 0.25, recordLengthS: 0.5, lowCutHz: null,
    sourceType: 'Accelerated Weight Drop (AWD)', stack: 4, geophoneFreqHz: 14, geophoneType: 'Vertical (Z)', spreadType: 'Split-spread (symmetric)', channels: 48,
    hints: { rxInterval: '2-5 m', sxInterval: 'Every 2-4 receivers', sampleRate: '0.25 ms', recordLength: '0.5 s', lowCut: 'None', source: 'Sledge hammer / AWD', stack: '4-8', geophoneFreq: '10-14 Hz', geophoneType: 'Vertical (Z)', spreadType: 'All line live', channels: '48-120' },
    note: 'Dense shots for ray coverage; add off-end shots.',
  },
  {
    jobType: 'Downhole', geometry: 'borehole', waveType: 'P + SH',
    rxIntervalM: 1, sxIntervalM: null, sourceOffsetM: 2.5, sampleRateMs: 0.125, recordLengthS: 0.25, lowCutHz: null,
    sourceType: 'S-wave Hammer (Beam)', stack: 3, geophoneFreqHz: 14, geophoneType: 'Borehole 3C', spreadType: 'N/A', channels: 3,
    hints: { rxInterval: '1 m (depth)', sxInterval: 'Source 2-3 m from the collar', sampleRate: '0.0625-0.125 ms', recordLength: '0.25 s', lowCut: 'None', source: 'S-wave hammer (beam) + plate', stack: '3-5 per polarity', geophoneFreq: '10-28 Hz', geophoneType: 'Borehole 3C', spreadType: 'Single borehole', channels: '3-24' },
    note: 'Clamp the tool at each depth; record both SH polarities.',
  },
  {
    jobType: 'Crosshole', geometry: 'borehole', waveType: 'P + SH',
    rxIntervalM: 1, sxIntervalM: 1, sourceOffsetM: null, sampleRateMs: 0.0625, recordLengthS: 0.25, lowCutHz: null,
    sourceType: 'Sparker', stack: 3, geophoneFreqHz: 28, geophoneType: 'Borehole 3C', spreadType: 'N/A', channels: 3,
    hints: { rxInterval: '1 m (depth)', sxInterval: '1 m (depth)', sampleRate: '0.0625 ms', recordLength: '0.25 s', lowCut: 'None', source: 'Borehole source', stack: '3-5', geophoneFreq: '28-100 Hz', geophoneType: 'Borehole 3C', spreadType: 'Source and receiver at the same elevation', channels: '3-24' },
    note: 'A borehole deviation survey is required (ASTM D4428).',
  },
  {
    jobType: 'HVSR (Nakamura)', geometry: 'point', waveType: 'Passive / Ambient',
    rxIntervalM: null, sxIntervalM: null, sourceOffsetM: null, sampleRateMs: 4, recordLengthS: 1800, lowCutHz: null,
    sourceType: 'Ambient Noise (Passive)', stack: 1, geophoneFreqHz: 2, geophoneType: '3-Component (3C)', spreadType: 'N/A', channels: 3,
    hints: { rxInterval: 'N/A', sxInterval: 'N/A', sampleRate: '4 ms', recordLength: '30 min', lowCut: 'None', source: 'Ambient noise (passive)', stack: '1', geophoneFreq: '2 Hz / broadband', geophoneType: '3-Component (3C)', spreadType: 'Single station', channels: '3' },
    note: 'Avoid wind and rain; good ground coupling (SESAME guidelines).',
  },
  {
    jobType: 'Vibroseis 2D Reflection', geometry: '2D', waveType: 'P-wave',
    rxIntervalM: 10, sxIntervalM: 20, sourceOffsetM: null, sampleRateMs: 2, recordLengthS: 4, lowCutHz: 8,
    sourceType: 'Vibroseis', stack: 2, geophoneFreqHz: 10, geophoneType: 'Vertical (Z)', spreadType: 'Split-spread (symmetric)', channels: 480,
    sweep: { startHz: 8, endHz: 90, lengthS: 12, taperS: 0.5, type: 'Linear' },
    hints: { rxInterval: '10-25 m', sxInterval: '20-50 m', sampleRate: '2 ms', recordLength: '4.0 s (correlated)', lowCut: '8 Hz', source: 'Vibroseis', stack: '2-4 sweeps', geophoneFreq: '10 Hz', geophoneType: 'Vertical (Z)', spreadType: 'Split-spread / roll-along', channels: '240-960' },
    note: 'Typical sweep: linear 8-90 Hz, 12 s, 0.5 s tapers.',
  },
  {
    jobType: '3D Reflection', geometry: '3D', waveType: 'P-wave',
    rxIntervalM: 10, sxIntervalM: 20, sourceOffsetM: null, sampleRateMs: 2, recordLengthS: 4, lowCutHz: 8,
    sourceType: 'Vibroseis', stack: 2, geophoneFreqHz: 10, geophoneType: 'Vertical (Z)', spreadType: 'Orthogonal', channels: 960,
    sweep: { startHz: 8, endHz: 90, lengthS: 12, taperS: 0.5, type: 'Linear' },
    hints: { rxInterval: '5-25 m', sxInterval: '5-50 m', sampleRate: '1-2 ms', recordLength: '2.0-4.0 s', lowCut: '8 Hz', source: 'Vibroseis or an impulsive source', stack: '1-4', geophoneFreq: '10 Hz', geophoneType: 'Vertical (Z) / nodes', spreadType: 'Orthogonal / brick', channels: '1000+' },
    note: 'Check bin size, fold, offset and azimuth distribution.',
  },
  {
    jobType: 'Fault Investigation (High-Res)', geometry: '2D', waveType: 'P-wave',
    rxIntervalM: 1, sxIntervalM: 2, sourceOffsetM: null, sampleRateMs: 0.25, recordLengthS: 0.5, lowCutHz: null,
    sourceType: 'Weight Drop', stack: 4, geophoneFreqHz: 28, geophoneType: 'Vertical (Z)', spreadType: 'Split-spread (symmetric)', channels: 120,
    hints: { rxInterval: '0.5-1 m', sxInterval: '1-2 m', sampleRate: '0.125-0.25 ms', recordLength: '0.5-1.0 s', lowCut: 'None / 30 Hz', source: 'Weight drop / seismic gun / SH beam', stack: '4-8', geophoneFreq: '28-40 Hz (P) / 14 Hz (SH)', geophoneType: 'Vertical (Z) / Horizontal (H)', spreadType: 'Split-spread / roll-along', channels: '96-240' },
    note: 'Line perpendicular to the fault; extend at least 2x the target depth each side.',
  },
  {
    jobType: 'Vs30 Site Classification (SI 413)', geometry: '2D', waveType: 'Surface wave (Rayleigh)',
    rxIntervalM: 2, sxIntervalM: 5, sourceOffsetM: 5, sampleRateMs: 0.5, recordLengthS: 2, lowCutHz: null,
    sourceType: 'Sledge Hammer', stack: 5, geophoneFreqHz: 4.5, geophoneType: 'Vertical (Z)', spreadType: 'End-on', channels: 24,
    hints: { rxInterval: '1-2 m', sxInterval: 'Off-end 5-10 m', sampleRate: '0.5 ms', recordLength: '2.0 s', lowCut: 'None', source: 'Sledge hammer + S-wave beam', stack: '5-10', geophoneFreq: '4.5 Hz (Z) / 14 Hz (H)', geophoneType: 'Vertical (Z) + Horizontal (H)', spreadType: 'End-on + split', channels: '24-48' },
    note: 'Combine MASW and SH refraction; reach at least 30 m depth.',
  },
];

/** The preset for a job type (exact, case-insensitive), or null. */
export function presetFor(jobType: string): JobPreset | null {
  const t = (jobType || '').trim().toLowerCase();
  if (!t) return null;
  return JOB_PRESETS.find((p) => p.jobType.toLowerCase() === t) ?? null;
}

/** True for job types whose array length should reach about 2x target depth. */
export function isMaswJob(jobType: string): boolean {
  return /masw|vs30|remi/i.test(jobType || '');
}

/** True for job types that rely on horizontally polarised shear waves. */
export function isShJob(jobType: string, waveType: string): boolean {
  return /\bsh\b|s-wave/i.test(jobType || '') || /\bsh\b/i.test(waveType || '');
}
