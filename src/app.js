// app.js — UI, toetsenbord, bestanden inladen en rendering voor de cue-player.
import { AudioEngine } from './audio-engine.js';
import { CueList, isAudioFile } from './cue-model.js';
import { saveAudio, loadAudio, deleteAudio, saveMeta, loadMeta } from './storage.js';
import { exportProject, importProject } from './project.js';

const engine = new AudioEngine();
const cues = new CueList();

// Meervoudige selectie (voor shift-selecteren + samen verwijderen).
const selection = new Set(); // cue-ids
let anchorIndex = -1;

// Instellingen (persist in localStorage).
const SETTINGS_KEY = 'webqlab.settings.v1';
const defaultSettings = { defaultFadeIn: 0, defaultFadeOut: 3, singleCueMode: false, blockBrowserKeys: true, inspectorHidden: false, saveKeybindsWithProject: false };
const _loadedSettings = loadSettings();
const settings = { ...defaultSettings, ..._loadedSettings };
// Migratie: oude 'escFade'-instelling → 'defaultFadeOut'.
if (_loadedSettings.escFade != null && _loadedSettings.defaultFadeOut == null) settings.defaultFadeOut = _loadedSettings.escFade;
delete settings.escFade;

function loadSettings() {
  try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; } catch { return {}; }
}
function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* negeer */ }
}

// Sneltoetsen — bewerkbaar, met presets. Waarde is een KeyboardEvent.key ('' = uit).
const KEYBINDS_KEY = 'webqlab.keybinds.v1';
const KEY_ACTIONS = [
  { id: 'go', label: 'GO — speel + selecteer volgende' },
  { id: 'playPause', label: 'Afspelen / pauze (huidige)' },
  { id: 'selectUp', label: 'Selecteer omhoog' },
  { id: 'selectDown', label: 'Selecteer omlaag' },
  { id: 'selectNext', label: 'Selecteer volgende (niet spelen)' },
  { id: 'fadeInGo', label: 'Fade-in starten (transition)' },
  { id: 'fadeOut', label: 'Fade uit (2× = direct stop)' },
  { id: 'delete', label: 'Verwijder selectie' },
  { id: 'fullscreen', label: 'Volledig scherm' },
];
const KEY_PRESETS = {
  default: { go: ' ', playPause: '', selectUp: 'ArrowUp', selectDown: 'ArrowDown', selectNext: '', fadeInGo: 'i', fadeOut: 'Escape', delete: 'Backspace', fullscreen: 'f' },
  vlc: { go: 'Enter', playPause: ' ', selectUp: 'ArrowUp', selectDown: 'ArrowDown', selectNext: '', fadeInGo: 'i', fadeOut: 'Escape', delete: 'Backspace', fullscreen: 'f' },
};
const keybinds = { ...KEY_PRESETS.default, ...loadKeybinds() };

function loadKeybinds() {
  try { return JSON.parse(localStorage.getItem(KEYBINDS_KEY)) || {}; } catch { return {}; }
}
function saveKeybinds() {
  try { localStorage.setItem(KEYBINDS_KEY, JSON.stringify(keybinds)); } catch { /* negeer */ }
}
function normKey(k) { return typeof k === 'string' && k.length === 1 ? k.toLowerCase() : k; }
function actionForKey(key) {
  const k = normKey(key);
  for (const a of KEY_ACTIONS) {
    if (keybinds[a.id] && normKey(keybinds[a.id]) === k) return a.id;
  }
  return null;
}

// DOM refs
const $ = (id) => document.getElementById(id);
const cueBody = $('cueBody');
const cueListWrap = $('cueListWrap');
const inspector = $('inspector');
const dropLine = $('dropLine');
const playPauseBtn = $('playPauseBtn');
const seekEl = $('seek');
const tpCurrent = $('tpCurrent');
const tpDuration = $('tpDuration');
const tpName = $('tpName');
const modeBadge = $('modeBadge');
const settingsModal = $('settingsModal');
const previewBtn = $('previewBtn');
const previewSeek = $('previewSeek');
const previewCur = $('previewCur');
const previewDur = $('previewDur');

// --- Rendering -------------------------------------------------------------

function render() {
  cueBody.innerHTML = '';
  cueListWrap.classList.toggle('has-cues', cues.cues.length > 0);

  cues.cues.forEach((cue, i) => {
    const tr = document.createElement('tr');
    tr.dataset.id = cue.id;
    tr.draggable = !locked;
    if (selection.has(cue.id)) tr.classList.add('selected');
    if (engine.isPlaying(cue.id)) tr.classList.add('playing');
    else if (engine.isPaused(cue.id)) tr.classList.add('paused');

    tr.innerHTML = `
      <td class="col-num">${cue.number ? escapeHtml(cue.number) : i + 1}</td>
      <td class="col-status"></td>
      <td class="col-name">${escapeHtml(cue.name)}${cue.loop ? ` <span class="loop-badge">⟳${escapeHtml(cue.loopCount || '∞')}</span>` : ''}${cue.autoContinue ? ' <span class="loop-badge" title="Auto-doorgaan">↳</span>' : ''}</td>
      <td class="col-time">${fmt(cue.fadeIn)}s</td>
      <td class="col-time">${fmt(cue.fadeOut)}s</td>
      <td class="col-vol">${Math.round(cue.volume * 100)}%</td>
      <td class="col-progress"><div class="progress-track"><div class="progress-fill" data-fill="${cue.id}"></div></div></td>
    `;

    tr.addEventListener('click', (e) => selectRow(cue.id, i, e));
    tr.addEventListener('dblclick', () => {
      selectOnly(cue.id, i);
      playCue(cue); // dubbelklik = starten
    });
    // Dubbelklik op het #-vakje = nummer direct bewerken (niet starten).
    const numCell = tr.querySelector('.col-num');
    numCell.addEventListener('dblclick', (e) => { e.stopPropagation(); if (!locked) startInlineNumberEdit(numCell, cue); });
    bindRowDrag(tr, cue.id);
    cueBody.appendChild(tr);
  });

  syncTransport();
}

