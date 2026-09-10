'use strict';
/*
 * TB-3PO web port — pattern generator engine.
 *
 * Faithful JavaScript port of the TB_3PO Hemisphere applet from
 * Phazerville (https://github.com/djphazer/O_C-Phazerville),
 * software/src/applets/TB3PO.h (original by Logarhythm, mods by djphazer).
 *
 * Ported 1:1 where possible:
 *  - Teensy 4.x build path (__IMXRT1062__): ACID_HALF_STEPS = 32, single-phase
 *    regeneration, exactly like Phazerville on the Teensy 4.1.
 *  - The Arduino/Teensy random() PRNG (avr-libc 1.6.4 Lehmer generator) is
 *    replicated bit-exactly (cores/teensy4/WMath.cpp), so a given seed builds
 *    the identical pattern as on hardware.
 *  - The braids quantizer (Lookup() degree semantics, notes[] in CV units of
 *    128 per semitone) and QuantEngine::Lookup() root/octave offsets.
 *  - 50%-of-cycle gate timing with slide "tied note" chains, 3V/6V accent
 *    gates, fixed-time exponential pitch slides (k = 0x3, >> 18).
 *
 * CV convention (same units as the firmware): 128 = 1 semitone, 1536 = 1 volt.
 */

const ACID_HALF_STEPS = 32; // Teensy 4.x: 32 (see TB3PO.h __IMXRT1062__)
const ACID_MAX_STEPS = 32;

const TICKS_PER_SECOND = 17000;   // HEMISPHERE_CLOCK_TICKS 17 = one millisecond
const ONE_OCTAVE = 12 << 7;       // 1536 CV units per octave (1 V)
const HEMISPHERE_3V_CV = 3 * ONE_OCTAVE;
const HEMISPHERE_MAX_INPUT_CV = 6 * ONE_OCTAVE;

