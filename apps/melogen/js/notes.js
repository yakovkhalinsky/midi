'use strict';
/*
 * Note model + seeded PRNG for Melogen.
 * Notes: { id, pitch (MIDI 0–127), start (beats), duration (beats), velocity (1–127) }
 */

let _nextId = 1;
function nextNoteId() { return _nextId++; }

function makeNote(pitch, start, duration, velocity, id) {
  return {
    id: id != null ? id : nextNoteId(),
    pitch: clampInt(pitch, 0, 127),
    start: Math.max(0, +start || 0),
    duration: Math.max(1 / 64, +duration || 0.25),
    velocity: clampInt(velocity == null ? 100 : velocity, 1, 127),
  };
}

function cloneNote(n) {
  return makeNote(n.pitch, n.start, n.duration, n.velocity, n.id);
}

function cloneNotes(arr) {
  return arr.map(cloneNote);
}

function clampInt(v, lo, hi) {
  v = Math.round(+v || 0);
  return v < lo ? lo : v > hi ? hi : v;
}

function snapBeat(t, snap) {
  if (!snap || snap <= 0) return t;
  return Math.round(t / snap) * snap;
}

function noteEnd(n) { return n.start + n.duration; }

function sortNotes(notes) {
  return notes.slice().sort((a, b) => a.start - b.start || a.pitch - b.pitch);
}

function notesInRange(notes, t0, t1) {
  return notes.filter((n) => n.start < t1 && noteEnd(n) > t0);
}

function patternLength(notes, fallback) {
  if (!notes.length) return fallback || 4;
  let max = 0;
  for (const n of notes) max = Math.max(max, noteEnd(n));
  return Math.max(fallback || 0, max);
}

function serializeNotes(notes) {
  return notes.map((n) => ({
    pitch: n.pitch, start: n.start, duration: n.duration, velocity: n.velocity,
  }));
}

function notesEqual(a, b) {
  if (a.length !== b.length) return false;
  const sa = serializeNotes(sortNotes(a));
  const sb = serializeNotes(sortNotes(b));
  return JSON.stringify(sa) === JSON.stringify(sb);
}

/* ---- Mulberry32 PRNG (deterministic, seedable) ---- */
function mulberry32(seed) {
  let a = (seed >>> 0) || 1;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function parseSeed(v) {
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

function randomSeedHex() {
  const n = (Math.random() * 0xffffffff) >>> 0;
  return ('00000000' + n.toString(16)).slice(-8);
}
