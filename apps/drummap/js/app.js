'use strict';
/*
 * DrumMap Web — glue layer: audio clock scheduling, drum voice wiring,
 * OLED + strip rendering, web-native parameter controls, persistence.
 */

(function () {
  // ------------------------------------------------------------------
  // State
  // ------------------------------------------------------------------
  const engine = new DrumMap();
  const ol = new OLED();

  let audioCtx = null;
  let voice = null;
  let running = false;
  let bpm = 120;
  let stepsPerBeat = 8;    // 32nd-note clock (8 ppqn) — what DrumMap expects
  let nextClockT = 0;
  let lastClockT = 0;
  let schedulerTimer = null;
  let uiCursor = DCUR.NONE;
  let lastFrameT = performance.now() / 1000;

  // synth params — source of truth until the voice exists
  const synth = {
    volume: 0.5,
    kickPitch: 155,
    kickDecay: 0.22,
    snareTone: 1800,
    hatDecay: 0.05,
    accent: 1.0,
  };

  const LOOKAHEAD = 0.15;
  const SCHED_MS = 25;

  const $ = (id) => document.getElementById(id);
  const oledCtx = $('oled').getContext('2d');
  const stripCtx = $('strip').getContext('2d');

  // ------------------------------------------------------------------
  // Audio
  // ------------------------------------------------------------------
  function ensureAudio() {
    if (audioCtx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    audioCtx = new AC();
    voice = new DrumVoice(audioCtx);
    applySynthParams();
    $('audioHint').textContent = '';
  }

  function applySynthParams() {
    if (!voice) return;
    voice.params.volume = synth.volume;
    voice.params.kickPitch = synth.kickPitch;
    voice.params.kickDecay = synth.kickDecay;
    voice.params.snareTone = synth.snareTone;
    voice.params.hatDecay = synth.hatDecay;
    voice.params.accent = synth.accent;
    voice.applyParams();
  }

  function period() { return 60 / (bpm * stepsPerBeat); }

  function doClock(t) {
    const events = engine.onClock(t);
    if (voice) for (const e of events) voice.hit(e);
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
    const dt = Math.min(Math.max(now - lastFrameT, 0.001), 0.2);
    lastFrameT = now;
    engine.refreshModulation();
    engine.update(now, dt);

    drawDrumMap(ol, engine, uiCursor);
    ol.blit(oledCtx, 1, '#e8f4ff');
    drawStrip();
    drawMonitor();
    requestAnimationFrame(frame);
  }

  function drawStrip() {
    const w = stripCanvas().width, h = stripCanvas().height;
    stripCtx.clearRect(0, 0, w, h);
    const cellW = w / 32;
    for (let i = 0; i < 32; i++) {
      const x = i * cellW;
      const isCur = i === engine.step;
      stripCtx.fillStyle = isCur ? 'rgba(255,180,84,0.18)' : 'rgba(255,255,255,0.035)';
      stripCtx.fillRect(x + 1, 2, cellW - 2, h - 4);
      for (let ch = 0; ch < 2; ch++) {
        if (ch === 1 && engine.mode[1] === 3) { /* accent row handled below */ }
        const part = (ch === 1 && engine.mode[ch] === 3) ? engine.mode[0] : engine.mode[ch];
        const level = engine.readDrumMap(i, part, engine._x, engine._y);
        const threshold = (ch === 1 && engine.mode[ch] === 3) ? (~engine._fill[0] & 0xff) : (~engine._fill[ch] & 0xff);
        const accent = engine.mode[ch] === 3 && level > 192;
        const fires = level > threshold && (engine.mode[ch] < 3 || level > 192);
        const rowY = ch === 0 ? 10 : 40;
        // level bar
        const bh = Math.max(2, Math.round((level / 255) * 22));
        stripCtx.fillStyle = fires ? (accent ? '#ffd9a0' : '#ffb454') : 'rgba(255,255,255,0.22)';
        stripCtx.fillRect(x + 3, rowY + 22 - bh, cellW - 3, bh);
        // trigger underline
        if (fires) {
          stripCtx.fillStyle = '#7fe3a0';
          stripCtx.fillRect(x + 2, rowY + 24, cellW - 5, 3);
        }
        if (engine.mode[1] === 3 && ch === 1) {
          stripCtx.fillStyle = '#c9a6ff';
          stripCtx.font = '8px monospace';
          stripCtx.textAlign = 'left';
          stripCtx.fillText('ACC>', 2, rowY - 2);
        }
      }
    }
    // loop divider
    stripCtx.strokeStyle = 'rgba(255,255,255,0.25)';
    stripCtx.beginPath();
    stripCtx.moveTo(0.5, 0);
    stripCtx.lineTo(0.5, h);
    stripCtx.moveTo(w - 0.5, 0);
    stripCtx.lineTo(w - 0.5, h);
    stripCtx.stroke();
  }

  function drawMonitor() {
    const parts = ['KICK', 'SNARE', 'HAT', 'ACCENT'];
    $('chA').textContent = parts[engine.mode[0]];
    $('chB').textContent = parts[engine.mode[1]];
    $('chALed').classList.toggle('on', engine.pulseAnimation[0] > 0);
    $('chBLed').classList.toggle('on', engine.pulseAnimation[1] > 0);
    $('stepLabel').textContent = 'step ' + (engine.step + 1) + '/32';
  }

  function stripCanvas() { return document.getElementById('strip'); }

  // ------------------------------------------------------------------
  // UI
  // ------------------------------------------------------------------
  function bindCursor(el, cur) {
    el.addEventListener('pointerenter', () => { uiCursor = cur; });
    el.addEventListener('focus', () => { uiCursor = cur; });
  }

  function setValueAnim() { engine.valueAnimation = HEM_DRUMMAP_VALUE_ANIMATION_TICKS; }

  function initParamUI() {
    $('partA').addEventListener('change', (e) => {
      engine.mode[0] = parseInt(e.target.value, 10) % 3;
      saveSoon();
    });
    bindCursor($('partA'), DCUR.PART_A);

    $('partB').addEventListener('change', (e) => {
      engine.mode[1] = parseInt(e.target.value, 10);
      updateFillB();
      saveSoon();
    });
    bindCursor($('partB'), DCUR.PART_B);

    const fillA = $('fillA'), fillB = $('fillB'), xs = $('xpos'), ys = $('ypos'), chaos = $('chaos');
    fillA.addEventListener('input', () => {
      engine.fill[0] = parseInt(fillA.value, 10);
      $('fillAVal').textContent = engine.fill[0];
      engine.valueAnimation = HEM_DRUMMAP_VALUE_ANIMATION_TICKS;
      saveSoon();
    });
    fillB.addEventListener('input', () => {
      engine.fill[1] = parseInt(fillB.value, 10);
      $('fillBVal').textContent = engine.fill[1];
      engine.valueAnimation = HEM_DRUMMAP_VALUE_ANIMATION_TICKS;
      saveSoon();
    });
    bindCursor(fillA, DCUR.FILL_A);
    bindCursor(fillB, DCUR.FILL_B);

    xs.addEventListener('input', () => {
      engine.x = parseInt(xs.value, 10);
      $('xVal').textContent = engine.x;
      engine.valueAnimation = HEM_DRUMMAP_VALUE_ANIMATION_TICKS;
      saveSoon();
    });
    ys.addEventListener('input', () => {
      engine.y = parseInt(ys.value, 10);
      $('yVal').textContent = engine.y;
      engine.valueAnimation = HEM_DRUMMAP_VALUE_ANIMATION_TICKS;
      saveSoon();
    });
    bindCursor(xs, DCUR.X);
    bindCursor(ys, DCUR.Y);

    chaos.addEventListener('input', () => {
      engine.chaos = parseInt(chaos.value, 10);
      $('chaosVal').textContent = engine.chaos;
      engine.valueAnimation = HEM_DRUMMAP_VALUE_ANIMATION_TICKS;
      saveSoon();
    });
    bindCursor(chaos, DCUR.CHAOS);

    const cvMode = $('cvMode');
    cvMode.addEventListener('change', () => {
      engine.cvMode = parseInt(cvMode.value, 10);
      saveSoon();
    });
    bindCursor(cvMode, DCUR.CV_MODE);
    const cv1 = $('cv1'), cv2 = $('cv2');
    cv1.addEventListener('input', () => {
      engine.cv[0] = parseInt(cv1.value, 10);
      $('cv1Val').textContent = volts(engine.cv[0]);
      saveSoon();
    });
    cv2.addEventListener('input', () => {
      engine.cv[1] = parseInt(cv2.value, 10);
      $('cv2Val').textContent = volts(engine.cv[1]);
      saveSoon();
    });

    $('patternSet').addEventListener('change', (e) => {
      engine.patternSet = e.target.value;
      saveSoon();
    });
  }

  function volts(v) { return (v * 6 / 255).toFixed(1) + ' V'; }

  function updateFillB() {
    const acc = engine.mode[1] === 3;
    $('fillBSlider').classList.toggle('disabled', acc);
    $('fillBNote').textContent = acc ? '(accent follows A fill)' : '';
  }

  function initTransportUI() {
    $('runBtn').addEventListener('click', () => { running ? stopRun() : startRun(); });
    $('clockBtn').addEventListener('click', tapClock);
    $('resetBtn').addEventListener('click', doReset);
    $('bpm').addEventListener('input', () => {
      bpm = con(parseFloat($('bpm').value) || 120, 20, 300);
      saveSoon();
    });
    $('div').addEventListener('change', () => {
      stepsPerBeat = parseInt($('div').value, 10);
      saveSoon();
    });
    window.addEventListener('keydown', (e) => {
      const tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'select' || tag === 'textarea') return;
      if (e.code === 'Space') { e.preventDefault(); tapClock(); }
      else if (e.key === 'r' || e.key === 'R') { doReset(); }
    });
  }

  function initAudioUI() {
    const defs = [
      ['vol', (v) => { synth.volume = v; }, (v) => Math.round(v * 100) + '%'],
      ['kickPitch', (v) => { synth.kickPitch = v; }, (v) => Math.round(v) + ' Hz'],
      ['kickDecay', (v) => { synth.kickDecay = v; }, (v) => (v * 1000).toFixed(0) + ' ms'],
      ['snareTone', (v) => { synth.snareTone = v; }, (v) => Math.round(v) + ' Hz'],
      ['hatDecay', (v) => { synth.hatDecay = v; }, (v) => Math.round(v * 1000) + ' ms'],
      ['accent', (v) => { synth.accent = v; }, (v) => '×' + v.toFixed(1)],
    ];
    for (const [id, set, fmt] of defs) {
      $(id).addEventListener('input', () => {
        set(parseFloat($(id).value));
        $(id + 'Val').textContent = fmt(parseFloat($(id).value));
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
  const STORE_KEY = 'drummap-web-v1';
  let saveTimer = null;
  function saveSoon() { clearTimeout(saveTimer); saveTimer = setTimeout(save, 300); }
  function save() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({
        mode: engine.mode.slice(), fill: engine.fill.slice(),
        x: engine.x, y: engine.y, chaos: engine.chaos, cvMode: engine.cvMode,
        cv: engine.cv.slice(), patternSet: engine.patternSet,
        bpm, stepsPerBeat, synth,
      }));
    } catch (e) { /* storage unavailable */ }
  }
  function load() {
    try {
      const d = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
      if (!d) return;
      engine.mode = [con(d.mode[0] | 0, 0, 2), con(d.mode[1] | 0, 0, 3)];
      engine.fill = [con(d.fill[0] | 0, 0, 255), con(d.fill[1] | 0, 0, 255)];
      engine.x = con(d.x | 0, 0, 255);
      engine.y = con(d.y | 0, 0, 255);
      engine.chaos = con(d.chaos | 0, 0, 255);
      engine.cvMode = con(d.cvMode | 0, 0, 2);
      engine.cv = [con(d.cv[0] | 0, -255, 255), con(d.cv[1] | 0, -255, 255)];
      engine.patternSet = PATTERN_SETS[d.patternSet] ? d.patternSet : 'grids2';
      bpm = con(d.bpm || 120, 20, 300);
      stepsPerBeat = [1, 2, 4, 8].includes(d.stepsPerBeat) ? d.stepsPerBeat : 8;
      if (d.synth) Object.assign(synth, d.synth);
    } catch (e) { /* ignore */ }
  }

  // ------------------------------------------------------------------
  // Boot
  // ------------------------------------------------------------------
  function syncControlsFromEngine() {
    $('partA').value = String(engine.mode[0]);
    $('partB').value = String(engine.mode[1]);
    $('fillA').value = engine.fill[0];
    $('fillAVal').textContent = engine.fill[0];
    $('fillB').value = engine.fill[1];
    $('fillBVal').textContent = engine.fill[1];
    $('xpos').value = engine.x;
    $('xVal').textContent = engine.x;
    $('ypos').value = engine.y;
    $('yVal').textContent = engine.y;
    $('chaos').value = engine.chaos;
    $('chaosVal').textContent = engine.chaos;
    $('cvMode').value = String(engine.cvMode);
    $('cv1').value = engine.cv[0];
    $('cv1Val').textContent = volts(engine.cv[0]);
    $('cv2').value = engine.cv[1];
    $('cv2Val').textContent = volts(engine.cv[1]);
    $('patternSet').value = engine.patternSet;
    $('bpm').value = bpm;
    $('div').value = String(stepsPerBeat);
    $('vol').value = synth.volume;
    $('volVal').textContent = Math.round(synth.volume * 100) + '%';
    $('kickPitch').value = synth.kickPitch;
    $('kickPitchVal').textContent = Math.round(synth.kickPitch) + ' Hz';
    $('kickDecay').value = synth.kickDecay;
    $('kickDecayVal').textContent = (synth.kickDecay * 1000).toFixed(0) + ' ms';
    $('snareTone').value = synth.snareTone;
    $('snareToneVal').textContent = Math.round(synth.snareTone) + ' Hz';
    $('hatDecay').value = synth.hatDecay;
    $('hatDecayVal').textContent = Math.round(synth.hatDecay * 1000) + ' ms';
    $('accent').value = synth.accent;
    $('accentVal').textContent = '×' + synth.accent.toFixed(1);
    updateFillB();
  }

  function setFavicon() {
    const logo = $('logoIcon');
    if (logo) {
      const lx = logo.getContext('2d');
      lx.fillStyle = '#ffb454';
      for (let col = 0; col < 8; col++) {
        for (let r = 0; r < 8; r++) {
          if ((ICON_DRUMMAP[col] >>> r) & 1) lx.fillRect(col, r, 1, 1);
        }
      }
    }
    const c = document.createElement('canvas');
    c.width = 8; c.height = 8;
    const cx = c.getContext('2d');
    cx.fillStyle = '#ffb454';
    for (let col = 0; col < 8; col++) {
      for (let r = 0; r < 8; r++) {
        if ((ICON_DRUMMAP[col] >>> r) & 1) cx.fillRect(col, r, 1, 1);
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
    engine.refreshModulation();

    initParamUI();
    initTransportUI();
    initAudioUI();
    syncControlsFromEngine();
    setFavicon();
    requestAnimationFrame(frame);
  }

  function boot() {
    load();
    engine.refreshModulation();

    initParamUI();
    initTransportUI();
    initAudioUI();
    syncControlsFromEngine();
    setFavicon();
    requestAnimationFrame(frame);
  }

  boot();
})();