function startInlineNumberEdit(cell, cue) {
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'num-edit';
  input.value = cue.number || '';
  cell.textContent = '';
  cell.appendChild(input);
  input.focus();
  input.select();
  let done = false;
  const finish = (save) => {
    if (done) return;
    done = true;
    if (save) { cue.number = input.value.trim(); persist(); }
    render();
    syncInspector();
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation(); // globale sneltoetsen niet triggeren tijdens typen
    if (e.key === 'Enter') finish(true);
    else if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
}

function fmt(n) { return Number.isInteger(n) ? String(n) : n.toFixed(1); }
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// --- Selectie --------------------------------------------------------------

function selectOnly(id, index) {
  selection.clear();
  selection.add(id);
  cues.selectById(id);
  anchorIndex = index;
}

function selectRow(id, index, e) {
  if (e.shiftKey && anchorIndex !== -1) {
    const [a, b] = [anchorIndex, index].sort((x, y) => x - y);
    selection.clear();
    for (let k = a; k <= b; k++) selection.add(cues.cues[k].id);
    cues.selectedIndex = index;
  } else if (e.metaKey || e.ctrlKey) {
    if (selection.has(id)) selection.delete(id);
    else selection.add(id);
    cues.selectById(id);
    anchorIndex = index;
  } else {
    selectOnly(id, index);
  }
  render();
  syncInspector();
}

function moveSel(delta, extend) {
  if (cues.cues.length === 0) return;
  cues.moveSelection(delta);
  const idx = cues.selectedIndex;
  if (extend && anchorIndex !== -1) {
    const [a, b] = [anchorIndex, idx].sort((x, y) => x - y);
    selection.clear();
    for (let k = a; k <= b; k++) selection.add(cues.cues[k].id);
  } else {
    selection.clear();
    if (cues.selected) selection.add(cues.selected.id);
    anchorIndex = idx;
  }
  render();
  syncInspector();
}

// --- Inspector -------------------------------------------------------------

function syncInspector() {
  const cue = cues.selected;
  if (!cue) { inspector.hidden = true; return; }
  inspector.hidden = false;
  $('insNumber').value = cue.number || '';
  $('insName').value = cue.name;
  $('insFadeIn').value = cue.fadeIn;
  $('insFadeOut').value = cue.fadeOut;
  $('insFadeOutEnd').checked = !!cue.fadeOutAtEnd;
  $('insVolume').value = cue.volume;
  $('insVolumeVal').textContent = `${Math.round(cue.volume * 100)}%`;
  $('insLoop').checked = !!cue.loop;
  $('insLoopCount').value = cue.loopCount || '';
  $('insLoopCrossfade').value = cue.loopCrossfade || '';
  $('loopCountField').hidden = !cue.loop;
  $('loopCrossfadeField').hidden = !cue.loop;
  $('insInPoint').value = cue.inPoint || '';
  $('insOutPoint').value = cue.outPoint || '';
  $('insAutoContinue').checked = !!cue.autoContinue;
  $('insAutoDelay').value = cue.autoContinueDelay ?? 1;
  $('autoContinueField').hidden = !cue.autoContinue;
  showInspectorDuration(cue);
  syncPreviewBar();
}

// Toon de audioduur in seconden (decodeert op de achtergrond als 'ie nog onbekend is).
function showInspectorDuration(cue) {
  const el = $('insDuration');
  const dur = engine.duration(cue.id);
  if (dur) {
    el.textContent = `${dur.toFixed(1)} s`;
    return;
  }
  el.textContent = '…';
  engine.prepare(cue)
    .then(() => { if (cues.selected === cue) el.textContent = `${engine.duration(cue.id).toFixed(1)} s`; })
    .catch(() => { if (cues.selected === cue) el.textContent = '—'; });
}

let dirty = false; // niet-opgeslagen wijzigingen sinds laatste opslaan/openen/nieuw
const PROJECT_NAME_KEY = 'webqlab.projectName';
let projectName = localStorage.getItem(PROJECT_NAME_KEY) || 'Naamloos';
function persist() { saveMeta(cues.cues); dirty = true; }

function setProjectName(name) {
  projectName = (name || '').trim() || 'Naamloos';
  localStorage.setItem(PROJECT_NAME_KEY, projectName);
  updateProjectTitle();
}
function updateProjectTitle() {
  const el = $('projectTitle');
  if (el.getAttribute('contenteditable') !== 'true') el.textContent = projectName;
}

function bindProjectTitle() {
  const el = $('projectTitle');
  const commit = (save) => {
    if (el.getAttribute('contenteditable') !== 'true') return;
    el.setAttribute('contenteditable', 'false');
    if (save) setProjectName(el.textContent);
    else el.textContent = projectName;
    el.blur();
  };
  el.addEventListener('click', () => {
    if (locked || el.getAttribute('contenteditable') === 'true') return;
    el.setAttribute('contenteditable', 'true');
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  });
  el.addEventListener('keydown', (e) => {
    e.stopPropagation(); // globale sneltoetsen niet triggeren tijdens typen
    if (e.key === 'Enter') { e.preventDefault(); commit(true); }
    else if (e.key === 'Escape') { e.preventDefault(); commit(false); }
  });
  el.addEventListener('blur', () => commit(true));
}

// Pas fn toe op elke geselecteerde cue (of op de primaire als er niets in de set staat).
function applyToSelected(fn) {
  const ids = selection.size ? [...selection] : (cues.selected ? [cues.selected.id] : []);
  for (const id of ids) { const c = cues.getById(id); if (c) fn(c); }
}

// Custom bevestigings-dialog (in plaats van window.confirm). Geeft een Promise<boolean>.
function customConfirm(message, { title = 'Bevestigen', okLabel = 'Bevestigen' } = {}) {
  const modal = $('confirmModal');
  $('confirmAlt').hidden = true; // 3e knop hoort niet bij een gewone bevestiging
  $('confirmCancel').textContent = 'Annuleren';
  $('confirmTitle').textContent = title;
  $('confirmMessage').textContent = message;
  $('confirmOk').textContent = okLabel;
  modal.hidden = false;
  void modal.offsetWidth; // forceer reflow → fade/scale-in
  modal.classList.add('open');

  return new Promise((resolve) => {
    const finish = (result) => {
      window.removeEventListener('keydown', onKey, true);
      $('confirmOk').removeEventListener('click', onOk);
      modal.querySelectorAll('[data-confirm-cancel]').forEach((el) => el.removeEventListener('click', onCancel));
      modal.classList.remove('open');
      setTimeout(() => { modal.hidden = true; }, 200);
      resolve(result);
    };
    const onOk = () => finish(true);
    const onCancel = () => finish(false);
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onCancel(); }
      else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); onOk(); }
    };
    $('confirmOk').addEventListener('click', onOk);
    modal.querySelectorAll('[data-confirm-cancel]').forEach((el) => el.addEventListener('click', onCancel));
    window.addEventListener('keydown', onKey, true); // capture: onderschep vóór globale sneltoetsen
    $('confirmOk').focus();
  });
}

// Naam/Nr.: bij meerdere geselecteerd eerst waarschuwen voor je het op allemaal toepast.
// (De primaire cue is tijdens het typen al bijgewerkt.)
async function maybePropagate(field, value, { noun, title }) {
  if (selection.size <= 1) return;
  const ok = await customConfirm(
    `Je hebt ${selection.size} cues geselecteerd. Wil je ${noun} van allemaal wijzigen naar "${value}"?`,
    { title, okLabel: `Op alle ${selection.size} toepassen` }
  );
  if (!ok) return;
  applyToSelected((c) => { c[field] = value; });
  render();
  syncInspector();
  persist();
}

