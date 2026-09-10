/* AUTO-GENERATED for the rack: copy of ../drummap/js/engine.js with the globals
 * that collide with the TB-3PO modules renamed to DM_*. Regenerate with the
 * snippet in the rack README if the drummap source changes. */
'use strict';
/*
 * DrumMap web port — pattern generator engine.
 *
 * Faithful JavaScript port of the DrumMap Hemisphere applet from Phazerville
 * (https://github.com/djphazer/O_C-Phazerville), software/src/applets/DrumMap.h
 * (© 2021 Benjamin Rosenbach; based on Mutable Instruments Grids by Émilie Gillet).
 *
 * Ported 1:1:
 *  - ReadDrumMap(): bilinear fade across the 5x5 drum_map table with the
 *    uint8 truncation of `x << 2` (fractional position within a quadrant),
 *    U8Mix = (b * mix + a * (255 - mix)) >> 8.
 *  - Chaos: per-part `randomness = random(0, chaos >> 2)` re-rolled at step 0
 *    of each loop, added to the map level.
 *  - Gates: `level > ~fill` (uint8 ~ = 255 - fill); channel B in accent mode
 *    plays channel A's part with A's fill and only fires above level 192.
 *  - CV inputs modulate Fill 1/2, X/Y or Fill 1/Chaos per cv_mode
 *    (Proportion(DetentedIn, 6V, 255) ⇔ ±255 over ±6 V).
 *  - Auto-reset after ~30000 ticks (≈1.76 s) without a clock.
 *  - Grids2 pattern table (the Phazerville default build) and the classic
 *    Grids table; short nodes read into the next node's bytes exactly like
 *    the firmware's contiguous PROGMEM layout (grid2 node_9 is 72 bytes).
 *
 * CV convention: 255 = full scale = 6 V of modulation range.
 */

const DRUM_MAX_VAL = 255;
const HEM_DRUMMAP_PULSE_ANIMATION_TICKS = 1000;   // ≈ 59 ms at 17 kHz
const HEM_DRUMMAP_VALUE_ANIMATION_TICKS = 16000;  // ≈ 0.94 s
const DRUM_AUTO_RESET_TICKS = 30000;              // ≈ 1.76 s
const DM_TICKS_PER_SECOND = 17000; // HEMISPHERE_CLOCK_TICKS 17 = one millisecond

const OUT_MODE_NAMES = ['Kick', 'Snare', 'HiHat', 'Accent'];
const CV_MODE_NAMES = ['FILL 1/2', 'X/Y', 'FA/CHAOS'];

