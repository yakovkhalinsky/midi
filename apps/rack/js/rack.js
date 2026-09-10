'use strict';
/*
 * Rack — up to 3 app slots in a column, one shared clock.
 *
 * Each slot is a same-origin iframe of an app page in compact mode (?slot=1).
 * The rack owns the shared transport (BPM, clock division, RUN/STOP, RESET)
 * and broadcasts clock edges to every live slot via postMessage. Each message
 * carries the rack's audio-clock time plus its clock base (perf-ms minus
 * audio-seconds*1000) so the slot can translate the edge into its own
 * AudioContext's timeline; both clocks derive from the same hardware clock.
 *
 * Per slot: clock divider ÷N (edge every Nth shared edge, cycle scaled), mute.
 * The slots themselves render, sound and route MIDI — the rack only conducts.
 */

(function () {
  const LOOKAHEAD = 0.15;
  const SCHED_MS = 25;
  const STORE_KEY = 'rack-web-v1';

  const APPS = {
    tb3po: { name: 'TB-3PO', src: '../tb3po/index.html?slot=1' },
    drummap: { name: 'DrumMap', src: '../drummap/index.html?slot=1' },
  };

  const $ = (id) => document.getElementById(id);
  const con = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

  // ------------------------------------------------------------------
  // State
  // ------------------------------------------------------------------
  const slots = [];           // {app, div, muted, loaded, el, iframe}
  let audioCtx = null;
  let running = false;
  let bpm = 124;
  let div = 4;                // shared clock: edges per beat (4 = 16ths)
  let outputDest = 'audio';   // global output: 'audio' | 'midi'
  let nextClockT = 0;
  let edgeIndex = 0;          // increments on every shared edge
  let schedulerTimer = null;

  const midiOut = new MidiOut(() => (audioCtx ? audioCtx.currentTime : undefined));
  let midiDeviceId = null;

  // ------------------------------------------------------------------
  // Audio + scheduling
  // ------------------------------------------------------------------
  function ensureAudio() {
    if (audioCtx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    audioCtx = new AC();
  }

  function period() { return 60 / (bpm * div); }

  /* perf-ms value of audio-clock second 0 (or of perf-seconds when no ctx) */
  function clockBase() {
    return performance.now() - (audioCtx ? audioCtx.currentTime : 0) * 1000;
  }

  function doClock(t) {
    const base = clockBase();
    edgeIndex++;
    for (const s of slots) {
      if (!s.app || s.muted || !s.loaded) continue;
      if ((edgeIndex - 1) % s.div !== 0) continue;   // ÷1 = every edge; ÷2 = every 2nd, first edge fires
      try {
        s.iframe.contentWindow.postMessage(
          { type: 'rack-clock', t, base, cycle: period() * s.div }, '*');
      } catch (e) { /* slot closed */ }
    }
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
    const t0 = audioCtx.currentTime + 0.08;
    nextClockT = t0;
    edgeIndex = 0;
    if (!schedulerTimer) schedulerTimer = setInterval(schedulerTick, SCHED_MS);
    $('runBtn').classList.add('on');
    $('runBtn').textContent = 'STOP';
    broadcast({ type: 'rack-run', on: true });
  }

  function stopRun() {
    running = false;
    $('runBtn').classList.remove('on');
    $('runBtn').textContent = 'RUN';
    broadcast({ type: 'rack-run', on: false });
  }

  function tapClock() {
    ensureAudio();
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
    const t = audioCtx ? audioCtx.currentTime + 0.015 : performance.now() / 1000;
    doClock(t);
  }

  function doReset() { broadcast({ type: 'rack-reset' }); }

  function broadcast(msg) {
    for (const s of slots) {
      if (!s.app || !s.loaded) continue;
      try { s.iframe.contentWindow.postMessage(msg, '*'); } catch (e) { /* closed */ }
    }
  }

  // ------------------------------------------------------------------
  // Slots
  // ------------------------------------------------------------------
  function setSlotApp(slot, app) {
    slot.app = APPS[app] ? app : null;
    slot.loaded = false;
    slot.el.classList.remove('loaded');
    slot.el.classList.toggle('empty', !slot.app);
    if (slot.app) {
      slot.iframe.src = APPS[slot.app].src;
      slot.stateEl.textContent = 'loading…';
      slot.stateEl.classList.remove('on');
    } else {
      slot.iframe.src = 'about:blank';
      slot.stateEl.textContent = '';
      slot.stateEl.classList.remove('on');
    }
    saveSoon();
  }

  function findSlotBySource(source) {
    for (const s of slots) {
      if (s.iframe.contentWindow === source) return s;
    }
    return null;
  }

  function initSlots() {
    document.querySelectorAll('.slot').forEach((el) => {
      const slot = {
        app: null, div: 1, muted: false, loaded: false,
        el,
        iframe: el.querySelector('.slotFrame'),
        stateEl: el.querySelector('.slot-state'),
        appPick: el.querySelector('.appPick'),
        divPick: el.querySelector('.divPick'),
        mutePick: el.querySelector('.mutePick'),
      };
      slots.push(slot);

      for (let n = 1; n <= 8; n++) {
        const opt = document.createElement('option');
        opt.value = n;
        opt.textContent = '÷' + n;
        slot.divPick.appendChild(opt);
      }

      slot.appPick.addEventListener('change', () => setSlotApp(slot, slot.appPick.value));
      slot.divPick.addEventListener('change', () => {
        slot.div = parseInt(slot.divPick.value, 10) || 1;
        saveSoon();
      });
      slot.mutePick.addEventListener('change', () => {
        slot.muted = slot.mutePick.checked;
        if (slot.muted) {
          postTo(slot, { type: 'rack-panic' });
          slot.stateEl.textContent = 'muted';
          slot.stateEl.classList.remove('on');
        }
        saveSoon();
      });
    });
  }

  function postTo(slot, msg) {
    try { slot.iframe.contentWindow.postMessage(msg, '*'); } catch (e) { /* closed */ }
  }

  // ------------------------------------------------------------------
  // Rack-level MIDI (device broadcast to slots)
  // ------------------------------------------------------------------
  function midiStatusText() {
    if (!midiOut.access) return 'not granted yet';
    if (!midiOut.output) return 'granted — device will push to all slots';
    const o = midiOut.outputs().find((x) => x.id === midiOut.output.id);
    return (o ? (o.name || o.id) : '?');
  }

  function updateMidiStatus() {
    $('midiStatus').textContent = 'Web MIDI: ' + midiStatusText();
  }

  function refreshMidiDevices() {
    const sel = $('midiDevice');
    const prev = midiDeviceId;
    sel.textContent = '';
    const outs = midiOut.outputs().map((o) => ({ id: o.id, name: o.name || o.id, manufacturer: o.manufacturer || '' }));
    if (!outs.length) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = midiOut.access ? 'no MIDI devices seen' : '—';
      sel.appendChild(opt);
    }
    for (const o of outs) {
      const opt = document.createElement('option');
      opt.value = o.id;
      opt.textContent = o.name + (o.manufacturer ? ' (' + o.manufacturer + ')' : '');
      sel.appendChild(opt);
    }
    if (prev && outs.some((o) => o.id === prev)) {
      sel.value = prev;
    } else if (outs.length === 1) {
      sel.value = outs[0].id;
    }
    updateMidiStatus();
    if (sel.value) pushMidiDevice(sel.value);
  }

  function pushMidiDevice(id) {
    midiDeviceId = id;
    broadcast({ type: 'rack-midi', deviceId: id });
    saveSoon();
  }

  async function ensureMidiAccess() {
    if (midiOut.access) { refreshMidiDevices(); broadcast({ type: 'rack-midi-enable' }); return; }
    try {
      await midiOut.init();
      midiOut.onState = () => refreshMidiDevices();
      if (midiDeviceId) midiOut.select(midiDeviceId);
      refreshMidiDevices();
      broadcast({ type: 'rack-midi-enable' });
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

  // ------------------------------------------------------------------
  // Persistence
  // ------------------------------------------------------------------
  let saveTimer = null;
  function saveSoon() { clearTimeout(saveTimer); saveTimer = setTimeout(save, 300); }
  function save() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({
        bpm, div, midiDeviceId, outputDest,
        slots: slots.map((s) => ({ app: s.app, div: s.div, muted: s.muted })),
      }));
    } catch (e) { /* storage unavailable */ }
  }
  function load() {
    try {
      const d = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
      if (!d) return;
      bpm = con(d.bpm || 124, 20, 300);
      div = [1, 2, 4, 8].includes(d.div) ? d.div : 4;
      midiDeviceId = d.midiDeviceId || null;
      outputDest = d.outputDest === 'midi' ? 'midi' : 'audio';
      if (Array.isArray(d.slots)) {
        d.slots.forEach((sd, i) => {
          if (!slots[i]) return;
          slots[i].app = APPS[sd.app] ? sd.app : null;
          slots[i].div = con(sd.div | 0, 1, 8);
          slots[i].muted = !!sd.muted;
        });
      }
    } catch (e) { /* ignore */ }
  }

  // ------------------------------------------------------------------
  // Boot + wiring
  // ------------------------------------------------------------------
  function syncControls() {
    $('bpm').value = bpm;
    $('div').value = String(div);
    $('outputDest').value = outputDest;
    for (const s of slots) {
      s.appPick.value = s.app || '';
      s.divPick.value = String(s.div);
      s.mutePick.checked = s.muted;
      setSlotApp(s, s.app);
      if (s.muted) s.stateEl.textContent = 'muted';
    }
  }

  function initTransportUI() {
    $('runBtn').addEventListener('click', () => { running ? stopRun() : startRun(); });
    $('clockBtn').addEventListener('click', tapClock);
    $('resetBtn').addEventListener('click', doReset);
    $('bpm').addEventListener('input', () => {
      bpm = con(parseFloat($('bpm').value) || 124, 20, 300);
      saveSoon();
    });
    $('div').addEventListener('change', () => {
      div = parseInt($('div').value, 10);
      saveSoon();
    });
    $('midiConnect').addEventListener('click', ensureMidiAccess);
    $('midiRefresh').addEventListener('click', () => { ensureMidiAccess().then(refreshMidiDevices); });
    $('midiDevice').addEventListener('change', () => { pushMidiDevice($('midiDevice').value || null); });
    $('midiPanic').addEventListener('click', () => broadcast({ type: 'rack-panic' }));
    $('outputDest').addEventListener('change', () => {
      outputDest = $('outputDest').value === 'midi' ? 'midi' : 'audio';
      broadcast({ type: 'rack-output', dest: outputDest });
      if (outputDest === 'midi') ensureMidiAccess();
      saveSoon();
    });

    window.addEventListener('keydown', (e) => {
      const tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'select' || tag === 'textarea') return;
      if (e.code === 'Space') { e.preventDefault(); tapClock(); }
      else if (e.key === 'r' || e.key === 'R') { doReset(); }
    });

    window.addEventListener('message', (ev) => {
      const m = ev.data || {};
      if (m.type === 'rack-ready') {
        const s = findSlotBySource(ev.source);
        if (s) {
          s.loaded = true;
          s.el.classList.add('loaded');
          s.stateEl.textContent = '● ' + (m.app || s.app);
          s.stateEl.classList.add('on');
          // bring the slot up to date with the rack state
          postTo(s, { type: 'rack-run', on: running });
          postTo(s, { type: 'rack-output', dest: outputDest });
        }
      } else if (m.type === 'rack-key') {
        if (m.code === 'Space') tapClock();
        else if (m.code === 'KeyR') doReset();
      }
    });
  }

  function boot() {
    initSlots();
    load();
    syncControls();
    initTransportUI();
    updateMidiStatus();
  }

  boot();
})();