function bindInspector() {
  // Naam & Nr.: live alleen op de primaire cue; bij bevestigen (blur/Enter) met een
  // meervoudige selectie eerst een waarschuwingsprompt.
  $('insNumber').addEventListener('input', (e) => withSelected((c) => { c.number = e.target.value; render(); persist(); }));
  $('insNumber').addEventListener('change', (e) => maybePropagate('number', e.target.value.trim(), { noun: 'het nummer', title: 'Nummer wijzigen' }));
  $('insName').addEventListener('input', (e) => withSelected((c) => { c.name = e.target.value; render(); persist(); }));
  $('insName').addEventListener('change', (e) => maybePropagate('name', e.target.value, { noun: 'de naam', title: 'Naam wijzigen' }));

  // Fades & volume: meteen op álle geselecteerde cues (zonder prompt).
  $('insFadeIn').addEventListener('input', (e) => { const v = num(e.target.value, 0); applyToSelected((c) => { c.fadeIn = v; }); render(); persist(); });
  $('insFadeOut').addEventListener('input', (e) => { const v = num(e.target.value, 0); applyToSelected((c) => { c.fadeOut = v; }); render(); persist(); });
  $('insFadeOutEnd').addEventListener('change', (e) => { const on = e.target.checked; applyToSelected((c) => { c.fadeOutAtEnd = on; }); persist(); });
  $('insVolume').addEventListener('input', (e) => {
    const v = num(e.target.value, 1);
    applyToSelected((c) => { c.volume = v; });
    $('insVolumeVal').textContent = `${Math.round(v * 100)}%`;
    render();
    persist();
  });

  // Loop & aantal keer: op alle geselecteerde cues (geen prompt).
  $('insLoop').addEventListener('change', (e) => {
    const on = e.target.checked;
    applyToSelected((c) => { c.loop = on; });
    $('loopCountField').hidden = !on;
    $('loopCrossfadeField').hidden = !on;
    render();
    persist();
  });
  $('insLoopCount').addEventListener('input', (e) => {
    const val = e.target.value.trim();
    applyToSelected((c) => { c.loopCount = val; });
    render();
    persist();
  });
  $('insLoopCrossfade').addEventListener('input', (e) => {
    const v = Math.max(0, num(e.target.value, 0));
    applyToSelected((c) => { c.loopCrossfade = v; });
    persist();
  });

  // In-/uitpunt (op alle geselecteerde cues).
  $('insInPoint').addEventListener('input', (e) => {
    const v = Math.max(0, num(e.target.value, 0));
    applyToSelected((c) => { c.inPoint = v; });
    render(); // ook de onderste afspeelbalk (region-duur) bijwerken
    persist();
    syncPreviewBar();
  });
  $('insOutPoint').addEventListener('input', (e) => {
    const raw = e.target.value.trim();
    const v = raw === '' ? '' : Math.max(0, num(raw, 0));
    applyToSelected((c) => { c.outPoint = v; });
    render();
    persist();
    syncPreviewBar();
  });

  // Auto-doorgaan (op alle geselecteerde cues).
  $('insAutoContinue').addEventListener('change', (e) => {
    const on = e.target.checked;
    applyToSelected((c) => { c.autoContinue = on; });
    $('autoContinueField').hidden = !on;
    render();
    persist();
  });
  $('insAutoDelay').addEventListener('input', (e) => {
    const v = Math.max(0, num(e.target.value, 1));
    applyToSelected((c) => { c.autoContinueDelay = v; });
    persist();
  });

  $('moveUpBtn').addEventListener('click', () => withSelected((c) => { cues.move(c.id, -1); render(); persist(); }));
  $('moveDownBtn').addEventListener('click', () => withSelected((c) => { cues.move(c.id, 1); render(); persist(); }));
  $('deleteBtn').addEventListener('click', deleteSelected);
}

function withSelected(fn) { const cue = cues.selected; if (cue) fn(cue); }
function num(v, fallback) { const n = parseFloat(v); return Number.isNaN(n) ? fallback : n; }

function deleteSelected() {
  if (locked) return;
  const ids = selection.size ? [...selection] : (cues.selected ? [cues.selected.id] : []);
  ids.forEach((id) => {
    engine.fadeOutCue(id, 0.05);
    cues.remove(id);
    deleteAudio(id).catch(() => {});
  });
  selection.clear();
  if (cues.selected) selection.add(cues.selected.id);
  render();
  syncInspector();
  persist();
}

// --- Playback --------------------------------------------------------------

// Aangeroepen als een cue eindigt. Bij een natuurlijk einde (uitgespeeld, niet
// weggefade/gestopt) selecteren we alvast de volgende cue — zonder die te spelen.
function onCueEnded(cue, info) {
  if (info?.natural && cue) {
    const idx = cues.cues.findIndex((c) => c.id === cue.id);
    if (idx !== -1 && idx + 1 < cues.cues.length) {
      const next = cues.cues[idx + 1];
      selectOnly(next.id, idx + 1);
      syncInspector();
      // Auto-doorgaan: na de wachttijd de volgende cue starten (zoals GO).
      if (cue.autoContinue) {
        const delay = Math.max(0, parseFloat(cue.autoContinueDelay) || 0);
        setTimeout(() => {
          const i = cues.cues.findIndex((c) => c.id === next.id);
          if (i !== -1) { selectOnly(next.id, i); go(); }
        }, delay * 1000);
      }
    }
  }
  render();
}

// Fade alle andere cues weg (voor single cue-modus).
function fadeOutOthers(exceptId, seconds = 0.3) {
  for (const id of [...engine.voices.keys()]) {
    if (id !== exceptId) engine.fadeOutCue(id, seconds);
  }
}

async function playCue(cue, opts = {}) {
  if (settings.singleCueMode) fadeOutOthers(cue.id);
  try {
    await engine.play(cue, { onEnded: onCueEnded, ...opts });
  } catch (err) {
    console.error('Kon cue niet afspelen:', cue.name, err);
    alert(`Kon "${cue.name}" niet afspelen: ${err.message}`);
    return;
  }
  render();
  animateProgress();
}

async function playSelected() { const cue = cues.selected; if (cue) await playCue(cue); }

// Speel ÁLLE cues tegelijk (ook in single cue-modus). Eerst decoderen zodat ze
// zo gelijk mogelijk starten.
async function playAll() {
  const list = cues.cues.slice();
  if (!list.length) return;
  await Promise.all(list.map((c) => engine.prepare(c).catch(() => {})));
  for (const cue of list) engine.play(cue, { onEnded: onCueEnded }); // engine.play omzeilt single cue
  render();
  animateProgress();
}

function go() {
  const cue = cues.selected;
  if (!cue) return;
  playCue(cue); // herstart als hij al speelt → nooit dubbel
  cues.advance();
  selectOnly(cues.selected.id, cues.selectedIndex);
  render();
  syncInspector();
}

const numValidate = (x) => (x !== '' && !Number.isNaN(parseFloat(x)) && parseFloat(x) >= 0 ? true : 'Voer een geldig getal in.');

// Transition-toets ('i'):
// - 2 cues geselecteerd → crossfade: speel de eerste, en vlak voor het einde daarvan
//   vloeit hij over in de tweede (eerste faadt uit, tweede faadt in).
// - 1 cue geselecteerd → start die cue met een gekozen fade-in (en schuif door, zoals GO).
async function openFadeInPrompt() {
  const selCues = [...selection]
    .map((id) => cues.getById(id))
    .filter(Boolean)
    .sort((a, b) => cues.cues.indexOf(a) - cues.cues.indexOf(b));

  if (selCues.length >= 2) {
    const [a, b] = selCues;
    const v = await customPrompt({
      title: 'Crossfade', message: `Crossfade van "${a.name}" naar "${b.name}" (s):`, okLabel: 'Start',
      inputType: 'number', defaultValue: '3', validate: numValidate,
    });
    if (v == null) return;
    transitionBetween(a, b, Math.max(0, parseFloat(v) || 0)); // 0 = harde cut (geen fade)
    return;
  }

  const cue = cues.selected;
  if (!cue) return;
  const v = await customPrompt({
    title: 'Fade-in', message: `Hoe lang moet de fade-in van "${cue.name}" duren (s)?`, okLabel: 'Start',
    inputType: 'number', defaultValue: String(cue.fadeIn || 2), validate: numValidate,
  });
  if (v == null) return;
  await playCue(cue, { fadeIn: Math.max(0, parseFloat(v) || 0) });
  cues.advance();
  if (cues.selected) selectOnly(cues.selected.id, cues.selectedIndex);
  render();
  syncInspector();
}

