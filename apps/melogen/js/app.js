'use strict';
/*
 * Melogen app shell: transport, generator UI, piano roll, audio/MIDI routing.
 */

(function () {
  const $ = (id) => document.getElementById(id);

  let audioCtx = null;
  let voice = null;
  const midiOut = new MidiOut(() => (audioCtx ? audioCtx.currentTime : undefined));
  let midi = { deviceId: null, channel: 0, ready: false, error: null };
  let outputDest = 'audio';

  let notes = [];
  let patternLength = 8; // beats
  let bpm = 120;
  let running = false;
  let loopOn = true;
  let appendMode = false;
  let seed = randomSeedHex();
  let algo = 'random';
  let key = 0;
  let scale = 'major';
  let density = 0.55;
  let octLo = 3;
  let octHi = 5;
  let snap = 0.25;

  let schedTimer = null;
  let nextBeatTime = 0;
  let beatPos = 0;
  const LOOKAHEAD = 0.08;
  const SCHED_MS = 25;
  const SUBDIV = 0.0625;

  const STORAGE_KEY = 'melogen.v1';

  const roll = new PianoRoll($('roll'), {
    lengthBeats: patternLength,
    snap,
    pitchMin: 36,
    pitchMax: 84,
    onChange(ns) { notes = ns; save(); },
    onSelect(sel) { updateSelectionInfo(sel); },
  });

  /* ---------- audio / midi ---------- */
  function ensureAudio() {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      voice = new MelogenVoice(audioCtx);
      applyVoiceParams();
    }
    if (audioCtx.state === 'suspended') audioCtx.resume();
    return audioCtx;
  }

  function applyVoiceParams() {
    const vol = +$('vol').value;
    const cutoff = +$('cutoff').value;
    const resonance = +$('resonance').value;
    const envAmt = +$('env').value;
    const accent = +$('accent').value;
    const glideMs = +$('glide').value;
    const releaseMs = +$('release').value;
    $('volVal').textContent = Math.round(vol * 100) + '%';
    $('cutoffVal').textContent = Math.round(cutoff) + ' Hz';
    $('resonanceVal').textContent = resonance.toFixed(1);
    $('envVal').textContent = Math.round(envAmt) + ' Hz';
    $('accentVal').textContent = '×' + accent.toFixed(1);
    $('glideVal').textContent = glideMs.toFixed(1) + ' ms';
    $('releaseVal').textContent = Math.round(releaseMs) + ' ms';
    if (!voice) return;
    voice.params.volume = vol;
    voice.params.cutoff = cutoff;
    voice.params.resonance = resonance;
    voice.params.envAmt = envAmt;
    voice.params.accent = accent;
    voice.params.slideTau = glideMs / 1000;
    voice.params.releaseTau = releaseMs / 1000;
    voice.applyParams();
  }

  async function ensureMidiAccess() {
    if (midi.ready) { refreshMidiDevices(); return; }
    try {
      await midiOut.init();
      midi.ready = true;
      midi.error = null;
      midiOut.onState = () => refreshMidiDevices();
      refreshMidiDevices();
      if (midi.deviceId) midiOut.select(midi.deviceId);
      midiOut.channel = midi.channel;
    } catch (err) {
      midi.error = String(err && err.message ? err.message : err);
      const sel = $('midiDevice');
      sel.innerHTML = '';
      const opt = document.createElement('option');
      opt.textContent = 'MIDI unavailable';
      sel.appendChild(opt);
      $('midiStatus').textContent = midi.error;
    }
  }

  function refreshMidiDevices() {
    const sel = $('midiDevice');
    const outs = midiOut.outputs();
    const prev = midi.deviceId;
    sel.innerHTML = '';
    const none = document.createElement('option');
    none.value = '';
    none.textContent = outs.length ? '— select device —' : 'no MIDI outputs';
    sel.appendChild(none);
    for (const o of outs) {
      const opt = document.createElement('option');
      opt.value = o.id;
      opt.textContent = o.name || o.id;
      sel.appendChild(opt);
    }
    if (prev && outs.some((o) => o.id === prev)) {
      sel.value = prev;
      midiOut.select(prev);
    }
    $('midiStatus').textContent = midi.ready
      ? (outs.length ? outs.length + ' output(s)' : 'access ok, no devices')
      : (midi.error || '');
  }

  /* ---------- transport ---------- */
  function beatsToSec(beats) { return (beats * 60) / bpm; }

  function start() {
    ensureAudio();
    running = true;
    $('runBtn').classList.add('on');
    $('runBtn').textContent = 'STOP';
    beatPos = 0;
    roll.setPlayhead(0);
    nextBeatTime = audioCtx.currentTime + 0.05;
    silenceAll();
    if (schedTimer) clearInterval(schedTimer);
    schedTimer = setInterval(schedulerTick, SCHED_MS);
    schedulerTick();
    if (outputDest === 'midi') {
      try { midiOut.transportStart(); } catch (e) {}
    }
  }

  function stop() {
    running = false;
    $('runBtn').classList.remove('on');
    $('runBtn').textContent = 'PLAY';
    if (schedTimer) { clearInterval(schedTimer); schedTimer = null; }
    silenceAll();
    beatPos = 0;
    roll.setPlayhead(0);
    if (outputDest === 'midi') {
      try { midiOut.transportStop(); midiOut.allOff(); } catch (e) {}
    }
  }

  function silenceAll() {
    if (voice) voice.allOff();
    try { midiOut.allOff(); } catch (e) {}
  }

  function schedulerTick() {
    if (!running || !audioCtx) return;
    const now = audioCtx.currentTime;
    while (nextBeatTime < now + LOOKAHEAD) {
      scheduleAt(beatPos, nextBeatTime);
      beatPos = +(beatPos + SUBDIV).toFixed(6);
      nextBeatTime += beatsToSec(SUBDIV);
      if (beatPos >= patternLength - 1e-9) {
        if (loopOn) beatPos = 0;
        else { stop(); return; }
      }
    }
    const ph = beatPos;
    roll.setPlayhead(ph);
  }

  function scheduleAt(beat, tAudio) {
    for (const n of notes) {
      if (n.start >= beat - 1e-9 && n.start < beat + SUBDIV - 1e-9) {
        triggerNote(n, tAudio);
      }
    }
  }

  function triggerNote(n, tAudio) {
    const durSec = beatsToSec(n.duration);
    const uid = 'p' + n.id + '_' + Math.round(tAudio * 1000);
    if (outputDest === 'audio') {
      ensureAudio();
      voice.noteOn(uid, n.pitch, n.velocity, tAudio);
      voice.noteOff(uid, tAudio + durSec);
    } else {
      midiOut.noteOn(n.pitch, n.velocity, tAudio);
      midiOut.noteOff(n.pitch, tAudio + durSec);
      blinkMidi();
    }
  }

  let midiBlinkTimer = null;
  function blinkMidi() {
    const led = $('midiLed');
    if (!led) return;
    led.classList.add('on');
    clearTimeout(midiBlinkTimer);
    midiBlinkTimer = setTimeout(() => led.classList.remove('on'), 80);
  }

  /* ---------- generation ---------- */
  function collectGenParams() {
    const p = {
      key, scale,
      length: patternLength,
      density,
      octLo, octHi,
      seed,
      velocity: 100,
      currentNotes: notes,
      step: snap,
      gate: snap,
    };
    for (const el of document.querySelectorAll('#algoParams [data-param]')) {
      const id = el.getAttribute('data-param');
      let v = el.value;
      if (el.dataset.num === '1') v = +v;
      p[id] = v;
    }
    p.density = density;
    return p;
  }

  function doGenerate() {
    const p = collectGenParams();
    const generated = runGenerator(algo, p);
    if (appendMode) notes = notes.concat(generated);
    else notes = generated;
    roll.setLength(patternLength);
    roll.setNotes(notes);
    roll.clearSelection();
    $('noteCount').textContent = notes.length + ' notes';
    save();
  }

  function clearPattern() {
    notes = [];
    roll.setNotes(notes);
    roll.clearSelection();
    $('noteCount').textContent = '0 notes';
    save();
  }

  /* ---------- UI builders ---------- */
  function fillKeyScale() {
    const keySel = $('key');
    keySel.innerHTML = '';
    NOTE_NAMES.forEach((name, i) => {
      const o = document.createElement('option');
      o.value = String(i);
      o.textContent = name;
      keySel.appendChild(o);
    });
    keySel.value = String(key);

    const scaleSel = $('scale');
    scaleSel.innerHTML = '';
    Object.keys(SCALES).forEach((id) => {
      const o = document.createElement('option');
      o.value = id;
      o.textContent = SCALES[id].name;
      scaleSel.appendChild(o);
    });
    scaleSel.value = scale;
  }

  function fillAlgo() {
    const sel = $('algo');
    sel.innerHTML = '';
    listGenerators().forEach((g) => {
      const o = document.createElement('option');
      o.value = g.id;
      o.textContent = g.name;
      sel.appendChild(o);
    });
    sel.value = algo;
    renderAlgoParams();
  }

  function renderAlgoParams() {
    const g = GENERATORS[algo] || GENERATORS.random;
    const box = $('algoParams');
    box.innerHTML = '';
    (g.params || []).forEach((spec) => {
      const row = document.createElement('div');
      row.className = 'row';
      const label = document.createElement('label');
      label.className = 'grow';
      const valSpan = document.createElement('span');
      valSpan.className = 'val';
      label.appendChild(document.createTextNode(spec.label + ' '));
      label.appendChild(valSpan);

      let input;
      if (spec.type === 'select') {
        input = document.createElement('select');
        spec.options.forEach((opt) => {
          const o = document.createElement('option');
          o.value = String(opt.v);
          o.textContent = opt.t;
          input.appendChild(o);
        });
        input.value = String(spec.def);
        input.dataset.num = typeof spec.def === 'number' ? '1' : '0';
        valSpan.textContent = '';
      } else {
        input = document.createElement('input');
        input.type = 'range';
        input.min = spec.min;
        input.max = spec.max;
        input.step = spec.step;
        input.value = spec.def;
        input.dataset.num = '1';
        valSpan.textContent = String(spec.def);
        input.addEventListener('input', () => {
          valSpan.textContent = input.value;
        });
      }
      input.setAttribute('data-param', spec.id);
      // skip duplicating density/step if also global — still show algo-specific ones
      row.appendChild(label);
      row.appendChild(input);
      box.appendChild(row);
    });
  }

  function updateSelectionInfo(sel) {
    const el = $('selInfo');
    if (!sel || !sel.length) {
      el.textContent = 'no selection';
      return;
    }
    if (sel.length === 1) {
      const n = sel[0];
      el.textContent = midiToName(n.pitch) + ' · vel ' + n.velocity + ' · ' +
        n.start.toFixed(2) + '–' + (n.start + n.duration).toFixed(2);
    } else {
      el.textContent = sel.length + ' notes selected';
    }
  }

  function syncOutputsUI() {
    $('outputDest').value = outputDest;
    $('midiGroup').classList.toggle('dimmed', outputDest !== 'midi');
    $('audioGroup').classList.toggle('dimmed', outputDest !== 'audio');
  }

  /* ---------- persistence ---------- */
  function save() {
    try {
      const data = {
        notes: serializeNotes(notes),
        patternLength, bpm, loopOn, appendMode, seed, algo,
        key, scale, density, octLo, octHi, snap, outputDest, midi,
        vol: +$('vol').value,
        cutoff: +$('cutoff').value,
        resonance: +$('resonance').value,
        envAmt: +$('env').value,
        accent: +$('accent').value,
        glide: +$('glide').value,
        release: +$('release').value,
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch (e) { /* ignore */ }
  }

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const d = JSON.parse(raw);
      if (Array.isArray(d.notes)) notes = d.notes.map((n) => makeNote(n.pitch, n.start, n.duration, n.velocity));
      if (d.patternLength) patternLength = d.patternLength;
      if (d.bpm) bpm = d.bpm;
      if (typeof d.loopOn === 'boolean') loopOn = d.loopOn;
      if (typeof d.appendMode === 'boolean') appendMode = d.appendMode;
      if (d.seed) seed = d.seed;
      if (d.algo) algo = d.algo;
      if (d.key != null) key = d.key;
      if (d.scale) scale = d.scale;
      if (d.density != null) density = d.density;
      if (d.octLo != null) octLo = d.octLo;
      if (d.octHi != null) octHi = d.octHi;
      if (d.snap != null) snap = d.snap;
      if (d.outputDest) outputDest = d.outputDest;
      if (d.midi) midi = Object.assign(midi, d.midi);
      if (d.vol != null) $('vol').value = d.vol;
      if (d.cutoff != null) $('cutoff').value = d.cutoff;
      if (d.resonance != null) $('resonance').value = d.resonance;
      if (d.envAmt != null) $('env').value = d.envAmt;
      if (d.accent != null) $('accent').value = d.accent;
      if (d.glide != null) $('glide').value = d.glide;
      if (d.release != null) $('release').value = d.release;
    } catch (e) { /* ignore */ }
  }

  function applyToControls() {
    $('bpm').value = bpm;
    $('length').value = patternLength;
    $('lengthVal').textContent = String(patternLength);
    $('density').value = density;
    $('densityVal').textContent = density.toFixed(2);
    $('seed').value = seed;
    $('octLo').value = octLo;
    $('octHi').value = octHi;
    $('snap').value = String(snap);
    $('loopOn').checked = loopOn;
    $('appendMode').checked = appendMode;
    $('key').value = String(key);
    $('scale').value = scale;
    $('algo').value = algo;
    $('midiChannel').value = String(midi.channel);
    roll.setLength(patternLength);
    roll.setSnap(snap);
    roll.setNotes(notes);
    $('noteCount').textContent = notes.length + ' notes';
    syncOutputsUI();
    applyVoiceParams();
  }

  /* ---------- wire events ---------- */
  function wire() {
    $('runBtn').addEventListener('click', () => {
      if (running) stop(); else start();
    });
    $('bpm').addEventListener('change', () => {
      bpm = clampInt($('bpm').value, 20, 300);
      $('bpm').value = bpm;
      save();
    });
    $('loopOn').addEventListener('change', () => {
      loopOn = $('loopOn').checked;
      save();
    });
    $('appendMode').addEventListener('change', () => {
      appendMode = $('appendMode').checked;
      save();
    });

    $('length').addEventListener('input', () => {
      patternLength = clampInt($('length').value, 1, 64);
      $('lengthVal').textContent = String(patternLength);
      roll.setLength(patternLength);
    });
    $('length').addEventListener('change', () => { save(); });

    $('density').addEventListener('input', () => {
      density = +$('density').value;
      $('densityVal').textContent = density.toFixed(2);
    });
    $('density').addEventListener('change', () => { save(); });

    $('key').addEventListener('change', () => { key = +$('key').value; save(); });
    $('scale').addEventListener('change', () => { scale = $('scale').value; save(); });
    $('octLo').addEventListener('change', () => {
      octLo = clampInt($('octLo').value, 0, 8);
      if (octHi < octLo) { octHi = octLo; $('octHi').value = octHi; }
      save();
    });
    $('octHi').addEventListener('change', () => {
      octHi = clampInt($('octHi').value, 0, 8);
      if (octHi < octLo) { octLo = octHi; $('octLo').value = octLo; }
      save();
    });

    $('snap').addEventListener('change', () => {
      snap = +$('snap').value;
      roll.setSnap(snap);
      save();
    });

    $('seed').addEventListener('change', () => {
      seed = $('seed').value.trim() || randomSeedHex();
      $('seed').value = seed;
      save();
    });
    $('randSeed').addEventListener('click', () => {
      seed = randomSeedHex();
      $('seed').value = seed;
      save();
    });

    $('algo').addEventListener('change', () => {
      algo = $('algo').value;
      renderAlgoParams();
      save();
    });

    $('genBtn').addEventListener('click', () => {
      ensureAudio();
      doGenerate();
    });
    $('clearBtn').addEventListener('click', clearPattern);
    $('delBtn').addEventListener('click', () => roll.deleteSelected());

    $('outputDest').addEventListener('change', () => {
      silenceAll();
      outputDest = $('outputDest').value;
      syncOutputsUI();
      if (outputDest === 'midi') ensureMidiAccess();
      save();
    });
    $('midiDevice').addEventListener('change', () => {
      midi.deviceId = $('midiDevice').value || null;
      midiOut.select(midi.deviceId);
      save();
    });
    $('midiChannel').addEventListener('change', () => {
      midi.channel = clampInt($('midiChannel').value, 0, 15);
      midiOut.channel = midi.channel;
      save();
    });
    $('midiPanic').addEventListener('click', () => {
      try { midiOut.allOff(); } catch (e) {}
      if (voice) voice.allOff();
    });

    const audioIds = ['vol', 'cutoff', 'resonance', 'env', 'accent', 'glide', 'release'];
    for (const id of audioIds) {
      $(id).addEventListener('input', () => { applyVoiceParams(); });
      $(id).addEventListener('change', () => { save(); });
    }

    window.addEventListener('keydown', (e) => {
      if (e.target && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
      if (e.code === 'Space') {
        e.preventDefault();
        if (running) stop(); else start();
      }
    });
  }

  /* ---------- boot ---------- */
  fillKeyScale();
  fillAlgo();

  // midi channel options
  (function () {
    const sel = $('midiChannel');
    sel.innerHTML = '';
    for (let i = 0; i < 16; i++) {
      const o = document.createElement('option');
      o.value = String(i);
      o.textContent = String(i + 1);
      sel.appendChild(o);
    }
  })();

  load();
  // re-fill selects after load may have changed algo/key
  $('key').value = String(key);
  $('scale').value = scale;
  $('algo').value = algo;
  renderAlgoParams();
  applyToControls();
  wire();
  roll.resize();

  // first-visit: generate a starter pattern
  if (!notes.length) doGenerate();

  if (outputDest === 'midi') ensureMidiAccess();
})();
