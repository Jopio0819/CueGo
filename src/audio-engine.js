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
    this.sinkId = null; // audio output device (null = default)
  }

  _ensureContext() {
  if (!this.ctx) {
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = 1;
    this.masterGain.connect(this.ctx.destination);
    // Pas de opgeslagen sinkId toe (als die bestaat en ondersteund wordt)
    if (this.sinkId && this.ctx.setSinkId) {
      this.ctx.setSinkId(this.sinkId).catch(() => {});
    }
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

  // Afspeelgebied [start, end] op basis van in-/uitpunt (in seconden).
  _region(cue) {
    const buf = this.buffers.get(cue.id);
    const dur = buf ? buf.duration : 0;
    let start = Math.max(0, parseFloat(cue.inPoint) || 0);
    let end = parseFloat(cue.outPoint);
    end = Number.isFinite(end) && end > 0 ? end : dur;
    if (dur) { start = Math.min(start, dur); end = Math.min(end, dur); }
    if (!(end > start)) { start = 0; end = dur; } // ongeldig → hele audio
    return { start, end, length: Math.max(0, end - start) };
  }

  // Effectieve speelduur (tussen in- en uitpunt). Vereist gedecodeerde buffer.
  playLength(cue) {
    return this._region(cue).length;
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

    const region = this._region(cue);
    const clampedOffset = Math.max(0, Math.min(offset, region.length));
    const { plays, infinite } = loopSpec(cue);
    const xf = cue.loop ? Math.max(0, parseFloat(cue.loopCrossfade) || 0) : 0;

    // Fade-uit aan het natuurlijke einde (indien ingesteld, en niet oneindig).
    const fo = Math.max(0, parseFloat(cue.fadeOut) || 0);
    if (cue.fadeOutAtEnd && fo > 0 && !infinite) {
      const step = xf > 0 ? region.length - Math.min(xf, region.length * 0.5) : region.length;
      const totalPlay = (plays - 1) * step + (region.length - clampedOffset);
      if (totalPlay > fo + Math.max(0, fadeIn) + 0.05) {
        gain.gain.setValueAtTime(target, now + totalPlay - fo);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + totalPlay);
      }
    }
    const voice = {
      cueId: cue.id, cue, source: null, sources: null, schedulerTimer: null, gain, buffer,
      startedAt: now, offset: clampedOffset,
      paused: false, ended: false, fading: false,
      onEnded, playsLeft: plays, infinite, crossfade: xf,
      regionStart: region.start, regionLen: region.length,
    };
    if (xf > 0 && region.length > 0.05) this._startCrossfadeLoop(voice, voice.offset);
    else this._startVoiceSource(voice, voice.offset);
    this.voices.set(cue.id, voice);
    return voice;
  }

  // Loop met crossfade: elke iteratie is een eigen bron met eigen fade, en de volgende
  // start `xf` seconden vóór het einde van de vorige → ze vloeien over.
  _startCrossfadeLoop(voice, firstOffset) {
    voice.sources = [];
    voice._xf = Math.max(0.02, Math.min(voice.crossfade, voice.regionLen * 0.5));
    voice._firstOffset = firstOffset;
    this._scheduleCrossIter(voice, this.ctx.currentTime + 0.03, true);
  }

  _scheduleCrossIter(voice, when, first) {
    if (voice.ended) return;
    const ctx = this.ctx;
    const xf = voice._xf;
    const offset = first ? voice._firstOffset : 0;
    const absStart = voice.regionStart + offset;
    const dur = voice.regionLen - offset;

    const src = ctx.createBufferSource();
    src.buffer = voice.buffer;
    const g = ctx.createGain();
    src.connect(g);
    g.connect(voice.gain);

    // Fade-in over xf, behalve de allereerste iteratie op offset 0 (die start vol;
    // de per-cue fade-in loopt al op de master-gain van de voice).
    if (first && offset === 0) {
      g.gain.setValueAtTime(1, when);
    } else {
      g.gain.setValueAtTime(0.0001, when);
      g.gain.exponentialRampToValueAtTime(1, when + xf);
    }
    const isLast = !voice.infinite && voice.playsLeft <= 1;
    if (!isLast) {
      g.gain.setValueAtTime(1, when + dur - xf);
      g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    }

    src.start(when, absStart, dur + 0.05);
    const entry = { src, g };
    voice.sources.push(entry);
    src.onended = () => {
      const i = voice.sources.indexOf(entry);
      if (i >= 0) voice.sources.splice(i, 1);
      if (voice.ended) return;
      const done = (isLast && !voice.fading) || (voice.fading && voice.sources.length === 0);
      if (done) {
        voice.ended = true;
        if (this.voices.get(voice.cueId) === voice) this.voices.delete(voice.cueId);
        if (voice.onEnded) voice.onEnded(voice.cue, { natural: !voice.fading });
      }
    };

    if (!voice.infinite) voice.playsLeft -= 1;
    const more = voice.infinite || voice.playsLeft > 0;
    if (more) {
      const nextWhen = when + dur - xf;
      const delayMs = Math.max(0, (nextWhen - ctx.currentTime) * 1000 - 80);
      voice.schedulerTimer = setTimeout(() => this._scheduleCrossIter(voice, nextWhen, false), delayMs);
    }
  }

  // (Her)start de bronnode, spelend tussen in- en uitpunt. `regionOffset` is de positie
  // binnen dat gebied. Oneindige loop → naadloos loopen binnen het gebied; eindig aantal
  // → herstart op het natuurlijke einde tot het aantal op is.
  _startVoiceSource(voice, regionOffset) {
    const ctx = this.ctx;
    const source = ctx.createBufferSource();
    source.buffer = voice.buffer;
    const absStart = voice.regionStart + regionOffset;
    const remaining = Math.max(0.01, voice.regionLen - regionOffset);
    if (voice.infinite) {
      source.loop = true;
      source.loopStart = voice.regionStart;
      source.loopEnd = voice.regionStart + voice.regionLen;
    }
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
    if (voice.infinite) source.start(ctx.currentTime, absStart);
    else source.start(ctx.currentTime, absStart, remaining);
  }
async setSinkId(deviceId) {
  this.sinkId = deviceId;
  const ctx = this.ctx;
  if (!ctx) return; // context nog niet aangemaakt, wordt toegepast bij creatie
  if (ctx.setSinkId) {
    try {
      await ctx.setSinkId(deviceId);
      return true;
    } catch (err) {
      console.warn('setSinkId mislukt:', err);
      throw err;
    }
  } else {
    throw new Error('setSinkId wordt niet ondersteund in deze browser.');
  }
}
  // Huidige afspeelpositie binnen het afspeelgebied (0..lengte), tijdens spelen én gepauzeerd.
  position(cueId) {
    const v = this.voices.get(cueId);
    if (!v) return 0;
    if (v.paused) return v.offset;
    const len = v.regionLen || (v.buffer ? v.buffer.duration : 0);
    const pos = v.offset + (this.ctx.currentTime - v.startedAt);
    if ((v.infinite || v.crossfade) && len) return pos % len; // wrap bij loop
    return Math.min(len, pos);
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
    // Vervang door een 'paused' placeholder die de positie (binnen het gebied) onthoudt.
    this.voices.set(cueId, {
      cueId, cue: v.cue, buffer: v.buffer, offset: pos, paused: true,
      source: null, gain: null, ended: false, onEnded: v.onEnded,
      regionStart: v.regionStart, regionLen: v.regionLen, infinite: false,
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
    const region = this._region(cue); // positie is relatief aan het afspeelgebied
    const pos = Math.max(0, Math.min(Math.max(0, region.length - 0.02), positionSec));
    const v = this.voices.get(cue.id);
    if (v && !v.paused && v.source) {
      await this.play(cue, { offset: pos, fadeIn: 0, onEnded: v.onEnded || onEnded });
    } else {
      this.voices.set(cue.id, {
        cueId: cue.id, cue, buffer: this.buffers.get(cue.id), offset: pos, paused: true,
        source: null, gain: null, ended: false, onEnded: (v && v.onEnded) || onEnded,
        regionStart: region.start, regionLen: region.length, infinite: false,
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

  // Alle bronnen van een voice (enkel of crossfade-meervoudig).
  _voiceSources(voice) {
    if (voice.sources) return voice.sources.map((s) => s.src);
    return voice.source ? [voice.source] : [];
  }

  _fadeAndStop(voice, seconds) {
    if (voice.ended) return;
    voice.fading = true; // markeer: dit einde is een fade-out, geen natuurlijk einde
    if (voice.schedulerTimer) { clearTimeout(voice.schedulerTimer); voice.schedulerTimer = null; }
    const now = this.ctx.currentTime;
    const fade = Math.max(0.01, seconds);
    const g = voice.gain.gain;
    const current = Math.max(0.0001, g.value);
    g.cancelScheduledValues(now);
    g.setValueAtTime(current, now);
    g.exponentialRampToValueAtTime(0.0001, now + fade);
    const stopAt = now + fade + 0.05;
    for (const s of this._voiceSources(voice)) {
      try { s.stop(stopAt); } catch { /* al gestopt */ }
    }
  }

  // Stop een klinkende voice direct, zonder onEnded-callback.
  _silence(voice) {
    if (!voice) return;
    voice.ended = true;
    if (voice.schedulerTimer) { clearTimeout(voice.schedulerTimer); voice.schedulerTimer = null; }
    for (const s of this._voiceSources(voice)) {
      try { s.onended = null; s.stop(); } catch { /* al gestopt */ }
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
