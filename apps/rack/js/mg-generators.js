/* Namespaced Melogen copy for the rack: colliding / shared symbols prefixed MG_*.
 * Source: ../melogen/js/generators.js — regenerate (re-copy + re-prefix) if Melogen generators change. */
'use strict';
/*
 * Pluggable melody generators for Melogen.
 * Each generator: generate(params) -> Note[]
 * Shared params: key (0–11), scale, length (beats), density (0–1),
 *                octLo, octHi, seed, velocity, gate (duration in beats for rhythm slots)
 */

const MG_MOTIF_BANK = [
  // short built-in motifs as scale-degree sequences (0 = root)
  [0, 2, 4, 2, 0, 4, 5, 4],
  [0, 0, 4, 4, 5, 5, 4, 4],
  [0, 2, 3, 5, 3, 2, 0, 0],
  [4, 2, 0, 2, 4, 4, 4, 2],
  [0, 4, 7, 4, 0, 4, 7, 9],
  [0, 3, 5, 3, 0, -2, 0, 3],
  [7, 5, 4, 2, 0, 2, 4, 5],
  [0, 2, 4, 5, 7, 5, 4, 2],
];

const MG_GENERATORS = {};

function MG_baseParams(p) {
  const length = Math.max(0.25, +(p.length != null ? p.length : 8));
  const density = Math.max(0, Math.min(1, +(p.density != null ? p.density : 0.5)));
  const key = MG_clampInt(p.key != null ? p.key : 0, 0, 11);
  const scale = p.scale || 'major';
  const octLo = MG_clampInt(p.octLo != null ? p.octLo : 3, 0, 8);
  const octHi = MG_clampInt(p.octHi != null ? p.octHi : 5, octLo, 8);
  const seed = MG_parseSeed(p.seed);
  const rng = MG_mulberry32(seed);
  const velocity = MG_clampInt(p.velocity != null ? p.velocity : 100, 1, 127);
  const gate = Math.max(1 / 32, +(p.gate != null ? p.gate : 0.25));
  const step = Math.max(1 / 32, +(p.step != null ? p.step : 0.25)); // rhythmic grid
  const pitches = MG_scalePitches(key, scale, octLo * 12, octHi * 12 + 11);
  return { length, density, key, scale, octLo, octHi, seed, rng, velocity, gate, step, pitches };
}

/* ---- Random in scale ---- */
MG_GENERATORS.random = {
  id: 'random',
  name: 'Random in scale',
  params: [
    { id: 'step', label: 'step', type: 'select', options: [
      { v: 0.25, t: '1/4' }, { v: 0.125, t: '1/8' }, { v: 0.0625, t: '1/16' }, { v: 0.5, t: '1/2' },
    ], def: 0.25 },
    { id: 'gate', label: 'gate', type: 'select', options: [
      { v: 0.125, t: '1/8' }, { v: 0.25, t: '1/4' }, { v: 0.5, t: '1/2' }, { v: 0.0625, t: '1/16' },
    ], def: 0.25 },
  ],
  generate(p) {
    const b = MG_baseParams(p);
    const notes = [];
    if (!b.pitches.length) return notes;
    for (let t = 0; t < b.length - 1e-9; t += b.step) {
      if (b.rng() > b.density) continue;
      const pitch = MG_pickFrom(b.pitches, b.rng);
      const dur = Math.min(b.gate, b.length - t);
      const vel = MG_clampInt(b.velocity + Math.floor((b.rng() - 0.5) * 30), 40, 127);
      notes.push(MG_makeNote(pitch, +t.toFixed(6), dur, vel));
    }
    return notes;
  },
};

/* ---- Markov (from current pattern or motif bank) ---- */
MG_GENERATORS.markov = {
  id: 'markov',
  name: 'Markov',
  params: [
    { id: 'order', label: 'order', type: 'range', min: 1, max: 3, step: 1, def: 1 },
    { id: 'step', label: 'step', type: 'select', options: [
      { v: 0.25, t: '1/4' }, { v: 0.125, t: '1/8' }, { v: 0.0625, t: '1/16' },
    ], def: 0.25 },
    { id: 'gate', label: 'gate', type: 'select', options: [
      { v: 0.125, t: '1/8' }, { v: 0.25, t: '1/4' }, { v: 0.5, t: '1/2' },
    ], def: 0.25 },
    { id: 'source', label: 'source', type: 'select', options: [
      { v: 'auto', t: 'pattern / motifs' }, { v: 'motifs', t: 'motifs only' }, { v: 'pattern', t: 'pattern only' },
    ], def: 'auto' },
  ],
  generate(p) {
    const b = MG_baseParams(p);
    const order = MG_clampInt(p.order != null ? p.order : 1, 1, 3);
    const source = p.source || 'auto';
    const chain = MG_buildMarkov(p.currentNotes || [], b, order, source);
    const notes = [];
    if (!b.pitches.length) return notes;

    // start state
    let state = [];
    const starts = Object.keys(chain);
    if (starts.length) {
      const key = MG_pickFrom(starts, b.rng);
      state = key === '' ? [] : key.split(',').map(Number);
    } else {
      state = [MG_pickFrom(b.pitches, b.rng)];
    }

    for (let t = 0; t < b.length - 1e-9; t += b.step) {
      if (b.rng() > Math.max(0.15, b.density)) continue;
      const next = MG_markovNext(chain, state, order, b);
      state = state.concat(next).slice(-order);
      const dur = Math.min(b.gate, b.length - t);
      const vel = MG_clampInt(b.velocity + Math.floor((b.rng() - 0.5) * 24), 40, 127);
      notes.push(MG_makeNote(next, +t.toFixed(6), dur, vel));
    }
    return notes;
  },
};

