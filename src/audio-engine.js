// audio-engine.js — Web Audio kern voor WebQLab.
// Eén AudioContext + masterGain. Per cue is er hooguit ÉÉN actieve voice: een cue
// opnieuw starten herstart hem (nooit twee keer dezelfde cue tegelijk). De voice
// onthoudt zijn positie, zodat pauze/hervatten/seek werken (VLC-achtig) — ondanks
// dat AudioBufferSourceNode zelf geen pauze/seek kent (we stoppen en herstarten
// met een offset).

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.masterGain = null;
    this.voices = new Map(); // cueId -> voice (max. 1 per cue)
    this._decodeByFile = new WeakMap(); // File -> Promise<AudioBuffer>
    this.buffers = new Map(); // cueId -> AudioBuffer (voor duur/seek zonder afspelen)
  }

  _ensureContext() {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.value = 1;
      this.masterGain.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return this.ctx;
  }

  // Decodeer de audio van een cue naar een AudioBuffer (gecachet).
  async decode(cue) {
    this._ensureContext();
    let p = this._decodeByFile.get(cue.file);
    if (!p) {
      p = cue.file.arrayBuffer().then((buf) => this.ctx.decodeAudioData(buf));
      this._decodeByFile.set(cue.file, p);
    }
    const buffer = await p;
    this.buffers.set(cue.id, buffer);
    return buffer;
  }

  // Zorg dat de buffer klaarstaat en geef de duur terug (voor de afspeelbalk).
  async prepare(cue) {
    await this.decode(cue);
    return this.duration(cue.id);
  }

  duration(cueId) {
    const b = this.buffers.get(cueId);
    return b ? b.duration : 0;
  }

  // Start (of herstart) een cue vanaf `offset`. Een bestaande voice van dezelfde
  // cue wordt eerst gestopt → nooit twee keer dezelfde cue tegelijk.
  async play(cue, { offset = 0, fadeIn = cue.fadeIn ?? 0, onEnded } = {}) {
    const ctx = this._ensureContext();
    if (ctx.state !== 'running') {
      try { await ctx.resume(); } catch { /* negeer */ }
    }
    const buffer = await this.decode(cue);
    this._discard(cue.id); // verwijder bestaande voice zonder callback

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    const gain = ctx.createGain();
    source.connect(gain);
    gain.connect(this.masterGain);

    const now = ctx.currentTime;
    const target = clamp01(cue.volume ?? 1);
    const fi = Math.max(0, fadeIn);
    if (fi > 0) {
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, target), now + fi);
      gain.gain.setValueAtTime(target, now + fi);
    } else {
      gain.gain.setValueAtTime(target, now);
    }

    const voice = {
      cueId: cue.id, cue, source, gain, buffer,
      startedAt: now, offset, paused: false, ended: false, onEnded,
    };
    source.onended = () => {
      if (voice.ended) return; // al opgeruimd door stop/seek/herstart
      voice.ended = true;
      if (this.voices.get(cue.id) === voice) this.voices.delete(cue.id);
      // 'natural' = echt uitgespeeld (niet weggefade door Esc/verwijderen).
      if (onEnded) onEnded(cue, { natural: !voice.fading });
    };
    source.start(now, offset);
    this.voices.set(cue.id, voice);
    return voice;
  }

  // Huidige afspeelpositie in seconden (werkt tijdens spelen én gepauzeerd).
  position(cueId) {
    const v = this.voices.get(cueId);
    if (!v) return 0;
    if (v.paused) return v.offset;
    return Math.min(v.buffer.duration, v.offset + (this.ctx.currentTime - v.startedAt));
  }

  isPlaying(cueId) {
    const v = this.voices.get(cueId);
    return !!v && !v.paused;
  }
  isPaused(cueId) {
    const v = this.voices.get(cueId);
    return !!v && v.paused;
  }
  anyPlaying() {
    for (const v of this.voices.values()) if (!v.paused) return true;
    return false;
  }

  pause(cueId) {
    const v = this.voices.get(cueId);
    if (!v || v.paused) return;
    const pos = this.position(cueId);
    this._silence(v);
    // Vervang door een 'paused' placeholder die de positie onthoudt.
    this.voices.set(cueId, {
      cueId, cue: v.cue, buffer: v.buffer, offset: pos, paused: true,
      source: null, gain: null, ended: false, onEnded: v.onEnded,
    });
  }

  async resume(cueId) {
    const v = this.voices.get(cueId);
    if (!v || !v.paused) return;
    await this.play(v.cue, { offset: v.offset, fadeIn: 0, onEnded: v.onEnded });
  }

  // Afspelen/pauze omschakelen voor de afspeelbalk.
  async toggle(cue, { onEnded } = {}) {
    if (this.isPlaying(cue.id)) {
      this.pause(cue.id);
    } else if (this.isPaused(cue.id)) {
      await this.resume(cue.id);
    } else {
      await this.play(cue, { onEnded });
    }
  }

  // Spring naar `positionSec`. Tijdens spelen: herstart daar. Anders: onthoud als
  // gepauzeerde positie (zodat play daarvandaan verdergaat).
  async seek(cue, positionSec, { onEnded } = {}) {
    await this.prepare(cue);
    const dur = this.duration(cue.id);
    const pos = Math.max(0, Math.min(Math.max(0, dur - 0.02), positionSec));
    const v = this.voices.get(cue.id);
    if (v && !v.paused && v.source) {
      await this.play(cue, { offset: pos, fadeIn: 0, onEnded: v.onEnded || onEnded });
    } else {
      this.voices.set(cue.id, {
        cueId: cue.id, cue, buffer: this.buffers.get(cue.id), offset: pos, paused: true,
        source: null, gain: null, ended: false, onEnded: (v && v.onEnded) || onEnded,
      });
    }
  }

  // Fade één cue uit over `seconds` en verwijder daarna.
  fadeOutCue(cueId, seconds = 3) {
    const v = this.voices.get(cueId);
    if (!v) return;
    if (v.paused || !v.source) {
      this.voices.delete(cueId);
      return;
    }
    this._fadeAndStop(v, seconds);
  }

  // Kern-eis: fade ALLE cues uit (Esc).
  fadeOutAll(seconds = 3) {
    for (const cueId of [...this.voices.keys()]) this.fadeOutCue(cueId, seconds);
  }

  // Harde stop zonder fade (2× Esc).
  stopAll() {
    for (const v of this.voices.values()) this._silence(v);
    this.voices.clear();
  }

  _fadeAndStop(voice, seconds) {
    if (voice.ended) return;
    voice.fading = true; // markeer: dit einde is een fade-out, geen natuurlijk einde
    const now = this.ctx.currentTime;
    const fade = Math.max(0.01, seconds);
    const g = voice.gain.gain;
    const current = Math.max(0.0001, g.value);
    g.cancelScheduledValues(now);
    g.setValueAtTime(current, now);
    g.exponentialRampToValueAtTime(0.0001, now + fade);
    try {
      voice.source.stop(now + fade + 0.05); // onended ruimt de voice op
    } catch {
      /* al gestopt */
    }
  }

  // Stop een klinkende voice direct, zonder onEnded-callback.
  _silence(voice) {
    if (!voice || !voice.source) return;
    voice.ended = true;
    try {
      voice.source.onended = null;
      voice.source.stop();
    } catch {
      /* al gestopt */
    }
  }

  // Verwijder een bestaande voice (bij herstart/seek) zonder callback.
  _discard(cueId) {
    const v = this.voices.get(cueId);
    if (!v) return;
    this._silence(v);
    this.voices.delete(cueId);
  }
}

function clamp01(v) {
  if (Number.isNaN(v)) return 1;
  return Math.min(1, Math.max(0, v));
}