// Cross-fade van cue A naar cue B, getimed zodat de overgang vlak vóór A's einde
// voltooid is. Speelt A al, dan wordt die NIET herstart (transitie o.b.v. resttijd);
// speelt A niet, dan start A eerst vanaf het begin.
async function transitionBetween(a, b, fade) {
  await engine.prepare(a).catch(() => {});
  await engine.prepare(b).catch(() => {});
  const lenA = engine.playLength(a) || 0;
  let remaining;
  if (engine.isPlaying(a.id)) {
    remaining = Math.max(0, lenA - engine.position(a.id)); // A speelt al → resttijd
  } else {
    await engine.play(a, { onEnded: onCueEnded }); // A start nu vanaf begin
    render();
    animateProgress();
    remaining = lenA;
  }
  // Kleine voorsprong zodat de transitie nog vóór A's natuurlijke einde valt (ook bij fade 0).
  const startMs = Math.max(0, remaining - Math.max(fade, 0.06)) * 1000;
  setTimeout(async () => {
    if (!engine.isPlaying(a.id)) return; // gebruiker greep in → transitie afblazen
    engine.fadeOutCue(a.id, fade); // A uitfaden
    await engine.play(b, { fadeIn: fade, onEnded: onCueEnded }); // B infaden
    const bi = cues.cues.indexOf(b);
    if (bi !== -1) { selectOnly(b.id, bi); syncInspector(); }
    render();
    animateProgress();
  }, startMs);
}

function panic() {
  // Elke spelende cue faadt uit over zijn eigen fade-uit-tijd.
  const fades = [...engine.voices.values()].map((v) => Math.max(0, parseFloat(v.cue?.fadeOut) || 0));
  engine.fadeOutAll();
  const maxFade = fades.length ? Math.max(...fades) : 0;
  setTimeout(render, maxFade * 1000 + 200);
}
function hardStop() { engine.stopAll(); render(); }

let lastEscAt = -1e9;
function handleEsc() {
  const now = performance.now();
  if (now - lastEscAt < 600) hardStop();
  else panic();
  lastEscAt = now;
}

// --- Voortgang + afspeelbalk -----------------------------------------------

let rafId = null;
function animateProgress() {
  if (rafId) return;
  const tick = () => {
    let anyActive = false;
    document.querySelectorAll('.progress-fill').forEach((f) => (f.style.width = '0%'));
    for (const cueId of engine.voices.keys()) {
      if (!engine.isPlaying(cueId)) continue;
      anyActive = true;
      const c = cues.getById(cueId);
      const dur = (c && engine.playLength(c)) || 1;
      const pct = Math.min(1, engine.position(cueId) / dur);
      const fill = document.querySelector(`[data-fill="${cueId}"]`);
      if (fill) fill.style.width = `${pct * 100}%`;
    }
    syncTransportProgress();
    syncPreviewBar();
    rafId = anyActive ? requestAnimationFrame(tick) : null;
  };
  rafId = requestAnimationFrame(tick);
  startPreviewTicker(); // robuuste back-up voor de preview-tijd
}

// Welke cue bestuurt de afspeelbalk?
// - Single cue-modus: de cue die nu klinkt/gepauzeerd is (anders de selectie).
// - Normaal: de geselecteerde cue.
function transportCue() {
  if (settings.singleCueMode) {
    for (const id of engine.voices.keys()) {
      const c = cues.getById(id);
      if (c) return c;
    }
  }
  return cues.selected;
}

