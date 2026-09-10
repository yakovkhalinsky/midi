'use strict';
/*
 * 64x64 one-bit OLED renderer, mirroring the weegfx drawing primitives used
 * by Hemisphere applets (pixel buffer + column-major 6x8 font + 8x8 icons),
 * plus a port of TB_3PO::DrawGraphics().
 */

class OLED {
  constructor() {
    this.w = 64; this.h = 64;
    this.buf = new Uint8Array(this.w * this.h);
  }
  clear() { this.buf.fill(0); }
  px(x, y, v) {
    if (v === undefined) v = 1;
    x |= 0; y |= 0;
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    this.buf[y * this.w + x] = v ? 1 : 0;
  }
  /* gfxRect: filled rectangle */
  rect(x, y, w, h) {
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.px(x + i, y + j);
  }
  /* gfxFrame: outline; dotted skips every other pixel like OC's dotted frames */
  frame(x, y, w, h, dotted) {
    for (let i = 0; i < w; i++) {
      if (!dotted || (i & 1) === 0) { this.px(x + i, y); this.px(x + i, y + h - 1); }
    }
    for (let j = 0; j < h; j++) {
      if (!dotted || (j & 1) === 0) { this.px(x, y + j); this.px(x + w - 1, y + j); }
    }
  }
  /* gfxInvert: XOR region (used by edit cursors) */
  invert(x, y, w, h) {
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
      const xx = x + i, yy = y + j;
      if (xx < 0 || yy < 0 || xx >= this.w || yy >= this.h) continue;
      this.buf[yy * this.w + xx] ^= 1;
    }
  }
  /* gfxLine */
  line(x1, y1, x2, y2) {
    x1 |= 0; y1 |= 0; x2 |= 0; y2 |= 0;
    const dx = Math.abs(x2 - x1), dy = Math.abs(y2 - y1);
    const sx = x1 < x2 ? 1 : -1, sy = y1 < y2 ? 1 : -1;
    let err = dx - dy;
    for (;;) {
      this.px(x1, y1);
      if (x1 === x2 && y1 === y2) break;
      const e2 = 2 * err;
      if (e2 > -dy) { err -= dy; x1 += sx; }
      if (e2 < dx) { err += dx; y1 += sy; }
    }
  }
  /* gfxCircle (outline) */
  circle(cx, cy, r) {
    let x = r, y = 0, err = 1 - r;
    while (x >= y) {
      this.px(cx + x, cy + y); this.px(cx + y, cy + x);
      this.px(cx - y, cy + x); this.px(cx - x, cy + y);
      this.px(cx - x, cy - y); this.px(cx - y, cy - x);
      this.px(cx + y, cy - x); this.px(cx + x, cy - y);
      y++;
      if (err < 0) err += 2 * y + 1;
      else { x--; err += 2 * (y - x) + 1; }
    }
  }
  /* gfxBitmap / gfxIcon: column-major bitmap, bit 0 = top row */
  bitmap(x, y, data, w) {
    w = w || 8;
    for (let c = 0; c < w; c++) {
      const byte = data[c];
      for (let r = 0; r < 8; r++) if ((byte >>> r) & 1) this.px(x + c, y + r);
    }
  }
  icon(x, y, data) { this.bitmap(x, y, data, 8); }
  /* gfxPrint: 6px advance, y = top row of the 8px glyphs */
  print(x, y, str) {
    let cx = x | 0;
    const s = String(str);
    for (const ch of s) {
      const g = fontGlyph(ch.charCodeAt(0));
      if (g) this.bitmap(cx, y, g, 6);
      cx += 6;
    }
  }
  /* blit to a canvas context at integer scale */
  blit(ctx, scale, color, dim) {
    ctx.clearRect(0, 0, this.w * scale, this.h * scale);
    ctx.fillStyle = color;
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        if (this.buf[y * this.w + x]) ctx.fillRect(x * scale, y * scale, scale, scale);
      }
    }
  }
}

/* pad() from HSUtils.h: steady-width padding for numbers */
function pad(range, number) {
  let padding = 0;
  while (range > 1) {
    if (Math.abs(number) < range) padding += 6;
    range = Math.floor(range / 10);
  }
  if (number < 0 && padding > 0) padding -= 6;
  return padding;
}

/* Cursor ids (TB3POCursor from TB3PO.h) */
const CUR = { NONE: -1, LOCK_SEED: 0, DIGIT1: 1, DIGIT2: 2, DIGIT3: 3, DIGIT4: 4, DENSITY: 5, QSELECT: 6, TRANS_MODE: 7, LENGTH: 8, HOLD_PITCH: 9 };

/*
 * Port of TB_3PO::DrawGraphics()
 * e = engine (TB3PO), cursor = CUR.* (web focus stands in for the hardware cursor)
 */
