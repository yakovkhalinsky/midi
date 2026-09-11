'use strict';
/*
 * Canvas piano roll for Melogen.
 * Interactions: draw (empty drag), select/move, resize duration (right edge),
 * delete (Delete/Backspace or right-click), velocity (Alt+drag vertical).
 */

class PianoRoll {
  constructor(canvas, opts) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.opts = Object.assign({
      pitchMin: 36,
      pitchMax: 84,
      lengthBeats: 8,
      snap: 0.25,
      beatWidth: 48,
      rowHeight: 14,
      gutter: 44,
      onChange: null,
      onSelect: null,
    }, opts || {});

    this.notes = [];
    this.selected = new Set();
    this.playhead = 0;
    this.scrollX = 0;
    this.scrollY = 0;
    this.drag = null; // { mode, ... }

    this._bind();
    this.resize();
  }

  setNotes(notes) {
    this.notes = notes;
    this.redraw();
  }

  setLength(beats) {
    this.opts.lengthBeats = Math.max(1, beats);
    this.redraw();
  }

  setSnap(snap) {
    this.opts.snap = snap;
  }

  setPlayhead(beats) {
    this.playhead = beats;
    this.redraw();
  }

  setPitchRange(lo, hi) {
    this.opts.pitchMin = lo;
    this.opts.pitchMax = hi;
    this.redraw();
  }

  clearSelection() {
    this.selected.clear();
    if (this.opts.onSelect) this.opts.onSelect([]);
    this.redraw();
  }

  getSelectedNotes() {
    return this.notes.filter((n) => this.selected.has(n.id));
  }

  deleteSelected() {
    if (!this.selected.size) return;
    this.notes = this.notes.filter((n) => !this.selected.has(n.id));
    this.selected.clear();
    this._emitChange();
    this.redraw();
  }

  resize() {
    const parent = this.canvas.parentElement;
    const w = parent ? parent.clientWidth : 640;
    const h = parent ? parent.clientHeight : 360;
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.max(1, Math.floor(w * dpr));
    this.canvas.height = Math.max(1, Math.floor(h * dpr));
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.cssW = w;
    this.cssH = h;
    this.redraw();
  }

  /* ---- geometry ---- */
  contentHeight() {
    return (this.opts.pitchMax - this.opts.pitchMin + 1) * this.opts.rowHeight;
  }
  contentWidth() {
    return this.opts.lengthBeats * this.opts.beatWidth;
  }
  pitchToY(pitch) {
    return (this.opts.pitchMax - pitch) * this.opts.rowHeight - this.scrollY;
  }
  yToPitch(y) {
    const p = this.opts.pitchMax - Math.floor((y + this.scrollY) / this.opts.rowHeight);
    return clampInt(p, this.opts.pitchMin, this.opts.pitchMax);
  }
  beatToX(beat) {
    return this.opts.gutter + beat * this.opts.beatWidth - this.scrollX;
  }
  xToBeat(x) {
    return (x - this.opts.gutter + this.scrollX) / this.opts.beatWidth;
  }

  hitTest(x, y) {
    if (x < this.opts.gutter) return null;
    // top-most note wins
    for (let i = this.notes.length - 1; i >= 0; i--) {
      const n = this.notes[i];
      const nx = this.beatToX(n.start);
      const ny = this.pitchToY(n.pitch);
      const nw = n.duration * this.opts.beatWidth;
      const nh = this.opts.rowHeight - 1;
      if (x >= nx && x <= nx + nw && y >= ny && y <= ny + nh) {
        const edge = (x >= nx + nw - 6);
        return { note: n, edge };
      }
    }
    return null;
  }

  /* ---- drawing ---- */
  redraw() {
    const ctx = this.ctx;
    const w = this.cssW, h = this.cssH;
    if (!w || !h) return;
    ctx.clearRect(0, 0, w, h);

    // background
    ctx.fillStyle = '#0c1016';
    ctx.fillRect(0, 0, w, h);

    this._drawGrid();
    this._drawGutter();
    this._drawNotes();
    this._drawPlayhead();
  }

  _drawGrid() {
    const ctx = this.ctx;
    const { gutter, beatWidth, rowHeight, lengthBeats, pitchMin, pitchMax, snap } = this.opts;
    const w = this.cssW, h = this.cssH;

    // pitch rows
    for (let p = pitchMin; p <= pitchMax; p++) {
      const y = this.pitchToY(p);
      if (y + rowHeight < 0 || y > h) continue;
      const pc = ((p % 12) + 12) % 12;
      const isBlack = [1, 3, 6, 8, 10].indexOf(pc) >= 0;
      ctx.fillStyle = isBlack ? '#10151c' : '#141a22';
      ctx.fillRect(gutter, y, w - gutter, rowHeight);
      ctx.strokeStyle = '#1a222c';
      ctx.beginPath();
      ctx.moveTo(gutter, y + rowHeight);
      ctx.lineTo(w, y + rowHeight);
      ctx.stroke();
    }

    // vertical beat / bar lines
    const barBeats = 4;
    for (let b = 0; b <= lengthBeats + 0.001; b += snap || 0.25) {
      const x = this.beatToX(b);
      if (x < gutter - 1 || x > w) continue;
      const isBar = Math.abs(b % barBeats) < 1e-6;
      const isBeat = Math.abs(b % 1) < 1e-6;
      ctx.strokeStyle = isBar ? '#3a4658' : isBeat ? '#2a3442' : '#1c2430';
      ctx.lineWidth = isBar ? 1.5 : 1;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }
  }

  _drawGutter() {
    const ctx = this.ctx;
    const { gutter, rowHeight, pitchMin, pitchMax } = this.opts;
    const h = this.cssH;
    ctx.fillStyle = '#12171f';
    ctx.fillRect(0, 0, gutter, h);
    ctx.strokeStyle = '#2a3442';
    ctx.beginPath();
    ctx.moveTo(gutter - 0.5, 0);
    ctx.lineTo(gutter - 0.5, h);
    ctx.stroke();

    ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textBaseline = 'middle';
    for (let p = pitchMin; p <= pitchMax; p++) {
      const y = this.pitchToY(p);
      if (y + rowHeight < 0 || y > h) continue;
      const pc = ((p % 12) + 12) % 12;
      const isBlack = [1, 3, 6, 8, 10].indexOf(pc) >= 0;
      // key
      ctx.fillStyle = isBlack ? '#1a1f28' : '#d7dfe8';
      ctx.fillRect(2, y + 1, gutter - 6, rowHeight - 2);
      if (!isBlack || pc === 0) {
        ctx.fillStyle = isBlack ? '#8b96a5' : '#2a3140';
        if (pc === 0) {
          ctx.fillStyle = '#7fe3a0';
          ctx.fillText(midiToName(p), 6, y + rowHeight / 2);
        }
      }
    }
  }

  _drawNotes() {
    const ctx = this.ctx;
    const { rowHeight, beatWidth, gutter } = this.opts;
    const w = this.cssW, h = this.cssH;
    for (const n of this.notes) {
      const x = this.beatToX(n.start);
      const y = this.pitchToY(n.pitch);
      const nw = Math.max(4, n.duration * beatWidth);
      const nh = rowHeight - 2;
      if (x + nw < gutter || x > w || y + nh < 0 || y > h) continue;

      const selected = this.selected.has(n.id);
      const bright = 0.35 + (n.velocity / 127) * 0.65;
      ctx.fillStyle = selected
        ? `rgba(255, 180, 84, ${0.55 + bright * 0.35})`
        : `rgba(127, 227, 160, ${0.35 + bright * 0.5})`;
      ctx.strokeStyle = selected ? '#ffb454' : '#5cb882';
      roundRect(ctx, x, y + 1, nw, nh, 3);
      ctx.fill();
      ctx.stroke();

      // resize handle hint
      ctx.fillStyle = selected ? 'rgba(255,255,255,0.35)' : 'rgba(0,0,0,0.25)';
      ctx.fillRect(x + nw - 4, y + 3, 3, nh - 4);
    }
  }

  _drawPlayhead() {
    const x = this.beatToX(this.playhead);
    if (x < this.opts.gutter || x > this.cssW) return;
    const ctx = this.ctx;
    ctx.strokeStyle = '#ff6b6b';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, this.cssH);
    ctx.stroke();
  }

  /* ---- interaction ---- */
  _bind() {
    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => this._onDown(e));
    c.addEventListener('pointermove', (e) => this._onMove(e));
    c.addEventListener('pointerup', (e) => this._onUp(e));
    c.addEventListener('pointercancel', (e) => this._onUp(e));
    c.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const rect = c.getBoundingClientRect();
      const hit = this.hitTest(e.clientX - rect.left, e.clientY - rect.top);
      if (hit) {
        this.selected.clear();
        this.selected.add(hit.note.id);
        this.deleteSelected();
      }
    });
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        // zoom beat width
        const factor = e.deltaY > 0 ? 0.9 : 1.1;
        this.opts.beatWidth = Math.max(16, Math.min(160, this.opts.beatWidth * factor));
      } else if (e.shiftKey) {
        this.scrollX = Math.max(0, this.scrollX + e.deltaY);
      } else {
        this.scrollY = Math.max(0, Math.min(Math.max(0, this.contentHeight() - this.cssH), this.scrollY + e.deltaY));
        this.scrollX = Math.max(0, this.scrollX + e.deltaX);
      }
      this.redraw();
    }, { passive: false });

    window.addEventListener('keydown', (e) => {
      if (e.target && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        this.deleteSelected();
      } else if (e.key === 'a' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        this.notes.forEach((n) => this.selected.add(n.id));
        if (this.opts.onSelect) this.opts.onSelect(this.getSelectedNotes());
        this.redraw();
      } else if (e.key === 'Escape') {
        this.clearSelection();
      }
    });

    window.addEventListener('resize', () => this.resize());
  }

  _pos(e) {
    const rect = this.canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  _onDown(e) {
    if (e.button === 2) return;
    this.canvas.setPointerCapture(e.pointerId);
    const { x, y } = this._pos(e);
    const hit = this.hitTest(x, y);
    const beat = snapBeat(Math.max(0, this.xToBeat(x)), this.opts.snap);
    const pitch = this.yToPitch(y);

    if (hit) {
      if (!e.shiftKey && !this.selected.has(hit.note.id)) {
        this.selected.clear();
        this.selected.add(hit.note.id);
      } else if (e.shiftKey) {
        if (this.selected.has(hit.note.id)) this.selected.delete(hit.note.id);
        else this.selected.add(hit.note.id);
      } else {
        this.selected.add(hit.note.id);
      }

      if (e.altKey) {
        this.drag = {
          mode: 'velocity',
          startY: y,
          origins: this.getSelectedNotes().map((n) => ({ id: n.id, velocity: n.velocity })),
        };
      } else if (hit.edge && this.selected.has(hit.note.id)) {
        this.drag = {
          mode: 'resize',
          noteId: hit.note.id,
          originDur: hit.note.duration,
          startBeat: this.xToBeat(x),
        };
      } else {
        this.drag = {
          mode: 'move',
          startBeat: beat,
          startPitch: pitch,
          origins: this.getSelectedNotes().map((n) => ({
            id: n.id, start: n.start, pitch: n.pitch,
          })),
        };
      }
      if (this.opts.onSelect) this.opts.onSelect(this.getSelectedNotes());
      this.redraw();
      return;
    }

    // empty → draw new note
    this.selected.clear();
    const note = makeNote(pitch, beat, this.opts.snap || 0.25, 100);
    this.notes.push(note);
    this.selected.add(note.id);
    this.drag = {
      mode: 'draw',
      noteId: note.id,
      originStart: beat,
    };
    if (this.opts.onSelect) this.opts.onSelect(this.getSelectedNotes());
    this._emitChange();
    this.redraw();
  }

  _onMove(e) {
    if (!this.drag) {
      // cursor hint
      const { x, y } = this._pos(e);
      const hit = this.hitTest(x, y);
      this.canvas.style.cursor = hit
        ? (hit.edge ? 'ew-resize' : (e.altKey ? 'ns-resize' : 'grab'))
        : (x < this.opts.gutter ? 'default' : 'crosshair');
      return;
    }
    const { x, y } = this._pos(e);
    const beat = Math.max(0, this.xToBeat(x));
    const pitch = this.yToPitch(y);

    if (this.drag.mode === 'draw') {
      const n = this.notes.find((nn) => nn.id === this.drag.noteId);
      if (n) {
        const end = snapBeat(Math.max(beat, n.start + (this.opts.snap || 0.25)), this.opts.snap);
        n.duration = Math.max(this.opts.snap || 0.25, end - n.start);
        n.pitch = pitch;
        this.redraw();
      }
    } else if (this.drag.mode === 'move') {
      const dBeat = snapBeat(beat, this.opts.snap) - this.drag.startBeat;
      const dPitch = pitch - this.drag.startPitch;
      for (const o of this.drag.origins) {
        const n = this.notes.find((nn) => nn.id === o.id);
        if (!n) continue;
        n.start = Math.max(0, snapBeat(o.start + dBeat, this.opts.snap));
        n.pitch = clampInt(o.pitch + dPitch, this.opts.pitchMin, this.opts.pitchMax);
      }
      this.redraw();
    } else if (this.drag.mode === 'resize') {
      const n = this.notes.find((nn) => nn.id === this.drag.noteId);
      if (n) {
        const end = snapBeat(Math.max(beat, n.start + (this.opts.snap || 0.25)), this.opts.snap);
        n.duration = Math.max(this.opts.snap || 0.25, end - n.start);
        this.redraw();
      }
    } else if (this.drag.mode === 'velocity') {
      const dy = this.drag.startY - y;
      for (const o of this.drag.origins) {
        const n = this.notes.find((nn) => nn.id === o.id);
        if (!n) continue;
        n.velocity = clampInt(o.velocity + dy * 0.5, 1, 127);
      }
      if (this.opts.onSelect) this.opts.onSelect(this.getSelectedNotes());
      this.redraw();
    }
  }

  _onUp(e) {
    if (!this.drag) return;
    // clamp notes inside length
    for (const n of this.notes) {
      if (n.start >= this.opts.lengthBeats) n.start = Math.max(0, this.opts.lengthBeats - (this.opts.snap || 0.25));
      if (n.start + n.duration > this.opts.lengthBeats) {
        n.duration = Math.max(this.opts.snap || 0.25, this.opts.lengthBeats - n.start);
      }
    }
    this.drag = null;
    this._emitChange();
    this.redraw();
  }

  _emitChange() {
    if (this.opts.onChange) this.opts.onChange(this.notes);
  }
}

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}
