'use strict';
/*
 * 64x64 one-bit OLED renderer (weegfx-style primitives) plus a port of
 * DrumMap::DrawInterface(), DrumMap::DrawTracks() and Hemisphere's DrawSlider().
 */

class OLED {
  constructor() {
    this.w = 64; this.h = 64;
    this.buf = new Uint8Array(this.w * this.h);
  }
  clear() { this.buf.fill(0); }
  /* gfxClear: clear a region to black */
  clearRect(x, y, w, h) {
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
      const xx = (x + i) | 0, yy = (y + j) | 0;
      if (xx < 0 || yy < 0 || xx >= this.w || yy >= this.h) continue;
      this.buf[yy * this.w + xx] = 0;
    }
  }
  px(x, y, v) {
    if (v === undefined) v = 1;
    x |= 0; y |= 0;
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    this.buf[y * this.w + x] = v ? 1 : 0;
  }
  rect(x, y, w, h) {
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.px(x + i, y + j);
  }
  frame(x, y, w, h, dotted) {
    for (let i = 0; i < w; i++) {
      if (!dotted || (i & 1) === 0) { this.px(x + i, y); this.px(x + i, y + h - 1); }
    }
    for (let j = 0; j < h; j++) {
      if (!dotted || (j & 1) === 0) { this.px(x, y + j); this.px(x + w - 1, y + j); }
    }
  }
  invert(x, y, w, h) {
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
      const xx = x + i, yy = y + j;
      if (xx < 0 || yy < 0 || xx >= this.w || yy >= this.h) continue;
      this.buf[yy * this.w + xx] ^= 1;
    }
  }
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
  /* weegfx drawLine(..., p): dotted, a pixel every p positions */
  dottedLine(x1, y1, x2, y2, p) {
    x1 |= 0; y1 |= 0; x2 |= 0; y2 |= 0;
    p = Math.max(1, p | 0);
    const dx = Math.abs(x2 - x1), dy = Math.abs(y2 - y1);
    const sx = x1 < x2 ? 1 : -1, sy = y1 < y2 ? 1 : -1;
    let err = (dx >> 1), c = 0;
    let x = x1, y = y1;
    for (;;) {
      if (++c % p === 0) this.px(x, y);
      if (x === x2 && y === y2) break;
      const e2 = 2 * err;
      if (e2 > -dy) { err -= dy; x += sx; }
      if (e2 < dx) { err += dx; y += sy; }
    }
  }
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
  bitmap(x, y, data, w) {
    w = w || 8;
    for (let c = 0; c < w; c++) {
      const byte = data[c];
      for (let r = 0; r < 8; r++) if ((byte >>> r) & 1) this.px(x + c, y + r);
    }
  }
  icon(x, y, data) { this.bitmap(x, y, data, 8); }
  print(x, y, str) {
    let cx = x | 0;
    const s = String(str);
    for (const ch of s) {
      const g = fontGlyph(ch.charCodeAt(0));
      if (g) this.bitmap(cx, y, g, 6);
      cx += 6;
    }
  }
  blit(ctx, scale, color) {
    ctx.clearRect(0, 0, this.w * scale, this.h * scale);
    ctx.fillStyle = color;
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        if (this.buf[y * this.w + x]) ctx.fillRect(x * scale, y * scale, scale, scale);
      }
    }
  }
}

/* web focus stands in for the hardware cursor */
const DCUR = { NONE: -1, PART_A: 0, PART_B: 1, FILL_A: 2, FILL_B: 3, X: 4, Y: 5, CHAOS: 6, CV_MODE: 7 };
const PART_ICONS = [ICON_BD, ICON_SN, ICON_HH];
const HIT_ICONS = [ICON_BD_HIT, ICON_SN_HIT, ICON_HH_HIT];

/* HemisphereApplet::DrawSlider() */
function drawSlider(ol, x, y, len, value, isCursor) {
  const p = isCursor ? 1 : 3;
  const w = proportion(value, DRUM_MAX_VAL, len - 1);
  ol.dottedLine(x, y + 4, x + len, y + 4, p);
  ol.rect(x + w, y, 2, 8);
  if (isCursor) ol.invert(x - 1, y, len + 3, 8);
}

/* DrumMap::DrawTracks() — mini level chart of the next 32 steps */
function drawTracks(ol, e, y, ch) {
  const part = (ch === 1 && e.mode[ch] === 3) ? e.mode[0] : e.mode[ch];
  for (let i = 0; i < 32; i++) {
    const level = e.readDrumMap((e.step + i) % 32, part, e._x, e._y);
    let h = level >> 6;
    if (level > 0) h++;
    ol.rect(2 * i, y + 4 - h, 2, h);
  }
}

/* DrumMap::DrawInterface(); cursor = DCUR.* (web focus) */
function drawDrumMap(ol, e, cursor) {
  ol.clear();

  // output selection
  ol.print(1, 15, 'A');
  ol.icon(15, 15, e.pulseAnimation[0] > 0 ? HIT_ICONS[e.mode[0]] : PART_ICONS[e.mode[0]]);

  ol.print(32, 15, 'B');
  if (e.mode[1] === 3) {
    // accent: B plays A's part
    ol.icon(46, 15, PART_ICONS[e.mode[0]]);
    ol.print(53, 15, '>');
  } else {
    ol.icon(46, 15, e.pulseAnimation[1] > 0 ? HIT_ICONS[e.mode[1]] : PART_ICONS[e.mode[1]]);
  }

  // fill
  ol.print(1, 25, 'F');
  drawSlider(ol, 9, 25, 20, e._fill[0], cursor === DCUR.FILL_A);
  // don't show fill for channel b if it is in accent mode
  if (e.mode[1] < 3) {
    ol.print(32, 25, 'F');
    drawSlider(ol, 40, 25, 20, e._fill[1], cursor === DCUR.FILL_B);
  }

  // x & y
  ol.print(1, 35, 'X');
  drawSlider(ol, 9, 35, 20, e._x, cursor === DCUR.X);
  ol.print(32, 35, 'Y');
  drawSlider(ol, 40, 35, 20, e._y, cursor === DCUR.Y);

  // chaos
  ol.print(1, 45, 'CHAOS');
  drawSlider(ol, 32, 45, 28, e._chaos, cursor === DCUR.CHAOS);

  // step count as progress bar
  ol.frame(0, 10, (e.step + 1) * 2, 3);

  // cursor for part selection
  if (cursor === DCUR.PART_A || cursor === DCUR.PART_B) {
    ol.invert(14 + cursor * 31, 14, 16, 9);
  }

  if (cursor === DCUR.CV_MODE) {
    ol.icon(1, 57, ICON_CV);
    ol.print(10, 55, CV_MODE_NAMES[e.cvMode]);
    ol.invert(10, 54, 50, 9);
  } else {
    drawTracks(ol, e, 55, 0);
    drawTracks(ol, e, 60, 1);
  }

  // display value for knobs
  if (e.valueAnimation > 0 && cursor >= DCUR.FILL_A && cursor <= DCUR.CHAOS) {
    const map = [e.fill[0], e.fill[1], e.x, e.y, e.chaos];
    const val = map[cursor - DCUR.FILL_A];
    const yPos = 4 + 10 * Math.floor(cursor / 2);
    ol.clearRect(23, yPos, 19, 10);
    ol.print(23, yPos + 1, String(val).padStart(3, ' '));
    ol.invert(23, yPos, 19, 10);
  }
}