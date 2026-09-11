/* Namespaced Melogen copy for the rack: colliding / shared symbols prefixed MG_*.
 * Source: ../melogen/js/notes.js — regenerate (re-copy + re-prefix) if Melogen notes change. */
'use strict';
/*
 * Note model + seeded PRNG for Melogen.
 * Notes: { id, pitch (MIDI 0–127), start (beats), duration (beats), velocity (1–127) }
 */

let MG__nextId = 1;
function MG_nextNoteId() { return MG__nextId++; }

function MG_makeNote(pitch, start, duration, velocity, id) {
  return {
    id: id != null ? id : MG_nextNoteId(),
    pitch: MG_clampInt(pitch, 0, 127),
    start: Math.max(0, +start || 0),
    duration: Math.max(1 / 64, +duration || 0.25),
    velocity: MG_clampInt(velocity == null ? 100 : velocity, 1, 127),
  };
}

function MG_cloneNote(n) {
  return MG_makeNote(n.pitch, n.start, n.duration, n.velocity, n.id);
}

function MG_cloneNotes(arr) {
  return arr.map(MG_cloneNote);
}

function MG_clampInt(v, lo, hi) {
  v = Math.round(+v || 0);
  return v < lo ? lo : v > hi ? hi : v;
}

function MG_snapBeat(t, snap) {
  if (!snap || snap <= 0) return t;
  return Math.round(t / snap) * snap;
}

function MG_noteEnd(n) { return n.start + n.duration; }

function MG_sortNotes(notes) {
  return notes.slice().sort((a, b) => a.start - b.start || a.pitch - b.pitch);
}

function MG_notesInRange(notes, t0, t1) {
  return notes.filter((n) => n.start < t1 && MG_noteEnd(n) > t0);
}

function MG_patternLength(notes, fallback) {
  if (!notes.length) return fallback || 4;
  let max = 0;
  for (const n of notes) max = Math.max(max, MG_noteEnd(n));
  return Math.max(fallback || 0, max);
}

function MG_serializeNotes(notes) {
  return notes.map((n) => ({
    pitch: n.pitch, start: n.start, duration: n.duration, velocity: n.velocity,
  }));
}

function MG_notesEqual(a, b) {
  if (a.length !== b.length) return false;
  const sa = MG_serializeNotes(MG_sortNotes(a));
  const sb = MG_serializeNotes(MG_sortNotes(b));
  return JSON.stringify(sa) === JSON.stringify(sb);
}

/* ---- Mulberry32 PRNG (deterministic, seedable) ---- */
function MG_mulberry32(seed) {
  let a = (seed >>> 0) || 1;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function MG_parseSeed(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return (v >>> 0) || 1;
  const s = String(v == null ? '' : v).trim();
  if (!s) return ((Math.random() * 0xffffffff) >>> 0) || 1;
  if (/^0x[0-9a-f]+$/i.test(s)) return (parseInt(s, 16) >>> 0) || 1;
  if (/^\d+$/.test(s)) return (parseInt(s, 10) >>> 0) || 1;
  // FNV-1a hash of string
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) || 1;
}

function MG_randomSeedHex() {
  const n = (Math.random() * 0xffffffff) >>> 0;
  return ('00000000' + n.toString(16)).slice(-8);
}
