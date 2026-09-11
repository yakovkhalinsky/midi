# Melogen — melody generator + piano roll

Generate melodies with pluggable algorithms, then edit them on a piano roll.
Web Audio preview or Web MIDI out. **Same seed → same notes.**

Not a direct Phazerville applet port — a sibling web tool in the same static
architecture as [TB-3PO](../tb3po/) and [DrumMap](../drummap/).
Also available as a **generator + stepped-playback** slot in the [Rack](../rack/).

**Live:** <https://yakov.khalinsky.com/midi/apps/melogen/>

## Run it

No build step, no dependencies:

```sh
# from the repo root
python3 -m http.server 8000
# http://localhost:8000/apps/melogen/
```

Or open `index.html` directly. Web MIDI needs a Chromium-based browser in a
secure context (`https://` or `http://localhost`).

## Features

- **Note model** — pitch (MIDI), start (beats), duration, velocity; deterministic PRNG (Mulberry32) when a seed is set.
- **Generators**
  - **Random in scale** — key/scale, length, density, step/gate, octave range, seed
  - **Markov** — order 1–3 from the current pattern and/or a small built-in motif bank
  - **Euclidean** — Bjorklund pulses/steps/rotate + scale pitches (walk / cycle / random)
  - **Contour / arp** — up, down, up-down, down-up, random; gate length; arp octaves
- **Piano roll** — pitch gutter, beat/bar grid, draw, select/move, resize duration, delete, Alt-drag velocity, snap, playhead, scroll/zoom
- **Transport** — play/stop, BPM, loop, pattern length
- **Output** — soft saw Web Audio voice with TB-3PO-style filter/amp envelope controls (cutoff, resonance, filter env, accent, glide, release), or Web MIDI out (device + channel) like the sibling apps
- **Generate** — replace or append (toggle)

## Files

| File | Contents |
| --- | --- |
| `index.html` | layout |
| `style.css` | dark panel UI |
| `js/notes.js` | note model, snap, Mulberry32 PRNG |
| `js/scales.js` | keys, scale tables, pitch helpers |
| `js/generators.js` | pluggable generators |
| `js/roll.js` | canvas piano roll |
| `js/synth.js` | Web Audio polyphonic preview voice (per-note filter + TB-3PO-style envelopes) |
| `js/midi.js` | shared Web MIDI helper (same as siblings) |
| `js/app.js` | transport, UI wiring, persistence |
| `_selftest.html` | headless checks (determinism, note model, MIDI stub, offline audio) |

## Self-test

Open [`_selftest.html`](_selftest.html) — expect all `PASS` lines for generator
determinism, note clamps, Euclidean pulse count, MidiOut bytes, and offline voice render.
