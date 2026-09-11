'use strict';
/*
 * Simple polyphonic Web Audio voice for Melogen preview.
 * Soft saw → lowpass → per-note gain envelope → master.
 */

function midiToFreq(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

class MelogenVoice {
  constructor(ctx) {
    this.ctx = ctx;
    this.params = {
      volume: 0.28,
      cutoff: 1800,
      resonance: 1.2,
      attack: 0.008,
      decay: 0.08,
      sustain: 0.55,
      release: 0.12,
      wave: 'sawtooth',
    };

    this.master = ctx.createGain();
    this.master.gain.value = this.params.volume;

    this.filter = ctx.createBiquadFilter();
    this.filter.type = 'lowpass';
    this.filter.frequency.value = this.params.cutoff;
    this.filter.Q.value = this.params.resonance;

    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -8;
    this.limiter.ratio.value = 8;
    this.limiter.attack.value = 0.003;
    this.limiter.release.value = 0.1;

    this.filter.connect(this.master);
    this.master.connect(this.limiter);
    this.limiter.connect(ctx.destination);

    this.active = new Map(); // id -> { osc, gain }
  }

  applyParams() {
    const p = this.params;
    const t = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(p.volume, t, 0.03);
    this.filter.frequency.setTargetAtTime(p.cutoff, t, 0.03);
    this.filter.Q.setTargetAtTime(p.resonance, t, 0.03);
  }

  noteOn(id, pitch, velocity, when) {
    const ctx = this.ctx;
    const t = Math.max(when != null ? when : ctx.currentTime, ctx.currentTime);
    this.noteOff(id, t); // retrigger same id

    const osc = ctx.createOscillator();
    osc.type = this.params.wave;
    osc.frequency.setValueAtTime(midiToFreq(pitch), t);

    const gain = ctx.createGain();
    const amp = (velocity / 127) * 0.45;
    const p = this.params;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.linearRampToValueAtTime(amp, t + p.attack);
    gain.gain.linearRampToValueAtTime(amp * p.sustain, t + p.attack + p.decay);

    osc.connect(gain);
    gain.connect(this.filter);
    osc.start(t);

    this.active.set(id, { osc, gain, pitch });
  }

  noteOff(id, when) {
    const v = this.active.get(id);
    if (!v) return;
    const ctx = this.ctx;
    const t = Math.max(when != null ? when : ctx.currentTime, ctx.currentTime);
    const p = this.params;
    try {
      v.gain.gain.cancelScheduledValues(t);
      v.gain.gain.setValueAtTime(Math.max(0.0001, v.gain.gain.value), t);
      v.gain.gain.setTargetAtTime(0.0001, t, p.release);
      v.osc.stop(t + p.release * 5 + 0.05);
    } catch (e) { /* already stopped */ }
    this.active.delete(id);
    // disconnect later
    setTimeout(() => {
      try { v.osc.disconnect(); v.gain.disconnect(); } catch (e) {}
    }, (p.release * 5 + 0.1) * 1000);
  }

  allOff() {
    const ids = [...this.active.keys()];
    for (const id of ids) this.noteOff(id);
  }

  dispose() {
    this.allOff();
    try {
      this.filter.disconnect();
      this.master.disconnect();
      this.limiter.disconnect();
    } catch (e) {}
  }
}