function MG_buildMarkov(currentNotes, b, order, source) {
  const sequences = [];
  const usePattern = source !== 'motifs' && currentNotes && currentNotes.length >= 2;
  const useMotifs = source !== 'pattern' || !usePattern;

  if (usePattern) {
    const sorted = MG_sortNotes(currentNotes);
    sequences.push(sorted.map((n) => n.pitch));
  }
  if (useMotifs || !sequences.length) {
    const rootMidi = b.key + b.octLo * 12;
    for (const motif of MG_MOTIF_BANK) {
      const seq = motif.map((deg) => {
        const iv = MG_SCALES[b.scale] ? MG_SCALES[b.scale].intervals : MG_SCALES.major.intervals;
        const n = iv.length;
        let d = deg;
        let oct = 0;
        while (d < 0) { d += n; oct--; }
        while (d >= n) { d -= n; oct++; }
        return MG_clampInt(rootMidi + iv[d] + oct * 12, 0, 127);
      });
      sequences.push(seq);
    }
  }

  const chain = Object.create(null);
  for (const seq of sequences) {
    for (let i = 0; i < seq.length; i++) {
      const from = seq.slice(Math.max(0, i - order), i).join(',');
      const to = seq[i];
      if (!chain[from]) chain[from] = [];
      chain[from].push(to);
    }
  }
  return chain;
}

function MG_markovNext(chain, state, order, b) {
  const key = state.slice(-order).join(',');
  let opts = chain[key];
  if (!opts || !opts.length) opts = chain[''];
  if (!opts || !opts.length) {
    // fallback: any value in chain or scale
    const all = [];
    for (const k of Object.keys(chain)) all.push(...chain[k]);
    if (all.length) return MG_pickFrom(all, b.rng);
    return MG_pickFrom(b.pitches, b.rng);
  }
  let pitch = MG_pickFrom(opts, b.rng);
  // snap into available pitch range / scale if needed
  if (b.pitches.indexOf(pitch) < 0) {
    pitch = MG_nearestInScale(pitch, b.key, b.scale);
    // clamp to oct range
    while (pitch < b.octLo * 12) pitch += 12;
    while (pitch > b.octHi * 12 + 11) pitch -= 12;
    if (b.pitches.indexOf(pitch) < 0) pitch = MG_pickFrom(b.pitches, b.rng);
  }
  return pitch;
}

/* ---- Euclidean rhythm + scale pitches ---- */
MG_GENERATORS.euclidean = {
  id: 'euclidean',
  name: 'Euclidean',
  params: [
    { id: 'pulses', label: 'pulses', type: 'range', min: 1, max: 32, step: 1, def: 5 },
    { id: 'steps', label: 'steps', type: 'range', min: 1, max: 32, step: 1, def: 16 },
    { id: 'rotation', label: 'rotate', type: 'range', min: 0, max: 31, step: 1, def: 0 },
    { id: 'gate', label: 'gate', type: 'select', options: [
      { v: 0.125, t: '1/8' }, { v: 0.25, t: '1/4' }, { v: 0.5, t: '1/2' }, { v: 0.0625, t: '1/16' },
    ], def: 0.25 },
    { id: 'pitchMode', label: 'pitches', type: 'select', options: [
      { v: 'walk', t: 'random walk' }, { v: 'cycle', t: 'cycle up' }, { v: 'random', t: 'random' },
    ], def: 'walk' },
  ],
  generate(p) {
    const b = MG_baseParams(p);
    const steps = MG_clampInt(p.steps != null ? p.steps : 16, 1, 64);
    const pulses = MG_clampInt(p.pulses != null ? p.pulses : 5, 1, steps);
    const rotation = MG_clampInt(p.rotation != null ? p.rotation : 0, 0, steps - 1);
    const pattern = MG_euclideanPattern(pulses, steps, rotation);
    const stepDur = b.length / steps;
    const notes = [];
    if (!b.pitches.length) return notes;

    const mode = p.pitchMode || 'walk';
    let idx = Math.floor(b.rng() * b.pitches.length);
    for (let i = 0; i < steps; i++) {
      if (!pattern[i]) continue;
      if (mode === 'random') idx = Math.floor(b.rng() * b.pitches.length);
      else if (mode === 'cycle') idx = (idx + 1) % b.pitches.length;
      else {
        // random walk
        const delta = Math.floor(b.rng() * 5) - 2;
        idx = Math.max(0, Math.min(b.pitches.length - 1, idx + delta));
      }
      const t = i * stepDur;
      const dur = Math.min(b.gate, b.length - t, stepDur * 0.95);
      const vel = MG_clampInt(b.velocity + Math.floor((b.rng() - 0.5) * 20), 40, 127);
      notes.push(MG_makeNote(b.pitches[idx], +t.toFixed(6), dur, vel));
    }
    return notes;
  },
};

