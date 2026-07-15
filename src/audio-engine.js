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

    const gain = ctx.createGain();
    gain.connect(this.masterGain);

    const now = ctx.currentTime;
    const target = clamp01(cue.volume ?? 1);
    const fi = Math.max(0, fadeIn);
    if (fi > 0) {
      // Equal-power (sinus) fade-in: gelijkmatig hoorbaar opkomen, niet "eerst niks
      // en dan ineens veel" zoals bij een exponentiële ramp vanaf bijna nul.
      const steps = 48;
      const curve = new Float32Array(steps + 1);
      for (let i = 0; i <= steps; i++) {
        curve[i] = Math.sin((i / steps) * (Math.PI / 2)) * target;
      }
      gain.gain.setValueCurveAtTime(curve, now, fi);
    } else {
      gain.gain.setValueAtTime(target, now);
    }

    const { plays, infinite } = loopSpec(cue);
    const voice = {
      cueId: cue.id, cue, source: null, gain, buffer,
      startedAt: now, offset, paused: false, ended: false, fading: false,
      onEnded, playsLeft: plays, infinite,
    };
    this._startVoiceSource(voice, offset);
    this.voices.set(cue.id, voice);
    return voice;
  }

  // (Her)start de bronnode van een voice. Bij oneindige loop → source.loop (naadloos);
  // bij een eindig aantal → herstart op het natuurlijke einde tot het aantal op is.
  _startVoiceSource(voice, offset) {
    const ctx = this.ctx;
    const source = ctx.createBufferSource();
    source.buffer = voice.buffer;
    source.loop = voice.infinite; // alleen naadloos loopen bij oneindig
    source.connect(voice.gain);
    source.onended = () => {
      if (voice.ended) return; // al opgeruimd door stop/seek/herstart
      // Eindig loopen: nog beurten over en niet weggefade → volgende iteratie.
      if (!voice.fading && !voice.infinite && voice.playsLeft > 1) {
        voice.playsLeft -= 1;
        voice.startedAt = ctx.currentTime;
        voice.offset = 0;
        this._startVoiceSource(voice, 0);
        return;
      }
      voice.ended = true;
      if (this.voices.get(voice.cueId) === voice) this.voices.delete(voice.cueId);
      // 'natural' = echt uitgespeeld (niet weggefade door Esc/verwijderen).
      if (voice.onEnded) voice.onEnded(voice.cue, { natural: !voice.fading });
    };
    voice.source = source;
    source.start(ctx.currentTime, offset);
  }

  // Huidige afspeelpositie in seconden (werkt tijdens spelen én gepauzeerd).
  position(cueId) {
    const v = this.voices.get(cueId);
    if (!v) return 0;
    if (v.paused) return v.offset;
    const pos = v.offset + (this.ctx.currentTime - v.startedAt);
    if (v.infinite && v.buffer.duration) return pos % v.buffer.duration; // wrap bij loop
    return Math.min(v.buffer.duration, pos);
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

  // Fade één cue uit en verwijder daarna. Zonder `seconds` gebruikt hij de eigen
  // fade-uit-tijd van de cue.
  fadeOutCue(cueId, seconds) {
    const v = this.voices.get(cueId);
    if (!v) return;
    const fade = seconds != null ? seconds : Math.max(0, parseFloat(v.cue?.fadeOut) || 0);
    if (v.paused || !v.source) {
      this.voices.delete(cueId);
      return;
    }
    this._fadeAndStop(v, fade);
  }

  // Fade ALLE cues uit (Esc). Zonder `seconds`: elke cue over zijn eigen fade-uit.
  fadeOutAll(seconds) {
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

// Bepaal hoe vaak een cue speelt. Loop uit → 1×. Loop aan met getal N>0 → N×.
// Loop aan zonder (geldig) getal → oneindig (naadloos).
function loopSpec(cue) {
  if (!cue.loop) return { plays: 1, infinite: false };
  const n = parseInt(cue.loopCount, 10);
  if (Number.isFinite(n) && n > 0) return { plays: n, infinite: false };
  return { plays: Infinity, infinite: true };
}