let seeking = false;
function fmtTime(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

function setPlayIcon(isPlaying) {
  playPauseBtn.querySelector('.ic-play').hidden = isPlaying;
  playPauseBtn.querySelector('.ic-pause').hidden = !isPlaying;
}

// Vul het afgespeelde deel van de seek-slider (0..1000 → %).
function updateSeekFill() {
  seekEl.style.setProperty('--seek-pct', `${(seekEl.value / 1000) * 100}%`);
}

function syncTransport() {
  const cue = transportCue();
  if (!cue) {
    tpName.textContent = '';
    tpCurrent.textContent = '0:00';
    tpDuration.textContent = '0:00';
    seekEl.value = 0;
    updateSeekFill();
    setPlayIcon(false);
    return;
  }
  tpName.textContent = cue.name;
  const known = engine.playLength(cue);
  if (known) tpDuration.textContent = fmtTime(known);
  else engine.prepare(cue).then(() => { if (transportCue() === cue) tpDuration.textContent = fmtTime(engine.playLength(cue)); }).catch(() => {});
  syncTransportProgress();
}

function syncTransportProgress() {
  const cue = transportCue();
  if (!cue) { setPlayIcon(false); return; }
  const dur = engine.playLength(cue) || 0;
  const pos = engine.position(cue.id);
  tpCurrent.textContent = fmtTime(pos);
  if (!seeking) { seekEl.value = dur ? Math.round((pos / dur) * 1000) : 0; updateSeekFill(); }
  setPlayIcon(engine.isPlaying(cue.id));
}

async function transportToggle() {
  const cue = transportCue();
  if (!cue) return;
  if (engine.isPlaying(cue.id)) {
    engine.pause(cue.id);
  } else if (engine.isPaused(cue.id)) {
    if (settings.singleCueMode) fadeOutOthers(cue.id);
    await engine.resume(cue.id);
  } else {
    await playCue(cue);
  }
  render();
  animateProgress();
  syncTransportProgress();
}

function bindTransportBar() {
  playPauseBtn.addEventListener('click', transportToggle);

  seekEl.addEventListener('input', () => {
    seeking = true;
    updateSeekFill();
    const cue = transportCue();
    if (!cue) return;
    const dur = engine.playLength(cue) || 0;
    tpCurrent.textContent = fmtTime((seekEl.value / 1000) * dur);
  });

  seekEl.addEventListener('change', async () => {
    seeking = false;
    const cue = transportCue();
    if (!cue) return;
    await engine.prepare(cue);
    const dur = engine.playLength(cue) || 0;
    await engine.seek(cue, (seekEl.value / 1000) * dur, { onEnded: onCueEnded });
    render();
    if (engine.isPlaying(cue.id)) animateProgress();
    syncTransportProgress();
  });
}

// --- Preview-/monitor-balk in de inspector (voor de geselecteerde cue) ------

let previewSeeking = false;
function syncPreviewBar() {
  const cue = cues.selected;
  if (!cue) {
    previewCur.textContent = '0:00';
    previewDur.textContent = '0:00';
    previewSeek.value = 0;
    previewSeek.style.setProperty('--seek-pct', '0%');
    previewBtn.textContent = '▶';
    return;
  }
  const len = engine.playLength(cue);
  if (len) previewDur.textContent = fmtTime(len);
  else engine.prepare(cue).then(() => { if (cues.selected === cue) previewDur.textContent = fmtTime(engine.playLength(cue)); }).catch(() => {});
  const pos = engine.position(cue.id);
  previewCur.textContent = fmtTime(pos);
  if (!previewSeeking) {
    const pct = len ? (pos / len) * 100 : 0;
    previewSeek.value = Math.round(pct * 10);
    previewSeek.style.setProperty('--seek-pct', `${pct}%`);
  }
  previewBtn.textContent = engine.isPlaying(cue.id) ? '⏸' : '▶';
}

// Robuuste updater voor de preview-tijd (los van de rAF-lus, die soms gepauzeerd wordt).
let previewTimer = null;
function startPreviewTicker() {
  if (previewTimer) return;
  previewTimer = setInterval(() => {
    const cue = cues.selected;
    syncPreviewBar();
    if (!cue || (!engine.isPlaying(cue.id) && !engine.isPaused(cue.id))) {
      clearInterval(previewTimer);
      previewTimer = null;
    }
  }, 120);
}

function bindPreviewBar() {
  previewBtn.addEventListener('click', async () => {
    const cue = cues.selected;
    if (!cue) return;
    if (engine.isPlaying(cue.id)) engine.pause(cue.id);
    else if (engine.isPaused(cue.id)) await engine.resume(cue.id);
    else await playCue(cue);
    render();
    animateProgress();
    syncPreviewBar();
    startPreviewTicker();
  });
  previewSeek.addEventListener('input', () => {
    previewSeeking = true;
    previewSeek.style.setProperty('--seek-pct', `${previewSeek.value / 10}%`);
    const cue = cues.selected;
    if (!cue) return;
    const len = engine.playLength(cue) || 0;
    previewCur.textContent = fmtTime((previewSeek.value / 1000) * len);
  });
  previewSeek.addEventListener('change', async () => {
    previewSeeking = false;
    const cue = cues.selected;
    if (!cue) return;
    await engine.prepare(cue);
    const len = engine.playLength(cue) || 0;
    await engine.seek(cue, (previewSeek.value / 1000) * len, { onEnded: onCueEnded });
    render();
    if (engine.isPlaying(cue.id)) animateProgress();
    syncPreviewBar();
  });
}

// --- Bestanden inladen -----------------------------------------------------

function addFiles(fileList) {
  if (locked) return 0;
  const startLen = cues.cues.length; // nieuwe cues komen hierna
  let added = 0;
  for (const file of fileList) {
    if (!isAudioFile(file)) continue;
    const cue = cues.add(file);
    cue.fadeIn = settings.defaultFadeIn; // standaard fades uit instellingen
    cue.fadeOut = settings.defaultFadeOut;
    saveAudio(cue.id, file).catch((err) => console.warn('Opslaan mislukt:', err));
    added += 1;
  }
  if (added > 0) {
    // Alleen de zojuist toegevoegde bestanden sorteren en onderaan laten staan;
    // de bestaande volgorde blijft ongemoeid.
    cues.sortTailByTitleNumber(startLen);
    selectOnly(cues.cues[startLen].id, startLen); // selecteer het (eerste) nieuwe bestand
    render();
    syncInspector();
    persist();
  }
  return added;
}

async function pickFolder() {
  if (!window.showDirectoryPicker) {
    alert('Map kiezen wordt niet ondersteund in deze browser. Gebruik Chrome/Edge, of sleep bestanden erin.');
    return;
  }
  try {
    const dirHandle = await window.showDirectoryPicker();
    const files = [];
    await collectFiles(dirHandle, files);
    if (addFiles(files) === 0) alert('Geen audiobestanden gevonden in die map.');
  } catch (err) {
    if (err.name !== 'AbortError') console.error(err);
  }
}

async function collectFiles(dirHandle, out) {
  for await (const entry of dirHandle.values()) {
    if (entry.kind === 'file') {
      const file = await entry.getFile();
      if (isAudioFile(file)) out.push(file);
    } else if (entry.kind === 'directory') {
      await collectFiles(entry, out);
    }
  }
}

function bindLoaders() {
  $('pickFolderBtn').addEventListener('click', () => { closeMenus(); pickFolder(); });
  $('pickFilesBtn').addEventListener('click', () => { closeMenus(); $('fileInput').click(); });
  $('fileInput').addEventListener('change', (e) => { addFiles(e.target.files); e.target.value = ''; });

  let dragHideTimer = null;
  const showDrop = () => document.body.classList.add('dragging');
  const hideDrop = () => document.body.classList.remove('dragging');
  const isFileDrag = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');

  window.addEventListener('dragover', (e) => {
    if (locked || !isFileDrag(e)) return; // interne herorden-drag of vergrendeld → geen overlay
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    showDrop();
    clearTimeout(dragHideTimer);
    dragHideTimer = setTimeout(hideDrop, 150);
  });
  window.addEventListener('dragend', () => { clearTimeout(dragHideTimer); hideDrop(); });
  window.addEventListener('drop', async (e) => {
    if (locked || !isFileDrag(e)) return;
    e.preventDefault();
    clearTimeout(dragHideTimer);
    hideDrop();
    const files = await filesFromDrop(e.dataTransfer);
    if (addFiles(files) === 0) alert('Geen audiobestanden in de sleep-selectie gevonden.');
  });
}

// --- Cues herordenen door slepen (met invoeglijn) --------------------------

let dragCueId = null;

function showDropLine(tr, after) {
  const wrapRect = cueListWrap.getBoundingClientRect();
  const rowRect = tr.getBoundingClientRect();
  const y = (after ? rowRect.bottom : rowRect.top) - wrapRect.top + cueListWrap.scrollTop;
  dropLine.style.top = `${y}px`;
  dropLine.hidden = false;
}
function hideDropLine() { dropLine.hidden = true; }

function bindRowDrag(tr, cueId) {
  tr.addEventListener('dragstart', (e) => {
    dragCueId = cueId;
    tr.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('application/x-webqlab-cue', cueId); // géén 'Files'-type
  });
  tr.addEventListener('dragend', () => { tr.classList.remove('dragging'); hideDropLine(); dragCueId = null; });
  tr.addEventListener('dragover', (e) => {
    if (!dragCueId || dragCueId === cueId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const rect = tr.getBoundingClientRect();
    showDropLine(tr, e.clientY > rect.top + rect.height / 2);
  });
  tr.addEventListener('drop', (e) => {
    if (!dragCueId || dragCueId === cueId) return;
    e.preventDefault();
    e.stopPropagation();
    const rect = tr.getBoundingClientRect();
    const after = e.clientY > rect.top + rect.height / 2;
    cues.reorder(dragCueId, cueId, after);
    hideDropLine();
    render();
    syncInspector();
    persist();
  });
}

// --- Uitklap-menu's --------------------------------------------------------

function bindMenus() {
  const menus = [...document.querySelectorAll('[data-menu]')];
  menus.forEach((menu) => {
    menu.querySelector('[data-menu-toggle]').addEventListener('click', (e) => {
      e.stopPropagation();
      const willOpen = !menu.classList.contains('open');
      menus.forEach((m) => m.classList.remove('open'));
      menu.classList.toggle('open', willOpen);
    });
    menu.querySelector('.menu-panel').addEventListener('click', (e) => e.stopPropagation());
  });
  document.addEventListener('click', () => menus.forEach((m) => m.classList.remove('open')));
}
function closeMenus() { document.querySelectorAll('[data-menu].open').forEach((m) => m.classList.remove('open')); }

// --- Sleep-import van losse bestanden en mappen ----------------------------

async function filesFromDrop(dataTransfer) {
  const items = dataTransfer.items;
  if (items && items.length && items[0].webkitGetAsEntry) {
    const out = [];
    const entries = [];
    for (const item of items) { const entry = item.webkitGetAsEntry(); if (entry) entries.push(entry); }
    for (const entry of entries) await walkEntry(entry, out);
    if (out.length) return out;
  }
  return Array.from(dataTransfer.files || []);
}

function walkEntry(entry, out) {
  return new Promise((resolve) => {
    if (entry.isFile) {
      entry.file((file) => { if (isAudioFile(file)) out.push(file); resolve(); }, () => resolve());
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      const readAll = () => {
        reader.readEntries(async (batch) => {
          if (!batch.length) return resolve();
          for (const child of batch) await walkEntry(child, out);
          readAll();
        }, () => resolve());
      };
      readAll();
    } else {
      resolve();
    }
  });
}

// --- Instellingen-popup + project opslaan/openen ---------------------------

function isModalOpen() {
  return !settingsModal.hidden || !$('promptModal').hidden || !$('confirmModal').hidden;
}

// --- Vergrendeling (zachte lock tegen per ongeluk bewerken) -----------------
const LOCK_KEY = 'webqlab.lock'; // {salt, hash}
const LOCKED_KEY = 'webqlab.locked'; // '1' | '0'
let locked = false;

// Elementen die bij vergrendeling worden uitgeschakeld (afspelen blijft werken).
const LOCK_EDIT_IDS = [
  'insNumber', 'insName', 'insFadeIn', 'insFadeOut', 'insFadeOutEnd', 'insVolume', 'insLoop',
  'insLoopCount', 'insLoopCrossfade', 'insInPoint', 'insOutPoint', 'insAutoContinue', 'insAutoDelay',
  'moveUpBtn', 'moveDownBtn', 'deleteBtn', 'pickFolderBtn', 'pickFilesBtn',
  'setFadeIn', 'setFadeOut', 'setSingleCue', 'setBlockKeys', 'setSaveKeybinds', 'openKeysBtn', 'openProjectBtn', 'newProjectBtn',
];

function hasPassword() { try { return !!JSON.parse(localStorage.getItem(LOCK_KEY)); } catch { return false; } }

// SHA-256 vereist crypto.subtle (secure context). Buiten https/localhost valt de
// soft-lock terug op een simpele hash zodat 'wachtwoord instellen' overal werkt.
const HASH_ALGO = (window.crypto && window.crypto.subtle) ? 'sha256' : 'simple';
function simpleHash(str) {
  let h1 = 0x811c9dc5 >>> 0, h2 = 0xc9dc5118 >>> 0;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ (c + i + 1), 0x01000193) >>> 0;
  }
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
}
async function hashWith(algo, str) {
  if (algo === 'sha256' && window.crypto?.subtle) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  return simpleHash(str);
}
function randomSalt() {
  const a = new Uint8Array(16);
  if (window.crypto?.getRandomValues) crypto.getRandomValues(a);
  else for (let i = 0; i < a.length; i++) a[i] = Math.floor(Math.random() * 256);
  return [...a].map((b) => b.toString(16).padStart(2, '0')).join('');
}
async function setPassword(pw) {
  const salt = randomSalt();
  const algo = HASH_ALGO;
  localStorage.setItem(LOCK_KEY, JSON.stringify({ salt, algo, hash: await hashWith(algo, salt + pw) }));
}
async function checkPassword(pw) {
  try {
    const { salt, hash, algo } = JSON.parse(localStorage.getItem(LOCK_KEY));
    return (await hashWith(algo || 'sha256', salt + pw)) === hash;
  } catch { return false; }
}

