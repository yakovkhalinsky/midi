# DrumMap — Web Edition

A browser port of **[DrumMap](https://github.com/djphazer/O_C-Phazerville/blob/main/software/src/applets/DrumMap.h)**,
the 2-channel [Grids](https://mutable-instruments.net/modules/grids/) pattern generator
Hemisphere applet for Ornament & Crime ([Phazerville firmware](https://github.com/djphazer/O_C-Phazerville)),
by Ben Rosenbach (based on Mutable Instruments Grids by Émilie Gillet).

Two drum channels traverse a 5×5 map of rhythms with X/Y coordinates, bilinearly faded
between cells — exactly like Grids. Trigger outputs are rendered with a small Web Audio
drum voice (kick / snare / hi-hat, accents louder & brighter).

## Run it

No build step. Open `index.html` directly, or `python3 -m http.server` in this folder.

**Live:** <https://yakovkhalinsky.github.io/midi/apps/drummap/> (GitHub Pages)

## Faithful to the hardware

Ported 1:1 from `DrumMap.h` on the Phazerville (Teensy 4.x) build:

- **ReadDrumMap()** — bilinear U8Mix fade across the 5×5 `drum_map` table
  (`(b * mix + a * (255 - mix)) >> 8`), with the `uint8_t quadX = x << 2` truncation
  giving the fractional position inside a quadrant.
- **Grids2 pattern table by default** (`DRUMMAP_GRIDS2` is set in Phazerville's default
  builds), with the original Mutable Instruments table selectable. Node layouts are
  contiguous, so Grids2's short `node_9` (72 bytes) reads into the next node's bytes
  exactly like the firmware's PROGMEM layout.
- **Chaos** — per-part `randomness = random(0, chaos >> 2)` re-rolled at step 0 of each
  32-step loop, added to the map level.
- **Gates** — `level > ~fill` (uint8 ~, i.e. threshold = 255 − fill); channel B in
  **accent** mode plays channel A's part, gated by A's fill, firing only above level 192.
- **CV assignment** — Fill 1/2, X/Y or Fill 1/Chaos, `±255` over ±6 V like
  `Proportion(DetentedIn(), 6 V, 255)`.
- **Auto-reset** after ~30000 ticks (≈1.76 s) without a clock.
- **OLED** — port of `DrawInterface()`: A/B labels with drum icons (hit variants pulse),
  F/X/Y/CHAOS dotted sliders with value popups, step progress bar, CV mode label, and the
  two 32-step level mini-charts at the bottom.

## Web adaptations

- **Clock**: musical BPM with a division select — **1/32 (8 ppqn) by default**, which is
  what DrumMap expects; also 1/4, 1/8, 1/16 for slower/faster rates. One clock edge
  advances one step. CLOCK tap / spacebar also clock it.
- **CV inputs become sliders** (−6…+6 V), re-routed live by the CV-assign select.
- **Voice** (web addition): kick (sine with pitch drop), snare (tone + noise band-pass),
  hi-hat (noise high-pass), accent multiplies level/brightness. Adjustable kick pitch &
  decay, snare tone, hat decay, accent amount, volume.
- **Pattern strip**: 32-step two-row visualization (level bars + trigger markers +
  playhead) below the OLED.
- **Pattern-set toggle**: Grids 2 ↔ classic Grids tables.
- **Persistence** via `localStorage`. Keyboard: `Space` = clock tap, `R` = reset.

## Files

| File | Contents |
| --- | --- |
| `index.html`, `style.css` | page + styling |
| `js/data.js` | generated: 6×8 font, drum icons, both Grids pattern tables (nodes + offsets + 5×5 map) |
| `js/engine.js` | faithful port: `DrumMap` class incl. `ReadDrumMap`, chaos, thresholds, auto-reset |
| `js/display.js` | 1-bit OLED renderer + `DrawInterface`/`DrawTracks`/`DrawSlider` ports |
| `js/synth.js` | kick/snare/hat Web Audio voices |
| `js/app.js` | scheduler, UI wiring, strip, persistence |
| `_selftest.html` | headless tests (map corners/fades, triggers, accent gate, auto-reset, OLED pixels, audio render) |

## Credits

- DrumMap applet © 2021 Benjamin Rosenbach — MIT license
- Grids patterns & concept by Émilie Gillet (Mutable Instruments) — pattern data GPL-3.0
- Grids2 patterns collected by KittenVillage
- Phazerville firmware by djphazer & contributors
## Enabling Web Audio / Web MIDI (important when browsing remotely)

- **Web Audio** needs a single click (browser autoplay rule): press RUN, CLOCK, or
  "Enable audio". If it still fails, the OLED hint shows the reason (e.g. no audio
  device). The "Enable audio" button plays a test kick so you can verify the path.
- **Web MIDI** is stricter: browsers only expose `requestMIDIAccess()` on **secure
  contexts** — `https://` or `http://localhost`. Loading over plain `http://` from a
  LAN/Tailscale IP makes Chrome block MIDI entirely (no permission prompt appears).

Two ways to get a secure context:

1. **SSH tunnel** (no cert warnings): `ssh -L 8080:localhost:8080 <user>@<host>`, then
   open `http://localhost:8080/`.
2. **HTTPS with the included self-signed server**: `./.https-server.py` serves
   `https://<host>:8444/` — accept the browser's certificate warning once, then the
   MIDI permission prompt appears when you click **Enable MIDI**.
