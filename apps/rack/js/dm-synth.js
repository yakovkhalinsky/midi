/* AUTO-GENERATED for the rack: copy of ../drummap/js/synth.js with the globals
 * that collide with the TB-3PO modules renamed to DM_*. Regenerate with the
 * snippet in the rack README if the drummap source changes. */
'use strict';
/*
 * Web Audio drum voices for the DrumMap port. The hardware emits trigger
 * pulses (velocity from the Grids level); these render kick / snare / hi-hat
 * one-shots, with accents louder and brighter.
 */

class DrumVoice {
  constructor(ctx) {
    this.ctx = ctx;
    this.params = {
      volume: 0.5,
      kickPitch: 155,   // Hz start pitch
      kickDecay: 0.22,  // s
      snareTone: 1800,  // Hz bandpass
      hatDecay: 0.05,   // s
      accent: 1.0,      // multiplier for accent hits
    };

    this.master = ctx.createGain();
    this.master.gain.value = this.params.volume;

    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -8;
    this.limiter.ratio.value = 12;
    this.limiter.attack.value = 0.001;
    this.limiter.release.value = 0.08;

    this.master.connect(this.limiter);
    this.limiter.connect(ctx.destination);

    // shared white-noise buffer
    const len = Math.floor(ctx.sampleRate * 1.5);
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }

  applyParams() {
    this.master.gain.setTargetAtTime(this.params.volume, this.ctx.currentTime, 0.03);
  }

  /* {t, part, accent} — part 0 kick, 1 snare, 2 hihat */
  hit(ev) {
    const t = Math.max(ev.t, this.ctx.currentTime);
    if (ev.part === 0) this.kick(t, ev.accent);
    else if (ev.part === 1) this.snare(t, ev.accent);
    else this.hat(t, ev.accent);
  }

  kick(t, accent) {
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    const start = this.params.kickPitch * (accent ? 1.25 : 1);
    osc.frequency.setValueAtTime(start, t);
    osc.frequency.exponentialRampToValueAtTime(42, t + 0.09);

    const g = ctx.createGain();
    const peak = 0.9 * (1 + (accent ? this.params.accent : 0));
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(peak, t + 0.004);
    g.gain.setTargetAtTime(0.0001, t + 0.01, this.params.kickDecay * 0.45);

    osc.connect(g);
    g.connect(this.master);
    osc.start(t);
    osc.stop(t + this.params.kickDecay + 0.3);
  }

  snare(t, accent) {
    const ctx = this.ctx;
    const level = 0.6 * (1 + (accent ? this.params.accent : 0));

    // tonal body
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(220, t);
    osc.frequency.exponentialRampToValueAtTime(165, t + 0.06);
    const og = ctx.createGain();
    og.gain.setValueAtTime(0.0001, t);
    og.gain.linearRampToValueAtTime(level * 0.5, t + 0.003);
    og.gain.setTargetAtTime(0.0001, t + 0.005, 0.018);
    osc.connect(og);
    og.connect(this.master);
    osc.start(t);
    osc.stop(t + 0.25);

    // noise burst
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = this.params.snareTone * (accent ? 1.25 : 1);
    bp.Q.value = 0.9;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.0001, t);
    ng.gain.linearRampToValueAtTime(level, t + 0.002);
    ng.gain.setTargetAtTime(0.0001, t + 0.004, 0.022);
    src.connect(bp);
    bp.connect(ng);
    ng.connect(this.master);
    src.start(t, Math.random() * 0.5);
    src.stop(t + 0.25);
  }

  hat(t, accent) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = accent ? 9500 : 7800;
    const g = ctx.createGain();
    const peak = 0.45 * (1 + (accent ? this.params.accent : 0));
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(peak, t + 0.001);
    g.gain.setTargetAtTime(0.0001, t + 0.002, this.params.hatDecay * 0.3);
    src.connect(hp);
    hp.connect(g);
    g.connect(this.master);
    src.start(t, Math.random() * 0.5);
    src.stop(t + this.params.hatDecay + 0.15);
  }

  dispose() {
    try { /* nothing persistent */ } catch (e) { /* noop */ }
  }
}