function setLocked(v) {
  locked = v;
  localStorage.setItem(LOCKED_KEY, v ? '1' : '0');
  applyLockState();
}
function applyLockState() {
  document.body.classList.toggle('locked', locked);
  LOCK_EDIT_IDS.forEach((id) => { const el = $(id); if (el) el.disabled = locked; });
  const addToggle = document.querySelector('[data-menu] [data-menu-toggle]');
  if (addToggle) addToggle.disabled = locked;
  const lockBtn = $('lockBtn');
  lockBtn.hidden = !hasPassword(); // geen slot-icoon als er geen wachtwoord is
  lockBtn.classList.toggle('locked-on', locked);
  lockBtn.title = locked ? 'Ontgrendelen (bewerken is vergrendeld)' : 'Vergrendelen';
  lockBtn.querySelector('.ic-locked').hidden = !locked;
  lockBtn.querySelector('.ic-unlocked').hidden = locked;
  render(); // draggable-status van rijen bijwerken
}

// Slot-knop in de balk: alleen (ont)grendelen — het slot is verborgen als er geen
// wachtwoord is (instellen gebeurt via Instellingen).
async function toggleLock() {
  if (!hasPassword()) return;
  if (locked) {
    const pw = await customPrompt({
      title: 'Ontgrendelen', message: 'Voer je wachtwoord in om bewerken te ontgrendelen.', okLabel: 'Ontgrendel',
      validate: async (v) => ((await checkPassword(v)) ? true : 'Onjuist wachtwoord.'),
    });
    if (pw != null) setLocked(false);
  } else {
    setLocked(true);
  }
}

// Custom wachtwoord-prompt met inline validatie. Geeft Promise<string|null>.
function customPrompt({ title = 'Invoer', message = '', okLabel = 'OK', inputType = 'password', defaultValue = '', validate } = {}) {
  const modal = $('promptModal');
  $('promptTitle').textContent = title;
  $('promptMessage').textContent = message;
  const input = $('promptInput'); input.type = inputType; input.value = defaultValue;
  const err = $('promptError'); err.hidden = true; err.textContent = '';
  modal.hidden = false; void modal.offsetWidth; modal.classList.add('open');
  setTimeout(() => { input.focus(); input.select(); }, 0);
  return new Promise((resolve) => {
    const done = (val) => {
      window.removeEventListener('keydown', onKey, true);
      $('promptOk').removeEventListener('click', onOk);
      input.removeEventListener('keydown', onInputKey);
      modal.querySelectorAll('[data-prompt-cancel]').forEach((el) => el.removeEventListener('click', onCancel));
      modal.classList.remove('open');
      setTimeout(() => { modal.hidden = true; }, 180);
      resolve(val);
    };
    const submit = async () => {
      const v = input.value;
      if (validate) { const r = await validate(v); if (r !== true) { err.textContent = r || 'Ongeldig.'; err.hidden = false; input.select(); return; } }
      done(v);
    };
    const onOk = () => submit();
    const onCancel = () => done(null);
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(null); } };
    const onInputKey = (e) => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); submit(); } };
    $('promptOk').addEventListener('click', onOk);
    modal.querySelectorAll('[data-prompt-cancel]').forEach((el) => el.addEventListener('click', onCancel));
    window.addEventListener('keydown', onKey, true);
    input.addEventListener('keydown', onInputKey);
  });
}
function openSettings() {
  syncSettingsForm();
  renderKeybinds();
  settingsModal.hidden = false;
  void settingsModal.offsetWidth; // forceer reflow zodat de begintoestand telt
  settingsModal.classList.add('open'); // triggert de fade/scale-in
}
function closeSettings() {
  capturingAction = null;
  settingsModal.classList.remove('open');
  setTimeout(() => { settingsModal.hidden = true; }, 200); // wacht op de animatie
}

function selectTab(name) {
  settingsModal.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  settingsModal.querySelectorAll('.tab-panel').forEach((p) => (p.hidden = p.dataset.panel !== name));
}

function syncSettingsForm() {
  $('setFadeIn').value = settings.defaultFadeIn;
  $('setFadeOut').value = settings.defaultFadeOut;
  $('setSingleCue').checked = settings.singleCueMode;
  $('setBlockKeys').checked = settings.blockBrowserKeys;
  $('setSaveKeybinds').checked = settings.saveKeybindsWithProject;
  updateLockSettingsUI();
}

// Toon de vergrendel-status en de instellen/verwijderen-knop in de instellingen.
function updateLockSettingsUI() {
  const has = hasPassword();
  $('lockStatusNote').textContent = has
    ? 'Er is een wachtwoord ingesteld. Gebruik het slot in de balk om te (ont)grendelen.'
    : 'Stel een wachtwoord in om bewerkingen te kunnen vergrendelen.';
  $('passwordBtn').textContent = has ? 'Wachtwoord verwijderen…' : 'Wachtwoord instellen…';
}

function applySingleCueBadge() { modeBadge.hidden = !settings.singleCueMode; }

// --- Sneltoets-editor ---
function keyDisplay(k) {
  if (!k) return '—';
  const map = { ' ': 'Space', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Escape: 'Esc', Delete: 'Del', Backspace: '⌫', Enter: '↵' };
  if (map[k]) return map[k];
  return k.length === 1 ? k.toUpperCase() : k;
}

