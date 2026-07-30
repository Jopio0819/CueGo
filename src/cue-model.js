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

function compareByTitleNumber(a, b) {
  const na = titleNumber(a.name);
  const nb = titleNumber(b.name);
  if (na !== nb) return na - nb;
  return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
}

// De cue-soorten. 'audio' is de bestaande speler; de rest zijn besturings-cues
// die geen eigen geluid maken maar iets anders doen bij GO. 'light' (DMX) is
// gereserveerd — het veld bestaat al zodat opslag/serialisatie er klaar voor is,
// maar de UI en het gedrag komen in een latere fase.
export const CUE_TYPES = ['audio', 'group', 'fade', 'stop', 'wait', 'midi', 'osc', 'light'];

// Fabrieksfuncties voor de niet-primitieve defaults, zodat elke cue z'n eigen
// verse array/object krijgt (nooit een gedeelde referentie).
const freshEq = () => [0, 0, 0, 0, 0, 0];
const freshChildren = () => [];
const freshMidiOut = () => ({ deviceId: '', messages: [] });
const freshOscOut = () => ({ host: '', port: 53000, address: '', args: '' });
const freshDmx = () => ({ universe: 1, protocol: 'artnet', fadeTime: 0, channels: [] });

// DE plek waar de veldenlijst van een cue staat — één keer, niet vier keer.
// createCue, cueToMeta, metaToCue, de opslag-cache (storage.js) en het
// projectbestand (project.js) lopen hier allemaal overheen. Een nieuw veld
// toevoegen = hier één regel. `def` is een waarde of een fabrieksfunctie;
// `norm` normaliseert bij het inlezen (verdedigt tegen oude/rommelige data).
export const CUE_FIELDS = [
  // --- gemeenschappelijk (elk cue-type) ---
  { key: 'type', def: 'audio', norm: (v) => (CUE_TYPES.includes(v) ? v : 'audio') },
  { key: 'number', def: '' },
  { key: 'name', def: '' },
  { key: 'preWait', def: 0 }, // seconden wachten vóór de cue z'n actie doet
  { key: 'autoContinue', def: false }, // na afloop automatisch de volgende cue starten
  { key: 'autoContinueDelay', def: 1 },
  { key: 'autoFollow', def: false }, // volgende cue starten zodra deze klaar is
  { key: 'midiTrigger', def: '' }, // MIDI-input die deze cue start (bv. 'note:0:60')
  // --- audio ---
  { key: 'fadeIn', def: 0 },
  { key: 'fadeOut', def: 3 },
  { key: 'fadeOutAtEnd', def: false }, // fade-uit ook aan het natuurlijke einde
  { key: 'volume', def: 1 }, // 0..1
  { key: 'loop', def: false },
  { key: 'loopCount', def: '' }, // aantal keer; leeg = oneindig
  { key: 'loopCrossfade', def: 0 }, // crossfade tussen loop-iteraties (s)
  { key: 'inPoint', def: 0 }, // startpunt (s)
  { key: 'outPoint', def: '' }, // eindpunt (s); leeg = einde audio
  { key: 'eq', def: freshEq, norm: (v) => (Array.isArray(v) && v.length === 6 ? v.map(Number) : freshEq()) },
  // --- wait ---
  { key: 'waitTime', def: 3 }, // seconden wachten (wait-cue)
  // --- stop / fade (doel-cue) ---
  { key: 'target', def: '' }, // doel-cue-id, of 'all'
  { key: 'stopFade', def: 0 }, // uitfade-tijd bij stop (0 = hard)
  { key: 'fadeTo', def: 0 }, // doelvolume 0..1 (fade-cue)
  { key: 'fadeTime', def: 3 }, // duur van de fade (s)
  { key: 'stopAfter', def: false }, // doel-cue stoppen na de fade
  // --- group ---
  { key: 'mode', def: 'simultaneous' }, // 'simultaneous' | 'sequential'
  { key: 'children', def: freshChildren, norm: (v) => (Array.isArray(v) ? v.slice() : []) },
  // --- midi-out ---
  { key: 'midiOut', def: freshMidiOut },
  // --- osc-out ---
  { key: 'oscOut', def: freshOscOut },
  // --- light / DMX (gereserveerd voor later) ---
  { key: 'dmx', def: freshDmx },
];

function defaultFor(f) {
  return typeof f.def === 'function' ? f.def() : f.def;
}

// Diepe kopie voor plain data (arrays/objecten), zodat cues nooit een array of
// object delen. Onze cue-data is puur JSON, dus dit volstaat.
function cloneValue(v) {
  if (Array.isArray(v)) return v.map(cloneValue);
  if (v && typeof v === 'object') return JSON.parse(JSON.stringify(v));
  return v;
}

// Bouw een cue met alle velden op hun default, overschreven door `partial`.
// `file` is runtime-only (niet in CUE_FIELDS) en gaat mee als het meekomt.
export function baseCue(partial = {}) {
  const cue = { id: partial.id || uuid() };
  for (const f of CUE_FIELDS) {
    cue[f.key] = f.key in partial ? partial[f.key] : defaultFor(f);
  }
  if ('file' in partial) cue.file = partial.file;
  return cue;
}

export function createCue(file) {
  return baseCue({ type: 'audio', file, name: file.name.replace(/\.[^.]+$/, '') });
}

// Cue → platte metadata (voor opslag en voor de gedeelde show op de server).
// fileName/fileType gaan mee zodat een andere client het bestand kan herbouwen.
export function cueToMeta(c) {
  const m = { id: c.id };
  for (const f of CUE_FIELDS) {
    m[f.key] = cloneValue(c[f.key] === undefined ? defaultFor(f) : c[f.key]);
  }
  m.fileName = c.file?.name || '';
  m.fileType = c.file?.type || '';
  return m;
}

// Platte metadata (+ audiobestand) → cue. Ontbrekende velden krijgen hun default;
// `norm` schoont rommelige waarden op. `file` is null voor niet-audio cues.
export function metaToCue(m, file) {
  const cue = { id: m.id || uuid(), file };
  for (const f of CUE_FIELDS) {
    if (f.key in m && m[f.key] !== undefined) {
      cue[f.key] = f.norm ? f.norm(m[f.key]) : cloneValue(m[f.key]);
    } else {
      cue[f.key] = defaultFor(f);
    }
  }
  if (!cue.name) cue.name = (file?.name || '').replace(/\.[^.]+$/, '');
  return cue;
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

  // Sorteer de hele lijst op het nummer in de titel (dan alfanumeriek).
  sortByTitleNumber() {
    const selId = this.selected?.id;
    this.cues.sort(compareByTitleNumber);
    if (selId) this.selectedIndex = this.cues.findIndex((c) => c.id === selId);
  }

  // Sorteer alleen de nieuw toegevoegde cues (vanaf fromIndex) onderaan, zodat de
  // bestaande volgorde ongemoeid blijft. Gebruikt bij importeren.
  sortTailByTitleNumber(fromIndex) {
    if (fromIndex >= this.cues.length) return;
    const selId = this.selected?.id;
    const head = this.cues.slice(0, fromIndex);
    const tail = this.cues.slice(fromIndex).sort(compareByTitleNumber);
    this.cues = head.concat(tail);
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
