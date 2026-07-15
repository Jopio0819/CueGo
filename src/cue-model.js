// cue-model.js — datamodel voor cues en de cue-lijst.

function uuid() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  // Fallback voor niet-secure contexts.
  return 'cue-' + Math.abs(Date.now() ^ (performance.now() * 1000)).toString(36) + '-' + Math.floor(performance.now() % 100000).toString(36);
}

export const AUDIO_EXTENSIONS = ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'oga', 'flac', 'opus', 'aiff', 'aif'];

export function isAudioFile(file) {
  if (file.type && file.type.startsWith('audio/')) return true;
  const name = (file.name || '').toLowerCase();
  return AUDIO_EXTENSIONS.some((ext) => name.endsWith(`.${ext}`));
}

// Eerste getal in een titel (bv. "03 - Intro" → 3). Geen getal → Infinity (achteraan).
export function titleNumber(name) {
  const m = String(name).match(/\d+/);
  return m ? parseInt(m[0], 10) : Infinity;
}

export function createCue(file) {
  return {
    id: uuid(),
    number: '', // eigen cue-nummer (leeg = toon lijstpositie)
    name: file.name.replace(/\.[^.]+$/, ''),
    file,
    fadeIn: 0, // seconden
    fadeOut: 3, // seconden (per-cue default)
    volume: 1, // 0..1
  };
}

export class CueList {
  constructor() {
    this.cues = [];
    this.selectedIndex = -1;
  }

  add(file) {
    const cue = createCue(file);
    this.cues.push(cue);
    if (this.selectedIndex === -1) this.selectedIndex = 0;
    return cue;
  }

  // Voeg een reeds opgebouwde cue toe (bv. bij herladen uit opslag).
  addExisting(cue) {
    this.cues.push(cue);
    if (this.selectedIndex === -1) this.selectedIndex = 0;
    return cue;
  }

  get selected() {
    return this.cues[this.selectedIndex] || null;
  }

  getById(id) {
    return this.cues.find((c) => c.id === id) || null;
  }

  select(index) {
    if (index < 0 || index >= this.cues.length) return;
    this.selectedIndex = index;
  }

  selectById(id) {
    const idx = this.cues.findIndex((c) => c.id === id);
    if (idx !== -1) this.selectedIndex = idx;
  }

  moveSelection(delta) {
    if (this.cues.length === 0) return;
    let idx = this.selectedIndex + delta;
    idx = Math.max(0, Math.min(this.cues.length - 1, idx));
    this.selectedIndex = idx;
  }

  // Schuif de selectie 1 op na een GO (QLab-gedrag). Clamp op het laatste item.
  advance() {
    if (this.selectedIndex < this.cues.length - 1) this.selectedIndex += 1;
  }

  remove(id) {
    const idx = this.cues.findIndex((c) => c.id === id);
    if (idx === -1) return;
    this.cues.splice(idx, 1);
    if (this.cues.length === 0) {
      this.selectedIndex = -1;
    } else if (this.selectedIndex >= this.cues.length) {
      this.selectedIndex = this.cues.length - 1;
    }
  }

  move(id, delta) {
    const idx = this.cues.findIndex((c) => c.id === id);
    if (idx === -1) return;
    const newIdx = Math.max(0, Math.min(this.cues.length - 1, idx + delta));
    if (newIdx === idx) return;
    const [cue] = this.cues.splice(idx, 1);
    this.cues.splice(newIdx, 0, cue);
    this.selectedIndex = newIdx;
  }

  // Sorteer op het nummer in de titel (dan alfanumeriek). Gebruikt bij importeren.
  sortByTitleNumber() {
    const selId = this.selected?.id;
    this.cues.sort((a, b) => {
      const na = titleNumber(a.name);
      const nb = titleNumber(b.name);
      if (na !== nb) return na - nb;
      return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
    });
    if (selId) this.selectedIndex = this.cues.findIndex((c) => c.id === selId);
  }

  // Verplaats cue `dragId` naar de positie vóór `targetId` (of naar het einde als
  // targetId null is). Gebruikt bij slepen om te herordenen.
  reorder(dragId, targetId, after = false) {
    const from = this.cues.findIndex((c) => c.id === dragId);
    if (from === -1) return;
    const selectedId = this.selected?.id;
    const [cue] = this.cues.splice(from, 1);

    let to;
    if (targetId == null) {
      to = this.cues.length;
    } else {
      to = this.cues.findIndex((c) => c.id === targetId);
      if (to === -1) to = this.cues.length;
      else if (after) to += 1;
    }
    this.cues.splice(to, 0, cue);

    // Houd dezelfde cue geselecteerd na het herordenen.
    if (selectedId) this.selectedIndex = this.cues.findIndex((c) => c.id === selectedId);
  }
}