/* C++ CONSTRAIN */
function DM_con(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
/* Proportion: (value / max_value) * result_max with C++ int truncation */
function DM_proportion(value, maxValue, resultMax) {
  return Math.trunc((value * resultMax) / maxValue);
}

class DrumMap {
  constructor() {
    // settings (C++ member initializers)
    this.mode = [0, 1];        // 0 kick, 1 snare, 2 hihat; ch B also 3 = accent
    this.fill = [128, 128];
    this.x = 0;
    this.y = 0;
    this.chaos = 0;
    this.cvMode = 0;           // 0 = Fill A/B, 1 = X/Y, 2 = Fill A/Chaos
    this.cv = [0, 0];          // web stand-in for CV inputs, -255..255 (±6 V)
    this.patternSet = 'grids2';

    // runtime
    this.step = 0;
    this.randomness = [0, 0, 0];
    this.pulseAnimation = [0, 0];
    this.valueAnimation = 0;   // ticks remaining (counts down by dt * 17 kHz)
    this.lastClock = -1e9;     // seconds, clock domain of the app

    // effective (CV-modulated) values, like _fill/_x/_y/_chaos
    this._fill = [128, 128];
    this._x = 0;
    this._y = 0;
    this._chaos = 0;
    this.refreshModulation();
  }

  /* HemisphereApplet::Modulate(): param + CV, constrained */
  modulate(param, ch) {
    return DM_con(param + this.cv[ch], 0, DRUM_MAX_VAL);
  }

  /* the modulation block at the top of Controller() — runs every frame */
  refreshModulation() {
    this._fill = [this.fill[0], this.fill[1]];
    this._x = this.x;
    this._y = this.y;
    this._chaos = this.chaos;
    switch (this.cvMode) {
      case 0:
        this._fill[0] = this.modulate(this._fill[0], 0);
        this._fill[1] = this.modulate(this._fill[1], 1);
        break;
      case 1:
        this._x = this.modulate(this._x, 0);
        this._y = this.modulate(this._y, 1);
        break;
      case 2:
        this._fill[0] = this.modulate(this._fill[0], 0);
        this._chaos = this.modulate(this._chaos, 1);
        break;
    }
  }

  /* Controller(), clock-edge portion. Returns web-audio events:
   * { t, ch, part, accent } */
  onClock(t) {
    this.refreshModulation();
    const events = [];

    // generate randomness for each drum type on the first step of the pattern
    if (this.step === 0) {
      for (let i = 0; i < 3; i++) {
        this.randomness[i] = arduinoRange(this._chaos >> 2);
      }
    }

    for (let ch = 0; ch < 2; ch++) {
      // accent on ch 1 plays whatever part ch 0 is set to
      const part = (ch === 1 && this.mode[ch] === 3) ? this.mode[0] : this.mode[ch];
      let level = this.readDrumMap(this.step, part, this._x, this._y);
      level = DM_con(level + this.randomness[part], 0, DRUM_MAX_VAL);
      // use ch 0 fill if ch 1 is in accent mode
      const threshold = (ch === 1 && this.mode[ch] === 3) ? (~this._fill[0] & 0xff) : (~this._fill[ch] & 0xff);
      if (level > threshold) {
        if (this.mode[ch] < 3) {
          // normal part
          events.push({ t, ch, part, accent: false });
          this.pulseAnimation[ch] = HEM_DRUMMAP_PULSE_ANIMATION_TICKS;
        } else if (level > 192) {
          // accent
          events.push({ t, ch, part, accent: true });
          this.pulseAnimation[ch] = HEM_DRUMMAP_PULSE_ANIMATION_TICKS;
        }
      }
    }

    // keep track of last clock for auto-reset
    this.lastClock = t;
    // loop back to first step
    if (++this.step > 31) this.step = 0;
    return events;
  }

  /* non-clock portion of Controller(), run every frame; now/dt in seconds.
   * The firmware counts these in 17 kHz ticks; here dt is scaled the same way. */
  update(now, dt) {
    const dTicks = dt * DM_TICKS_PER_SECOND;
    for (let ch = 0; ch < 2; ch++) {
      if (this.pulseAnimation[ch] > 0) {
        this.pulseAnimation[ch] = Math.max(0, this.pulseAnimation[ch] - dTicks);
      }
    }
    if (this.valueAnimation > 0) this.valueAnimation = Math.max(0, this.valueAnimation - dTicks);
    // auto-reset after ~2 seconds of no clock
    if (now - this.lastClock > DRUM_AUTO_RESET_TICKS / DM_TICKS_PER_SECOND && this.step !== 0) {
      this.step = 0;
    }
  }

  /* uint8_t DrumMap::ReadDrumMap(step, part, x, y) */
  readDrumMap(step, part, x, y) {
    const set = PATTERN_SETS[this.patternSet] || PATTERN_SETS.grids2;
    const i = x >> 6;
    const j = y >> 6;
    const nodeOffset = (node) => set.offsets[node];
    const offset = (part * 32) + step;
    const a = set.data[nodeOffset(set.map[i][j]) + offset];
    const b = set.data[nodeOffset(set.map[i + 1][j]) + offset];
    const c = set.data[nodeOffset(set.map[i][j + 1]) + offset];
    const d = set.data[nodeOffset(set.map[i + 1][j + 1]) + offset];
    const quadX = (x << 2) & 0xff;   // uint8_t truncation
    const quadY = (y << 2) & 0xff;
    // U8Mix returns (b * mix + a * (255 - mix)) >> 8
    const abFade = (b * quadX + a * (255 - quadX)) >> 8;
    const cdFade = (d * quadX + c * (255 - quadX)) >> 8;
    return (cdFade * quadY + abFade * (255 - quadY)) >> 8;
  }

  reset() { this.step = 0; }
}

/* Arduino random(0, howbig): 0 when howbig <= 0; non-deterministic by design here
 * (hardware seeds with micros()) */
function arduinoRange(howbig) {
  if (howbig <= 0) return 0;
  return Math.floor(Math.random() * howbig);
}