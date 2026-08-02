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
const freshMidiOut = () => ({ deviceId: '', type: 'noteon', channel: 1, data1: 60, data2: 100 });
const freshOscOut = () => ({ host: '127.0.0.1', port: 53000, address: '', args: '' });
const freshDmx = () => ({ protocol: 'artnet', host: '', universe: 1, fadeTime: 0, channels: [] });

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
  // --- nesting (groepen) ---
  // parentId koppelt een cue aan de groep waar 'ie in zit. De nesting leeft in de
  // platte lijst: kinderen staan direct ná hun groep, in volgorde. Zo blijven
  // selectie, opslag en de meeste lijstlogica gewoon plat werken.
  { key: 'parentId', def: '' },
  { key: 'mode', def: 'simultaneous' }, // group: 'simultaneous' | 'sequential'
  { key: 'collapsed', def: false }, // group ingeklapt in de lijst?
  // --- cart / hotkey-soundboard ---
  { key: 'cartSlot', def: -1 }, // plek in het cart-raster; -1 = niet in de cart
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

  // --- Nesting (groepen) ----------------------------------------------------
  // De boom leeft in de platte lijst: een cue's `parentId` wijst naar z'n groep,
  // en nakomelingen staan altijd direct (aaneengesloten) ná die groep. Deze
  // helpers lezen die structuur; alle mutaties bewaren de aaneengeslotenheid.

  // Nesting-diepte (0 = bovenste niveau). Met lus-bescherming.
  depthOf(cue) {
    let d = 0, c = cue; const seen = new Set();
    while (c && c.parentId && !seen.has(c.id)) { seen.add(c.id); c = this.getById(c.parentId); if (c) d++; else break; }
    return d;
  }

  // Is `cue` een (klein)kind van `ancestorId`?
  isDescendantOf(cue, ancestorId) {
    let c = cue; const seen = new Set();
    while (c && c.parentId && !seen.has(c.id)) {
      if (c.parentId === ancestorId) return true;
      seen.add(c.id); c = this.getById(c.parentId);
    }
    return false;
  }

  // Directe kinderen van een groep, in lijstvolgorde.
  childrenOf(id) {
    return this.cues.filter((c) => c.parentId === id);
  }

  // Het aaneengesloten bereik [start, end) van een cue + al z'n nakomelingen.
  subtreeRange(id) {
    const start = this.cues.findIndex((c) => c.id === id);
    if (start === -1) return null;
    let end = start + 1;
    while (end < this.cues.length && this.isDescendantOf(this.cues[end], id)) end++;
    return { start, end };
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

  // Schuif de selectie 1 op na een GO (QLab-gedrag). Een groep-cue slaat z'n hele
  // subtree over (de kinderen zijn immers al door de groep afgevuurd). Clamp op het
  // laatste item.
  advance() {
    const cur = this.selected;
    if (!cur) return;
    const r = this.subtreeRange(cur.id);
    const target = r ? r.end : this.selectedIndex + 1;
    if (target <= this.cues.length - 1) this.selectedIndex = target;
  }

  // Verwijder een cue én z'n hele subtree (een groep neemt z'n kinderen mee).
  remove(id) {
    const r = this.subtreeRange(id);
    if (!r) return;
    this.cues.splice(r.start, r.end - r.start);
    if (this.cues.length === 0) this.selectedIndex = -1;
    else if (this.selectedIndex >= this.cues.length) this.selectedIndex = this.cues.length - 1;
    else if (this.selectedIndex > r.start) this.selectedIndex = Math.max(r.start, this.selectedIndex - (r.end - r.start));
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

  // Verplaats cue `dragId` (mét z'n hele subtree) naar `targetId`. Varianten:
  //  - intoGroup: word het eerste kind van de doel-groep;
  //  - after=false: kom vóór het doel te staan, als broer (zelfde ouder);
  //  - after=true: kom ná de hele subtree van het doel te staan;
  //  - targetId == null: naar het einde, op het bovenste niveau.
  reorder(dragId, targetId, after = false, intoGroup = false) {
    const range = this.subtreeRange(dragId);
    if (!range) return;
    const dragged = this.cues[range.start];
    // Nooit een groep in z'n eigen (klein)kind laten vallen — dat zou een lus maken.
    if (targetId && (targetId === dragId || this.isDescendantOf(this.getById(targetId), dragId))) return;

    const selectedId = this.selected?.id;
    const block = this.cues.splice(range.start, range.end - range.start);

    // Nieuwe ouder van de gesleepte cue (de nakomelingen houden hun eigen parentId).
    if (intoGroup && targetId) dragged.parentId = targetId;
    else if (targetId) dragged.parentId = this.getById(targetId)?.parentId || '';
    else dragged.parentId = '';

    // Invoegpositie in de resterende lijst.
    let to;
    if (targetId == null) {
      to = this.cues.length;
    } else if (intoGroup) {
      to = this.cues.findIndex((c) => c.id === targetId) + 1; // net ná de groep-header
    } else {
      const ti = this.cues.findIndex((c) => c.id === targetId);
      if (ti === -1) to = this.cues.length;
      else if (after) { const tr = this.subtreeRange(targetId); to = tr ? tr.end : ti + 1; }
      else to = ti;
    }
    this.cues.splice(to, 0, ...block);

    if (selectedId) this.selectedIndex = this.cues.findIndex((c) => c.id === selectedId);
  }

  // Wikkel een set cues in een nieuwe groep: de groep komt op de plek van de
  // eerste geselecteerde cue, en die cues worden er kinderen van (in lijstvolgorde,
  // mét hun eigen subtrees). Geeft de groep terug.
  groupCues(ids, group) {
    const set = new Set(ids);
    // Zit een voorouder óók in de selectie, dan neemt die deze cue al mee — dus
    // alleen de buitenste laag van de selectie zelfstandig verplaatsen.
    const ancestorSelected = (c) => {
      let p = this.getById(c.parentId); const seen = new Set();
      while (p && !seen.has(p.id)) { if (set.has(p.id)) return true; seen.add(p.id); p = this.getById(p.parentId); }
      return false;
    };
    const members = this.cues.filter((c) => set.has(c.id) && !ancestorSelected(c));
    if (!members.length) return null;

    const firstIdx = this.cues.findIndex((c) => c.id === members[0].id);
    const parentOfFirst = members[0].parentId || '';

    // Verzamel de subtree-blokken (in lijstvolgorde) en verwijder ze daarna van
    // achteren naar voren, zodat indices niet verschuiven.
    const blocks = members.map((m) => { const r = this.subtreeRange(m.id); return this.cues.slice(r.start, r.end); });
    const ranges = members.map((m) => this.subtreeRange(m.id)).sort((a, b) => b.start - a.start);
    for (const r of ranges) this.cues.splice(r.start, r.end - r.start);

    group.parentId = parentOfFirst;
    for (const b of blocks) b[0].parentId = group.id; // top van elk blok wordt kind
    const insertAt = Math.min(firstIdx, this.cues.length);
    this.cues.splice(insertAt, 0, group, ...blocks.flat());
    return group;
  }
}