function drawTB3PO(ol, e, cursor) {
  ol.clear();

  let heartY = 15, dieY = 15;
  if (e.randApplyAnim > 0) {
    if (e.randApplyAnim > 20) heartY = 13;
    else dieY = 13;
  }

  // Heart represents the seed/favorite; pulses on reset
  if (e.heartPulse > 0 && e.heartPulse < 1 && e.heartPulse % 0.4 < 0.25) heartY = 13;
  ol.icon(4, Math.round(heartY), ICON_FAVORITE);
  ol.icon(15, Math.round(e.lockSeed ? 15 : dieY), e.lockSeed ? ICON_LOCK : ICON_RANDOM);

  // 16-bit seed as 4 hex digits
  const dispSeed = e.seed & 0xffff;
  let sx = 25;
  for (let i = 3; i >= 0; --i) {
    const nib = (dispSeed >>> (i * 4)) & 0xF;
    ol.print(sx, 15, nib <= 9 ? String(nib) : String.fromCharCode('a'.charCodeAt(0) + nib - 10));
    sx += 6;
  }

  // Density meter: three note icons
  const gateDens = e.getOnOffDensity();
  const pitchDens = e.getPitchChangeDensity();
  const xd = 5 + 7 - gateDens;
  const yd = Math.trunc((64 * pitchDens) / 256);
  ol.bitmap(12 - xd, 27 + yd, ICON_NOTE4, 8);
  ol.bitmap(12, 27 - yd, ICON_NOTE4, 8);
  ol.bitmap(12 + xd, 27, ICON_NOTE4, 8);

  // Density number
  let densDisplay, densNeg;
  if (e.densityEncoderDisplay > 0) {
    densDisplay = Math.abs(e.densityEncoder - 7);
    densNeg = e.densityEncoder < 7;
    if (e.densityCv !== 0) { // knob icon: centerpoint being edited under CV
      ol.circle(3, 40, 3);
      ol.line(3, 38, 3, 40);
    }
  } else {
    densDisplay = gateDens;
    densNeg = e.density < 7;
    if (e.densityCv !== 0) ol.bitmap(22, 37, ICON_CV, 8);
  }
  if (densNeg) ol.print(8, 37, '-');
  ol.print(14, 37, densDisplay);
  if (e.densityAutoEnabled) ol.frame(8, 35, 16, 11, true);

  // Quantizer / transpose mode
  const eng = getScaleById(e.scaleIndex) || SCALES[0];
  if (cursor === CUR.QSELECT || cursor === CUR.TRANS_MODE) {
    ol.print(44, 26, 'Q1');
  } else {
    ol.print(36, 26, eng.short);
  }
  ol.print(38, 36, e.transposeInSemitones ? 'Root' : 'Deg');

  // Current / total steps
  const displayStep = e.step + 1;
  ol.print(1 + pad(10, displayStep), 47, displayStep);
  ol.print(1 + pad(10, displayStep) + 6 * String(displayStep).length, 47, '/');
  ol.print(1 + pad(10, displayStep) + 6 * (String(displayStep).length + 1), 47, e.numSteps);
  if (e.holdPitch) ol.print(32, 47, 'H');

  // Octave icons
  if (e.stepIsOctDown(e.step)) ol.bitmap(41, 54, ICON_DOWN, 8);
  else if (e.stepIsOctUp(e.step)) ol.bitmap(41, 54, ICON_UP, 8);

  ol.print(49, 55, NOTE_NAMES[e.currStepSemitone]);

  // TB-303 style octave keyboard
  let x = 1;
  const keyPatt = 0x054A;
  for (let i = 0; i < 12; ++i) {
    const y = ((keyPatt >>> i) & 0x1) ? 56 : 61;
    if (i === 5) x += 3; // E-F white gap
    if (e.currStepSemitone === i && e.stepIsGated(e.step)) {
      ol.rect(x - 1, y - 1, 5, 4);
    } else {
      ol.rect(x, y, 3, 2);
    }
    x += 3;
  }

  // Step markers
  if (e.stepIsAccent(e.step)) ol.print(37, 46, '!');
  if (e.stepIsSlid(e.step) || e.noSlides) ol.bitmap(42, 46, ICON_BEND, 8);
  if (e.noSlides) ol.print(42, 46, 'X');
  if (e.holdPitch && !e.stepIsGated(e.step)) ol.print(42, 46, '-');
  if (e.slideActiveUntil !== 0) ol.bitmap(52, 46, ICON_WAVE, 8);

  // Edit cursor (web focus, shown in the applet's edit-mode style)
  switch (cursor) {
    case CUR.LOCK_SEED:
      ol.invert(14, 14, e.lockSeed ? 11 : 36, 9);
      break;
    case CUR.DIGIT1: case CUR.DIGIT2: case CUR.DIGIT3: case CUR.DIGIT4:
      ol.invert(25 + 6 * (cursor - 1), 14, 7, 9);
      break;
    case CUR.DENSITY:
      ol.invert(9, 36, 14, 9);
      ol.icon(26, 37, ICON_LEFT);
      break;
    case CUR.QSELECT:
      ol.invert(44, 25, 13, 9);
      ol.icon(35, 26, ICON_RIGHT);
      break;
    case CUR.TRANS_MODE:
      ol.icon(31, 36, ICON_RIGHT);
      break;
    case CUR.LENGTH:
      ol.invert(20, 45, 12, 9);
      ol.icon(33, 47, ICON_LEFT);
      break;
    case CUR.HOLD_PITCH:
      ol.frame(31, 45, 9, 11);
      ol.icon(41, 47, ICON_LEFT);
      break;
  }
}

/* density display value clamps like the hardware uint8 path */
function gateDens_(g) { return con(g, 0, 7); }