'use strict';
/*
 * Rack — up to 3 apps in a column, one shared clock, one output destination.
 *
 * The three OLED screens in the top row are live slots; a selector (or clicking
 * a screen) shows the selected slot's controls underneath. Slots are real
 * component instances (engine + voice + OLED renderer per slot), not iframes:
 * drummap's modules are loaded as namespaced copies (js/dm-*.js, DM_ prefixed
 * globals) so both apps' files coexist on one page.
 *
 * The rack owns: transport (BPM, clock division, RUN/STOP, CLOCK/RESET), the
 * global output destination (Web Audio | MIDI out), and one Web MIDI device.
 * Per slot: app, clock ÷N, mute, and MIDI channel/velocity/etc.
 *
 * Clock: one lookahead scheduler on the rack's AudioContext; each slot gets
 * edges every ÷Nth shared edge, with cycle = period * N (first edge fires).
 * Slot factories are exposed as window.RackSlots for _selftest.html.
 */

(function () {
  const LOOKAHEAD = 0.15;
  const SCHED_MS = 25;
  const STORE_KEY = 'rack-web-v2';

  const $ = (id) => document.getElementById(id);
  const con = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const fmtSigned = (n) => (n > 0 ? '+' : '') + n;

  const rack = {
    audioCtx: null,
    running: false,
    bpm: 124,
    div: 4,            // shared clock: edges per beat (4 = 16ths)
    outputDest: 'audio',
    midiDeviceId: null,
    midiOut: null,
    slots: [],
    selected: 0,
    edgeIndex: 0,
    nextClockT: 0,
    timer: null,
  };

  function ensureAudio() {
    if (rack.audioCtx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    rack.audioCtx = new AC();
    for (const s of rack.slots) s.ensureVoice();
  }

  function period() { return 60 / (rack.bpm * rack.div); }

  /* perf-ms value of audio-second 0 (or of perf-seconds when no ctx) */
  function clockBase() {
    return performance.now() - (rack.audioCtx ? rack.audioCtx.currentTime : 0) * 1000;
  }

  function flashLed(el) {
    el.classList.add('on');
    clearTimeout(flashLed.timer);
    flashLed.timer = setTimeout(() => el.classList.remove('on'), 90);
  }

  // ==================================================================
  // Slot: TB-3PO
  // ==================================================================
  function makeTB3POSlot(index, cell, controls) {
    const engine = new TB3PO();
    const ol = new OLED();
    const s = {
      index, app: 'tb3po', div: 1, muted: false,
      engine, ol,
      params: {
        lockSeed: false, seedHex: (engine.seed & 0xffff).toString(16).padStart(4, '0'),
        density: 12, length: 16,
        scaleIndex: engine.scaleIndex, rootNote: engine.rootNote, qOctave: engine.qOctave,
        transposeAmt: 0, transposeInSemitones: engine.transposeInSemitones,
      },
      voiceParams: { volume: 0.22, cutoff: 550, resonance: 10, envAmt: 2600, accent: 1.0, slideMs: 5.2, releaseMs: 14 },
      midiParams: { channel: 0, velocity: 100, accentVel: 127, octave: 0, portamento: false },
      heldNote: null,
      voice: null,
      cell, controls,
    };

    s.name = 'TB-3PO';

    s.ensureVoice = function () {
      if (!s.voice && rack.audioCtx) {
        s.voice = new AcidVoice(rack.audioCtx);
        s.applyVoiceParams();
      }
    };

    s.applyVoiceParams = function () {
      if (!s.voice) return;
      const v = s.voiceParams, p = s.voice.params;
      p.volume = v.volume; p.cutoff = v.cutoff; p.resonance = v.resonance;
      p.envAmt = v.envAmt; p.accent = v.accent;
      p.slideTau = v.slideMs / 1000; p.releaseTau = v.releaseMs / 1000;
      s.voice.applyParams();
    };

    s.regenerate = function () {
      engine.regenerateAll();
      engine.regeneratePhase = 1;
      engine.updateRegeneration();
      engine.currPitchCv = engine.getPitchForStep(engine.step);
      engine.currStepSemitone = engine.getSemitoneForStep(engine.step);
      s.livePitch();
    };

    s.livePitch = function () {
      if (s.voice && rack.audioCtx) {
        s.voice.pitch({ t: rack.audioCtx.currentTime, semis: engine.currPitchCv / 128, glide: false });
      }
    };

    s.requantize = function () {
      engine.currPitchCv = engine.getPitchForStep(engine.step);
      engine.slideEndCv = engine.currPitchCv;
      engine.currStepSemitone = engine.getSemitoneForStep(engine.step);
      s.livePitch();
    };

    s.applyEngine = function () {
      engine.lockSeed = s.params.lockSeed ? 1 : 0;
      engine.seed = parseInt(s.params.seedHex, 16) & 0xffff;
      engine.densityEncoder = s.params.density;
      engine.densityEncoderDisplay = 25;
      engine.numSteps = s.params.length;
      engine.scaleIndex = s.params.scaleIndex;
      engine.rootNote = s.params.rootNote;
      engine.qOctave = s.params.qOctave;
      engine.transposeAmt = s.params.transposeAmt;
      engine.transposeInSemitones = s.params.transposeInSemitones;
      engine.setQuantizerScale();
      engine.refreshDensity();
      s.regenerate();
    };

    s.applyEngine();

    /* ---- clock ---- */
    s.onClock = function (t, cycle) {
      if (s.muted) return;
      engine.refreshDensity();
      const evs = engine.onClock(t, cycle);
      const toAudio = rack.outputDest === 'audio' && s.voice;
      const toMidi = rack.outputDest === 'midi';
      for (const e of evs) {
        if (e.type === 'pitch') {
          if (toAudio) s.voice.pitch(e);
        } else if (e.type === 'gateOn') {
          if (toAudio) s.voice.gateOn(e);
          else if (toMidi) s.midiGateOn(e);
        }
      }
      if (engine.gateOffTime > 0 && !engine.stepIsSlid(engine.step)) {
        if (toAudio) {
          s.voice.cancelPendingOff(engine.gateOffTime);
          s.voice.gateOff(engine.gateOffTime);
        } else if (toMidi) {
          s.midiGateOff(engine.gateOffTime);
        }
      }
      for (const e of evs) {
        if (e.type === 'pitch' && e.glide) engine.slideActiveUntil = e.t + 6 * (s.voiceParams.slideMs / 1000);
      }
    };

    /* ---- per-slot MIDI (TB-3PO note semantics: chains + CC65) ---- */
    s.midiGateOn = function (ev) {
      const m = s.midiParams;
      const note = con(Math.round(engine.currPitchCv / 128) + 60 + m.octave * 12, 0, 127);
      const vel = con(ev.accent ? m.accentVel : m.velocity, 1, 127);
      const ch = m.channel & 0xf;
      const chained = s.heldNote !== null && s.heldNote !== note;
      if (chained) {
        rack.midiOut.send([0x80 | ch, s.heldNote, 0], ev.t);
        if (m.portamento) rack.midiOut.send([0xb0 | ch, 65, 127], ev.t);
      }
      rack.midiOut.send([0x90 | ch, note, vel], ev.t);
      s.heldNote = note;
      s.cell.flashMidi();
    };

    s.midiGateOff = function (t) {
      if (s.heldNote === null) return;
      const ch = s.midiParams.channel & 0xf;
      rack.midiOut.send([0x80 | ch, s.heldNote, 0], t);
      s.heldNote = null;
      if (s.midiParams.portamento) rack.midiOut.send([0xb0 | ch, 65, 0], t);
    };

    s.midiSilence = function () {
      const ch = s.midiParams.channel & 0xf;
      if (s.heldNote !== null) {
        rack.midiOut.send([0x80 | ch, s.heldNote, 0]);
        s.heldNote = null;
      }
      rack.midiOut.send([0x80 | ch, 123, 0]);
      rack.midiOut.send([0xb0 | ch, 65, 0]);
    };

    s.reset = function () { engine.reset(); };

    s.setDest = function () {
      // global routing changed: silence the path that is no longer selected
      if (rack.outputDest === 'midi') { if (s.voice) s.voice.allOff(); }
      else s.midiSilence();
    };

    s.silence = function () { if (s.voice) s.voice.allOff(); s.midiSilence(); };

    /* ---- per-frame engine bookkeeping + render ---- */
    s.tick = function (now, dt) {
      engine.refreshDensity();
      if (engine.currGateCv > 0 && engine.gateOffTime > 0 && now >= engine.gateOffTime) {
        const willCut = !engine.stepIsSlid(engine.step);
        engine.gateOffTime = 0;
        if (willCut) {
          engine.currGateCv = 0;
          if (rack.outputDest === 'audio' && s.voice) s.voice.gateOff(now);
          else if (rack.outputDest === 'midi') s.midiGateOff(now);
        }
      }
      engine.update(now);
    };

    s.render = function () {
      drawTB3PO(s.ol, engine, CUR.NONE);
      s.ol.blit(s.cell.oledCtx, 1, '#e8f4ff');
      s.renderStrip();
      s.renderLeds();
    };

    s.renderLeds = function () {
      s.cell.leds.gate.classList.toggle('on', engine.currGateCv > 0);
      s.cell.leds.amber.classList.toggle('on', engine.currGateCv > 4608);
      s.cell.leds.blue.classList.toggle('on', engine.slideActiveUntil !== 0);
    };

    s.renderStrip = function () {
      const ctx = s.cell.stripCtx, w = s.cell.stripW, h = s.cell.stripH;
      ctx.clearRect(0, 0, w, h);
      const cellW = w / 32;
      for (let i = 0; i < 32; i++) {
        const x = i * cellW;
        const inLoop = i < engine.numSteps;
        const isCur = i === engine.step && inLoop;
        ctx.fillStyle = isCur ? 'rgba(126,220,255,0.16)' : (inLoop ? 'rgba(255,255,255,0.04)' : 'rgba(255,255,255,0.015)');
        ctx.fillRect(x + 1, 2, cellW - 2, h - 4);
        if (!inLoop) continue;
        if (engine.stepIsGated(i)) {
          const acc = engine.stepIsAccent(i);
          ctx.fillStyle = acc ? '#ffb454' : '#7fe3a0';
          ctx.fillRect(x + 1.5, 4, cellW - 3, (h - 6) * (acc ? 1 : 0.62));
        }
        if (engine.stepIsSlid(i)) {
          ctx.strokeStyle = '#7fb7ff';
          ctx.beginPath();
          ctx.moveTo(x + 2, h - 5);
          ctx.quadraticCurveTo(x + cellW / 2, h - 2.5, x + cellW - 2, h - 5);
          ctx.stroke();
        }
      }
    };

    s.buildControls = function (host) {
      const P = s.params, V = s.voiceParams, M = s.midiParams;
      host.innerHTML = `
        <div class="controls-head">
          <span class="mon-label">APP</span>
          <select data-k="app">
            <option value="tb3po" selected>TB-3PO</option>
            <option value="drummap">DrumMap</option>
            <option value="">— empty —</option>
          </select>
          <span class="mon-label">CLOCK</span>
          <select data-k="div">${[1,2,3,4,6,8].map(n => `<option value="${n}">÷${n}</option>`).join('')}</select>
          <label class="switch"><input type="checkbox" data-k="muted"><span>mute</span></label>
        </div>
        <div class="controls-grid">
          <div class="group">
            <h2>Seed</h2>
            <div class="row">
              <label class="switch"><input type="checkbox" data-k="lockSeed"><span>lock</span></label>
              <input class="hex" data-k="seedHex" maxlength="4" pattern="[0-9a-fA-F]{0,4}" title="seed hex (locked)">
              <button data-k="rand" class="small-btn">random</button>
            </div>
            <p class="tip">Same seed + settings = same pattern. Unlocked: re-randomizes on every RESET.</p>
          </div>
          <div class="group">
            <h2>Density</h2>
            <div class="row"><label class="grow">encoder <span class="val" data-k="densityVal"></span></label>
              <input type="range" data-k="density" min="0" max="14" step="1"></div>
            <p class="tip">−7 dense root · 0 sparse full scale · +7 dense full scale.</p>
          </div>
          <div class="group">
            <h2>Pattern</h2>
            <div class="row"><label class="grow">length <span class="val" data-k="lengthVal"></span></label>
              <input type="range" data-k="length" min="1" max="32" step="1"></div>
            <div class="row"><label class="switch"><input type="checkbox" data-k="holdPitch"><span>Hold pitch</span></label></div>
            <div class="row"><label class="switch"><input type="checkbox" data-k="noSlides"><span>Disable slides</span></label></div>
          </div>
          <div class="group">
            <h2>Quantizer</h2>
            <div class="row"><label class="grow">scale</label><select data-k="scale"></select></div>
            <div class="row"><label for="">root</label><select data-k="root"></select>
              <label>oct</label><select data-k="qoctave"></select></div>
          </div>
          <div class="group">
            <h2>Transpose</h2>
            <div class="row"><label class="grow">CV 1 <span class="val" data-k="transposeVal"></span></label>
              <input type="number" data-k="transpose" min="-24" max="24" step="1" style="width:4.5em"></div>
            <div class="row"><button data-k="transMode" class="small-btn"></button>
              <span class="tip inline">Root = semitones · Deg = scale degrees</span></div>
          </div>
          <div class="group audio-only">
            <h2>Voice</h2>
            <div class="row"><label class="grow">volume <span class="val" data-k="volVal"></span></label><input type="range" data-k="volume" min="0" max="0.6" step="0.01"></div>
            <div class="row"><label class="grow">cutoff <span class="val" data-k="cutoffVal"></span></label><input type="range" data-k="cutoff" min="120" max="4000" step="10"></div>
            <div class="row"><label class="grow">resonance <span class="val" data-k="resVal"></span></label><input type="range" data-k="resonance" min="1" max="20" step="0.1"></div>
            <div class="row"><label class="grow">filter env <span class="val" data-k="envVal"></span></label><input type="range" data-k="env" min="0" max="6000" step="50"></div>
            <div class="row"><label class="grow">accent <span class="val" data-k="accentVal"></span></label><input type="range" data-k="vaccent" min="0" max="2" step="0.1"></div>
            <div class="row"><label class="grow">glide <span class="val" data-k="glideVal"></span></label><input type="range" data-k="glide" min="1" max="30" step="0.1"></div>
            <div class="row"><label class="grow">release <span class="val" data-k="releaseVal"></span></label><input type="range" data-k="release" min="2" max="60" step="1"></div>
          </div>
          <div class="group midi-only">
            <h2>MIDI out</h2>
            <div class="row"><label>channel</label><select data-k="channel"></select>
              <label>oct</label><select data-k="moctave"></select></div>
            <div class="row"><label class="grow">velocity <span class="val" data-k="velVal"></span></label><input type="range" data-k="velocity" min="1" max="127" step="1"></div>
            <div class="row"><label class="grow">accent vel <span class="val" data-k="accVelVal"></span></label><input type="range" data-k="accvel" min="1" max="127" step="1"></div>
            <div class="row"><label class="switch"><input type="checkbox" data-k="portamento"><span>slides → CC65 portamento</span></label></div>
            <p class="tip">C4 = 60 · gate = 50% of the clock cycle · accent switches velocity.</p>
          </div>
        </div>`;
      const q = (k) => host.querySelector('[data-k="' + k + '"]');

      // wire simple sliders/checkboxes
      const bindings = [
        ['density', 'input', () => { P.density = parseInt(q('density').value, 10); engine.densityEncoder = P.density; engine.densityEncoderDisplay = 25; engine.refreshDensity(); }],
        ['length', 'input', () => { P.length = parseInt(q('length').value, 10); if (engine.step >= engine.numSteps) engine.step = 0; engine.numSteps = P.length; }],
        ['holdPitch', 'change', () => { engine.holdPitch = q('holdPitch').checked; }],
        ['noSlides', 'change', () => { engine.noSlides = q('noSlides').checked; }],
        ['lockSeed', 'change', () => { P.lockSeed = q('lockSeed').checked; engine.lockSeed = P.lockSeed ? 1 : 0; q('seedHex').disabled = !P.lockSeed; }],
        ['transpose', 'input', () => { P.transposeAmt = con(parseInt(q('transpose').value, 10) || 0, -24, 24); engine.transposeAmt = P.transposeAmt; s.requantize(); }],
        ['volume', 'input', () => { V.volume = parseFloat(q('volume').value); s.applyVoiceParams(); }],
        ['cutoff', 'input', () => { V.cutoff = parseFloat(q('cutoff').value); s.applyVoiceParams(); }],
        ['resonance', 'input', () => { V.resonance = parseFloat(q('resonance').value); s.applyVoiceParams(); }],
        ['env', 'input', () => { V.envAmt = parseFloat(q('env').value); s.applyVoiceParams(); }],
        ['vaccent', 'input', () => { V.accent = parseFloat(q('vaccent').value); s.applyVoiceParams(); }],
        ['glide', 'input', () => { V.slideMs = parseFloat(q('glide').value); s.applyVoiceParams(); }],
        ['release', 'input', () => { V.releaseMs = parseFloat(q('release').value); s.applyVoiceParams(); }],
        ['channel', 'change', () => { M.channel = parseInt(q('channel').value, 10); }],
        ['moctave', 'change', () => { M.octave = parseInt(q('moctave').value, 10); }],
        ['velocity', 'input', () => { M.velocity = parseInt(q('velocity').value, 10); }],
        ['accvel', 'input', () => { M.accentVel = parseInt(q('accvel').value, 10); }],
        ['portamento', 'change', () => { M.portamento = q('portamento').checked; }],
      ];
      // head controls
      const headBindings = [
        ['app', 'change', () => { changeSlotApp(s, q('app').value); }],
        ['div', 'change', () => { s.div = parseInt(q('div').value, 10) || 1; }],
        ['muted', 'change', () => { s.muted = q('muted').checked; if (s.muted) s.silence(); setCellName(s); }],
      ];
      for (const [k, ev, fn] of bindings.concat(headBindings)) {
        const el = q(k);
        if (el) el.addEventListener(ev, () => { fn(); saveSoon(); });
      }
      q('rand').addEventListener('click', () => { engine.reseed(); P.seedHex = (engine.seed & 0xffff).toString(16).padStart(4, '0'); s.syncControls(); saveSoon(); });
      q('seedHex').addEventListener('change', () => {
        const v = parseInt(q('seedHex').value, 16) & 0xffff;
        if (!isNaN(v)) { engine.seed = v; P.seedHex = v.toString(16).padStart(4, '0'); s.regenerate(); }
        s.syncControls(); saveSoon();
      });
      q('scale').addEventListener('change', () => { P.scaleIndex = parseInt(q('scale').value, 10); engine.scaleIndex = P.scaleIndex; engine.setQuantizerScale(); engine.refreshDensity(); s.requantize(); saveSoon(); });
      q('root').addEventListener('change', () => { P.rootNote = parseInt(q('root').value, 10); engine.rootNote = P.rootNote; s.requantize(); saveSoon(); });
      q('qoctave').addEventListener('change', () => { P.qOctave = parseInt(q('qoctave').value, 10); engine.qOctave = P.qOctave; s.requantize(); saveSoon(); });
      q('transMode').addEventListener('click', () => { engine.transposeInSemitones = !engine.transposeInSemitones; P.transposeInSemitones = engine.transposeInSemitones; s.requantize(); s.syncControls(); saveSoon(); });

      s.controlsHost = host;
      s.syncControls();
    };

    s.syncControls = function () {
      const host = s.controlsHost;
      if (!host) return;
      const P = s.params, V = s.voiceParams, M = s.midiParams;
      const q = (k) => host.querySelector('[data-k="' + k + '"]');
      const setV = (k, v) => { const el = q(k + 'Val'); if (el) el.textContent = v; };
      q('app').value = s.app;
      q('div').value = String(s.div);
      q('muted').checked = s.muted;
      q('lockSeed').checked = P.lockSeed;
      q('seedHex').value = P.seedHex;
      q('seedHex').disabled = !P.lockSeed;
      q('density').value = P.density; setV('density', fmtSigned(P.density - 7));
      q('length').value = P.length; setV('length', P.length);
      q('holdPitch').checked = engine.holdPitch;
      q('noSlides').checked = engine.noSlides;
      q('scale').value = String(P.scaleIndex);
      q('root').value = String(P.rootNote);
      q('qoctave').value = String(P.qOctave);
      q('transpose').value = P.transposeAmt; setV('transpose', fmtSigned(P.transposeAmt));
      q('transMode').textContent = engine.transposeInSemitones ? 'Root' : 'Deg';
      setV('vol', Math.round(V.volume * 100) + '%'); q('volume').value = V.volume;
      setV('cutoff', Math.round(V.cutoff) + ' Hz'); q('cutoff').value = V.cutoff;
      setV('resonance', V.resonance.toFixed(1)); q('resonance').value = V.resonance;
      setV('env', Math.round(V.envAmt) + ' Hz'); q('env').value = V.envAmt;
      setV('accent', '×' + V.accent.toFixed(1)); q('vaccent').value = V.accent;
      setV('glide', V.slideMs.toFixed(1) + ' ms'); q('glide').value = V.slideMs;
      setV('release', Math.round(V.releaseMs) + ' ms'); q('release').value = V.releaseMs;
      q('channel').value = String(M.channel);
      q('moctave').value = String(M.octave);
      setV('vel', M.velocity); q('velocity').value = M.velocity;
      setV('accVel', M.accentVel); q('accvel').value = M.accentVel;
      q('portamento').checked = M.portamento;
    };

    s.buildControlsStatics = function () {
      const q = (k) => s.controlsHost.querySelector('[data-k="' + k + '"]');
      for (const sc of SCALES) {
        const opt = document.createElement('option');
        opt.value = sc.id; opt.textContent = sc.name;
        q('scale').appendChild(opt);
      }
      for (let r = 0; r < 12; r++) {
        const opt = document.createElement('option');
        opt.value = r; opt.textContent = NOTE_NAMES[r];
        q('root').appendChild(opt);
      }
      const qo = q('qoctave'), mo = q('moctave');
      for (let o = -3; o <= 3; o++) {
        const a = document.createElement('option'); a.value = o; a.textContent = fmtSigned(o); qo.appendChild(a);
        if (o >= -2 && o <= 2) { const b = document.createElement('option'); b.value = o; b.textContent = fmtSigned(o); mo.appendChild(b); }
      }
      const ch = q('channel');
      for (let c = 0; c < 16; c++) {
        const opt = document.createElement('option');
        opt.value = c; opt.textContent = 'ch ' + (c + 1);
        ch.appendChild(opt);
      }
    };

    return s;
  }
  // ==================================================================
  // Slot: DrumMap
  // ==================================================================
  function makeDrumMapSlot(index, cell, controls) {
    const engine = new DrumMap();
    const ol = new DM_OLED();
    const s = {
      index, app: 'drummap', div: 2, muted: false,
      engine, ol,
      params: {
        patternSet: engine.patternSet,
        mode: engine.mode.slice(),
        fill: engine.fill.slice(),
        x: engine.x, y: engine.y, chaos: engine.chaos,
      },
      voiceParams: { volume: 0.5, kickPitch: 155, kickDecay: 0.22, snareTone: 1800, hatDecay: 0.05, accent: 1.0 },
      midiParams: { channel: 9, velocity: 100, accentVel: 127 },
      voice: null,
      cell, controls,
    };

    s.name = 'DrumMap';
    const GM_DRUM_NOTE = [36, 38, 42];
    const PART_NAMES = ['Kick', 'Snare', 'HiHat'];

    s.ensureVoice = function () {
      if (!s.voice && rack.audioCtx) {
        s.voice = new DrumVoice(rack.audioCtx);
        s.applyVoiceParams();
      }
    };

    s.applyVoiceParams = function () {
      if (!s.voice) return;
      Object.assign(s.voice.params, s.voiceParams);
      s.voice.applyParams();
    };

    s.applyEngine = function () {
      engine.patternSet = s.params.patternSet;
      engine.mode = s.params.mode.slice();
      engine.fill = s.params.fill.slice();
      engine.x = s.params.x; engine.y = s.params.y; engine.chaos = s.params.chaos;
      engine.refreshModulation();
    };

    s.applyEngine();

    /* ---- clock ---- */
    s.onClock = function (t) {
      if (s.muted) return;
      const events = engine.onClock(t);
      const audioOn = rack.outputDest === 'audio' && s.voice;
      const midiOn = rack.outputDest === 'midi' && rack.midiOut && rack.midiOut.output;
      if (audioOn) for (const e of events) s.voice.hit(e);
      if (midiOn) {
        for (const e of events) {
          const note = GM_DRUM_NOTE[e.part] || 36;
          const vel = con(e.accent ? s.midiParams.accentVel : s.midiParams.velocity, 1, 127);
          const ch = s.midiParams.channel & 0xf;
          rack.midiOut.send([0x90 | ch, note, vel], t);
          rack.midiOut.send([0x80 | ch, note, 0], t + 0.08);
          s.cell.flashMidi();
        }
      }
    };

    s.reset = function () { engine.reset(); };

    s.setDest = function () { /* one-shot drum hits: nothing held across a switch */ };
    s.midiSilence = function () { rack.midiOut.send([0xb0 | (s.midiParams.channel & 0xf), 123, 0]); };
    s.silence = function () { s.midiSilence(); };

    /* ---- per-frame + render ---- */
    s.tick = function (now, dt) {
      engine.refreshModulation();
      engine.update(now, dt);
    };

    s.render = function () {
      drawDrumMap(s.ol, engine, DCUR.NONE);
      s.ol.blit(s.cell.oledCtx, 1, '#e8f4ff');
      s.renderStrip();
      s.renderLeds();
    };

    s.renderLeds = function () {
      s.cell.leds.chA.classList.toggle('on', engine.pulseAnimation[0] > 0);
      s.cell.leds.chB.classList.toggle('on', engine.pulseAnimation[1] > 0);
    };

    s.renderStrip = function () {
      const ctx = s.cell.stripCtx, w = s.cell.stripW, h = s.cell.stripH;
      ctx.clearRect(0, 0, w, h);
      const cellW = w / 32;
      for (let i = 0; i < 32; i++) {
        const x = i * cellW;
        ctx.fillStyle = i === engine.step ? 'rgba(255,180,84,0.16)' : 'rgba(255,255,255,0.04)';
        ctx.fillRect(x + 1, 2, cellW - 2, h - 4);
        for (let ch = 0; ch < 2; ch++) {
          const part = (ch === 1 && engine.mode[ch] === 3) ? engine.mode[0] : engine.mode[ch];
          const level = engine.readDrumMap(i, part, engine._x, engine._y);
          const threshold = (ch === 1 && engine.mode[ch] === 3) ? (~engine._fill[0] & 0xff) : (~engine._fill[ch] & 0xff);
          const accent = engine.mode[ch] === 3 && level > 192;
          const fires = level > threshold && (engine.mode[ch] < 3 || level > 192);
          const rowY = ch === 0 ? 4 : h / 2 + 2;
          const bh = Math.max(2, Math.round((level / 255) * (h / 2 - 8)));
          ctx.fillStyle = fires ? (accent ? '#ffd9a0' : '#ffb454') : 'rgba(255,255,255,0.22)';
          ctx.fillRect(x + 2, rowY + h / 2 - 8 - bh, cellW - 3, bh);
          if (fires) {
            ctx.fillStyle = '#7fe3a0';
            ctx.fillRect(x + 1.5, rowY + h / 2 - 6, cellW - 3, 2.5);
          }
        }
      }
    };

    s.buildControls = function (host) {
      const P = s.params, V = s.voiceParams, M = s.midiParams;
      host.innerHTML = `
        <div class="controls-head">
          <span class="mon-label">APP</span>
          <select data-k="app">
            <option value="drummap" selected>DrumMap</option>
            <option value="tb3po">TB-3PO</option>
            <option value="">— empty —</option>
          </select>
          <span class="mon-label">CLOCK</span>
          <select data-k="div">${[1,2,3,4,6,8].map(n => `<option value="${n}">÷${n}</option>`).join('')}</select>
          <label class="switch"><input type="checkbox" data-k="muted"><span>mute</span></label>
        </div>
        <div class="controls-grid">
          <div class="group">
            <h2>Pattern set</h2>
            <div class="row"><label class="grow">set</label>
              <select data-k="patternSet">
                <option value="grids2">Grids 2 (Phazerville)</option>
                <option value="classic">Grids (original MI)</option>
              </select></div>
          </div>
          <div class="group">
            <h2>Channel A</h2>
            <div class="row"><label class="grow">part</label><select data-k="partA">
              <option value="0">Kick</option><option value="1">Snare</option><option value="2">HiHat</option></select></div>
            <div class="row"><label class="grow">fill <span class="val" data-k="fillAVal"></span></label>
              <input type="range" data-k="fillA" min="0" max="255" step="1"></div>
          </div>
          <div class="group">
            <h2>Channel B</h2>
            <div class="row"><label class="grow">part</label><select data-k="partB">
              <option value="0">Kick</option><option value="1">Snare</option>
              <option value="2">HiHat</option><option value="3">Accent (A)</option></select></div>
            <div class="row"><label class="grow">fill <span class="val" data-k="fillBVal"></span></label>
              <input type="range" data-k="fillB" min="0" max="255" step="1"></div>
          </div>
          <div class="group">
            <h2>Map</h2>
            <div class="row"><label class="grow">X <span class="val" data-k="xVal"></span></label>
              <input type="range" data-k="x" min="0" max="255" step="1"></div>
            <div class="row"><label class="grow">Y <span class="val" data-k="yVal"></span></label>
              <input type="range" data-k="y" min="0" max="255" step="1"></div>
            <div class="row"><label class="grow">chaos <span class="val" data-k="chaosVal"></span></label>
              <input type="range" data-k="chaos" min="0" max="255" step="1"></div>
          </div>
          <div class="group audio-only">
            <h2>Voice</h2>
            <div class="row"><label class="grow">volume <span class="val" data-k="volVal"></span></label><input type="range" data-k="volume" min="0" max="1" step="0.01"></div>
            <div class="row"><label class="grow">kick pitch <span class="val" data-k="kickPitchVal"></span></label><input type="range" data-k="kickPitch" min="90" max="260" step="1"></div>
            <div class="row"><label class="grow">kick decay <span class="val" data-k="kickDecayVal"></span></label><input type="range" data-k="kickDecay" min="0.05" max="0.5" step="0.01"></div>
            <div class="row"><label class="grow">snare tone <span class="val" data-k="snareToneVal"></span></label><input type="range" data-k="snareTone" min="800" max="3600" step="50"></div>
            <div class="row"><label class="grow">hat decay <span class="val" data-k="hatDecayVal"></span></label><input type="range" data-k="hatDecay" min="0.01" max="0.2" step="0.005"></div>
            <div class="row"><label class="grow">accent <span class="val" data-k="accentVal"></span></label><input type="range" data-k="vaccent" min="0" max="2" step="0.1"></div>
          </div>
          <div class="group midi-only">
            <h2>MIDI out</h2>
            <div class="row"><label>channel</label><select data-k="channel"></select>
              <span class="tip inline">GM drums</span></div>
            <div class="row"><label class="grow">velocity <span class="val" data-k="velVal"></span></label><input type="range" data-k="velocity" min="1" max="127" step="1"></div>
            <div class="row"><label class="grow">accent vel <span class="val" data-k="accVelVal"></span></label><input type="range" data-k="accvel" min="1" max="127" step="1"></div>
            <p class="tip">36 kick · 38 snare · 42 hat · accent switches velocity.</p>
          </div>
        </div>`;
      const q = (k) => host.querySelector('[data-k="' + k + '"]');

      const bindings = [
        ['patternSet', 'change', () => { P.patternSet = q('patternSet').value; engine.patternSet = P.patternSet; }],
        ['partA', 'change', () => { P.mode[0] = parseInt(q('partA').value, 10) % 3; engine.mode[0] = P.mode[0]; }],
        ['partB', 'change', () => { P.mode[1] = parseInt(q('partB').value, 10); engine.mode[1] = P.mode[1]; }],
        ['fillA', 'input', () => { P.fill[0] = parseInt(q('fillA').value, 10); engine.fill[0] = P.fill[0]; engine.valueAnimation = HEM_DRUMMAP_VALUE_ANIMATION_TICKS; }],
        ['fillB', 'input', () => { P.fill[1] = parseInt(q('fillB').value, 10); engine.fill[1] = P.fill[1]; engine.valueAnimation = HEM_DRUMMAP_VALUE_ANIMATION_TICKS; }],
        ['x', 'input', () => { P.x = parseInt(q('x').value, 10); engine.x = P.x; engine.valueAnimation = HEM_DRUMMAP_VALUE_ANIMATION_TICKS; }],
        ['y', 'input', () => { P.y = parseInt(q('y').value, 10); engine.y = P.y; engine.valueAnimation = HEM_DRUMMAP_VALUE_ANIMATION_TICKS; }],
        ['chaos', 'input', () => { P.chaos = parseInt(q('chaos').value, 10); engine.chaos = P.chaos; engine.valueAnimation = HEM_DRUMMAP_VALUE_ANIMATION_TICKS; }],
        ['volume', 'input', () => { V.volume = parseFloat(q('volume').value); s.applyVoiceParams(); }],
        ['kickPitch', 'input', () => { V.kickPitch = parseFloat(q('kickPitch').value); s.applyVoiceParams(); }],
        ['kickDecay', 'input', () => { V.kickDecay = parseFloat(q('kickDecay').value); s.applyVoiceParams(); }],
        ['snareTone', 'input', () => { V.snareTone = parseFloat(q('snareTone').value); s.applyVoiceParams(); }],
        ['hatDecay', 'input', () => { V.hatDecay = parseFloat(q('hatDecay').value); s.applyVoiceParams(); }],
        ['vaccent', 'input', () => { V.accent = parseFloat(q('vaccent').value); s.applyVoiceParams(); }],
        ['channel', 'change', () => { M.channel = parseInt(q('channel').value, 10); }],
        ['velocity', 'input', () => { M.velocity = parseInt(q('velocity').value, 10); }],
        ['accvel', 'input', () => { M.accentVel = parseInt(q('accvel').value, 10); }],
        ['app', 'change', () => { changeSlotApp(s, q('app').value); }],
        ['div', 'change', () => { s.div = parseInt(q('div').value, 10) || 1; }],
        ['muted', 'change', () => { s.muted = q('muted').checked; if (s.muted) s.midiSilence(); setCellName(s); }],
      ];
      for (const [k, ev, fn] of bindings) {
        const el = q(k);
        if (el) el.addEventListener(ev, () => { fn(); saveSoon(); });
      }

      s.controlsHost = host;
      s.syncControls();
    };

    s.syncControls = function () {
      const host = s.controlsHost;
      if (!host) return;
      const P = s.params, V = s.voiceParams, M = s.midiParams;
      const q = (k) => host.querySelector('[data-k="' + k + '"]');
      const setV = (k, v) => { const el = q(k + 'Val'); if (el) el.textContent = v; };
      q('app').value = s.app;
      q('div').value = String(s.div);
      q('muted').checked = s.muted;
      q('patternSet').value = P.patternSet;
      q('partA').value = String(P.mode[0]);
      q('partB').value = String(P.mode[1]);
      q('fillA').value = P.fill[0]; setV('fillA', P.fill[0]);
      q('fillB').value = P.fill[1]; setV('fillB', P.fill[1]);
      q('x').value = P.x; setV('x', P.x);
      q('y').value = P.y; setV('y', P.y);
      q('chaos').value = P.chaos; setV('chaos', P.chaos);
      setV('vol', Math.round(V.volume * 100) + '%'); q('volume').value = V.volume;
      setV('kickPitch', Math.round(V.kickPitch) + ' Hz'); q('kickPitch').value = V.kickPitch;
      setV('kickDecay', (V.kickDecay * 1000).toFixed(0) + ' ms'); q('kickDecay').value = V.kickDecay;
      setV('snareTone', Math.round(V.snareTone) + ' Hz'); q('snareTone').value = V.snareTone;
      setV('hatDecay', (V.hatDecay * 1000).toFixed(0) + ' ms'); q('hatDecay').value = V.hatDecay;
      setV('accent', '×' + V.accent.toFixed(1)); q('vaccent').value = V.accent;
      q('channel').value = String(M.channel);
      setV('vel', M.velocity); q('velocity').value = M.velocity;
      setV('accVel', M.accentVel); q('accvel').value = M.accentVel;
    };

    s.buildControlsStatics = function () {
      const ch = s.controlsHost.querySelector('[data-k="channel"]');
      for (let c = 0; c < 16; c++) {
        const opt = document.createElement('option');
        opt.value = c; opt.textContent = 'ch ' + (c + 1) + (c === 9 ? ' (GM)' : '');
        ch.appendChild(opt);
      }
    };

    return s;
  }

  // ==================================================================
  // Slot plumbing (cells, creation, selection)
  // ==================================================================
  function makeEmptySlotShell(index, cell, controls) {
    const s = {
      index, app: null, div: 1, muted: false, loaded: false,
      name: '— empty —', leds: [], engine: null, ol: null,
      cell, controls,
      ensureVoice() {}, applyVoiceParams() {}, applyEngine() {},
      onClock() {}, reset() {}, setDest() {}, silence() {}, tick() {}, render() {},
      buildControls(host) {
        host.innerHTML = `
          <div class="controls-head">
            <span class="mon-label">APP</span>
            <select data-k="app">
              <option value="" selected>— empty —</option>
              <option value="tb3po">TB-3PO</option>
              <option value="drummap">DrumMap</option>
            </select>
            <span class="tip inline">pick an app for slot ${index + 1}</span>
          </div>`;
        const q = (k) => host.querySelector('[data-k="' + k + '"]');
        q('app').addEventListener('change', () => { changeSlotApp(s, q('app').value); });
        s.controlsHost = host;
        s.syncControls = function () { const el = host.querySelector('[data-k="app"]'); if (el) el.value = s.app || ''; };
        s.syncControls();
      },
      syncControls() {},
      midiSilence() {}, midiGateOff() {},
    };
    return s;
  }

  function createSlot(index, app) {
    const cell = buildCell(index);
    const controls = document.createElement('div');
    controls.className = 'slot-controls';
    $('controls').appendChild(controls);
    const s = (app === 'tb3po') ? makeTB3POSlot(index, cell, controls)
      : (app === 'drummap') ? makeDrumMapSlot(index, cell, controls)
      : makeEmptySlotShell(index, cell, controls);
    s.buildControls(controls);
    if (s.buildControlsStatics) s.buildControlsStatics();
    s.syncControls && s.syncControls();
    return s;
  }

  function changeSlotApp(slot, app) {
    if (!(app === 'tb3po' || app === 'drummap')) app = null;
    if (app === slot.app) return;
    slot.silence && slot.silence();
    slot.cell.remove();
    slot.controls.remove();
    const fresh = createSlot(slot.index, app);
    fresh.div = slot.div;
    fresh.muted = slot.muted;
    rack.slots[slot.index] = fresh;
    syncCellOrder();
    selectSlot(rack.selected);
    saveSoon();
  }

  function syncCellOrder() {
    for (const s of rack.slots) {
      $('oledRow').appendChild(s.cell);
      $('controls').appendChild(s.controls);
    }
  }

  function buildCell(index) {
    const cell = document.createElement('div');
    cell.className = 'oled-cell empty';
    cell.dataset.slot = index;
    cell.innerHTML = `
      <div class="cell-head">
        <span class="cell-name">— empty —</span>
        <span class="cell-leds"></span>
      </div>
      <canvas class="cell-oled" width="64" height="64"></canvas>
      <canvas class="cell-strip" width="256" height="28"></canvas>`;
    const oled = cell.querySelector('.cell-oled');
    const strip = cell.querySelector('.cell-strip');
    cell.oledCtx = oled.getContext('2d');
    cell.stripCtx = strip.getContext('2d');
    cell.stripW = strip.width;
    cell.stripH = strip.height;
    cell.ledEls = {};
    cell.flashMidi = () => flashLed(cell.leds.purple);
    cell.addEventListener('click', () => { selectSlot(index); });
    $('oledRow').appendChild(cell);
    cell.leds = new Proxy({}, {
      get(t, k) {
        if (!t[k]) {
          const el = document.createElement('span');
          el.className = 'dot-led ' + k;
          cell.querySelector('.cell-leds').appendChild(el);
          t[k] = el;
        }
        return t[k];
      },
    });
    return cell;
  }

  function selectSlot(i) {
    rack.selected = con(i, 0, 2);
    $('slotSel').value = String(rack.selected);
    for (const s of rack.slots) {
      s.cell.classList.toggle('selected', s.index === rack.selected);
      s.cell.classList.toggle('empty', !s.app);
      s.controls.classList.toggle('selected', s.index === rack.selected);
      setCellName(s);
    }
  }

  function setCellName(s) {
    s.cell.querySelector('.cell-name').textContent = s.app
      ? (s.index + 1 + ': ' + s.name + (s.muted ? ' · muted' : ''))
      : '— empty —';
  }

  // ==================================================================
  // Rack-level MIDI
  // ==================================================================
  function midiStatusText() {
    if (!rack.midiOut.access) return 'not granted yet';
    if (!rack.midiOut.output) return 'granted — no device selected';
    const o = rack.midiOut.outputs().find((x) => x.id === rack.midiOut.output.id);
    return o ? (o.name || o.id) : '?';
  }

  function updateMidiStatus() {
    $('midiStatus').textContent = 'Web MIDI: ' + midiStatusText();
  }

  function refreshMidiDevices() {
    const sel = $('midiDevice');
    const prev = rack.midiDeviceId;
    sel.textContent = '';
    const outs = rack.midiOut.outputs().map((o) => ({ id: o.id, name: o.name || o.id, manufacturer: o.manufacturer || '' }));
    if (!outs.length) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = rack.midiOut.access ? 'no MIDI devices seen' : '—';
      sel.appendChild(opt);
    }
    for (const o of outs) {
      const opt = document.createElement('option');
      opt.value = o.id;
      opt.textContent = o.name + (o.manufacturer ? ' (' + o.manufacturer + ')' : '');
      sel.appendChild(opt);
    }
    if (prev && outs.some((o) => o.id === prev)) sel.value = prev;
    else if (outs.length === 1) sel.value = outs[0].id;
    rack.midiOut.select(sel.value || null);
    rack.midiDeviceId = sel.value || null;
    updateMidiStatus();
  }

  async function ensureMidiAccess() {
    if (rack.midiOut.access) { refreshMidiDevices(); return; }
    try {
      await rack.midiOut.init();
      rack.midiOut.onState = () => refreshMidiDevices();
      if (rack.midiDeviceId) rack.midiOut.select(rack.midiDeviceId);
      refreshMidiDevices();
    } catch (err) {
      const name = err && err.name;
      if (name === 'NotAllowedError') {
        $('midiStatus').textContent = 'Web MIDI: permission denied — reset in site settings';
      } else if (name === 'SecurityError') {
        $('midiStatus').textContent = 'Web MIDI: needs a secure context (https / localhost)';
      } else if (!(navigator.requestMIDIAccess)) {
        $('midiStatus').textContent = 'Web MIDI: not supported in this browser';
      } else {
        $('midiStatus').textContent = 'Web MIDI: failed (' + (err && err.message ? err.message : err) + ')';
      }
      return;
    }
    updateMidiStatus();
  }

  // ==================================================================
  // Scheduler
  // ==================================================================
  function doClock(t) {
    const base = clockBase();
    rack.edgeIndex++;
    for (const s of rack.slots) {
      if (!s.app || s.muted) continue;
      if ((rack.edgeIndex - 1) % s.div !== 0) continue;
      if (s.app === 'tb3po') s.onClock(t, period() * s.div);
      else s.onClock(t);
    }
  }

  function schedulerTick() {
    if (!rack.running || !rack.audioCtx) return;
    const horizon = rack.audioCtx.currentTime + LOOKAHEAD;
    while (rack.nextClockT < horizon) {
      doClock(rack.nextClockT);
      rack.nextClockT += period();
    }
  }

  function startRun() {
    ensureAudio();
    if (!rack.audioCtx) return;
    if (rack.audioCtx.state === 'suspended') rack.audioCtx.resume();
    rack.running = true;
    rack.nextClockT = rack.audioCtx.currentTime + 0.08;
    rack.edgeIndex = 0;
    if (!rack.timer) rack.timer = setInterval(schedulerTick, SCHED_MS);
    $('runBtn').classList.add('on');
    $('runBtn').textContent = 'STOP';
  }

  function stopRun() {
    rack.running = false;
    $('runBtn').classList.remove('on');
    $('runBtn').textContent = 'RUN';
    for (const s of rack.slots) s.app && s.silence();
  }

  function tapClock() {
    ensureAudio();
    if (rack.audioCtx && rack.audioCtx.state === 'suspended') rack.audioCtx.resume();
    const t = rack.audioCtx ? rack.audioCtx.currentTime + 0.015 : performance.now() / 1000;
    doClock(t);
  }

  function doReset() {
    for (const s of rack.slots) s.app && s.reset();
  }

  function applyOutputDest() {
    $('outputDest').value = rack.outputDest;
    document.body.dataset.dest = rack.outputDest;
    for (const s of rack.slots) {
      if (s.app) {
        s.setDest();
        s.syncControls && s.syncControls();
      }
    }
  }

  // ==================================================================
  // Frame loop
  // ==================================================================
  let lastFrameT = performance.now() / 1000;
  function frame() {
    const now = rack.audioCtx ? rack.audioCtx.currentTime : performance.now() / 1000;
    const dt = Math.min(Math.max(now - lastFrameT, 0.001), 0.2);
    lastFrameT = now;
    for (const s of rack.slots) {
      if (!s.app) continue;
      s.tick(now, dt);
      s.render();
    }
    requestAnimationFrame(frame);
  }

  function loadConfig() {
    try {
      return JSON.parse(localStorage.getItem(STORE_KEY) || 'null') || {};
    } catch (e) { return {}; }
  }

  function applySlotConfig(slot, sd) {
    slot.div = con(sd.div | 0, 1, 8);
    slot.muted = !!sd.muted;
    if (sd.params) Object.assign(slot.params, sd.params);
    if (sd.voiceParams) Object.assign(slot.voiceParams, sd.voiceParams);
    if (sd.midiParams) Object.assign(slot.midiParams, sd.midiParams);
    if (slot.app === 'tb3po') slot.applyEngine();
    if (slot.app === 'drummap') { slot.applyEngine(); slot.applyVoiceParams(); }
  }

  // ==================================================================
  // Boot
  // ==================================================================
  function initTransportUI() {
    $('runBtn').addEventListener('click', () => { rack.running ? stopRun() : startRun(); });
    $('clockBtn').addEventListener('click', tapClock);
    $('resetBtn').addEventListener('click', doReset);
    $('bpm').addEventListener('input', () => {
      rack.bpm = con(parseFloat($('bpm').value) || 124, 20, 300);
      saveSoon();
    });
    $('div').addEventListener('change', () => {
      rack.div = parseInt($('div').value, 10);
      saveSoon();
    });
    $('slotSel').addEventListener('change', () => selectSlot(parseInt($('slotSel').value, 10)));
    $('outputDest').addEventListener('change', () => {
      rack.outputDest = $('outputDest').value === 'midi' ? 'midi' : 'audio';
      applyOutputDest();
      if (rack.outputDest === 'midi') ensureMidiAccess();
      saveSoon();
    });
    $('midiConnect').addEventListener('click', ensureMidiAccess);
    $('midiRefresh').addEventListener('click', () => { ensureMidiAccess().then(refreshMidiDevices); });
    $('midiDevice').addEventListener('change', () => {
      rack.midiDeviceId = $('midiDevice').value || null;
      rack.midiOut.select(rack.midiDeviceId);
      updateMidiStatus();
      saveSoon();
    });
    $('midiPanic').addEventListener('click', () => {
      for (const s of rack.slots) if (s.app) s.midiSilence && s.midiSilence();
      flashLed($('midiDevice'));
    });

    window.addEventListener('keydown', (e) => {
      const tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'select' || tag === 'textarea') return;
      if (e.code === 'Space') { e.preventDefault(); tapClock(); }
      else if (e.key === 'r' || e.key === 'R') { doReset(); }
    });
  }

  // ==================================================================
  // Persistence
  // ==================================================================
  let saveTimer = null;
  function saveSoon() { clearTimeout(saveTimer); saveTimer = setTimeout(save, 300); }
  function save() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({
        bpm: rack.bpm, div: rack.div, outputDest: rack.outputDest,
        midiDeviceId: rack.midiDeviceId, selected: rack.selected,
        slots: rack.slots.map((s) => ({
          app: s.app, div: s.div, muted: s.muted,
          params: s.params, voiceParams: s.voiceParams, midiParams: s.midiParams,
        })),
      }));
    } catch (e) { /* storage unavailable */ }
  }

  function boot() {
    rack.midiOut = new MidiOut(() => (rack.audioCtx ? rack.audioCtx.currentTime : undefined));
    const d = loadConfig();
    const slotsCfg = Array.isArray(d.slots) && d.slots.some((s) => s && s.app)
      ? d.slots
      : [{ app: 'tb3po' }, {}, {}];   // fresh visitors: slot 1 starts with TB-3PO
    for (let i = 0; i < 3; i++) {
      const sd = slotsCfg[i] || {};
      const app = (sd.app === 'tb3po' || sd.app === 'drummap') ? sd.app : null;
      const s = createSlot(i, app);
      if (app) applySlotConfig(s, sd);
      rack.slots.push(s);
    }
    rack.bpm = con(d.bpm || 124, 20, 300);
    rack.div = [1, 2, 4, 8].includes(d.div) ? d.div : 4;
    rack.outputDest = d.outputDest === 'midi' ? 'midi' : 'audio';
    rack.midiDeviceId = d.midiDeviceId || null;
    rack.selected = con(d.selected | 0, 0, 2);

    initTransportUI();
    $('bpm').value = rack.bpm;
    $('div').value = String(rack.div);
    applyOutputDest();
    updateMidiStatus();
    selectSlot(rack.selected);
    for (const s of rack.slots) setCellName(s);
    requestAnimationFrame(frame);
  }

  boot();

  // test surface
  window.RackSlots = { createSlot, rack, doClock, clockBase, selectSlot, setCellName };
})();
