'use strict';
/*
 * Keys, scales, and pitch helpers for Melogen.
 */

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

const SCALES = {
  major:      { name: 'Major',      intervals: [0, 2, 4, 5, 7, 9, 11] },
  minor:      { name: 'Natural Minor', intervals: [0, 2, 3, 5, 7, 8, 10] },
  dorian:     { name: 'Dorian',     intervals: [0, 2, 3, 5, 7, 9, 10] },
  phrygian:   { name: 'Phrygian',   intervals: [0, 1, 3, 5, 7, 8, 10] },
  lydian:     { name: 'Lydian',     intervals: [0, 2, 4, 6, 7, 9, 11] },
  mixolydian: { name: 'Mixolydian', intervals: [0, 2, 4, 5, 7, 9, 10] },
  pentMajor:  { name: 'Pentatonic Maj', intervals: [0, 2, 4, 7, 9] },
  pentMinor:  { name: 'Pentatonic Min', intervals: [0, 3, 5, 7, 10] },
  blues:      { name: 'Blues',      intervals: [0, 3, 5, 6, 7, 10] },
  chromatic:  { name: 'Chromatic',  intervals: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] },
  whole:      { name: 'Whole Tone', intervals: [0, 2, 4, 6, 8, 10] },
  harmonic:   { name: 'Harmonic Minor', intervals: [0, 2, 3, 5, 7, 8, 11] },
};

function midiToName(midi) {
  const n = ((midi % 12) + 12) % 12;
  const oct = Math.floor(midi / 12) - 1;
  return NOTE_NAMES[n] + oct;
}

function scaleDegrees(root, scaleKey) {
  const sc = SCALES[scaleKey] || SCALES.major;
  return sc.intervals.map((i) => (root + i) % 12);
}

/** All MIDI pitches in [lo, hi] that belong to the scale. */
function scalePitches(root, scaleKey, lo, hi) {
  const deg = new Set(scaleDegrees(root, scaleKey));
  const out = [];
  for (let p = lo; p <= hi; p++) {
    if (deg.has(((p % 12) + 12) % 12)) out.push(p);
  }
  return out;
}

function nearestInScale(pitch, root, scaleKey) {
  const deg = scaleDegrees(root, scaleKey);
  const pc = ((pitch % 12) + 12) % 12;
  let bestPc = deg[0], bd = 99;
  for (const d of deg) {
    const dist = Math.min((d - pc + 12) % 12, (pc - d + 12) % 12);
    if (dist < bd) { bd = dist; bestPc = d; }
  }
  let signed = (bestPc - pc + 12) % 12;
  if (signed > 6) signed -= 12;
  return clampInt(pitch + signed, 0, 127);
}

function pickFrom(arr, rng) {
  if (!arr.length) return null;
  return arr[Math.floor(rng() * arr.length) % arr.length];
}