/* C++ CONSTRAIN */
function con(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

/* Proportion: (value / max_value) * result_max, with C++ int truncation */
function proportion(value, maxValue, resultMax) {
  return Math.trunc((value * resultMax) / maxValue);
}

/* ------------------------------------------------------------------ */
/* Teensy/Arduino random(), replicated from cores/teensy4/WMath.cpp    */
/* ------------------------------------------------------------------ */
class ArduinoRandom {
  constructor() { this.seed = 0; }
  randomSeed(s) { if (s > 0) this.seed = s >>> 0; }
  /* long random(void) */
  next() {
    let x = this.seed >>> 0;
    if (x === 0) x = 123459876;
    const hi = Math.floor(x / 127773);
    const lo = x - hi * 127773;
    x = 16807 * lo - 2836 * hi;      // fits in int32 without overflow
    if (x < 0) x += 0x7FFFFFFF;
    this.seed = x >>> 0;
    return x;
  }
  /* uint32_t random(uint32_t howbig) */
  rand(howbig) { if (!howbig) return 0; return this.next() % howbig; }
  /* int32_t random(howsmall, howbig) */
  range(a, b) { if (a >= b) return a; return this.rand(b - a) + a; }
}

/* ------------------------------------------------------------------ */
/* braids::Quantizer (Bryan Head re-implementation used by Phazerville) */
/* ------------------------------------------------------------------ */
class BraidsQuantizer {
  constructor() {
    this.notes = [];
    this.span = 1536;
    this.numNotes = 0;
    this.enabled = false;
  }
  configure(scale, mask) {
    if (mask === undefined) mask = 0xffff;
    this.notes = [];
    let m = mask >>> 0;
    for (let i = 0; i < scale.notes.length && i < 16; i++) {
      if (m & 1) this.notes.push(scale.notes[i]);
      m >>>= 1;
    }
    this.span = scale.span;
    this.numNotes = this.notes.length;
    this.enabled = this.numNotes !== 0 && this.span !== 0;
  }
  /* int32_t Quantizer::Lookup(int32_t index): index is a scale-degree note
   * number where 64 = degree 0. Returns CV (128/semitone). */
  lookup(index) {
    if (this.numNotes === 0) return 0;
    index -= 64;
    let octave = Math.trunc(index / this.numNotes);
    let rel = index - octave * this.numNotes;
    if (rel < 0) { octave--; rel += this.numNotes; }
    return this.notes[rel] + octave * this.span;
  }
}

/* ------------------------------------------------------------------ */
/* TB_3PO applet                                                       */
/* ------------------------------------------------------------------ */
class TB3PO {
  constructor() {
    this.rand = new ArduinoRandom();

    // QuantEngine (HS q_engine[0]) — defaults: SCALE_SEMI, root C, octave 0
    this.quantizer = new BraidsQuantizer();
    this.scaleIndex = 1;  // braids id of "Semitone" (OC::Scales::SCALE_SEMI)
    this.rootNote = 0;
    this.qOctave = 0;
    this.setQuantizerScale();

    // User settings
    this.lockSeed = 0;           // 0 = die (auto-reseed on Reset), 1 = locked
    this.noSlides = false;       // AuxButton on LENGTH
    this.holdPitch = true;       // default true, like the applet
    this.transposeInSemitones = false;
    this.transposeAmt = 0;       // from "CV 1" (SemitoneIn)
    this.seed = 0;

    this.density = 12;           // effective density (encoder + CV)
    this.currentPatternDensity = 0;
    this.densityEncoder = 12;    // 0..14, shown as -7..+7
    this.densityAuto = new Array(ACID_MAX_STEPS).fill(0);
    this.densityAutoEnabled = false;
    this.densityCv = 0;          // Proportion(DetentedIn(1), ..., 15)
    this.densityEncoderDisplay = 0;

    this.numSteps = 16;
    this.step = 0;
    this.resetFlag = 0;
    this.gate1Held = false;      // Gate(1): freeze step advance (Reset input held)

    // Generated sequence data
    this.gates = 0; this.slides = 0; this.accents = 0;
    this.octUps = 0; this.octDowns = 0;
    this.notes = new Array(ACID_MAX_STEPS).fill(0);
    this.scaleSize = this.quantizer.numNotes || 12;
    this.currentPatternScaleSize = this.scaleSize;

    // Gate timing
    this.gateOffTime = 0;        // seconds, audio-clock domain
    this.cycleTime = 0.5;        // seconds between last two clocks

    // Output state (CV units: 128/semitone)
    this.currGateCv = 0;
    this.currPitchCv = 0;
    this.slideStartCv = 0;
    this.slideEndCv = 0;
    this.currStepSemitone = 0;
    this.slideActiveUntil = 0;   // for the WAVEFORM icon

    // Display
    this.randApplyAnim = 0;
    this.regeneratePhase = 0;
    this.heartPulse = 0;         // heart beats on pattern reset
    this.reseedAnim = 0;         // die hops on new seed

    this.start();
  }

  /* ---- Start() ---- */
  start() {
    this.randApplyAnim = 0;
    this.currStepSemitone = 0;
    this.setQuantizerScale();
    this.density = 12;
    this.densityEncoder = 12;
    this.densityEncoderDisplay = 0;
    this.numSteps = 16;
    this.gateOffTime = 0;
    this.cycleTime = 0.5;
    this.currGateCv = 0;
    this.currPitchCv = this.getPitchForStep(0);
    this.slideStartCv = this.currPitchCv;
    this.slideEndCv = this.currPitchCv;
    this.lockSeed = 0;
    this.reset();
  }

  /* ---- Reset() ---- */
  reset() {
    if (this.lockSeed < 1) this.reseed();
    this.step = 0;
    this.resetFlag = 1;
    this.heartPulse = 1;
  }

  setQuantizerScale() {
    const scale = getScaleById(this.scaleIndex) || SCALES[0];
    this.quantizer.configure(scale);
    this.scaleSize = this.quantizer.numNotes || 12;
  }

  /* ---- Controller(), clock-edge portion. t = time (seconds), cycle =
   *      interval between the previous two clocks (ClockCycleTicks).
   *      Returns web-audio events: {type, t, ...} ---- */
  onClock(t, cycle) {
    this.cycleTime = cycle;
    this.regenerateIfDensityOrScaleChanged();

    const stepPv = this.step;
    const events = [];

    // step advance if reset not held
    if (!this.resetFlag && !this.gate1Held) {
      this.step = this.getNextStep(this.step);
    }

    if (this.stepIsSlid(stepPv)) {
      // Glide from previous step pitch (start from wherever the CV is now)
      this.slideStartCv = this.currPitchCv;
      this.slideEndCv = this.getPitchForStep(this.step);
      events.push({ type: 'pitch', t, semis: this.slideEndCv / 128, glide: true });
    } else if (!this.holdPitch || this.stepIsGated(this.step)) {
      // No glide but new pitch
      this.currPitchCv = this.getPitchForStep(this.step);
      this.slideStartCv = this.currPitchCv;
      this.slideEndCv = this.currPitchCv;
      events.push({ type: 'pitch', t, semis: this.currPitchCv / 128, glide: false });
    }

    if (this.stepIsGated(this.step) || this.stepIsSlid(stepPv)) {
      const accent = this.stepIsAccent(this.step);
      const retrig = this.currGateCv === 0;
      // 3V or 6V for accent
      this.currGateCv = (1 + (accent ? 1 : 0)) * HEMISPHERE_3V_CV;
      this.gateOffTime = t + this.cycleTime / 2; // multiplier of 2
      events.push({ type: 'gateOn', t, accent, retrig });
    }

    this.currStepSemitone = this.getSemitoneForStep(this.step);
    this.resetFlag = 0;

    // Amortized regeneration (applied after the step, like update_regeneration())
    this.updateRegeneration();
    return events;
  }

  /* The non-clock part of Controller(), run every frame: gate-off + slide anim */
  update(now) {
    if (this.currGateCv > 0 && this.gateOffTime > 0 && now >= this.gateOffTime) {
      this.gateOffTime = 0;
      if (!this.stepIsSlid(this.step)) this.currGateCv = 0;
    }
    if (this.randApplyAnim > 0) this.randApplyAnim--;
    if (this.densityEncoderDisplay > 0) this.densityEncoderDisplay--;
    if (this.heartPulse > 0) this.heartPulse -= 0.08;
    if (this.reseedAnim > 0) this.reseedAnim -= 0.08;
    if (this.slideActiveUntil !== 0 && now > this.slideActiveUntil) this.slideActiveUntil = 0;
  }

  /* ---- pitch helpers (faithful) ---- */
  getPitchForStep(stepNum) {
    let quantNote = 64 + this.notes[stepNum];
    if (!this.transposeInSemitones) {
      quantNote += Math.trunc((this.transposeAmt * this.scaleSize) / 12);
    }
    if (this.stepIsOctUp(stepNum)) quantNote += this.scaleSize;
    else if (this.stepIsOctDown(stepNum)) quantNote -= this.scaleSize;
    quantNote = con(quantNote, 0, 127);
    // QuantEngine::Lookup(): quantizer.Lookup(note) + (root_note << 7) + (octave * ONE_OCTAVE)
    let cv = this.quantizer.lookup(quantNote);
    cv += this.rootNote * 128;
    cv += this.qOctave * ONE_OCTAVE;
    cv += this.transposeInSemitones ? this.transposeAmt * 128 : 0;
    return cv;
  }

  getSemitoneForStep(stepNum) {
    // Don't add in octaves — use the current quantizer limited to the base octave
    const quantNote = con(64 + this.notes[stepNum], 0, 127);
    const cvNote = this.quantizer.lookup(quantNote) + this.rootNote * 128 + this.qOctave * ONE_OCTAVE;
    const noteNumber = 60 + Math.round(cvNote / 128); // 0V = C4 = MIDI 60
    return ((noteNumber % 12) + 12) % 12;
  }

  /* ---- generation (faithful) ---- */
  reseed() {
    // hardware: randomSeed(micros()) — truly random here too
    const buf = new Uint16Array(1);
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(buf);
    else buf[0] = Math.floor(Math.random() * 65536);
    this.rand.randomSeed(buf[0] || 1);
    this.seed = this.rand.range(0, 65535) & 0xffff;
    this.regenerateAll();
  }

  regenerateAll() {
    this.regeneratePhase = 1; // set to regenerate on next Controller
    this.randApplyAnim = 40;  // show that regenerate started
  }

  regenerateIfDensityOrScaleChanged() {
    if (this.regeneratePhase === 0) {
      if (this.density !== this.currentPatternDensity || this.scaleSize !== this.currentPatternScaleSize) {
        this.regeneratePhase = 1;
      }
    }
  }

  updateRegeneration() {
    if (this.regeneratePhase === 0) return;
    // Teensy 4.x path: single pass, seeded deterministically with seed + phase
    this.rand.randomSeed(this.seed + this.regeneratePhase);
    this.regeneratePitches();
    this.applyDensity();
    this.regeneratePhase = 0;
  }

  regeneratePitches() {
    const bFirstHalf = this.regeneratePhase < 3;
    const pitchChangeDens = this.getPitchChangeDensity();
    let availablePitches = 0;
    if (this.scaleSize > 0) {
      if (pitchChangeDens > 7) {
        availablePitches = this.scaleSize - 1;
      } else if (pitchChangeDens < 2) {
        // just the root note at lowest density, 0&1 at 2nd lowest
        availablePitches = pitchChangeDens;
      } else {
        let rangeFromScale = this.scaleSize - 3;
        if (rangeFromScale < 4) rangeFromScale = 4;
        availablePitches = 3 + proportion(pitchChangeDens - 3, 4, rangeFromScale);
        availablePitches = con(availablePitches, 1, this.scaleSize - 1);
      }
    }

    if (bFirstHalf) { this.octUps = 0; this.octDowns = 0; }

    const maxStep = bFirstHalf ? ACID_HALF_STEPS : ACID_MAX_STEPS;
    for (let s = bFirstHalf ? 0 : ACID_HALF_STEPS; s < maxStep; s++) {
      const forceRepeatNoteProb = 50 - pitchChangeDens * 6;
      if (s > 0 && this.randBit(forceRepeatNoteProb)) {
        this.notes[s] = this.notes[s - 1];
      } else {
        this.notes[s] = this.rand.rand(availablePitches + 1);
        this.octUps = (this.octUps << 1) >>> 0;
        this.octDowns = (this.octDowns << 1) >>> 0;
        const coinflip = this.rand.rand(200);
        if (coinflip < 80) { // 40% chance of up or down
          if (coinflip & 1) this.octUps |= 0x1;
          else this.octDowns |= 0x1;
        }
      }
    }

    if (this.scaleSize === 0) this.scaleSize = 12;
    this.currentPatternScaleSize = this.scaleSize;
  }

  applyDensity() {
    let latestSlide = 0;
    let latestAccent = 0;
    const onOffDens = this.getOnOffDensity();
    const densProb = 10 + onOffDens * 14;

    const bFirstHalf = this.regeneratePhase < 3;
    if (bFirstHalf) { this.gates = 0; this.slides = 0; this.accents = 0; }

    for (let i = 0; i < ACID_HALF_STEPS; ++i) {
      this.gates = (((this.gates << 1) >>> 0) | (this.randBit(densProb) ? 1 : 0)) >>> 0;
      this.slides = (((this.slides << 1) >>> 0) | (this.randBit(latestSlide ? 10 : 18) ? 1 : 0)) >>> 0;
      latestSlide = this.slides & 1;
      this.accents = (((this.accents << 1) >>> 0) | (this.randBit(latestAccent ? 7 : 16) ? 1 : 0)) >>> 0;
      latestAccent = this.accents & 1;
    }

    this.currentPatternDensity = this.density;
  }

  getOnOffDensity() { return Math.abs(this.density - 7); }
  getPitchChangeDensity() { return con(this.density, 0, 8); }

  stepIsGated(s) { return ((this.gates >>> s) & 1) === 1; }
  stepIsSlid(s) { if (this.noSlides) return false; return ((this.slides >>> s) & 1) === 1; }
  stepIsAccent(s) { return ((this.accents >>> s) & 1) === 1; }
  stepIsOctUp(s) { return ((this.octUps >>> s) & 1) === 1; }
  stepIsOctDown(s) { return ((this.octDowns >>> s) & 1) === 1; }

  getNextStep(s) { return (++s >= this.numSteps) ? 0 : s; }

  randBit(prob) { return this.rand.rand(100) < prob; }

  /* Effective density this frame: encoder centerpoint (or motion recording) + CV */
  effectiveDensity() {
    const den = this.densityAutoEnabled ? this.densityAuto[this.step] : this.densityEncoder;
    return con(den + this.densityCv, 0, 14);
  }

  refreshDensity() { this.density = this.effectiveDensity(); }
}

function getScaleById(id) {
  for (const s of SCALES) if (s.id === id) return s;
  return null;
}