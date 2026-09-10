'use strict';
/*
 * TB-3PO Web — glue layer: audio clock scheduling, Web Audio voice wiring,
 * OLED + pattern-strip rendering, web-native parameter controls, persistence.
 */

(function () {
  // ------------------------------------------------------------------
  // State
  // ------------------------------------------------------------------
  const engine = new TB3PO();
  const ol = new OLED();

  let audioCtx = null;
  let voice = null;
  let running = false;
  let bpm = 124;
  let stepsPerBeat = 4;   // clock steps per beat: 4 = 16th-note clocking (TB-303 style)
  let nextClockT = 0;
  let lastClockT = 0;
  let schedulerTimer = null;
  let uiCursor = CUR.NONE;

  /* slot mode (?slot=1): the rack supplies clock/reset via postMessage,
     the page hides its own transport and renders as a compact card */
  const SLOT_MODE = new URLSearchParams(location.search).has('slot');

  const midiOut = new MidiOut(() => (audioCtx ? audioCtx.currentTime : undefined));
  const midiSeq = new MidiNoteSeq(midiOut);
  let outputDest = 'audio'; // 'audio' | 'midi'
  const midi = {            // MIDI-out properties (persisted)
    deviceId: null,
    channel: 0,             // 0-15 = MIDI ch 1-16
    velocity: 100,
    accentVel: 127,
    octave: 0,
    slidesToPortamento: false,
  };

  // synth params — source of truth until the voice exists
  const synth = {
    volume: 0.22,
    cutoff: 550,
    resonance: 10,
    envAmt: 2600,
    accent: 1.0,
    slideMs: 5.2,       // faithful default: 2^18 / (3 * 17kHz) ≈ 5.15 ms
    releaseMs: 14,
  };

  const LOOKAHEAD = 0.15;   // seconds of audio scheduling horizon
  const SCHED_MS = 25;

  const $ = (id) => document.getElementById(id);
  const oledCanvas = $('oled');
  const stripCanvas = $('strip');
  const oledCtx = oledCanvas.getContext('2d');
  const stripCtx = stripCanvas.getContext('2d');

  // ------------------------------------------------------------------
  // Audio
  // ------------------------------------------------------------------
  function ensureAudio() {
    if (audioCtx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    audioCtx = new AC();
    voice = new AcidVoice(audioCtx);
    applySynthParams();
    $('audioHint').textContent = '';
  }

  function applySynthParams() {
    if (!voice) return;
    voice.params.volume = synth.volume;
    voice.params.cutoff = synth.cutoff;
    voice.params.resonance = synth.resonance;
    voice.params.envAmt = synth.envAmt;
    voice.params.accent = synth.accent;
    voice.params.slideTau = synth.slideMs / 1000;
    voice.params.releaseTau = synth.releaseMs / 1000;
    voice.applyParams();
  }

  function period() { return 60 / (bpm * stepsPerBeat); }

  /* One clock edge at time t (audio-clock domain when audio exists).
     explicitCycle: when driven by the rack, the interval between this and the
     previous edge for THIS slot (period * clock-division); otherwise derived
     from the last two local clocks. */
  function doClock(t, explicitCycle) {
    engine.refreshDensity();
    const cycle = explicitCycle !== undefined ? explicitCycle
      : (lastClockT > 0 ? Math.min(Math.max(t - lastClockT, 0.03), 4) : period());
    const evs = engine.onClock(t, cycle);
    const toAudio = outputDest === 'audio' && voice;
    const toMidi = outputDest === 'midi';
    for (const e of evs) {
      if (e.type === 'pitch') { if (toAudio) voice.pitch(e); }
      else if (e.type === 'gateOn') {
        if (toAudio) voice.gateOn(e);
        else if (toMidi) {
          // the preceding pitch event already advanced currPitchCv to this step
          midiSeq.noteOn(midiSeq.noteFor(engine.currPitchCv / 128), !!e.accent, audioCtx ? e.t : undefined);
        }
      }
    }
    // Precise release when the current step's gate drops at half-cycle
    if (engine.gateOffTime > 0 && !engine.stepIsSlid(engine.step)) {
      if (toAudio) {
        voice.cancelPendingOff(engine.gateOffTime);
        voice.gateOff(engine.gateOffTime);
      } else if (toMidi) {
        midiSeq.noteOff(audioCtx ? engine.gateOffTime : undefined);
      }
    }
    // WAVEFORM_ICON on the OLED while the pitch CV is actively sliding
    for (const e of evs) {
      if (e.type === 'pitch' && e.glide) engine.slideActiveUntil = e.t + 6 * (synth.slideMs / 1000);
    }
    lastClockT = t;
  }

  function schedulerTick() {
    if (!running || !audioCtx) return;
    const horizon = audioCtx.currentTime + LOOKAHEAD;
    while (nextClockT < horizon) {
      doClock(nextClockT);
      nextClockT += period();
    }
  }

  function startRun() {
    ensureAudio();
    if (!audioCtx) return;
    if (audioCtx.state === 'suspended') audioCtx.resume();
    running = true;
    const t0 = audioCtx.currentTime + 0.06;
    lastClockT = t0 - period();
    nextClockT = t0;
    if (!schedulerTimer) schedulerTimer = setInterval(schedulerTick, SCHED_MS);
    $('runBtn').classList.add('on');
    $('runBtn').textContent = 'STOP';
  }

  function stopRun() {
    running = false;
    if (voice) voice.allOff();
    if (outputDest === 'midi') midiSeq.silence();
    $('runBtn').classList.remove('on');
    $('runBtn').textContent = 'RUN';
  }

  function tapClock() {
    ensureAudio();
    const t = audioCtx ? audioCtx.currentTime + 0.015 : performance.now() / 1000;
    doClock(t);
  }

  function doReset() { engine.reset(); }

  // ------------------------------------------------------------------
  // Rendering
  // ------------------------------------------------------------------
  function frame() {
    const now = audioCtx ? audioCtx.currentTime : performance.now() / 1000;
    engine.refreshDensity();

    // gate-off (the non-clock half of Controller()); also feeds the output
    if (engine.currGateCv > 0 && engine.gateOffTime > 0 && now >= engine.gateOffTime) {
      const willCut = !engine.stepIsSlid(engine.step);
      engine.gateOffTime = 0;
      if (willCut) {
        engine.currGateCv = 0;
        if (voice && outputDest === 'audio') voice.gateOff(now);
        else if (outputDest === 'midi') midiSeq.noteOff(audioCtx ? now : undefined);
      }
    }
    engine.update(now);

    drawTB3PO(ol, engine, uiCursor);
    ol.blit(oledCtx, 1, '#e8f4ff');
    drawStrip();
    drawMonitor();
    requestAnimationFrame(frame);
  }

  function drawStrip() {
    const w = stripCanvas.width, h = stripCanvas.height;
    stripCtx.clearRect(0, 0, w, h);
    const cellW = w / 32;
    for (let i = 0; i < 32; i++) {
      const x = i * cellW;
      const inLoop = i < engine.numSteps;
      const isCur = i === engine.step && inLoop;
      // cell background
      stripCtx.fillStyle = isCur ? 'rgba(126,220,255,0.16)' : (inLoop ? 'rgba(255,255,255,0.035)' : 'rgba(255,255,255,0.012)');
      stripCtx.fillRect(x + 1, 2, cellW - 2, h - 4);
      // loop end marker
      if (i === engine.numSteps - 1) {
        stripCtx.strokeStyle = 'rgba(255,255,255,0.5)';
        stripCtx.beginPath();
        stripCtx.moveTo(x + cellW - 0.5, 0);
        stripCtx.lineTo(x + cellW - 0.5, h);
        stripCtx.stroke();
      }
      if (!inLoop) continue;

      const gated = engine.stepIsGated(i);
      const accent = engine.stepIsAccent(i);
      const slid = engine.stepIsSlid(i);
      const octUp = engine.stepIsOctUp(i);
      const octDn = engine.stepIsOctDown(i);

      if (gated) {
        const barH = accent ? 30 : 20;
        stripCtx.fillStyle = accent ? '#ffb454' : '#7fe3a0';
        stripCtx.fillRect(x + 2, 40 - barH, cellW - 4, barH);
      }
      if (slid) {
        stripCtx.strokeStyle = '#7fb7ff';
        stripCtx.beginPath();
        stripCtx.moveTo(x + 2, 44);
        stripCtx.quadraticCurveTo(x + cellW / 2, 48, x + cellW - 2, 44);
        stripCtx.stroke();
      }
      stripCtx.fillStyle = inLoop ? '#dfe8ef' : 'rgba(223,232,239,0.35)';
      stripCtx.font = '9px monospace';
      stripCtx.textAlign = 'center';
      const pc = engine.getSemitoneForStep(i);
      stripCtx.fillText(NOTE_NAMES[pc], x + cellW / 2, 56);
      if (octUp || octDn) {
        stripCtx.fillStyle = '#c9a6ff';
        stripCtx.beginPath();
        const cy = octUp ? 6 : 12;
        if (octUp) { stripCtx.moveTo(x + cellW / 2, 3); stripCtx.lineTo(x + cellW / 2 - 4, 9); stripCtx.lineTo(x + cellW / 2 + 4, 9); }
        else { stripCtx.moveTo(x + cellW / 2, 12); stripCtx.lineTo(x + cellW / 2 - 4, 6); stripCtx.lineTo(x + cellW / 2 + 4, 6); }
        stripCtx.fill();
      }
    }
  }

  function drawMonitor() {
    $('pitchV').textContent = (engine.currPitchCv / 1536).toFixed(2) + ' V';
    const gv = engine.currGateCv / 1536;
    $('gateV').textContent = gv > 0 ? gv.toFixed(0) + ' V' : '0 V';
    $('noteName').textContent = NOTE_NAMES[engine.currStepSemitone];
    $('gateLed').classList.toggle('on', engine.currGateCv > 0);
    $('accLed').classList.toggle('on', engine.currGateCv > 4608);
    $('slideLed').classList.toggle('on', engine.slideActiveUntil !== 0);
  }

  // ------------------------------------------------------------------
  // Output / MIDI panel
  // ------------------------------------------------------------------
  function flashMidiLed() {
    const led = $('midiLed');
    led.classList.add('on');
    clearTimeout(flashMidiLed.timer);
    flashMidiLed.timer = setTimeout(() => led.classList.remove('on'), 90);
  }

  function midiStatusText() {
    if (!midiOut.access) return 'not granted yet';
    const outs = midiOut.outputs().length;
    const ins = midiOut.access.inputs ? midiOut.access.inputs.size : 0;
    if (!midiOut.output) return 'granted · ' + outs + ' out · ' + ins + ' in';
    const o = midiOut.outputs().find((x) => x.id === midiOut.output.id);
    return (o ? (o.name || o.id) : '?') + ' · ch ' + (midiOut.channel + 1);
  }

  function updateMidiStatus() {
    $('midiStatus').textContent = 'Web MIDI: ' + midiStatusText();
  }

  function applyOutputDest() {
    $('outputDest').value = outputDest;
    $('midiGroup').classList.toggle('dimmed', outputDest !== 'midi');
    document.querySelector('.audio-rows').classList.toggle('dimmed', outputDest !== 'audio');
    if (outputDest === 'midi') {
      if (voice) voice.allOff();
    } else {
      midiSeq.silence();
    }
  }

  const EMPTY_DEVICE_TIP = 'Access granted, but the browser sees no MIDI devices. ' +
    'Check the interface is powered and connected to the machine running this browser, ' +
    'then press ↻ (Chrome also picks up hotplug automatically — restarting the browser ' +
    'after connecting an interface can help). If you denied the MIDI prompt earlier, reset ' +
    'it: padlock in the address bar → Site settings → MIDI.';

  function refreshMidiDevices() {
    const sel = $('midiDevice');
    const prev = midi.deviceId;
    sel.textContent = '';
    const outs = midiOut.outputs().map((o) => ({ id: o.id, name: o.name || o.id, manufacturer: o.manufacturer || '' }));
    if (!outs.length) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = midiOut.access ? 'no MIDI devices seen' : '—';
      sel.appendChild(opt);
      $('midiHint').textContent = EMPTY_DEVICE_TIP;
    } else if ($('midiHint').textContent === EMPTY_DEVICE_TIP) {
      $('midiHint').textContent = 'Notes map: C4 = MIDI 60 · gate = 50% of the clock cycle · accent switches velocity.';
    }
    for (const o of outs) {
      const opt = document.createElement('option');
      opt.value = o.id;
      opt.textContent = o.name + (o.manufacturer ? ' (' + o.manufacturer + ')' : '');
      sel.appendChild(opt);
    }
    if (prev && outs.some((o) => o.id === prev)) {
      sel.value = prev;
      midiOut.select(prev);
    } else if (outs.length === 1) {
      sel.value = outs[0].id;
      midiOut.select(outs[0].id);
    }
    updateMidiStatus();
  }

  function syncMidiParams() {
    midiOut.channel = midi.channel;
    midiSeq.velocity = midi.velocity;
    midiSeq.accentVel = midi.accentVel;
    midiSeq.octave = midi.octave;
    midiSeq.slidesToPortamento = midi.slidesToPortamento;
    $('midiChannel').value = String(midi.channel);
    $('midiOctave').value = String(midi.octave);
    $('midiVel').value = midi.velocity;
    $('midiVelVal').textContent = midi.velocity;
    $('midiAccVel').value = midi.accentVel;
    $('midiAccVelVal').textContent = midi.accentVel;
    $('midiPortamento').checked = midi.slidesToPortamento;
  }

  async function ensureMidiAccess() {
    if (midiOut.access) { refreshMidiDevices(); return; }
    $('midiStatus').textContent = 'Web MIDI: requesting access…';
    try {
      await midiOut.init();
      midiOut.onState = () => refreshMidiDevices();
      midiSeq.onActivity = flashMidiLed;
      if (midi.deviceId) midiOut.select(midi.deviceId);
      refreshMidiDevices();
      const sel = $('midiDevice');
      if (sel.value) {
        midi.deviceId = sel.value;
        midiOut.select(sel.value);
        saveSoon();
      }
    } catch (err) {
      const name = err && err.name;
      if (name === 'NotAllowedError') {
        $('midiHint').textContent = 'MIDI permission was denied for this site. Click the padlock ' +
          'in the address bar → Site settings → MIDI → reset permission, then press "Enable MIDI output" again.';
      } else if (name === 'SecurityError') {
        $('midiHint').textContent = 'Web MIDI was blocked: it needs a secure context (https:// or http://localhost).';
      } else if (!(navigator.requestMIDIAccess)) {
        $('midiHint').textContent = 'This browser has no Web MIDI API. Use Chrome / Edge / Opera (Firefox: dom.webmidi.enabled).';
      } else {
        $('midiHint').textContent = 'Web MIDI failed: ' + (err && err.message ? err.message : String(err));
      }
    }
    updateMidiStatus();
  }

  function initMidiUI() {
    const chSel = $('midiChannel');
    for (let c = 0; c < 16; c++) {
      const opt = document.createElement('option');
      opt.value = c;
      opt.textContent = 'ch ' + (c + 1);
      chSel.appendChild(opt);
    }
    const octSel = $('midiOctave');
    for (let o = -2; o <= 2; o++) {
      const opt = document.createElement('option');
      opt.value = o;
      opt.textContent = (o > 0 ? '+' : '') + o;
      octSel.appendChild(opt);
    }
    syncMidiParams();
    refreshMidiDevices();
    updateMidiStatus();

    $('outputDest').addEventListener('change', () => {
      outputDest = $('outputDest').value;
      if (outputDest === 'midi') ensureMidiAccess();
      applyOutputDest();
      saveSoon();
    });

    $('midiConnect').addEventListener('click', ensureMidiAccess);
    $('midiRefresh').addEventListener('click', () => { ensureMidiAccess().then(refreshMidiDevices); });

    $('midiDevice').addEventListener('change', () => {
      midi.deviceId = $('midiDevice').value || null;
      midiOut.select(midi.deviceId);
      updateMidiStatus();
      saveSoon();
    });
    chSel.addEventListener('change', () => {
      midi.channel = parseInt(chSel.value, 10);
      midiSeq.silence();              // don't leave a note hanging on the old channel
      midiOut.channel = midi.channel;
      saveSoon();
    });
    octSel.addEventListener('change', () => {
      midi.octave = parseInt(octSel.value, 10);
      midiSeq.octave = midi.octave;
      saveSoon();
    });
    $('midiVel').addEventListener('input', () => {
      midi.velocity = parseInt($('midiVel').value, 10);
      $('midiVelVal').textContent = midi.velocity;
      midiSeq.velocity = midi.velocity;
      saveSoon();
    });
    $('midiAccVel').addEventListener('input', () => {
      midi.accentVel = parseInt($('midiAccVel').value, 10);
      $('midiAccVelVal').textContent = midi.accentVel;
      midiSeq.accentVel = midi.accentVel;
      saveSoon();
    });
    $('midiPortamento').addEventListener('change', (e) => {
      midi.slidesToPortamento = e.target.checked;
      midiSeq.slidesToPortamento = midi.slidesToPortamento;
      saveSoon();
    });
    $('midiProgSend').addEventListener('click', () => {
      ensureMidiAccess().then(() => midiSeq.programChange(parseInt($('midiProg').value, 10) || 0));
    });
    $('midiPanic').addEventListener('click', () => {
      midiSeq.silence();
      flashMidiLed();
    });
  }

  // ------------------------------------------------------------------
  // UI helpers
  // ------------------------------------------------------------------
  function bindCursor(el, cur) {
    el.addEventListener('pointerenter', () => { uiCursor = cur; });
    el.addEventListener('focus', () => { uiCursor = cur; });
  }

  // ------------------------------------------------------------------
  // Seed panel
  // ------------------------------------------------------------------
  function renderSeed() {
    const hex = (engine.seed & 0xffff).toString(16).padStart(4, '0');
    document.querySelectorAll('.hexdigit .val').forEach((el, i) => { el.textContent = hex[i]; });
  }

  function updateLockUI() {
    $('lockBtn').textContent = engine.lockSeed ? 'LOCKED' : 'UNLOCKED';
    $('lockBtn').classList.toggle('on', !!engine.lockSeed);
    document.querySelector('.seed-digits').classList.toggle('disabled', !engine.lockSeed);
    renderSeed();
  }

  function initSeedUI() {
    document.querySelectorAll('.hexdigit').forEach((el, idx) => {
      bindCursor(el, CUR.DIGIT1 + idx);
      const shift = (3 - idx) * 4;
      const curNib = () => (engine.seed >>> shift) & 0xf;
      const setNib = (n) => {
        n = con(n, 0, 15);
        engine.seed = ((engine.seed & ~(0xf << shift)) | (n << shift)) & 0xffff;
        renderSeed();
        engine.regenerateAll();
        saveSoon();
      };
      el.querySelector('.up').addEventListener('click', () => setNib(curNib() + 1));
      el.querySelector('.down').addEventListener('click', () => setNib(curNib() - 1));
      el.addEventListener('wheel', (ev) => {
        ev.preventDefault();
        setNib(curNib() + (ev.deltaY < 0 ? 1 : -1));
      }, { passive: false });
    });
    $('lockBtn').addEventListener('click', () => {
      engine.lockSeed = engine.lockSeed ? 0 : 1;
      updateLockUI();
      saveSoon();
    });
    $('randBtn').addEventListener('click', () => {
      engine.reseed();
      renderSeed();
      saveSoon();
    });
    bindCursor($('lockBtn'), CUR.LOCK_SEED);
    bindCursor($('randBtn'), CUR.LOCK_SEED);
  }

  // ------------------------------------------------------------------
  // Parameter panel
  // ------------------------------------------------------------------
  function initParamUI() {
    const dens = $('density'), densCv = $('densityCv');
    dens.addEventListener('input', () => {
      engine.densityEncoder = parseInt(dens.value, 10);
      engine.densityEncoderDisplay = 25;
      if (engine.densityAutoEnabled) engine.densityAuto[engine.step] = engine.densityEncoder;
      engine.refreshDensity();
      $('densityVal').textContent = fmtSigned(engine.densityEncoder - 7);
      saveSoon();
    });
    densCv.addEventListener('input', () => {
      engine.densityCv = parseInt(densCv.value, 10);
      engine.refreshDensity();
      $('densityCvVal').textContent = (engine.densityCv * 6 / 15).toFixed(1) + ' V';
      saveSoon();
    });
    $('densityAuto').addEventListener('change', (ev) => {
      engine.densityAutoEnabled = ev.target.checked;
      saveSoon();
    });
    bindCursor(dens, CUR.DENSITY);
    bindCursor(densCv, CUR.DENSITY);

    const sel = $('scale');
    for (const s of SCALES) {
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = s.name;
      sel.appendChild(opt);
    }
    sel.value = String(engine.scaleIndex);
    sel.addEventListener('change', () => {
      engine.scaleIndex = parseInt(sel.value, 10);
      engine.setQuantizerScale();
      requantizeNow();
      saveSoon();
    });
    bindCursor(sel, CUR.QSELECT);

    const rootSel = $('root');
    for (let r = 0; r < 12; r++) {
      const opt = document.createElement('option');
      opt.value = r;
      opt.textContent = NOTE_NAMES[r];
      rootSel.appendChild(opt);
    }
    rootSel.addEventListener('change', () => {
      engine.rootNote = parseInt(rootSel.value, 10);
      requantizeNow();
      saveSoon();
    });
    bindCursor(rootSel, CUR.QSELECT);

    const octSel = $('qoctave');
    for (let o = -3; o <= 3; o++) {
      const opt = document.createElement('option');
      opt.value = o;
      opt.textContent = (o > 0 ? '+' : '') + o;
      octSel.appendChild(opt);
    }
    octSel.addEventListener('change', () => {
      engine.qOctave = parseInt(octSel.value, 10);
      requantizeNow();
      saveSoon();
    });
    bindCursor(octSel, CUR.QSELECT);

    const trans = $('transpose');
    trans.addEventListener('input', () => {
      engine.transposeAmt = parseInt(trans.value, 10);
      $('transVal').textContent = fmtSigned(engine.transposeAmt);
      requantizeNow();
      saveSoon();
    });
    bindCursor(trans, CUR.TRANS_MODE);

    $('transMode').addEventListener('click', () => {
      engine.transposeInSemitones = !engine.transposeInSemitones;
      $('transMode').textContent = engine.transposeInSemitones ? 'Root' : 'Deg';
      requantizeNow();
      saveSoon();
    });
    bindCursor($('transMode'), CUR.TRANS_MODE);

    const len = $('length');
    len.addEventListener('input', () => {
      engine.numSteps = parseInt(len.value, 10);
      if (engine.step >= engine.numSteps) engine.step = 0;
      $('lenVal').textContent = engine.numSteps;
      saveSoon();
    });
    bindCursor(len, CUR.LENGTH);

    $('holdPitch').addEventListener('change', (e) => { engine.holdPitch = e.target.checked; saveSoon(); });
    bindCursor($('holdPitch').closest('.switch'), CUR.HOLD_PITCH);
    $('noSlides').addEventListener('change', (e) => { engine.noSlides = e.target.checked; saveSoon(); });
    $('freeze').addEventListener('change', (e) => { engine.gate1Held = e.target.checked; });
  }

  /* re-quantize the current output immediately (scale/root/oct/transpose changes) */
  function requantizeNow() {
    engine.currPitchCv = engine.getPitchForStep(engine.step);
    engine.slideEndCv = engine.currPitchCv;
    engine.currStepSemitone = engine.getSemitoneForStep(engine.step);
    if (voice && audioCtx) {
      voice.pitch({ t: audioCtx.currentTime, semis: engine.currPitchCv / 128, glide: false });
    }
  }

  function fmtSigned(n) { return (n > 0 ? '+' : '') + n; }

  // ------------------------------------------------------------------
  // Transport
  // ------------------------------------------------------------------
  function initTransportUI() {
    $('runBtn').addEventListener('click', () => { running ? stopRun() : startRun(); });
    $('clockBtn').addEventListener('click', tapClock);
    $('resetBtn').addEventListener('click', doReset);
    $('bpm').addEventListener('input', () => {
      bpm = con(parseFloat($('bpm').value) || 124, 20, 300);
      saveSoon();
    });
    $('div').addEventListener('change', () => {
      stepsPerBeat = parseInt($('div').value, 10);
      saveSoon();
    });

    window.addEventListener('keydown', (e) => {
      const tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'select' || tag === 'textarea') return;
      if (SLOT_MODE) {
        // in slot mode the rack owns the transport — forward instead of double-clocking
        if (e.code === 'Space' || e.code === 'KeyR') {
          e.preventDefault();
          parent.postMessage({ type: 'rack-key', code: e.code }, '*');
        }
        return;
      }
      if (e.code === 'Space') { e.preventDefault(); tapClock(); }
      else if (e.key === 'r' || e.key === 'R') { doReset(); }
    });
  }

  // ------------------------------------------------------------------
  // Synth panel
  // ------------------------------------------------------------------
  function initAudioUI() {
    const defs = [
      ['vol', (v) => { synth.volume = v; }, (v) => Math.round(v * 100) + '%'],
      ['cutoff', (v) => { synth.cutoff = v; }, (v) => Math.round(v) + ' Hz'],
      ['resonance', (v) => { synth.resonance = v; }, (v) => v.toFixed(1)],
      ['env', (v) => { synth.envAmt = v; }, (v) => Math.round(v) + ' Hz'],
      ['accent', (v) => { synth.accent = v; }, (v) => '×' + v.toFixed(1)],
      ['glide', (v) => { synth.slideMs = v; }, (v) => v.toFixed(1) + ' ms'],
      ['release', (v) => { synth.releaseMs = v; }, (v) => v.toFixed(0) + ' ms'],
    ];
    for (const [id, set, fmt] of defs) {
      const el = $(id);
      el.addEventListener('input', () => {
        set(parseFloat(el.value));
        const lbl = $(id + 'Val');
        if (lbl) lbl.textContent = fmt(parseFloat(el.value));
        applySynthParams();
        saveSoon();
      });
    }
    $('audioBtn').addEventListener('click', () => {
      ensureAudio();
      if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
    });
  }

  // ------------------------------------------------------------------
  // Persistence
  // ------------------------------------------------------------------
  const STORE_KEY = 'tb3po-web-v1';
  let saveTimer = null;
  function saveSoon() { clearTimeout(saveTimer); saveTimer = setTimeout(save, 300); }
  function save() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({
        seed: engine.seed, lockSeed: engine.lockSeed,
        densityEncoder: engine.densityEncoder, densityCv: engine.densityCv,
        densityAutoEnabled: engine.densityAutoEnabled,
        scaleIndex: engine.scaleIndex, rootNote: engine.rootNote, qOctave: engine.qOctave,
        transposeAmt: engine.transposeAmt, transposeInSemitones: engine.transposeInSemitones,
        numSteps: engine.numSteps, holdPitch: engine.holdPitch, noSlides: engine.noSlides,
        bpm, stepsPerBeat, synth,
        outputDest, midi,
      }));
    } catch (e) { /* storage unavailable */ }
  }
  function load() {
    try {
      const d = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
      if (!d) return;
      engine.seed = (d.seed || 0) & 0xffff;
      engine.lockSeed = d.lockSeed ? 1 : 0;
      engine.densityEncoder = con(d.densityEncoder | 0, 0, 14);
      engine.densityCv = con(d.densityCv | 0, -15, 15);
      engine.densityAutoEnabled = !!d.densityAutoEnabled;
      engine.scaleIndex = d.scaleIndex;
      engine.rootNote = con(d.rootNote | 0, 0, 11);
      engine.qOctave = con(d.qOctave | 0, -3, 3);
      engine.transposeAmt = con(d.transposeAmt | 0, -24, 24);
      engine.transposeInSemitones = !!d.transposeInSemitones;
      engine.numSteps = con(d.numSteps | 0, 1, 32);
      engine.holdPitch = !!d.holdPitch;
      engine.noSlides = !!d.noSlides;
      bpm = con(d.bpm || 124, 20, 300);
      stepsPerBeat = con([1, 2, 4, 8].includes(d.stepsPerBeat) ? d.stepsPerBeat : 4, 1, 8);
      if (d.synth) Object.assign(synth, d.synth);
      if (d.outputDest === 'audio' || d.outputDest === 'midi') outputDest = d.outputDest;
      if (d.midi) Object.assign(midi, d.midi);
      engine.setQuantizerScale();
      engine.refreshDensity();
    } catch (e) { /* ignore */ }
  }

  // ------------------------------------------------------------------
  // Boot
  // ------------------------------------------------------------------
  function syncControlsFromEngine() {
    $('density').value = engine.densityEncoder;
    $('densityVal').textContent = fmtSigned(engine.densityEncoder - 7);
    $('densityCv').value = engine.densityCv;
    $('densityCvVal').textContent = (engine.densityCv * 6 / 15).toFixed(1) + ' V';
    $('densityAuto').checked = engine.densityAutoEnabled;
    $('scale').value = String(engine.scaleIndex);
    $('root').value = String(engine.rootNote);
    $('qoctave').value = String(engine.qOctave);
    $('transpose').value = engine.transposeAmt;
    $('transVal').textContent = fmtSigned(engine.transposeAmt);
    $('transMode').textContent = engine.transposeInSemitones ? 'Root' : 'Deg';
    $('length').value = engine.numSteps;
    $('lenVal').textContent = engine.numSteps;
    $('holdPitch').checked = engine.holdPitch;
    $('noSlides').checked = engine.noSlides;
    $('bpm').value = bpm;
    $('div').value = String(stepsPerBeat);
    $('vol').value = synth.volume;
    $('volVal').textContent = Math.round(synth.volume * 100) + '%';
    $('cutoff').value = synth.cutoff;
    $('cutoffVal').textContent = Math.round(synth.cutoff) + ' Hz';
    $('resonance').value = synth.resonance;
    $('resonanceVal').textContent = synth.resonance.toFixed(1);
    $('env').value = synth.envAmt;
    $('envVal').textContent = Math.round(synth.envAmt) + ' Hz';
    $('accent').value = synth.accent;
    $('accentVal').textContent = '×' + synth.accent.toFixed(1);
    $('glide').value = synth.slideMs;
    $('glideVal').textContent = synth.slideMs.toFixed(1) + ' ms';
    $('release').value = synth.releaseMs;
    $('releaseVal').textContent = synth.releaseMs.toFixed(0) + ' ms';
  }

  /* ---- rack slot mode (?slot=1): transport driven by the parent rack ---- */
  function initSlotMode() {
    document.body.classList.add('slot-mode');
    const reply = (msg) => { try { parent.postMessage(msg, '*'); } catch (e) { /* not framed */ } };
    reply({ type: 'rack-ready', app: 'tb3po' });
    window.addEventListener('message', (ev) => {
      const m = ev.data || {};
      if (m.type === 'rack-clock') {
        ensureAudio();
        if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
        let t = m.t;
        if (audioCtx) {
          const localBase = performance.now() - audioCtx.currentTime * 1000;
          t = (m.base + m.t * 1000 - localBase) / 1000;
        }
        doClock(t, m.cycle);
      } else if (m.type === 'rack-reset') {
        doReset();
      } else if (m.type === 'rack-run') {
        ensureAudio();
        if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
        if (!m.on) {
          if (voice) voice.allOff();
          if (outputDest === 'midi') midiSeq.silence();
        }
      } else if (m.type === 'rack-panic') {
        if (voice) voice.allOff();
        if (outputDest === 'midi') midiSeq.silence();
        flashMidiLed();
      } else if (m.type === 'rack-midi-enable') {
        ensureMidiAccess();
      }
    });
  }

  function setFavicon() {
    // header logo (CSS scales it up)
    const logo = $('logoIcon');
    if (logo) {
      const lx = logo.getContext('2d');
      lx.fillStyle = '#7fe3a0';
      for (let col = 0; col < 8; col++) {
        for (let r = 0; r < 8; r++) {
          if ((ICON_TB3PO[col] >>> r) & 1) lx.fillRect(col, r, 1, 1);
        }
      }
    }
    const c = document.createElement('canvas');
    c.width = 8; c.height = 8;
    const cx = c.getContext('2d');
    cx.fillStyle = '#7fe3a0';
    for (let col = 0; col < 8; col++) {
      for (let r = 0; r < 8; r++) {
        if ((ICON_TB3PO[col] >>> r) & 1) cx.fillRect(col, r, 1, 1);
      }
    }
    const big = document.createElement('canvas');
    big.width = 32; big.height = 32;
    const bx = big.getContext('2d');
    bx.imageSmoothingEnabled = false;
    bx.drawImage(c, 0, 0, 32, 32);
    const link = document.createElement('link');
    link.rel = 'icon';
    link.href = big.toDataURL();
    document.head.appendChild(link);
  }

  function boot() {
    load();
    const m = location.hash.match(/seed=([0-9a-fA-F]{1,4})/);
    if (m) engine.seed = parseInt(m[1], 16) & 0xffff;
    if (!engine.seed) engine.reseed();

    // build the initial pattern synchronously
    engine.regenerateAll();
    engine.regeneratePhase = 1;
    engine.updateRegeneration();
    engine.currPitchCv = engine.getPitchForStep(0);
    engine.currStepSemitone = engine.getSemitoneForStep(0);

    initSeedUI();
    initParamUI();
    initTransportUI();
    initAudioUI();
    initMidiUI();
    syncControlsFromEngine();
    applyOutputDest();
    if (outputDest === 'midi') ensureMidiAccess();
    updateLockUI();
    renderSeed();
    setFavicon();
    if (SLOT_MODE) initSlotMode();
    requestAnimationFrame(frame);
  }

  boot();
})();