function renderKeybinds() {
  const list = $('keybindList');
  list.innerHTML = '';
  for (const a of KEY_ACTIONS) {
    const row = document.createElement('div');
    row.className = 'keybind-row';
    const label = document.createElement('span');
    label.className = 'kb-label';
    label.textContent = a.label;
    const btn = document.createElement('button');
    const capturing = capturingAction === a.id;
    btn.className = 'kb-key' + (capturing ? ' capturing' : '');
    btn.textContent = capturing ? 'Druk op een toets…' : keyDisplay(keybinds[a.id]);
    btn.addEventListener('click', () => { if (locked) return; capturingAction = capturing ? null : a.id; renderKeybinds(); });
    row.append(label, btn);
    list.appendChild(row);
  }
}

function applyPreset(name) {
  if (locked) return;
  const preset = KEY_PRESETS[name];
  if (!preset) return;
  Object.assign(keybinds, preset);
  saveKeybinds();
  renderKeybinds();
}

function bindSettings() {
  $('settingsBtn').addEventListener('click', openSettings);
  settingsModal.querySelectorAll('[data-close]').forEach((el) => el.addEventListener('click', closeSettings));
  settingsModal.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => selectTab(t.dataset.tab)));

  $('setFadeIn').addEventListener('input', (e) => { settings.defaultFadeIn = num(e.target.value, 0); saveSettings(); });
  $('setFadeOut').addEventListener('input', (e) => { settings.defaultFadeOut = num(e.target.value, 3); saveSettings(); });
  $('setSingleCue').addEventListener('change', (e) => {
    settings.singleCueMode = e.target.checked;
    saveSettings();
    applySingleCueBadge();
    if (settings.singleCueMode) {
      const keep = [...engine.voices.keys()][0];
      if (keep) fadeOutOthers(keep, 0.3);
    }
    render();
  });
  $('setBlockKeys').addEventListener('change', (e) => { settings.blockBrowserKeys = e.target.checked; saveSettings(); });
  $('setSaveKeybinds').addEventListener('change', (e) => { settings.saveKeybindsWithProject = e.target.checked; saveSettings(); });

  $('passwordBtn').addEventListener('click', async () => {
    if (hasPassword()) {
      // Verwijderen: huidige wachtwoord vereist.
      const pw = await customPrompt({
        title: 'Wachtwoord verwijderen', message: 'Voer je huidige wachtwoord in om het te verwijderen.', okLabel: 'Verwijderen',
        validate: async (v) => ((await checkPassword(v)) ? true : 'Onjuist wachtwoord.'),
      });
      if (pw == null) return;
      localStorage.removeItem(LOCK_KEY);
      localStorage.removeItem(LOCKED_KEY);
      setLocked(false); // ontgrendelen + slot-icoon verbergen
    } else {
      // Instellen.
      const pw = await customPrompt({
        title: 'Wachtwoord instellen', message: 'Kies een wachtwoord om bewerkingen te kunnen vergrendelen.', okLabel: 'Instellen',
        validate: (v) => (v && v.length >= 1 ? true : 'Voer een wachtwoord in.'),
      });
      if (pw == null) return;
      await setPassword(pw);
      applyLockState(); // slot-icoon verschijnt nu
    }
    updateLockSettingsUI();
  });

  settingsModal.querySelectorAll('[data-preset]').forEach((b) => b.addEventListener('click', () => applyPreset(b.dataset.preset)));

  $('saveKeysBtn').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify({ format: 'webqlab-keybinds', version: 1, keybinds }, null, 2)], { type: 'application/json' });
    downloadBlob(blob, 'sneltoetsen.webqlabkeys');
  });
  $('openKeysBtn').addEventListener('click', () => $('keysInput').click());
  $('keysInput').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const incoming = data.keybinds || data;
      for (const a of KEY_ACTIONS) if (a.id in incoming) keybinds[a.id] = incoming[a.id];
      saveKeybinds();
      renderKeybinds();
    } catch (err) {
      alert('Kon sneltoets-preset niet lezen: ' + err.message);
    }
  });

  $('newProjectBtn').addEventListener('click', newProject);
  $('saveProjectBtn').addEventListener('click', saveProject);
  $('openProjectBtn').addEventListener('click', () => $('projectInput').click());
  $('projectInput').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (file) await openProjectFile(file);
  });
}

// Vraag met 3 keuzes: Opslaan / Niet opslaan / Annuleren. Geeft 'save'|'discard'|'cancel'.
function askSaveChoice() {
  const modal = $('confirmModal');
  $('confirmTitle').textContent = 'Niet-opgeslagen wijzigingen';
  $('confirmMessage').textContent = 'Je hebt wijzigingen die nog niet als projectbestand zijn opgeslagen. Wil je ze opslaan?';
  $('confirmOk').textContent = 'Opslaan';
  const alt = $('confirmAlt'); alt.textContent = 'Niet opslaan'; alt.hidden = false;
  $('confirmCancel').textContent = 'Annuleren';
  modal.hidden = false; void modal.offsetWidth; modal.classList.add('open');
  return new Promise((resolve) => {
    const finish = (val) => {
      window.removeEventListener('keydown', onKey, true);
      $('confirmOk').removeEventListener('click', onOk);
      alt.removeEventListener('click', onAlt);
      modal.querySelectorAll('[data-confirm-cancel]').forEach((el) => el.removeEventListener('click', onCancel));
      modal.classList.remove('open');
      setTimeout(() => { modal.hidden = true; alt.hidden = true; }, 180);
      resolve(val);
    };
    const onOk = () => finish('save');
    const onAlt = () => finish('discard');
    const onCancel = () => finish('cancel');
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish('cancel'); } };
    $('confirmOk').addEventListener('click', onOk);
    alt.addEventListener('click', onAlt);
    modal.querySelectorAll('[data-confirm-cancel]').forEach((el) => el.addEventListener('click', onCancel));
    window.addEventListener('keydown', onKey, true);
  });
}

// Bij niet-opgeslagen wijzigingen eerst vragen. Geeft false als de gebruiker annuleert.
async function confirmDiscardChanges() {
  if (!dirty || cues.cues.length === 0) return true;
  const choice = await askSaveChoice();
  if (choice === 'cancel') return false;
  if (choice === 'save') return await saveProject();
  return true; // niet opslaan → doorgaan
}

async function newProject() {
  if (locked) return;
  if (!(await confirmDiscardChanges())) return;
  engine.stopAll();
  for (const c of cues.cues) deleteAudio(c.id).catch(() => {});
  cues.cues = [];
  cues.selectedIndex = -1;
  selection.clear();
  render();
  syncInspector();
  persist();
  dirty = false; // lege, verse show
  setProjectName('Naamloos');
  closeSettings();
}

// Slaat op onder een door de gebruiker gekozen naam. Geeft true bij succes.
async function saveProject() {
  if (cues.cues.length === 0) { await customConfirm('Er zijn nog geen cues om op te slaan.', { title: 'Opslaan', okLabel: 'OK' }); return false; }
  const name = await customPrompt({
    title: 'Show opslaan', message: 'Geef de show een naam.', okLabel: 'Opslaan',
    inputType: 'text', defaultValue: projectName,
    validate: (v) => (v && v.trim() ? true : 'Voer een naam in.'),
  });
  if (name == null) return false;
  setProjectName(name);
  const filename = projectName.replace(/[^\w\-. ]+/g, '_') + '.webqlab';
  try {
    const kb = settings.saveKeybindsWithProject ? keybinds : null; // optioneel sneltoetsen meenemen
    const blob = await exportProject(cues.cues, settings, kb);
    downloadBlob(blob, filename);
    dirty = false;
    return true;
  } catch (err) {
    console.error(err);
    await customConfirm('Opslaan mislukt: ' + err.message, { title: 'Fout', okLabel: 'OK' });
    return false;
  }
}

