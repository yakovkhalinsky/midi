'use strict';
/*
 * Polyphonic Web Audio voice for Melogen preview.
 * Per note: saw → resonant lowpass (filter env) → amp → shared master/limiter.
 * Envelope / accent / glide feel mirrors TB-3PO's AcidVoice, adapted for polyphony.
 */

function midiToFreq(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

class MelogenVoice {
  constructor(ctx, destNode) {
    this.ctx = ctx;
    this.params = {
      volume: 0.28,
      cutoff: 1000,       // Hz — slightly brighter than TB-3PO's 550 for leads
      resonance: 10,      // Q (TB-3PO default)
      envAmt: 2600,       // Hz added at gate-on
      accent: 1.0,        // multiplier for amp + filter when accented
      slideTau: 0.0052,   // seconds (~5.2 ms TB-3PO default)
      releaseTau: 0.014,  // seconds (14 ms)
      attack: 0.002,      // seconds (~2 ms)
      wave: 'sawtooth',
    };

    this.master = ctx.createGain();
    this.master.gain.value = this.params.volume;

    // Optional destNode: skip per-voice limiter (standalone still uses default).
    if (destNode) {
      this.master.connect(destNode);
    } else {
      this.limiter = ctx.createDynamicsCompressor();
      this.limiter.threshold.value = -8;
      this.limiter.ratio.value = 8;
      this.limiter.attack.value = 0.003;
      this.limiter.release.value = 0.1;
      this.master.connect(this.limiter);
      this.limiter.connect(ctx.destination);
    }

    this.active = new Map(); // id -> { osc, filter, gain, pitch }
    this.lastPitch = null;
  }

  applyParams() {
    const p = this.params;
    const t = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(p.volume, t, 0.03);
    // Live Q updates for sounding notes; cutoff is the envelope base for new notes
    for (const v of this.active.values()) {
      try {
        v.filter.Q.setTargetAtTime(p.resonance, t, 0.03);
      } catch (e) { /* node gone */ }
    }
  }

  noteOn(id, pitch, velocity, when) {
    const ctx = this.ctx;
    const t = Math.max(when != null ? when : ctx.currentTime, ctx.currentTime);
    this.noteOff(id, t); // retrigger same id

    const p = this.params;
    const accented = (velocity | 0) >= 100;
    const accentBoost = accented ? p.accent : 0;

    const osc = ctx.createOscillator();
    osc.type = p.wave;

    const targetFreq = midiToFreq(pitch);
    const canGlide = this.lastPitch != null && p.slideTau > 0.0005;
    if (canGlide) {
      osc.frequency.setValueAtTime(midiToFreq(this.lastPitch), t);
      osc.frequency.setTargetAtTime(targetFreq, t, p.slideTau);
    } else {
      osc.frequency.setValueAtTime(targetFreq, t);
    }
    this.lastPitch = pitch;

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.Q.setValueAtTime(p.resonance, t);
    const peak = p.cutoff + p.envAmt * (1 + accentBoost);
    filter.frequency.setValueAtTime(peak, t);
    filter.frequency.setTargetAtTime(p.cutoff, t, 0.09);

    const gain = ctx.createGain();
    const ampLevel = 0.5 * (1 + accentBoost);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.linearRampToValueAtTime(ampLevel, t + p.attack);

    osc.connect(filter);
    filter.connect(gain);
    gain.connect(this.master);
    osc.start(t);

    this.active.set(id, { osc, filter, gain, pitch });
  }

  noteOff(id, when) {
    const v = this.active.get(id);
    if (!v) return;
    const ctx = this.ctx;
    const t = Math.max(when != null ? when : ctx.currentTime, ctx.currentTime);
    const p = this.params;
    const stopAfter = p.releaseTau * 8 + 0.05;
    try {
      v.gain.gain.cancelScheduledValues(t);
      v.gain.gain.setValueAtTime(Math.max(0.0001, v.gain.gain.value), t);
      v.gain.gain.setTargetAtTime(0.0001, t, p.releaseTau);
      v.osc.stop(t + stopAfter);
    } catch (e) { /* already stopped */ }
    this.active.delete(id);
    setTimeout(() => {
      try {
        v.osc.disconnect();
        v.filter.disconnect();
        v.gain.disconnect();
      } catch (e) {}
    }, (stopAfter + 0.05) * 1000);
  }

  allOff() {
    const ids = [...this.active.keys()];
    for (const id of ids) this.noteOff(id);
    this.lastPitch = null;
  }

  dispose() {
    this.allOff();
    try {
      this.master.disconnect();
      if (this.limiter) this.limiter.disconnect();
    } catch (e) {}
  }
}