/** Bjorklund / Euclidean rhythm: pulses distributed over steps. */
function MG_euclideanPattern(pulses, steps, rotation) {
  pulses = Math.max(0, Math.min(steps, pulses | 0));
  steps = Math.max(1, steps | 0);
  const pat = new Array(steps).fill(0);
  if (pulses === 0) return pat;
  // classic bjorklund
  let bucket = 0;
  for (let i = 0; i < steps; i++) {
    bucket += pulses;
    if (bucket >= steps) {
      bucket -= steps;
      pat[i] = 1;
    }
  }
  // rotate
  const r = ((rotation % steps) + steps) % steps;
  if (r) return pat.slice(r).concat(pat.slice(0, r));
  return pat;
}

/* ---- Contour / arp ---- */
MG_GENERATORS.contour = {
  id: 'contour',
  name: 'Contour / Arp',
  params: [
    { id: 'direction', label: 'direction', type: 'select', options: [
      { v: 'up', t: 'up' }, { v: 'down', t: 'down' },
      { v: 'updown', t: 'up-down' }, { v: 'downup', t: 'down-up' },
      { v: 'random', t: 'random' },
    ], def: 'up' },
    { id: 'step', label: 'step', type: 'select', options: [
      { v: 0.25, t: '1/4' }, { v: 0.125, t: '1/8' }, { v: 0.0625, t: '1/16' }, { v: 0.5, t: '1/2' },
    ], def: 0.125 },
    { id: 'gate', label: 'gate', type: 'select', options: [
      { v: 0.0625, t: '1/16' }, { v: 0.125, t: '1/8' }, { v: 0.25, t: '1/4' }, { v: 0.5, t: '1/2' },
    ], def: 0.125 },
    { id: 'octaves', label: 'arp octs', type: 'range', min: 1, max: 3, step: 1, def: 1 },
  ],
  generate(p) {
    const b = MG_baseParams(p);
    const dir = p.direction || 'up';
    const octs = MG_clampInt(p.octaves != null ? p.octaves : 1, 1, 3);
    const notes = [];
    if (!b.pitches.length) return notes;

    // build arp pool: scale pitches spanning octLo..octLo+octs
    const lo = b.octLo * 12;
    const hi = Math.min(127, (b.octLo + octs) * 12 - 1);
    let pool = MG_scalePitches(b.key, b.scale, lo, hi);
    if (!pool.length) pool = b.pitches.slice();
    pool = pool.slice().sort((a, c) => a - c);

    const seq = MG_buildContourSequence(pool, dir, b.rng);
    let si = 0;
    for (let t = 0; t < b.length - 1e-9; t += b.step) {
      // density can thin the arp
      if (b.density < 0.99 && b.rng() > Math.max(0.2, b.density)) {
        si = (si + 1) % seq.length;
        continue;
      }
      const pitch = seq[si % seq.length];
      si++;
      const dur = Math.min(b.gate, b.length - t, b.step * 0.95);
      const vel = MG_clampInt(b.velocity + Math.floor((b.rng() - 0.5) * 18), 40, 127);
      notes.push(MG_makeNote(pitch, +t.toFixed(6), dur, vel));
    }
    return notes;
  },
};

function MG_buildContourSequence(pool, dir, rng) {
  if (pool.length <= 1) return pool.slice();
  if (dir === 'up') return pool.slice();
  if (dir === 'down') return pool.slice().reverse();
  if (dir === 'updown') {
    if (pool.length < 3) return pool.concat(pool.slice().reverse().slice(1));
    return pool.concat(pool.slice(1, -1).reverse());
  }
  if (dir === 'downup') {
    const down = pool.slice().reverse();
    if (pool.length < 3) return down.concat(pool.slice(1));
    return down.concat(down.slice(1, -1).reverse());
  }
  // random shuffle (deterministic via rng)
  const a = pool.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = a[i]; a[i] = a[j]; a[j] = tmp;
  }
  return a;
}

function MG_listGenerators() {
  return Object.keys(MG_GENERATORS).map((id) => ({ id, name: MG_GENERATORS[id].name, params: MG_GENERATORS[id].params }));
}

function MG_runGenerator(id, params) {
  const g = MG_GENERATORS[id] || MG_GENERATORS.random;
  return g.generate(params || {});
}