async function openProjectFile(file) {
  if (locked) return;
  if (!(await confirmDiscardChanges())) return;
  try {
    const proj = await importProject(await file.arrayBuffer());
    await loadProject(proj);
    setProjectName((file.name || 'show').replace(/\.webqlab$/i, '').replace(/\.[^.]+$/, ''));
    closeSettings();
  } catch (err) {
    console.error(err);
    alert('Openen mislukt: ' + err.message);
  }
}

async function loadProject(proj) {
  engine.stopAll();
  for (const c of cues.cues) deleteAudio(c.id).catch(() => {});
  cues.cues = [];
  cues.selectedIndex = -1;
  selection.clear();

  Object.assign(settings, defaultSettings, proj.settings || {});
  saveSettings();
  syncSettingsForm();
  applySingleCueBadge();
  applyInspectorVisibility();

  // Sneltoetsen uit het project overnemen (indien meegenomen bij opslaan).
  if (proj.keybinds) {
    for (const a of KEY_ACTIONS) if (a.id in proj.keybinds) keybinds[a.id] = proj.keybinds[a.id];
    saveKeybinds();
    renderKeybinds();
  }

  for (const c of proj.cues) {
    cues.addExisting(c);
    saveAudio(c.id, c.file).catch(() => {});
  }
  if (cues.cues.length) selectOnly(cues.cues[0].id, 0);
  render();
  syncInspector();
  persist();
  dirty = false; // net geladen show is "opgeslagen"
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// --- Toetsenbord -----------------------------------------------------------

let capturingAction = null;

// Alleen echte tekstinvoer telt als 'typen'. Een gefocuste checkbox/switch/slider/knop
// niet — zodat spatie ook dan GO doet i.p.v. de switch opnieuw om te schakelen.
function isTyping() {
  const el = document.activeElement;
  if (!el) return false;
  if (el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return true;
  if (el.tagName === 'INPUT') {
    const t = (el.type || 'text').toLowerCase();
    return !['checkbox', 'radio', 'range', 'button', 'submit', 'reset', 'file', 'color'].includes(t);
  }
  return false;
}

function runAction(id, e) {
  switch (id) {
    case 'go': (e && e.shiftKey) ? playAll() : go(); break;
    case 'playPause': transportToggle(); break;
    case 'selectUp': moveSel(-1, e.shiftKey); break;
    case 'selectDown': moveSel(1, e.shiftKey); break;
    case 'selectNext': moveSel(1, false); break;
    case 'fadeInGo': openFadeInPrompt(); break;
    case 'delete': deleteSelected(); break;
    case 'fullscreen': toggleFullscreen(); break;
    default: break;
  }
}

// Na het schakelen van een switch/checkbox (waar dan ook) de focus loslaten, zodat
// een volgende spatie GO doet i.p.v. de switch opnieuw om te schakelen.
function bindSwitchBlur() {
  document.addEventListener('change', (e) => {
    const el = e.target;
    if (el && el.tagName === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio')) {
      el.blur();
    }
  });
}

function bindKeyboard() {
  window.addEventListener('keydown', (e) => {
    // Bezig een sneltoets in te stellen? Vang de toets af.
    if (capturingAction) { e.preventDefault(); e.stopPropagation(); captureKey(e); return; }

    const typing = isTyping();

    // Browser-sneltoetsen blokkeren (kiosk). Normaal tekst bewerken in velden blijft werken.
    if (settings.blockBrowserKeys) {
      const editKey = typing && (e.metaKey || e.ctrlKey) && ['a', 'c', 'v', 'x', 'z', 'y'].includes((e.key || '').toLowerCase());
      if (!editKey && (e.metaKey || e.ctrlKey || e.altKey || /^F\d{1,2}$/.test(e.key))) e.preventDefault();
    }

    // Modal open: Esc sluit, verder niets.
    if (isModalOpen()) {
      if (e.key === 'Escape') { e.preventDefault(); closeSettings(); }
      return;
    }

    if (e.metaKey || e.ctrlKey || e.altKey) return; // gemodificeerde toetsen negeren voor cue-acties

    const action = actionForKey(e.key);

    // Fade-uit werkt altijd, ook tijdens typen (panic-toets).
    if (action === 'fadeOut') {
      e.preventDefault();
      if (typing) document.activeElement.blur();
      closeMenus();
      handleEsc();
      return;
    }

    if (typing || !action) return;
    e.preventDefault();
    runAction(action, e);
  });
}

// Sla de ingedrukte toets op voor de actie die 'geleerd' wordt.
function captureKey(e) {
  if (['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return; // wacht op echte toets
  if (e.key !== 'Escape') { // Esc annuleert
    keybinds[capturingAction] = e.key;
    saveKeybinds();
  }
  capturingAction = null;
  renderKeybinds();
}

// --- Init ------------------------------------------------------------------

function toggleFullscreen() {
  if (!document.fullscreenElement) {
    const p = document.documentElement.requestFullscreen?.();
    if (p) p.then(lockEscape).catch(() => {});
  } else {
    document.exitFullscreen?.();
  }
}

// Vang Esc af in fullscreen (Edge/Chrome) zodat 'ie niet meteen fullscreen verlaat,
// maar de fade-uit-actie triggert. Fullscreen verlaten: Esc ingedrukt houden.
function lockEscape() {
  try { navigator.keyboard?.lock?.(['Escape']).catch(() => {}); } catch { /* niet ondersteund */ }
}
function unlockKeyboard() {
  try { navigator.keyboard?.unlock?.(); } catch { /* niet ondersteund */ }
}

// Bij het verlaten van fullscreen (op welke manier dan ook) de keyboard-lock opheffen.
document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement) unlockKeyboard();
});

function applyInspectorVisibility() {
  document.body.classList.toggle('inspector-collapsed', settings.inspectorHidden);
  $('inspectorToggle').classList.toggle('active', !settings.inspectorHidden);
}

function bindTopbar() {
  $('fsBtn').addEventListener('click', toggleFullscreen);
  $('lockBtn').addEventListener('click', toggleLock);
  $('inspectorToggle').addEventListener('click', () => {
    settings.inspectorHidden = !settings.inspectorHidden;
    saveSettings();
    applyInspectorVisibility();
  });
}

async function restoreFromStorage() {
  const meta = loadMeta();
  if (!meta.length) return;
  for (const m of meta) {
    const file = await loadAudio(m.id);
    if (!file) continue;
    cues.addExisting({
      id: m.id,
      number: m.number ?? '',
      name: m.name ?? file.name.replace(/\.[^.]+$/, ''),
      file,
      fadeIn: m.fadeIn ?? 0,
      fadeOut: m.fadeOut ?? 3,
      fadeOutAtEnd: !!m.fadeOutAtEnd,
      volume: m.volume ?? 1,
      loop: !!m.loop,
      loopCount: m.loopCount || '',
      loopCrossfade: m.loopCrossfade || 0,
      inPoint: m.inPoint || 0,
      outPoint: m.outPoint || '',
      autoContinue: !!m.autoContinue,
      autoContinueDelay: m.autoContinueDelay ?? 1,
    });
  }
  if (cues.cues.length) selectOnly(cues.cues[0].id, 0);
  render();
  syncInspector();
}

bindTopbar();
bindTransportBar();
bindPreviewBar();
bindLoaders();
bindMenus();
bindInspector();
bindSettings();
bindSwitchBlur();
bindProjectTitle();
bindKeyboard();
applySingleCueBadge();
applyInspectorVisibility();
locked = hasPassword() && localStorage.getItem(LOCKED_KEY) === '1';
applyLockState();
updateProjectTitle();
render();
syncInspector();
restoreFromStorage();
