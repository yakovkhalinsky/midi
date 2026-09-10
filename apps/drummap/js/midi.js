'use strict';
/*
 * Web MIDI output helper, shared by the web sequencer ports.
 *
 * IMPORTANT: navigator.requestMIDIAccess() only exists in secure contexts
 * (https://, or http://localhost) and only in Chromium-based browsers.
 * Over plain http:// from a LAN/Tailscale IP, Chrome blocks it without even
 * showing a permission prompt — load the app via an SSH tunnel (localhost)
 * or HTTPS to enable MIDI.
 *
 * Scheduling: Web MIDI send() timestamps use the performance clock (ms);
 * events scheduled on the audio clock are converted in send().
 */

class MidiOut {
  constructor(getTime) {
    this.getTime = getTime;     // returns scheduler time in seconds
    this.access = null;
    this.output = null;
    this.channel = 0;           // 0-based (MIDI channel 1); drums default 9 = ch 10
    this.ready = false;
    this.onState = null;        // set by the app to refresh the UI
  }

  async init() {
    if (!navigator.requestMIDIAccess) {
      throw new Error('Web MIDI unavailable in this browser/context — it needs a Chromium-based browser AND a secure context (https://, or http://localhost via an SSH tunnel). Loading over plain http:// from a LAN/Tailscale IP blocks MIDI entirely.');
    }
    this.access = await navigator.requestMIDIAccess({ sysex: false });
    this.ready = true;
    this.access.onstatechange = () => { if (this.onState) this.onState(); };
  }

  outputs() {
    return this.access ? Array.from(this.access.outputs.values()) : [];
  }

  select(id) {
    if (!this.access) return;
    this.output = id ? this.access.outputs.get(id) : null;
  }

  get active() { return !!this.output; }

  /* whenSec: scheduler time (audio-clock domain) -> performance-clock ms */
  send(bytes, whenSec) {
    if (!this.output) return;
    let ts;
    if (whenSec !== undefined && this.getTime) {
      try {
        const now = this.getTime();
        ts = window.performance.now() + Math.max(0, whenSec - now) * 1000;
      } catch (e) { ts = undefined; }
    }
    try { this.output.send(bytes, ts); }
    catch (e) { console.warn('MIDI send failed:', e); }
  }

  noteOn(note, vel, whenSec) {
    this.send([0x90 | (this.channel & 0xf), note & 0x7f, vel & 0x7f], whenSec);
  }
  noteOff(note, whenSec) {
    this.send([0x80 | (this.channel & 0xf), note & 0x7f, 0], whenSec);
  }
  allOff() {
    this.send([0xb0 | (this.channel & 0xf), 123, 0]); // CC 123: all notes off
    this.send([0x80 | (this.channel & 0xf), 0, 0]);
  }
  clockTick(whenSec) { this.send([0xf8], whenSec); }
  transportStart() { this.send([0xfa]); }
  transportStop() { this.send([0xfc]); }
}