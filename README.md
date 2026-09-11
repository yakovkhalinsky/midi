# web sequencer ports

Static browser ports of **Ornament & Crime / Phazerville** Hemisphere applets.
No build step, no dependencies — every app is plain HTML/JS/CSS, served as-is.

**Live on GitHub Pages:** https://yakov.khalinsky.com/midi/

| App | Phazerville applet | What it does |
| --- | --- | --- |
| [Rack](https://yakov.khalinsky.com/midi/apps/rack/) | — | **Three OLEDs in a row, shared clock** — pick a slot (1–3) to edit its controls; per-slot ÷N division and mute, global Web Audio / MIDI output, one MIDI device for all slots |
| [TB-3PO](https://yakov.khalinsky.com/midi/apps/tb3po/) | [`TB3PO.h`](https://github.com/djphazer/O_C-Phazerville/blob/main/software/src/applets/TB3PO.h) | TB-303-style acid pattern generator — bit-exact PRNG, braids quantizer, Web Audio voice or **Web MIDI out** (channel, velocity, accent, CC65 portamento) |
| [DrumMap](https://yakov.khalinsky.com/midi/apps/drummap/) | [`DrumMap.h`](https://github.com/djphazer/O_C-Phazerville/blob/main/software/src/applets/DrumMap.h) | Two-channel Grids drum pattern generator — bilinear 5×5 rhythm map, Web Audio drum voice or Web MIDI (GM drums 36/38/42) |
| [Melogen](https://yakov.khalinsky.com/midi/apps/melogen/) | — | Melody generator (random / Markov / Euclidean / contour) + piano-roll editor, Web Audio or Web MIDI out |

Each app has a headless `_selftest.html` page (open it directly) checking engine
determinism, OLED rendering and audio/MIDI plumbing.

## Run locally

```sh
python3 -m http.server 8000
# http://localhost:8000/apps/tb3po/ · http://localhost:8000/apps/drummap/ · http://localhost:8000/apps/melogen/
```

Web MIDI needs a Chromium-based browser in a secure context — `https://` or
`http://localhost`.