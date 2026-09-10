'use strict';
/*
 * Web Audio TB-303-ish bass voice driven by the TB-3PO CV model.
 *
 * The applet outputs pitch CV (1 V/oct, with fixed-time exponential slides)
 * and a gate (3 V normal, 6 V accent). This voice renders those CVs with:
 *   - a saw oscillator (frequency follows the pitch CV, slides via
 *     setTargetAtTime with a time constant matching the firmware math
 *     k = 0x3, >> 18 per tick at 17 kHz => tau ~= 5.15 ms)
 *   - a resonant lowpass with an accentable filter envelope per gate
 *   - amp gate with fast attack / exponential release
 */

const SLIDE_TAU_DEFAULT = 262144 / (3 * TICKS_PER_SECOND); // 2^18 / (3 * 17kHz) ≈ 5.1 ms

function semisToFreq(semis) {
  return 440 * Math.pow(2, (semis - 9) / 12); // semis relative to C4 (0 V)
}

class AcidVoice {
  constructor(ctx) {
    this.ctx = ctx;
    this.params = {
      volume: 0.25,
      cutoff: 550,        // Hz, base filter cutoff
      resonance: 10,      // Q
      envAmt: 2600,       // Hz added at gate-on
      accent: 1.0,        // how much accent pushes amp + filter
      slideTau: SLIDE_TAU_DEFAULT,
      releaseTau: 0.014,
      attack: 0.002,
    };

    this.osc = ctx.createOscillator();
    this.osc.type = 'sawtooth';
    this.osc.frequency.value = semisToFreq(0);

    this.filter = ctx.createBiquadFilter();
    this.filter.type = 'lowpass';
    this.filter.frequency.value = this.params.cutoff;
    this.filter.Q.value = this.params.resonance;

    this.amp = ctx.createGain();
    this.amp.gain.value = 0;

    this.master = ctx.createGain();
    this.master.gain.value = this.params.volume;

    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -10;
    this.limiter.ratio.value = 12;
    this.limiter.attack.value = 0.002;
    this.limiter.release.value = 0.1;

    this.osc.connect(this.filter);
    this.filter.connect(this.amp);
    this.amp.connect(this.master);
    this.master.connect(this.limiter);
    this.limiter.connect(ctx.destination);

    this.osc.start();

    this.scheduledOffAt = 0; // amp release scheduled at this audio time
    this.gateOpen = false;
  }

  applyParams() {
    const p = this.params;
    const t = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(p.volume, t, 0.03);
    this.filter.Q.setTargetAtTime(p.resonance, t, 0.03);
  }

  /* {type:'pitch', t, semis, glide} */
  pitch(ev) {
    const f = semisToFreq(ev.semis);
    const t = Math.max(ev.t, this.ctx.currentTime);
    if (ev.glide) {
      this.osc.frequency.setTargetAtTime(f, t, this.params.slideTau);
    } else {
      this.osc.frequency.setValueAtTime(f, t);
    }
  }

  /* {type:'gateOn', t, accent, retrig} */
  gateOn(ev) {
    const p = this.params;
    const t = Math.max(ev.t, this.ctx.currentTime);
    const wasOpen = this.gateOpen;
    this.gateOpen = true;

    if (ev.retrig && !wasOpen) {
      this.amp.gain.cancelScheduledValues(t);
      this.amp.gain.setValueAtTime(0.0001, t);
      this.amp.gain.linearRampToValueAtTime(0.5 * (1 + (ev.accent ? p.accent : 0)), t + p.attack);
    } else {
      // gate held through a slide chain — just update level (accent change)
      this.amp.gain.setTargetAtTime(0.5 * (1 + (ev.accent ? p.accent : 0)), t, 0.006);
    }

    // filter envelope, retrigged on every gate-on like a 303
    const peak = p.cutoff + p.envAmt * (1 + (ev.accent ? p.accent : 0));
    this.filter.frequency.cancelScheduledValues(t);
    this.filter.frequency.setValueAtTime(peak, t);
    this.filter.frequency.setTargetAtTime(p.cutoff, t, 0.09);
  }

  /* schedule the gate cut; t = audio time */
  gateOff(t) {
    if (typeof t !== 'number') t = this.ctx.currentTime;
    t = Math.max(t, this.ctx.currentTime);
    this.gateOpen = false;
    this.scheduledOffAt = t;
    this.amp.gain.setTargetAtTime(0.0001, t, this.params.releaseTau);
  }

  /* cancel a previously scheduled release (new clock arrived first) */
  cancelPendingOff(beforeTime) {
    if (this.scheduledOffAt > this.ctx.currentTime) {
      this.amp.gain.cancelScheduledValues(this.scheduledOffAt);
    }
    this.scheduledOffAt = 0;
  }

  allOff() {
    this.gateOpen = false;
    const t = this.ctx.currentTime;
    this.amp.gain.cancelScheduledValues(t);
    this.amp.gain.setTargetAtTime(0.0001, t, 0.008);
  }

  dispose() {
    try { this.osc.stop(); } catch (e) { /* already stopped */ }
    this.osc.disconnect();
  }
}