'use strict';
/*
 * TB-3PO MIDI note sequencer — the app-specific layer on top of the shared
 * MidiOut helper (js/midi.js).
 *
 * The applet's pitch/gate/accent CVs are re-encoded as MIDI notes:
 *   - pitch CV (1 V/oct, C4 = 0 V)  -> MIDI note 60 + semitones (+ octave shift)
 *   - gate (3 V / 6 V accent)       -> note-on velocity (base / accent velocity)
 *   - slide chains (tied gates)     -> previous note is ended, optionally with
 *                                      CC65 portamento armed for mono synths
 *
 * The shared helper knows nothing about notes-in-progress; this class tracks
 * the held note so gate cuts and chained steps pair note-off/note-on correctly.
 */

class MidiNoteSeq {
  constructor(midiOut) {
    this.out = midiOut;                 // shared MidiOut instance
    this.velocity = 100;
    this.accentVel = 127;
    this.octave = 0;                    // extra octave shift on top of the engine CV
    this.slidesToPortamento = false;
    this.heldNote = null;               // last note-on still sounding
    this.onActivity = null;             // note-on callback (LED)
  }

  /* engine pitch CV (128 units/semitone, 0 V = C4) -> MIDI note number */
  noteFor(semis) {
    return con(Math.round(semis) + 60 + this.octave * 12, 0, 127);
  }

  /* gateOn: {t, accent, retrig}; when audioCtx is missing, t must be undefined */
  noteOn(note, accent, t) {
    const vel = con(accent ? this.accentVel : this.velocity, 1, 127);
    const chained = this.heldNote !== null && this.heldNote !== note;
    if (chained) {
      // slid step without retrigger: end the previous note first, then
      // (optionally) ask a mono synth to glide into the new one
      this.out.noteOff(this.heldNote, t);
      if (this.slidesToPortamento) this.out.send([0xb0 | (this.out.channel & 0xf), 65, 127], t);
    }
    this.out.noteOn(note, vel, t);
    this.heldNote = note;
    if (this.onActivity) this.onActivity();
  }

  /* gate cut; t = scheduler time (audio-clock seconds) or undefined = now */
  noteOff(t) {
    if (this.heldNote === null) return;
    this.out.noteOff(this.heldNote, t);
    this.heldNote = null;
    if (this.slidesToPortamento) this.out.send([0xb0 | (this.out.channel & 0xf), 65, 0], t);
  }

  /* release whatever is sounding (STOP, RESET, output switch, panic) */
  silence() {
    const ch = 0x80 | (this.out.channel & 0xf);
    if (this.heldNote !== null) {
      this.out.noteOff(this.heldNote, undefined);
      this.heldNote = null;
    }
    this.out.send([ch, 123, 0]);                    // all notes off
    this.out.send([0xb0 | (this.out.channel & 0xf), 65, 0]); // portamento off
  }

  programChange(program, t) {
    this.out.send([0xc0 | (this.out.channel & 0xf), con(program | 0, 0, 127)], t);
  }
}