# TB-3PO — Web Edition

A browser-based port of **[TB-3PO](https://github.com/djphazer/O_C-Phazerville/blob/main/software/src/applets/TB3PO.h)**,
the TB-303-style acid pattern generator Hemisphere applet for Ornament & Crime
([Phazerville firmware](https://github.com/djphazer/O_C-Phazerville)) by Logarhythm & djphazer.

The applet's pitch CV and gate outputs are rendered with a small 303-style Web Audio voice
(saw → resonant lowpass with accentable envelope), and the OLED screen is recreated pixel-for-pixel.

## Run it

No build step, no dependencies. Either:

```sh
# from this folder
python3 -m http.server 8000
# then open http://localhost:8000
```

or simply open `index.html` directly in a browser (plain `<script>` tags, works over `file://`).

## What is faithful to the hardware

Ported 1:1 from `TB3PO.h` on the Teensy 4.x (`__IMXRT1062__`) build path:

- **Pattern generator** — `regenerate_pitches()` / `apply_density()` with the exact
  probability tables, octave coin-flip (`random(200) < 80`, odd = up), slide and accent
  "consecutive" rules, and the density → gate-probability / pitch-pool mappings
  (−7 = dense + root only, 0 = sparse + full scale, +7 = dense + full scale).
- **Bit-exact PRNG** — Teensy 4.x `random()` (avr-libc 1.6.4 Lehmer generator,
  `cores/teensy4/WMath.cpp`). The same 16-bit seed builds the identical pattern as on
  hardware: regeneration is seeded with `seed + 1` in a single pass, exactly like the
  IMXRT1062 path.
- **Deterministic seeds** — lock the seed (lock icon) to edit the 4 hex digits; same
  seed + settings = same pattern. Unlocked (die) re-randomizes on every RESET.
- **braids quantizer** — `Quantizer::Lookup()` degree semantics (note 64 = degree 0),
  CV units of 128/semitone, `QuantEngine` root/octave offsets, and the OC scale list
  (Semitone, Ionian, Dorian, … by way of `braids_quantizer_scales.h`).
- **Playback** — 50%-of-clock-cycle gates, 3 V / 6 V accent gates, slide steps tie the
  gate through the next step (legato chains), fixed-time exponential slides with the
  firmware constants (`k = 0x3`, `>> 18` per tick at 17 kHz ⇒ τ ≈ 5.15 ms), hold-pitch
  behavior, transpose in Root (semitones) or Deg (scale degrees) modes.
- **OLED screen** — a port of `TB_3PO::DrawGraphics()` on a 1-bit 64×64 buffer with the
  original 6×8 font and 8×8 icons (heart, lock, die, note meter, CV/knob, arrows, bend,
  waveform): seed hex digits, three-note density meter, −7…+7 readout, Q-engine name,
  step/length counter, octave keyboard, accent `!`, slide/wave/hold markers, and the
  edit-cursor brackets.
- **Parameters** — lock/reseed/edit seed, density (encoder centerpoint + CV offset +
  per-step motion recording), quantizer select, transpose mode, length 1–32, hold pitch,
  disable-slides (AuxButton), and freeze (Reset jack held = `Gate(1)`).

## Web adaptations

- **Clock**: internal BPM clock (20–300 musical BPM, lookahead-scheduled for tight audio
  timing) with a clock-division control — BPM counts quarter notes; the select picks steps
  per beat (1/4, 1/8, 1/16 by default — TB-303 style 16th-note clocking — 1/32). One clock
  edge advances one step, exactly like the hardware jack. A manual CLOCK tap button and
  the spacebar also clock it. Gate timing follows the interval between the last two
  clocks, so it tracks tempo changes like `ClockCycleTicks()`.
- **CV inputs become sliders**: Transpose CV (semitones) and Density CV (±6 V ⇔ ±15
  density units, the same `Proportion` mapping as the firmware).
- **Voice / output routing** — an **Output** selector chooses where the applet's pitch/gate CVs go:
  - **Web Audio** — the built-in 303-ish voice: sawtooth → resonant LPF with per-gate
    filter envelope, accent pushes level + env, exponential pitch slides via
    `setTargetAtTime`, safety limiter. Volume, cutoff, resonance, env amount, accent,
    glide time (τ) and release are adjustable.
  - **MIDI out** — the same CV model re-encoded as MIDI notes over the Web MIDI API
    (shared `js/midi.js` helper): pitch CV → note (C4 = 60), gate → note-on/off at the
    50%-of-cycle gate times, accent → a separate accent velocity. Properties:
    output device, MIDI channel 1–16, octave shift −2…+2, base + accent velocity,
    optional slide-chains → CC65 portamento (armed on tied notes, released at the
    gate cut), program change, panic (all notes off). Chained (slid) steps end the
    previous note before starting the next one so polyphonic synths don't stack.
    MIDI timing is scheduled on the Web Audio clock and translated to Web MIDI
    send() timestamps. Settings persist; an activity LED blinks on each note-on.
- **Pattern strip**: a 32-step visualization of the generated gates/accents/slides/
  octaves/notes with a playhead (web-only addition).
- **Persistence**: settings are saved to `localStorage`. URL hash `#seed=abcd` picks a seed.
- **Keyboard**: `Space` = clock tap, `R` = reset.

## Files

| File | Contents |
| --- | --- |
| `index.html` | page layout |
| `style.css` | panel/OLED styling |
| `js/data.js` | generated: 6×8 SSD1306 font, icons from `icons.h`, braids scale table |
| `js/engine.js` | faithful port: `ArduinoRandom`, `BraidsQuantizer`, `TB3PO` class |
| `js/display.js` | 64×64 1-bit OLED renderer + `DrawGraphics()` port |
| `js/synth.js` | Web Audio 303-style voice |
| `js/midi.js` | shared Web MIDI output helper (same file as the drummap port) |
| `js/midiseq.js` | TB-3PO note sequencer on top of `midi.js` (mapping, chains, portamento) |
| `js/app.js` | scheduler, UI wiring, pattern strip, output routing, persistence |
| `_selftest.html` | headless test page (engine determinism, OLED pixel checks, offline audio render) |

Regenerate `js/data.js` from Phazerville sources if you want to refresh it (see the
comment at the top of the file).

## Fidelity notes / deviations

- Default density is 12 (shown as +5) — on a fresh hardware boot the encoder value is
  effectively uninitialized, so this web default follows the applet's `Start()` intent.
- Gate timing is scheduled against the Web Audio clock rather than the O&C's 17 kHz tick
  loop; the slide time constant is exposed as a control (default = the firmware value).
- `reseed()` uses `crypto.getRandomValues` (the hardware uses `micros()`); both are
  truly random — the *pattern build* is deterministic either way, seeded by `seed + 1`.
- The Q-engine popup editor (mask rotation etc.) is not emulated; scale/root/octave are
  exposed directly instead.
- Web MIDI requires a Chromium-based browser in a secure context (`https://`, or
  `http://localhost`); over plain `http://` from a LAN IP, Chrome blocks
  `requestMIDIAccess()` entirely — the app shows this in the MIDI status line.

## Credits

- TB-3PO applet © 2020 Logarhythm, modified by djphazer — MIT license
- Phazerville / Ornament & Crime Hemisphere
- braids quantizer & scales by Émilie Gillet (Mutable Instruments), re-implemented by Bryan Head
- SSD1306 6×8 font by Neven Boyanov (SSD1306xLED)
## Enabling Web Audio / Web MIDI (important when browsing remotely)

- **Web Audio** needs a single click (browser autoplay rule): press RUN, CLOCK, or
  "Enable audio". If it still fails, the OLED hint shows the reason (e.g. no audio
  device). The "Enable audio" button plays a short blip so you can verify the path.
- **Web MIDI** is stricter: browsers only expose `requestMIDIAccess()` on **secure
  contexts** — `https://` or `http://localhost`. Loading over plain `http://` from a
  LAN/Tailscale IP makes Chrome block MIDI entirely (no permission prompt appears).

Two ways to get a secure context:

1. **SSH tunnel** (no cert warnings): `ssh -L 8080:localhost:8080 <user>@<host>`, then
   open `http://localhost:8080/`.
2. **HTTPS with the included self-signed server**: `./.https-server.py` serves
   `https://<host>:8444/` — accept the browser's certificate warning once, then the
   MIDI permission prompt appears when you click **Enable MIDI**.
