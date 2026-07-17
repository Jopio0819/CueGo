// app.js — UI, toetsenbord, bestanden inladen en rendering voor de cue-player.
import { AudioEngine, EQ_BANDS, EQ_MAX_DB } from './audio-engine.js';
import { CueList, isAudioFile, cueToMeta, metaToCue } from './cue-model.js';
import * as showSync from './show-sync.js';
import { saveAudio, loadAudio, deleteAudio, saveMeta, loadMeta } from './storage.js';
import { exportProject, importProject } from './project.js';
import { createControl, publicApi, detectServer } from './control.js';
import { connectAppLink, deviceId, defaultDeviceLabel } from './net-remote.js';
import { createMidi, describeSignature, MIDI_SUPPORTED } from './midi.js';
import { createProjectStore } from './projects-store.js';

const engine = new AudioEngine();
const cues = new CueList();

// Besturings-events (window.cuego.on(...)). No-op tot de control is aangemaakt.
let emit = () => {};

// Meervoudige selectie (voor shift-selecteren + samen verwijderen).
const selection = new Set(); // cue-ids
let anchorIndex = -1;

// Instellingen (persist in localStorage).
const SETTINGS_KEY = 'webqlab.settings.v1';
const defaultSettings = { defaultFadeIn: 0, defaultFadeOut: 3, singleCueMode: false, blockBrowserKeys: true, inspectorHidden: false, saveKeybindsWithProject: false, midiEnabled: false, remoteEnabled: true, inspectorWidth: 290,audioOutputDeviceId: '' };
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
      control.dispatch('play', { cue: cue.id }); // dubbelklik = starten (via de bus)
    });
    // Dubbelklik op het #-vakje = nummer direct bewerken (niet starten).
    const numCell = tr.querySelector('.col-num');
    numCell.addEventListener('dblclick', (e) => { e.stopPropagation(); if (!locked) startInlineNumberEdit(numCell, cue); });
    bindRowDrag(tr, cue.id);
    cueBody.appendChild(tr);
  });

  syncTransport();
  // Vers opgebouwde rijen hebben lege voortgangsbalkjes; bij een gepauzeerde cue
  // draait de animatielus niet meer, dus die tekenen we hier één keer terug.
  drawVoiceFills();
  // Zijn wij niet de showcomputer, dan zegt onze eigen engine niets: de rijen en
  // de balk krijgen de toestand van de showcomputer er weer overheen.
  if (isFollower()) applyRemotePlayback();
  emit('statechange');
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

  // Bij een meervoudige selectie is één cue's naam tonen misleidend — dan lijkt het
  // alsof die naam voor alles geldt. Verschillen ze? Toon een streepje als placeholder.
  const selCues = selection.size > 1
    ? [...selection].map((id) => cues.getById(id)).filter(Boolean)
    : [cue];
  const shared = (field) => (selCues.every((c) => c[field] === selCues[0][field]) ? selCues[0][field] : null);

  const sharedName = shared('name');
  $('insName').value = sharedName ?? '';
  $('insName').placeholder = sharedName === null ? '—' : '';

  const sharedNumber = shared('number');
  $('insNumber').value = sharedNumber ?? '';
  $('insNumber').placeholder = sharedNumber === null ? '—' : '—';
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
  syncCueMidi();
  syncEqStatus();
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
function persist() {
  saveMeta(cues.cues); // lokale cache
  dirty = true;
  schedulePushShow(); // zelf-gehost: andere clients meteen bijwerken
}

function setProjectName(name) {
  projectName = (name || '').trim() || 'Naamloos';
  localStorage.setItem(PROJECT_NAME_KEY, projectName);
  updateProjectTitle();
  schedulePushShow(); // naam hoort bij de gedeelde show (no-op zonder server)
}
function updateProjectTitle() {
  const el = $('projectTitle');
  if (el.getAttribute('contenteditable') !== 'true') el.textContent = projectName;
  // Tabtitel volgt de show, zodat je met meerdere vensters ziet welke welke is.
  document.title = projectName && projectName !== 'Naamloos' ? `${projectName} - CueGo` : 'CueGo';
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
      document.activeElement?.blur?.(); // focus niet in de gesloten dialoog laten hangen
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

  // Geen ↑/↓/Verwijder-knoppen meer in de inspector: herordenen doe je door te
  // slepen, verwijderen met de Delete-toets.
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
    if (sharedShow) showSync.deleteAudio(id); // ook van de server af
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
  if (cue) emit('cueend', { id: cue.id, number: cue.number, name: cue.name, natural: !!info?.natural });
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
  emit('cuestart', { id: cue.id, number: cue.number, name: cue.name });
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

// `a.cue` (optioneel): eerst die cue selecteren. Een andere client stuurt zijn
// eigen selectie mee, anders zou de showcomputer zíjn cue afspelen i.p.v. de jouwe.
function go(a) {
  if (a?.cue) {
    const target = resolveCue(a.cue);
    if (target) selectOnly(target.id, cues.cues.indexOf(target));
  }
  const cue = cues.selected;
  if (!cue) return;
  emit('go', { id: cue.id, number: cue.number, name: cue.name });
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
  emit('panic');
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
  // Via de bus: op een niet-showcomputer moet Esc de showcomputer stilleggen,
  // niet alleen dit scherm.
  if (now - lastEscAt < 600) control.dispatch('stop');
  else control.dispatch('panic');
  lastEscAt = now;
}

// --- Voortgang + afspeelbalk -----------------------------------------------

let rafId = null;
// Teken de voortgangsbalkjes van alle klinkende én gepauzeerde cues. Een
// gepauzeerde cue houdt z'n groene vlak (je wilt zíén waar je gebleven bent —
// meekijkers deden dat al, de host hoort dat ook te doen). Geeft terug of er
// nog iets écht speelt, zodat de animatielus weet of hij door moet.
function drawVoiceFills() {
  let anyPlaying = false;
  document.querySelectorAll('.progress-fill').forEach((f) => (f.style.width = '0%'));
  for (const cueId of engine.voices.keys()) {
    const playing = engine.isPlaying(cueId);
    if (!playing && !engine.isPaused(cueId)) continue;
    if (playing) anyPlaying = true;
    const c = cues.getById(cueId);
    const dur = (c && engine.playLength(c)) || 1;
    const pct = Math.min(1, engine.position(cueId) / dur);
    const fill = document.querySelector(`[data-fill="${cueId}"]`);
    if (fill) fill.style.width = `${pct * 100}%`;
  }
  return anyPlaying;
}

function animateProgress() {
  if (rafId) return;
  const tick = () => {
    const anyActive = drawVoiceFills(); // laatste tik na een pauze tekent het bevroren vlak
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
  // Via de bus: op een niet-showcomputer bedient deze knop de showcomputer.
  // (De preview-knop in de inspector blijft bewust wél lokaal — voorluisteren
  // hoort niet de zaal in te gaan.)
  playPauseBtn.addEventListener('click', () => control.dispatch('toggle'));

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

// --- Equalizer (fullscreen popup) ------------------------------------------

// Oudere cues (van vóór de EQ) hebben het veld nog niet.
function ensureEq(c) {
  if (!Array.isArray(c.eq) || c.eq.length !== EQ_BANDS.length) c.eq = EQ_BANDS.map(() => 0);
  return c.eq;
}

function eqIsVlak(c) {
  return !c?.eq || c.eq.every((v) => !v);
}

// Klein statusje naast de knop in de inspector.
function syncEqStatus() {
  const el = $('eqStatus');
  if (el) el.textContent = eqIsVlak(cues.selected) ? '(vlak)' : '(aangepast)';
}

function fmtDb(v) {
  if (!v) return '0';
  return (v > 0 ? '+' : '−') + Math.abs(v).toFixed(1).replace(/\.0$/, '');
}

// Bouw de zes kolommen één keer.
function buildEqUi() {
  const wrap = $('eqBands');
  if (!wrap || wrap.childElementCount) return;
  EQ_BANDS.forEach((band, i) => {
    const col = document.createElement('div');
    col.className = 'eq-band';

    const db = document.createElement('span');
    db.className = 'eq-db';

    const sliderWrap = document.createElement('div');
    sliderWrap.className = 'eq-slider-wrap';
    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(-EQ_MAX_DB);
    input.max = String(EQ_MAX_DB);
    input.step = '0.5';
    input.value = '0';
    input.dataset.band = String(i);
    sliderWrap.appendChild(input);

    const freq = document.createElement('span');
    freq.className = 'eq-freq';
    freq.textContent = band.label;
    const em = document.createElement('em');
    em.textContent = band.type === 'lowshelf' ? 'laag' : band.type === 'highshelf' ? 'hoog' : 'Hz';
    freq.appendChild(em);

    input.addEventListener('input', () => {
      const v = parseFloat(input.value) || 0;
      // Zelfde regel als volume/fades: geldt voor álle geselecteerde cues, en
      // een spelende cue hoort het meteen.
      applyToSelected((c) => { ensureEq(c)[i] = v; engine.updateEq(c.id, c.eq); });
      db.textContent = fmtDb(v);
      col.classList.toggle('actief', v !== 0);
      persist();
      syncEqStatus();
    });

    col.append(db, sliderWrap, freq);
    wrap.appendChild(col);
  });
}

// Zet de schuiven op de waarden van de primaire cue.
function syncEqUiFromCue() {
  const cue = cues.selected;
  if (!cue) return;
  const eq = ensureEq(cue);
  document.querySelectorAll('#eqBands .eq-band').forEach((col, i) => {
    const input = col.querySelector('input');
    input.value = String(eq[i] || 0);
    col.querySelector('.eq-db').textContent = fmtDb(eq[i] || 0);
    col.classList.toggle('actief', !!eq[i]);
  });
}

function openEq() {
  if (locked || !cues.selected) return;
  buildEqUi();
  const n = selection.size > 1 ? selection.size : 1;
  $('eqTitle').textContent = n > 1 ? `Equalizer — ${n} cues` : `Equalizer — ${cues.selected.name}`;
  const modal = $('eqModal');
  modal.hidden = false;
  void modal.offsetWidth;
  modal.classList.add('open');
  // De gedraaide schuiven moeten precies zo lang zijn als hun kolom hoog is.
  const w = modal.querySelector('.eq-slider-wrap');
  if (w) $('eqBands').style.setProperty('--eq-h', `${w.clientHeight}px`);
  syncEqUiFromCue();
}

function closeEq() {
  const modal = $('eqModal');
  if (modal.hidden) return;
  document.activeElement?.blur?.(); // focus nooit in een gesloten popup laten hangen
  modal.classList.remove('open');
  setTimeout(() => { modal.hidden = true; }, 200);
}

function bindEq() {
  $('eqBtn')?.addEventListener('click', openEq);
  document.querySelectorAll('[data-eq-close]').forEach((el) => el.addEventListener('click', closeEq));
  $('eqFlatBtn')?.addEventListener('click', () => {
    applyToSelected((c) => { c.eq = EQ_BANDS.map(() => 0); engine.updateEq(c.id, c.eq); });
    persist();
    syncEqUiFromCue();
    syncEqStatus();
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
    // Zelf-gehost: de audio moet ook naar de server, anders zien andere clients
    // straks wel de cue maar kunnen ze 'm niet afspelen.
    if (sharedShow) {
      showSync.uploadAudio(cue.id, file)
        .then(() => schedulePushShow()) // pas melden als de audio er echt is
        .catch((err) => console.warn('Uploaden mislukt:', file.name, err.message));
    }
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
  // showDirectoryPicker vereist een secure context (https of localhost). Benader je
  // CueGo via een LAN-IP, dan bestaat 'ie niet — dan pakken we de klassieke
  // map-invoer (webkitdirectory), die ook over gewone http werkt.
  if (!window.showDirectoryPicker || !window.isSecureContext) {
    $('folderInput').click();
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
  // Terugval-map-invoer (zonder secure context). Levert álle bestanden uit de map
  // en submappen; addFiles filtert de audio er zelf uit.
  $('folderInput').addEventListener('change', (e) => {
    const n = addFiles(e.target.files);
    e.target.value = '';
    if (n === 0) alert('Geen audiobestanden gevonden in die map.');
  });

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
  return !settingsModal.hidden || !$('promptModal').hidden || !$('confirmModal').hidden || !$('eqModal').hidden;
}

// --- Vergrendeling (zachte lock tegen per ongeluk bewerken) -----------------
const LOCK_KEY = 'webqlab.lock'; // {salt, hash}
const LOCKED_KEY = 'webqlab.locked'; // '1' | '0'
let locked = false;

// Elementen die bij vergrendeling worden uitgeschakeld (afspelen blijft werken).
// Fade-tijden en loop blijven bewust wél bewerkbaar als het device vergrendeld is:
// dat zijn de dingen die je tijdens een show nog wilt bijstellen.
const LOCK_EDIT_IDS = [
  'insNumber', 'insName', 'insFadeOutEnd', 'insVolume',
  'insLoopCount', 'insLoopCrossfade', 'insInPoint', 'insOutPoint', 'insAutoContinue', 'insAutoDelay',
  'pickFolderBtn', 'pickFilesBtn',
  'setFadeIn', 'setFadeOut', 'setSingleCue', 'setBlockKeys', 'setSaveKeybinds', 'openKeysBtn', 'openProjectBtn', 'newProjectBtn',
  'setMidi', 'eqBtn',
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
  appLink?.beat?.(); // status meteen doorgeven, niet pas bij de volgende ping
}
function applyLockState() {
  document.body.classList.toggle('locked', locked);
  LOCK_EDIT_IDS.forEach((id) => { const el = $(id); if (el) el.disabled = locked; });
  const addToggle = document.querySelector('[data-menu] [data-menu-toggle]');
  if (addToggle) addToggle.disabled = locked;
  const lockBtn = $('lockBtn');
  // Slot tonen bij een lokaal wachtwoord óf een admin-wachtwoord op de server.
  lockBtn.hidden = !hasPassword() && !adminLock;
  lockBtn.classList.toggle('locked-on', locked);
  lockBtn.title = locked ? 'Ontgrendelen (bewerken is vergrendeld)' : 'Vergrendelen';
  lockBtn.querySelector('.ic-locked').hidden = !locked;
  lockBtn.querySelector('.ic-unlocked').hidden = locked;
  syncCueMidi(); // trigger-veld hangt van lock én MIDI-status af
  applyLockToSections(); // grijs wat je nu toch niet kunt bewerken
  updateLockSettingsUI(); // ook bij vergrendelen vanaf een ander apparaat
  renderDevices(); // (ont)grendel-knoppen volgen onze eigen lock-status
  render(); // draggable-status van rijen bijwerken
}

// Slot-knop in de balk: alleen (ont)grendelen — het slot is verborgen als er geen
// wachtwoord is (instellen gebeurt via Instellingen).
async function toggleLock() {
  if (!hasPassword() && !adminLock) return;
  if (!locked) { setLocked(true); return; }

  // Admin-wachtwoord: de server controleert 'm, zodat één wachtwoord voor alle
  // apparaten geldt. Anders het lokale wachtwoord van dit apparaat.
  const pw = await customPrompt({
    title: 'Ontgrendelen',
    message: adminLock
      ? 'Voer het admin-wachtwoord in om op dit apparaat te kunnen bewerken.'
      : 'Voer je wachtwoord in om bewerken te ontgrendelen.',
    okLabel: 'Ontgrendel',
    validate: async (v) => {
      if (adminLock) {
        const res = await fetch('api/unlock', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: v, deviceId: deviceId() }),
        }).catch(() => null);
        return res?.ok ? true : 'Onjuist wachtwoord.';
      }
      return (await checkPassword(v)) ? true : 'Onjuist wachtwoord.';
    },
  });
  if (pw != null) setLocked(false);
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
      // Focus loslaten! Blijft die in het (verborgen) invoerveld hangen, dan denkt
      // isTyping() dat je typt en werkt geen enkele sneltoets meer — ook spatie/GO niet.
      input.blur();
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
  selectTab('play'); // altijd bovenaan beginnen, niet waar je vorige keer was
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
  let title = '';
  settingsModal.querySelectorAll('.tab').forEach((t) => {
    const on = t.dataset.tab === name;
    t.classList.toggle('active', on);
    if (on) title = t.textContent.trim(); // kop volgt de gekozen pagina
  });
  settingsModal.querySelectorAll('.tab-panel').forEach((p) => (p.hidden = p.dataset.panel !== name));
  const heading = $('settingsTitle');
  if (heading && title) heading.textContent = title;
}

function syncSettingsForm() {
  $('setFadeIn').value = settings.defaultFadeIn;
  $('setFadeOut').value = settings.defaultFadeOut;
  $('setSingleCue').checked = settings.singleCueMode;
  $('setBlockKeys').checked = settings.blockBrowserKeys;
  $('setSaveKeybinds').checked = settings.saveKeybindsWithProject;
  if ($('setRemote')) $('setRemote').checked = settings.remoteEnabled !== false;
  updateLockSettingsUI();
  updateControlTab();
  updateMidiUI();
  renderDevices();
}

// Toon de vergrendel-status, het ontgrendel-blok en de instellen/verwijderen-knop.
function updateLockSettingsUI() {
  const has = hasPassword();

  // Zelf-gehost beheert de sérver het wachtwoord (gevraagd bij het starten) —
  // een eigen wachtwoord per apparaat bestaat daar niet, dus ook geen knop.
  // Alleen statisch gehost (GitHub Pages) stel je 'm per apparaat in.
  $('passwordBtn').hidden = sharedShow;
  $('lockStatusNote').textContent = adminLock
    ? 'De server beheert het admin-wachtwoord (gevraagd bij het starten). Elk apparaat start vergrendeld tot het daar is ingevuld.'
    : sharedShow
      ? 'Er is geen admin-wachtwoord. Wil je vergrendeling gebruiken? Herstart de server en vul er bij het starten één in.'
      : has
        ? 'Er is een wachtwoord ingesteld. Gebruik het slot in de balk om te (ont)grendelen.'
        : 'Stel een wachtwoord in om bewerkingen te kunnen vergrendelen.';
  $('passwordBtn').textContent = has ? 'Wachtwoord verwijderen…' : 'Wachtwoord instellen…';

  // Vergrendeld? Dan hier ontgrendelen. Zonder wachtwoord (bv. vergrendeld vanaf
  // het Multi-device-paneel) valt er niets te controleren — dan zou je muurvast
  // zitten, dus is één klik genoeg.
  const section = $('unlockSection');
  if (!section) return;
  section.hidden = !locked;
  if (!locked) { $('unlockError').hidden = true; $('unlockInput').value = ''; return; }

  // Bij een admin-wachtwoord op de server valt er altijd iets in te vullen, ook
  // al staat er lokaal geen wachtwoord.
  const canAsk = has || adminLock;
  $('unlockNote').textContent = adminLock
    ? 'Dit apparaat is vergrendeld. Voer het admin-wachtwoord in om hier te kunnen bewerken.'
    : has
      ? 'Dit apparaat is vergrendeld. Voer het wachtwoord in om bewerken vrij te geven.'
      : 'Dit apparaat is vergrendeld vanaf een ander apparaat. Er is hier geen wachtwoord ingesteld.';
  $('unlockInput').hidden = !canAsk;
}

// Draait er een server met een admin-wachtwoord, dan controleert die 'm — zo geldt
// één wachtwoord voor alle apparaten. Anders het lokale wachtwoord van dit apparaat.
async function tryUnlock() {
  const input = $('unlockInput');
  const err = $('unlockError');
  const fail = (msg) => { err.textContent = msg; err.hidden = false; input.select(); };

  if (adminLock) {
    try {
      const res = await fetch('api/unlock', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: input.value, deviceId: deviceId() }),
      });
      if (!res.ok) return fail('Onjuist wachtwoord.');
    } catch {
      return fail('Geen verbinding met de server.');
    }
  } else if (hasPassword() && !(await checkPassword(input.value))) {
    return fail('Onjuist wachtwoord.');
  }

  input.value = '';
  err.hidden = true;
  setLocked(false); // roept applyLockState → updateLockSettingsUI
}

function bindUnlock() {
  const btn = $('unlockBtn');
  if (!btn) return;
  btn.addEventListener('click', tryUnlock);
  $('unlockInput').addEventListener('keydown', (e) => {
    e.stopPropagation(); // niet de globale sneltoetsen triggeren tijdens typen
    if (e.key === 'Enter') { e.preventDefault(); tryUnlock(); }
  });
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
    downloadBlob(blob, 'sneltoetsen.cgokeys');
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
  $('downloadProjectBtn').addEventListener('click', downloadProject);
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
      document.activeElement?.blur?.(); // focus niet in de gesloten dialoog laten hangen
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
  for (const c of cues.cues) {
    deleteAudio(c.id).catch(() => {});
    if (sharedShow) showSync.deleteAudio(c.id); // gedeelde show: ook op de server opruimen
  }
  cues.cues = [];
  cues.selectedIndex = -1;
  selection.clear();
  render();
  syncInspector();
  persist();
  dirty = false; // lege, verse show
  setProjectName('Naamloos');
  renderRecentProjects(); // 'huidige'-markering klopt niet meer
  closeSettings();
}

// Bouw het projectbestand van de huidige show.
async function buildProjectBlob() {
  const kb = settings.saveKeybindsWithProject ? keybinds : null; // optioneel sneltoetsen meenemen
  return await exportProject(cues.cues, settings, kb);
}

async function askProjectName(title) {
  if (cues.cues.length === 0) { await customConfirm('Er zijn nog geen cues om op te slaan.', { title, okLabel: 'OK' }); return null; }
  return await customPrompt({
    title, message: 'Geef de show een naam.', okLabel: 'Opslaan',
    inputType: 'text', defaultValue: projectName,
    validate: (v) => (v && v.trim() ? true : 'Voer een naam in.'),
  });
}

// Opslaan bij 'Recente projecten': lokaal als bestand in projects/, statisch
// gehost in de browseropslag. Geeft true bij succes.
async function saveProject() {
  const name = await askProjectName('Show opslaan');
  if (name == null) return false;
  setProjectName(name);
  try {
    const blob = await buildProjectBlob();
    await projectStore.save(projectName, blob, Date.now());
    dirty = false;
    await renderRecentProjects();
    return true;
  } catch (err) {
    console.error(err);
    await customConfirm('Opslaan mislukt: ' + err.message, { title: 'Fout', okLabel: 'OK' });
    return false;
  }
}

// Los bestand downloaden (los van de recente-projectenlijst).
async function downloadProject() {
  const name = await askProjectName('Show downloaden');
  if (name == null) return false;
  setProjectName(name);
  try {
    const blob = await buildProjectBlob();
    downloadBlob(blob, projectName.replace(/[^\w\-. ]+/g, '_') + '.cgo');
    dirty = false;
    return true;
  } catch (err) {
    console.error(err);
    await customConfirm('Downloaden mislukt: ' + err.message, { title: 'Fout', okLabel: 'OK' });
    return false;
  }
}

// --- Recente projecten -----------------------------------------------------

let projectStore = null;

function fmtSize(bytes) {
  if (!bytes) return '';
  const mb = bytes / 1048576;
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} kB`;
}
function fmtWhen(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  return d.toLocaleDateString('nl-NL', { day: 'numeric', month: 'short' }) + ' ' +
    d.toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' });
}

async function renderRecentProjects() {
  const list = $('recentProjects');
  const note = $('recentNote');
  if (!list || !projectStore) return;

  if (note) {
    note.textContent = projectStore.kind === 'server'
      ? 'Opgeslagen als bestand in de map projects/ naast de server — gewoon te kopiëren en te backuppen.'
      : 'Opgeslagen in de browseropslag van dit apparaat (er is geen server om naartoe te schrijven). Wil je een echt bestand? Gebruik Downloaden.';
  }

  let items = [];
  try { items = await projectStore.list(); } catch (err) { console.warn('Projecten ophalen mislukt:', err); }

  list.innerHTML = '';
  if (!items.length) {
    const p = document.createElement('p');
    p.className = 'settings-note';
    p.textContent = 'Nog geen opgeslagen shows.';
    list.appendChild(p);
    return;
  }

  for (const it of items) {
    const row = document.createElement('div');
    row.className = 'recent-row' + (it.name === projectName ? ' current' : '');

    const open = document.createElement('button');
    open.className = 'recent-open';
    open.innerHTML = `<span class="recent-name"></span><span class="recent-meta"></span>`;
    open.querySelector('.recent-name').textContent = it.name;
    open.querySelector('.recent-meta').textContent = [fmtWhen(it.savedAt), fmtSize(it.size)].filter(Boolean).join(' · ');
    open.addEventListener('click', () => openRecentProject(it.name));

    const del = document.createElement('button');
    del.className = 'btn kb-clear';
    del.textContent = 'Verwijder';
    del.addEventListener('click', (e) => { e.stopPropagation(); deleteRecentProject(it.name); });

    row.append(open, del);
    list.appendChild(row);
  }
}

async function openRecentProject(name) {
  if (locked) return;
  if (!(await confirmDiscardChanges())) return;
  try {
    const blob = await projectStore.load(name);
    if (!blob) throw new Error('Project niet gevonden');
    const proj = await importProject(await blob.arrayBuffer());
    await loadProject(proj);
    setProjectName(name);
    await renderRecentProjects();
    closeSettings();
  } catch (err) {
    console.error(err);
    await customConfirm('Openen mislukt: ' + err.message, { title: 'Fout', okLabel: 'OK' });
  }
}

async function deleteRecentProject(name) {
  if (locked) return;
  const ok = await customConfirm(`"${name}" definitief verwijderen?`, { title: 'Project verwijderen', okLabel: 'Verwijderen' });
  if (!ok) return;
  try {
    await projectStore.remove(name);
    await renderRecentProjects();
  } catch (err) {
    await customConfirm('Verwijderen mislukt: ' + err.message, { title: 'Fout', okLabel: 'OK' });
  }
}

async function openProjectFile(file) {
  if (locked) return;
  if (!(await confirmDiscardChanges())) return;
  try {
    const proj = await importProject(await file.arrayBuffer());
    await loadProject(proj);
    setProjectName((file.name || 'show').replace(/\.cgo$/i, '').replace(/\.[^.]+$/, ''));
    closeSettings();
  } catch (err) {
    console.error(err);
    alert('Openen mislukt: ' + err.message);
  }
}

async function loadProject(proj) {
  engine.stopAll();
  for (const c of cues.cues) {
    deleteAudio(c.id).catch(() => {});
    if (sharedShow) showSync.deleteAudio(c.id); // gedeelde show: ook op de server opruimen
  }
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
  // Gedeelde show: dit project wordt de show voor álle clients.
  if (sharedShow) await uploadWholeShow();
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

// Sneltoetsen lopen via de command-bus, niet rechtstreeks naar de functies:
// anders slaan ze de forward-hook over en speelt een niet-showcomputer zelf af.
function runAction(id, e) {
  switch (id) {
    case 'go': control.dispatch(e && e.shiftKey ? 'playAll' : 'go'); break;
    case 'playPause': control.dispatch('toggle'); break;
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
      if (e.key === 'Escape') {
        e.preventDefault();
        if (!$('eqModal').hidden) closeEq();
        else closeSettings();
      }
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

// --- Besturings-API (window.cuego + transports) ----------------------------

// Zoek een cue op via referentie: null → geselecteerde cue; anders match op
// zichtbaar nummer, dan op 1-gebaseerde positie, dan op id.
function resolveCue(ref) {
  if (ref == null || ref === '') return cues.selected;
  const s = String(ref);
  let c = cues.cues.find((x) => String(x.number) === s);
  if (c) return c;
  const n = parseInt(s, 10);
  if (String(n) === s && n >= 1 && n <= cues.cues.length) return cues.cues[n - 1];
  return cues.getById(s) || null;
}

// Speel een specifieke cue (of de geselecteerde) — selecteert 'm, schuift níet door.
function apiPlay(ref) {
  const cue = resolveCue(ref);
  if (!cue) return;
  const idx = cues.cues.indexOf(cue);
  selectOnly(cue.id, idx);
  syncInspector();
  playCue(cue);
}

// Selecteer via richting ('up'/'down'/'next'/'prev'/'first'/'last') of een cue-referentie.
function apiSelect(dirOrCue) {
  if (!cues.cues.length) return;
  const d = String(dirOrCue ?? '').toLowerCase();
  if (d === 'up' || d === 'prev' || d === 'previous') return moveSel(-1, false);
  if (d === 'down' || d === 'next') return moveSel(1, false);
  if (d === 'first') { selectOnly(cues.cues[0].id, 0); render(); syncInspector(); return; }
  if (d === 'last') { const i = cues.cues.length - 1; selectOnly(cues.cues[i].id, i); render(); syncInspector(); return; }
  const cue = resolveCue(dirOrCue);
  if (cue) { const i = cues.cues.indexOf(cue); selectOnly(cue.id, i); render(); syncInspector(); }
}

// Reset (QLab-gedrag): alles direct stoppen en de playhead terug naar de eerste cue.
function apiReset() {
  engine.stopAll();
  if (cues.cues.length) selectOnly(cues.cues[0].id, 0);
  render();
  syncInspector();
}

async function apiPause() {
  const cue = transportCue();
  if (cue && engine.isPlaying(cue.id)) { engine.pause(cue.id); render(); syncTransportProgress(); }
}
async function apiResume() {
  const cue = transportCue();
  if (!cue) return;
  if (engine.isPaused(cue.id)) { if (settings.singleCueMode) fadeOutOthers(cue.id); await engine.resume(cue.id); }
  else if (!engine.isPlaying(cue.id)) { await playCue(cue); }
  render();
  animateProgress();
  syncTransportProgress();
}

// Momentopname van de toestand (voor de netwerk-remote e.d.).
function apiState() {
  return {
    projectName,
    locked,
    // Eén bron van waarheid: elke remote leest dit uit dezelfde toestand, dus
    // alle apparaten tonen gegarandeerd hetzelfde.
    remoteEnabled: settings.remoteEnabled !== false,
    selectedId: cues.selected?.id ?? null,
    cues: cues.cues.map((c, i) => ({
      id: c.id,
      index: i + 1,
      number: c.number || '',
      name: c.name,
      selected: selection.has(c.id),
      playing: engine.isPlaying(c.id),
      paused: engine.isPaused(c.id),
      position: engine.position(c.id) || 0,
      duration: engine.playLength(c) || 0,
    })),
  };
}

// --- Afspeelbalk op een niet-showcomputer ----------------------------------
// Wij spelen dan zelf niets af, dus onze engine is leeg. De showcomputer pusht
// zijn toestand; die tonen we hier, zodat de balk en de voortgang meelopen.

let showState = null;
let showStateAt = 0; // wanneer we die toestand ontvingen — nodig om te interpoleren

// Zijn wij een client die meekijkt i.p.v. afspeelt?
function isFollower() {
  return !!(sharedShow && appLink && !appLink.isPrimary());
}

function remoteCue(id) {
  return showState?.cues?.find((c) => c.id === id) || null;
}

// Positie van een cue op de showcomputer, NU — vloeiend. Elke push hard
// overnemen zou elke ~halve seconde een sprongetje geven (netwerk-jitter maakt
// dat de gepushte positie nooit exact aansluit op onze eigen telling). Daarom
// loopt de getoonde positie gewoon op 1× snelheid door en buigt hij zachtjes
// richting de gepushte waarheid: kleine fouten smelten weg, alleen een échte
// sprong (seek, andere cue) wordt direct overgenomen.
const smoothPos = new Map(); // cueId -> { pos, at }

function remotePos(info) {
  if (!info) return 0;
  const basis = info.position || 0;
  if (!info.playing) { smoothPos.delete(info.id); return basis; } // gepauzeerd/stil → bevriezen
  const nu = performance.now();
  let doel = basis + (nu - showStateAt) / 1000; // waar de showcomputer nú zit
  const dur = info.duration || 0;

  // Zelf vooruit gokken op wat de cue gaat doen. Een loopende cue wikkelt aan
  // het einde terug naar het begin — dat weet deze client uit z'n eigen
  // cue-lijst, dus daar hoeft hij niet op een push te wachten. Zonder dit
  // plakt de balk elke ronde even op 100%. Zit de gok er een fractie naast,
  // dan corrigeert de volgende push dat toch.
  const cue = cues.getById(info.id);
  if (dur > 0 && cue?.loop) doel = doel % dur;

  const klem = (p) => (dur ? Math.min(p, dur) : p);

  const s = smoothPos.get(info.id);
  // Een loop-wikkel ís een sprong terug — direct overnemen, net als een seek.
  const gewikkeld = cue?.loop && s && doel < s.pos - 0.05;
  if (!s || gewikkeld || Math.abs(doel - s.pos) > 0.75) {
    // Eerste meting, of een echte sprong → direct overnemen.
    smoothPos.set(info.id, { pos: doel, at: nu });
    return klem(doel);
  }
  const dt = (nu - s.at) / 1000;
  s.at = nu;
  // 1× snelheid plus een zachte correctie (±25% van de fout per tik) — en de
  // balk mag daarbij nooit terugkruipen, dat oog vangt élk sprongetje terug.
  s.pos = Math.max(s.pos, s.pos + dt + (doel - s.pos) * Math.min(1, dt * 1.5));
  return klem(s.pos);
}

// Werk de rijen en de afspeelbalk bij met de toestand van de showcomputer.
// Bewust géén render(): dat bouwt de hele lijst opnieuw op, en dit draait een
// paar keer per seconde.
function applyRemotePlayback() {
  if (!showState) return;
  for (const cue of cues.cues) {
    const row = cueBody.querySelector(`tr[data-id="${cue.id}"]`);
    if (!row) continue;
    const info = remoteCue(cue.id);
    row.classList.toggle('playing', !!info?.playing);
    row.classList.toggle('paused', !!info?.paused);
    const fill = row.querySelector('[data-fill]');
    if (fill) {
      const pct = info?.duration ? Math.min(1, remotePos(info) / info.duration) * 100 : 0;
      fill.style.width = `${pct}%`;
    }
  }

  // De balk volgt wat er klinkt; klinkt er niets, dan onze eigen selectie.
  const playing = showState.cues?.find((c) => c.playing || c.paused);
  const info = playing || remoteCue(cues.selected?.id);
  if (!info) return;
  const pos = remotePos(info);
  tpName.textContent = info.name;
  tpCurrent.textContent = fmtTime(pos);
  tpDuration.textContent = fmtTime(info.duration);
  if (!seeking) {
    seekEl.value = info.duration ? Math.round((pos / info.duration) * 1000) : 0;
    updateSeekFill();
  }
  setPlayIcon(!!info.playing);
}

// Eigen animatielus van de meekijker — dezelfde 60fps-lus als de showcomputer,
// maar dan gevoed door de gepushte (en bijgebogen) positie. Een interval van
// 100ms is technisch juist maar óógt stapperig; pas op schermverversing wordt
// het écht vloeiend. Stopt vanzelf zodra er niets meer speelt.
let followRaf = null;
let followTimer = null;
function startFollowTicker() {
  if (followRaf || followTimer) return;
  const klaar = () => !isFollower() || !showState?.cues?.some((c) => c.playing);
  const stop = () => {
    cancelAnimationFrame(followRaf);
    clearInterval(followTimer);
    followRaf = null;
    followTimer = null;
  };
  const frame = () => {
    if (klaar()) { stop(); return; }
    applyRemotePlayback();
    followRaf = requestAnimationFrame(frame);
  };
  followRaf = requestAnimationFrame(frame);
  // Vangnet: in een verborgen tab staat requestAnimationFrame stil — dan volstaat
  // een grove tik, en moet ook het stoppen hiervandaan kunnen komen.
  followTimer = setInterval(() => {
    if (klaar()) { stop(); return; }
    if (document.visibilityState === 'hidden') applyRemotePlayback();
  }, 500);
}

// Korte melding rechtsonder. Geen dialoog: dit mag een show nooit blokkeren,
// maar stil mislukken mag het al helemaal niet.
let toastTimer = null;
function showToast(msg) {
  let el = $('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 4000);
}

// Commando's die geluid maken. Is een ándere client de showcomputer, dan gaan
// deze daarheen i.p.v. hier af te spelen. (`transition` niet: die opent eerst een
// prompt, en die hoort op het scherm te blijven waar je 'm intikt.)
const FORWARD_CMDS = new Set(['go', 'play', 'playAll', 'stop', 'panic', 'pause', 'resume', 'toggle', 'reset']);

// Geeft true als het commando is doorgestuurd (dan voeren we het hier niet uit).
function forwardCommand(cmd, args) {
  if (!sharedShow || !appLink || appLink.isPrimary()) return false; // wij zijn de showcomputer
  if (!FORWARD_CMDS.has(cmd)) return false;

  let payload = args;
  if (cmd === 'go') {
    // Stuur onze eigen selectie mee én schuif hier door, zodat beide kanten op
    // dezelfde volgende cue uitkomen.
    payload = { cue: cues.selected?.id ?? null };
    cues.advance();
    if (cues.selected) selectOnly(cues.selected.id, cues.selectedIndex);
    render();
    syncInspector();
  }
  // deviceId meesturen: dan weet de server dat dit een eigen client is en geen
  // remote van buitenaf (die valt onder de 'afstandsbediening uit'-blokkade).
  fetch('api/command', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cmd, args: payload, deviceId: deviceId() }),
  })
    .then(async (res) => {
      if (res.ok) return;
      // Niet stil laten mislukken: een GO die nergens landt is in een show het
      // ergste wat er kan gebeuren.
      const info = await res.json().catch(() => ({}));
      showToast(info.error || `Commando "${cmd}" is niet aangekomen bij de showcomputer.`);
    })
    .catch(() => showToast('Geen verbinding met de showcomputer.'));
  return true;
}

const control = createControl({
  forward: forwardCommand,
  go, playAll,
  play: apiPlay,
  stop: hardStop,
  reset: apiReset,
  panic,
  pause: apiPause,
  resume: apiResume,
  toggle: transportToggle,
  select: apiSelect,
  transition: openFadeInPrompt,
  state: apiState,
});
emit = control.emit;
window.cuego = publicApi(control);

// --- MIDI-controller -------------------------------------------------------

const MIDI_KEY = 'webqlab.midi.v1';
// Wat je aan een knop van je controller kunt koppelen (loopt via dezelfde command-bus).
const MIDI_ACTIONS = [
  { id: 'go', label: 'GO — speel + selecteer volgende', cmd: 'go' },
  { id: 'panic', label: 'Panic — fade alles uit (Esc)', cmd: 'panic' },
  { id: 'stop', label: 'Stop — direct stoppen', cmd: 'stop' },
  { id: 'pause', label: 'Pause', cmd: 'pause' },
  { id: 'resume', label: 'Resume', cmd: 'resume' },
  { id: 'toggle', label: 'Afspelen / pauze (wisselen)', cmd: 'toggle' },
  { id: 'reset', label: 'Reset — stop + terug naar de eerste cue', cmd: 'reset' },
  { id: 'selectUp', label: 'Vorige cue selecteren', cmd: 'select', args: { dir: 'up' } },
  { id: 'selectDown', label: 'Volgende cue selecteren', cmd: 'select', args: { dir: 'down' } },
  { id: 'transition', label: 'Transition (fade-in / crossfade)', cmd: 'transition' },
  { id: 'playAll', label: 'Alles tegelijk starten', cmd: 'playAll' },
];

let midiBinds = loadMidiBinds(); // { actionId: 'note:0:60' }
let midiLearning = null; // actie die nu op een knopdruk wacht
let midiDevices = [];

function loadMidiBinds() {
  try { return JSON.parse(localStorage.getItem(MIDI_KEY)) || {}; } catch { return {}; }
}
function saveMidiBinds() {
  try { localStorage.setItem(MIDI_KEY, JSON.stringify(midiBinds)); } catch { /* negeer */ }
}

const midi = createMidi({
  // Knop ingedrukt → eerst een globale actie, anders een cue met deze trigger.
  onTrigger: (sig) => {
    const hit = MIDI_ACTIONS.find((a) => midiBinds[a.id] === sig);
    if (hit) { control.dispatch(hit.cmd, hit.args); return; }
    const cue = cues.cues.find((c) => c.midiTrigger === sig);
    if (cue) control.dispatch('play', { cue: cue.id });
  },
  onDevices: (names) => { midiDevices = names; updateMidiUI(); },
});

// Eén knop hoort bij één ding. Haal een handtekening overal weg (globale acties én
// cue-triggers) behalve bij degene die 'm zojuist claimde.
function clearMidiSignature(sig, { keepActionId, keepCueId } = {}) {
  for (const a of MIDI_ACTIONS) {
    if (a.id !== keepActionId && midiBinds[a.id] === sig) delete midiBinds[a.id];
  }
  let cueChanged = false;
  for (const c of cues.cues) {
    if (c.id !== keepCueId && c.midiTrigger === sig) { c.midiTrigger = ''; cueChanged = true; }
  }
  saveMidiBinds();
  if (cueChanged) persist();
  return cueChanged;
}

async function setMidiEnabled(on) {
  if (on) {
    try {
      await midi.enable();
      settings.midiEnabled = true;
    } catch (err) {
      settings.midiEnabled = false;
      $('setMidi').checked = false;
      await customConfirm(`MIDI kon niet worden ingeschakeld: ${err.message}`, { title: 'MIDI', okLabel: 'OK' });
    }
  } else {
    midi.disable();
    midiLearning = null;
    settings.midiEnabled = false;
  }
  saveSettings();
  updateMidiUI();
}

// Toon status, apparaten en de koppelingen.
function updateMidiUI() {
  const note = $('midiNote');
  const list = $('midiList');
  const hint = $('midiHint');
  const field = $('midiSwitchField');
  if (!note || !list) return;

  if (!MIDI_SUPPORTED) {
    // Pagina blijft bereikbaar, maar legt uit waarom er niets te kiezen valt.
    note.textContent = 'Web MIDI wordt niet ondersteund in deze browser. Gebruik Chrome of Edge (en https of localhost).';
    if (field) field.hidden = true;
    list.hidden = true;
    if (hint) hint.hidden = true;
    return;
  }
  if (field) field.hidden = false;
  $('setMidi').checked = !!settings.midiEnabled;

  if (settings.midiEnabled) {
    note.textContent = midiDevices.length
      ? `Verbonden: ${midiDevices.join(', ')}`
      : 'Ingeschakeld, maar geen MIDI-apparaat gevonden. Sluit je controller aan.';
  } else {
    note.textContent = 'Bedien CueGo met een foot pedal of MIDI-knoppen. Werkt in de browser, geen server nodig.';
  }
  list.hidden = !settings.midiEnabled;
  if (hint) hint.hidden = !settings.midiEnabled;
  if (settings.midiEnabled) renderMidiBinds();
  syncCueMidi(); // het trigger-veld in de inspector volgt de MIDI-status
}

function renderMidiBinds() {
  const list = $('midiList');
  list.innerHTML = '';
  for (const a of MIDI_ACTIONS) {
    const row = document.createElement('div');
    row.className = 'keybind-row';

    const label = document.createElement('span');
    label.className = 'kb-label';
    label.textContent = a.label;

    const btn = document.createElement('button');
    const learning = midiLearning === a.id;
    btn.className = 'kb-key' + (learning ? ' capturing' : '');
    btn.textContent = learning ? 'Druk op een knop…' : describeSignature(midiBinds[a.id]);
    btn.addEventListener('click', () => {
      if (locked) return;
      if (learning) { midi.cancelLearn(); midiLearning = null; renderMidiBinds(); return; }
      midiLearning = a.id;
      renderMidiBinds();
      midi.learn((sig) => {
        // Dezelfde knop nooit aan twee dingen koppelen (ook niet aan een cue).
        const cueChanged = clearMidiSignature(sig, { keepActionId: a.id });
        midiBinds[a.id] = sig;
        midiLearning = null;
        saveMidiBinds();
        renderMidiBinds();
        if (cueChanged) syncInspector();
      });
    });

    const clear = document.createElement('button');
    clear.className = 'btn kb-clear';
    clear.textContent = 'Wissen';
    clear.disabled = !midiBinds[a.id] || locked;
    clear.addEventListener('click', () => {
      delete midiBinds[a.id];
      saveMidiBinds();
      renderMidiBinds();
    });

    row.append(label, btn, clear);
    list.appendChild(row);
  }
}

function bindMidiSettings() {
  const sw = $('setMidi');
  if (sw) sw.addEventListener('change', (e) => setMidiEnabled(e.target.checked));

  // Afstandsbediening aan/uit.
  const rw = $('setRemote');
  if (rw) rw.addEventListener('change', (e) => {
    settings.remoteEnabled = e.target.checked;
    saveSettings();
    appLink?.pushState(true);
    updateControlTab();
  });

  // --- MIDI preset import/export --------------------------------------------
  const saveMidiBtn = $('saveMidiBtn');
  const openMidiBtn = $('openMidiBtn');
  const midiInput = $('midiInput');

  if (saveMidiBtn) {
    saveMidiBtn.addEventListener('click', () => {
      const blob = new Blob(
        [JSON.stringify({ format: 'webqlab-midi', version: 1, bindings: midiBinds }, null, 2)],
        { type: 'application/json' }
      );
      downloadBlob(blob, 'midi-preset.cgomconfg');
    });
  }

  if (openMidiBtn) {
    openMidiBtn.addEventListener('click', () => midiInput?.click());
  }

  if (midiInput) {
    midiInput.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      e.target.value = '';
      if (!file) return;
      try {
        const data = JSON.parse(await file.text());
        const incoming = data.bindings || data;
        if (typeof incoming !== 'object') throw new Error('Geen geldige MIDI-koppelingen.');
        // Overwrite current bindings (keeping only actions that exist)
        for (const key of Object.keys(midiBinds)) delete midiBinds[key];
        Object.assign(midiBinds, incoming);
        saveMidiBinds();
        renderMidiBinds();
      } catch (err) {
        alert('Kon MIDI-preset niet lezen: ' + err.message);
      }
    });
  }
}

// --- MIDI-trigger per cue (inspector) --------------------------------------

let cueLearning = null; // cue-id dat op een knopdruk wacht

// Een cue-trigger hoort bij één cue, dus dit werkt op de primaire selectie
// (niet op alle geselecteerde cues — twee cues met dezelfde knop kan niet).
function syncCueMidi() {
  const btn = $('insMidiTrigger');
  const clear = $('insMidiClear');
  const hint = $('insMidiHint');
  if (!btn) return;
  const cue = cues.selected;
  const learning = cue && cueLearning === cue.id;

  btn.classList.toggle('capturing', !!learning);
  btn.textContent = learning ? 'Druk op een knop…' : describeSignature(cue?.midiTrigger);
  const usable = MIDI_SUPPORTED && settings.midiEnabled && !locked;
  btn.disabled = !usable;
  clear.disabled = !usable || !cue?.midiTrigger;
  if (hint) {
    hint.textContent = !MIDI_SUPPORTED ? '(MIDI niet ondersteund)'
      : !settings.midiEnabled ? '(zet MIDI aan bij Instellingen → MIDI)'
      : '';
  }
  // Grijs zolang MIDI-besturing uit staat — of zolang dit apparaat vergrendeld is.
  const section = document.querySelector('.ins-section[data-section="midi"]');
  if (section) section.classList.toggle('section-off', locked || !(MIDI_SUPPORTED && settings.midiEnabled));
}

function bindCueMidi() {
  const btn = $('insMidiTrigger');
  const clear = $('insMidiClear');
  if (!btn) return;

  btn.addEventListener('click', () => {
    const cue = cues.selected;
    if (!cue || locked || !settings.midiEnabled) return;
    if (cueLearning === cue.id) { midi.cancelLearn(); cueLearning = null; syncCueMidi(); return; }
    cueLearning = cue.id;
    syncCueMidi();
    midi.learn((sig) => {
      // Knop losweken van een globale actie of een andere cue.
      clearMidiSignature(sig, { keepCueId: cue.id });
      cue.midiTrigger = sig;
      cueLearning = null;
      persist();
      render();
      syncCueMidi();
      if (settings.midiEnabled) renderMidiBinds();
    });
  });

  clear.addEventListener('click', () => {
    const cue = cues.selected;
    if (!cue || locked) return;
    cue.midiTrigger = '';
    persist();
    render();
    syncCueMidi();
  });
}

// Stond MIDI aan? Dan bij het opstarten meteen weer verbinden.
async function initMidi() {
  if (MIDI_SUPPORTED && settings.midiEnabled) {
    try { await midi.enable(); } catch { settings.midiEnabled = false; }
  }
  updateMidiUI();
}

// Detecteer of we lokaal via server.mjs draaien. Zet een body-class zodat
// server-afhankelijke opties (netwerk-remote, OSC) automatisch (on)zichtbaar zijn.
let serverInfo = null;
let appLink = null;
let linkConnected = false;

// --- Gedeelde show (alleen zelf-gehost) -------------------------------------
// De server is dan eigenaar van de cue-lijst en elke client toont dezelfde show.
// Op statische hosting blijft alles lokaal, precies zoals het was.

let sharedShow = false;
let adminLock = false; // server heeft een admin-wachtwoord → elk apparaat start vergrendeld
let applyingRemote = false; // wijziging komt van een andere client → niet terugsturen
let pushShowTimer = null;
let lastPushed = '';

// Wijzigingen samenvoegen: tijdens het slepen van een volume-slider is één push
// aan het eind genoeg, geen tien per seconde.
function schedulePushShow() {
  if (!sharedShow || applyingRemote) return;
  clearTimeout(pushShowTimer);
  pushShowTimer = setTimeout(async () => {
    const metas = cues.cues.map(cueToMeta);
    // Naam hoort bij de show, niet bij het apparaat — anders heet dezelfde show
    // op elke client anders.
    const body = JSON.stringify({ name: projectName, cues: metas });
    if (body === lastPushed) return; // niets werkelijk veranderd
    lastPushed = body;
    try {
      await showSync.pushShow(appLink?.appId() ?? null, metas, projectName);
    } catch (err) {
      console.warn('Show synchroniseren mislukt:', err.message);
    }
  }, 250);
}

// Zet de show van de server neer. Bestaande cue-objecten passen we ter plekke aan
// i.p.v. ze te vervangen: de audio-engine houdt een referentie naar het cue-object
// van een spelende voice, en die mag niet losraken.
async function applyShow(show) {
  applyingRemote = true;

  // Laad-icoontje zolang de audio van de cues binnenkomt. Pas na 250ms tonen:
  // staat alles al in de lokale cache, dan is 't klaar vóór iemand iets ziet.
  const total = (show.cues || []).length;
  let loaded = 0;
  const loadingEl = $('cueLoading');
  const loadingText = $('cueLoadingText');
  const setProgress = () => { if (loadingText) loadingText.textContent = `Cues laden… (${loaded}/${total})`; };
  const showLoaderTimer = setTimeout(() => {
    if (!loadingEl) return;
    setProgress();
    loadingEl.hidden = false;
    cueListWrap.classList.add('loading');
  }, 250);

  try {
    const next = [];
    for (const m of show.cues || []) {
      let file = (await loadAudio(m.id)) || null; // lokale cache eerst
      if (!file) {
        file = await showSync.downloadAudio(m.id, m.fileName, m.fileType);
        if (file) saveAudio(m.id, file).catch(() => {});
      }
      loaded += 1;
      setProgress();
      if (!file) continue; // audio (nog) niet beschikbaar → cue overslaan
      const existing = cues.getById(m.id);
      if (existing) {
        Object.assign(existing, metaToCue(m, existing.file || file));
        engine.updateEq(existing.id, existing.eq); // EQ-wijziging van een andere client direct hoorbaar
        next.push(existing);
      } else {
        next.push(metaToCue(m, file));
      }
    }

    const selectedId = cues.selected?.id;
    cues.cues = next;
    // Selectie zo goed mogelijk vasthouden.
    const idx = next.findIndex((c) => c.id === selectedId);
    cues.selectedIndex = idx !== -1 ? idx : (next.length ? 0 : -1);
    selection.clear();
    if (cues.selected) selection.add(cues.selected.id);

    // Naam van de show overnemen (die hoort bij de show, niet bij dit apparaat).
    if (show.name && show.name !== projectName) setProjectName(show.name);

    saveMeta(cues.cues); // lokale cache bijwerken
    lastPushed = JSON.stringify({ name: projectName, cues: cues.cues.map(cueToMeta) }); // kwam van de server
    render();
    // Niet de inspector verversen terwijl iemand in een veld typt — dan zou de
    // tekst onder z'n handen verspringen.
    if (!isTyping()) syncInspector();
  } finally {
    clearTimeout(showLoaderTimer);
    if (loadingEl) loadingEl.hidden = true;
    cueListWrap.classList.remove('loading');
    applyingRemote = false;
  }
}

// Onze lokale show wordt de gedeelde show (server was nog leeg).
async function uploadWholeShow() {
  for (const c of cues.cues) {
    try {
      if (!(await showSync.hasAudio(c.id))) await showSync.uploadAudio(c.id, c.file);
    } catch (err) {
      console.warn('Uploaden mislukt:', c.name, err.message);
    }
  }
  const metas = cues.cues.map(cueToMeta);
  lastPushed = JSON.stringify({ name: projectName, cues: metas });
  await showSync.pushShow(appLink?.appId() ?? null, metas, projectName).catch((err) => console.warn(err.message));
}

// Bij opstarten: heeft de server een show, dan wint die. Is de server leeg en
// hebben wij cues, dan wordt onze show de gedeelde show.
async function initSharedShow() {
  try {
    const show = await showSync.fetchShow();
    if (show.cues?.length) await applyShow(show);
    else if (cues.cues.length) await uploadWholeShow();
  } catch (err) {
    console.warn('Gedeelde show laden mislukt:', err.message);
  }
}

async function initServerDetection() {
  serverInfo = await detectServer();
  document.body.classList.toggle('has-server', !!serverInfo);
  document.body.classList.toggle('no-server', !serverInfo);
  // Lokaal → shows als bestand in projects/; statisch gehost → IndexedDB.
  projectStore = createProjectStore(!!serverInfo);
  renderRecentProjects();
  // Lokaal? Dan luisteren naar commando's van remotes en onze toestand terugsturen.
  if (serverInfo) {
    sharedShow = true; // de server is nu eigenaar van de cue-lijst
    // Admin-wachtwoord op de server → dit apparaat begint vergrendeld, tot het
    // wachtwoord hiér is ingevuld (Instellingen → Beveiliging).
    adminLock = !!serverInfo.adminLock;
    if (adminLock) setLocked(true);
    appLink = connectAppLink({
      // dispatchLocal: dit komt al van de server, dus hier uitvoeren en niet
      // opnieuw doorsturen (dat zou een lus geven).
      dispatch: control.dispatchLocal,
      getState: apiState,
      on: control.on, // pusht de toestand pas ná een render (niet halverwege een async dispatch)
      onStatus: ({ connected }) => { linkConnected = connected; updateControlTab(); },
      onShow: (show) => { applyShow(show); }, // andere client wijzigde de show
      // Afspeelbalk volgt de showcomputer; het klokje overbrugt de gaten tussen pushes.
      onState: (st) => {
        showState = st;
        showStateAt = performance.now();
        applyRemotePlayback();
        if (st?.cues?.some((c) => c.playing)) startFollowTicker();
      },
      label: deviceLabel(), // gaat meteen mee bij het verbinden
      isLocked: () => locked, // gaat mee in het levensteken
      onLock: (lockIt) => { if (lockIt !== locked) setLocked(lockIt); }, // op afstand (ont)grendeld
      onDevices: (info) => {
        devicesInfo = info;
        document.body.classList.toggle('is-showcomputer', info.showDeviceId === deviceId());
        renderDevices();
      },
    });
    await initSharedShow();
  }
  updateControlTab();
}

// --- Multi-device: wie is de showcomputer? ---------------------------------

const DEVICE_LABEL_KEY = 'webqlab.deviceLabel';
let devicesInfo = { showDeviceId: null, you: null, devices: [] };

// Zelf een naam gegeven? Die wint. Anders iets herkenbaars uit de browser afleiden.
function deviceLabel() {
  return localStorage.getItem(DEVICE_LABEL_KEY) || defaultDeviceLabel();
}

// Een ander apparaat op afstand (ont)grendelen vanuit het Multi-device-paneel.
async function setRemoteLock(id, lockIt) {
  await fetch('api/devices', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lockDeviceId: id, locked: lockIt }),
  }).catch(() => {});
}

// Onze naam doorgeven zodat je de apparaten in de lijst uit elkaar houdt.
async function sendDeviceLabel(label) {
  await fetch('api/devices', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId: deviceId(), label }),
  }).catch(() => {});
}

async function claimShowComputer(id) {
  await fetch('api/devices', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ showDeviceId: id }),
  }).catch(() => {});
}

function renderDevices() {
  const list = $('deviceList');
  if (!list) return;
  const input = $('setDeviceLabel');
  if (input && document.activeElement !== input) {
    input.value = localStorage.getItem(DEVICE_LABEL_KEY) || '';
    input.placeholder = defaultDeviceLabel(); // leeg = deze naam wordt gebruikt
  }

  list.innerHTML = '';
  if (!devicesInfo.devices.length) {
    const p = document.createElement('p');
    p.className = 'settings-note';
    p.textContent = 'Nog geen apparaten verbonden.';
    list.appendChild(p);
    return;
  }

  for (const d of devicesInfo.devices) {
    const row = document.createElement('div');
    row.className = 'device-row' + (d.deviceId === deviceId() ? ' is-me' : '');

    const name = document.createElement('span');
    name.className = 'device-name';
    name.textContent = d.label + (d.deviceId === deviceId() ? ' (dit apparaat)' : '');

    const tag = document.createElement('span');
    tag.className = 'device-tag';
    tag.textContent = [d.isShow ? '🔊 showcomputer' : '', d.locked ? '🔒 vergrendeld' : ''].filter(Boolean).join(' · ');

    row.append(name, tag);

    if (!d.isShow) {
      const btn = document.createElement('button');
      btn.className = 'btn kb-clear';
      btn.textContent = 'Maak showcomputer';
      btn.disabled = locked; // vanaf een vergrendeld apparaat niets omgooien
      btn.addEventListener('click', () => claimShowComputer(d.deviceId));
      row.appendChild(btn);
    }

    const isMe = d.deviceId === deviceId();
    const lockBtn = document.createElement('button');
    lockBtn.className = 'btn kb-clear';
    lockBtn.textContent = d.locked ? 'Ontgrendel' : 'Vergrendel';
    if (isMe && locked) {
      // Jezelf losmaken mag altijd — maar dan via het wachtwoord. Zonder deze
      // uitzondering zet je jezelf klem: de knop staat uit zodra je vergrendeld bent.
      lockBtn.disabled = false;
      lockBtn.addEventListener('click', () => toggleLock());
    } else {
      // Andermans apparaat omgooien mag niet vanaf een vergrendeld apparaat.
      lockBtn.disabled = locked;
      lockBtn.addEventListener('click', () => setRemoteLock(d.deviceId, !d.locked));
    }
    row.appendChild(lockBtn);

    list.appendChild(row);
  }
}

function bindDevices() {
  const input = $('setDeviceLabel');
  if (!input) return;
  input.addEventListener('change', (e) => {
    const label = e.target.value.trim();
    if (label) localStorage.setItem(DEVICE_LABEL_KEY, label);
    else localStorage.removeItem(DEVICE_LABEL_KEY); // leeg = terug naar de standaardnaam
    sendDeviceLabel(deviceLabel());
  });
}

// Toon in het Besturing-tabblad of de server-afhankelijke opties beschikbaar zijn.
function updateControlTab() {
  const status = $('controlServerStatus');
  if (!status) return;
  status.textContent = serverInfo
    ? `CueGo draait lokaal (server.mjs) — netwerk-remote en OSC zijn beschikbaar.${linkConnected ? ' Verbonden.' : ''}`
    : 'Statisch gehost — alleen de JavaScript-API en MIDI werken hier. Start CueGo lokaal met "node server.mjs" voor netwerk-remote en OSC.';
  status.classList.toggle('ok', !!serverInfo);

  // Remote-URL's: op elk LAN-adres waarop de server bereikbaar is.
  const urls = $('remoteUrls');
  if (urls && serverInfo) {
    const port = serverInfo.port || location.port;
    const hosts = (serverInfo.ips || []).length ? serverInfo.ips : [location.hostname];
    urls.innerHTML = '';
    for (const ip of hosts) {
      const href = `http://${ip}:${port}/remote.html`;
      const a = document.createElement('a');
      a.className = 'remote-url';
      a.href = href;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = href;
      urls.appendChild(a);
    }
    const note = $('remoteTokenNote');
    if (note) {
      note.textContent = serverInfo.adminLock
        ? 'De remote vraagt om het admin-wachtwoord (dat je bij het starten hebt ingevuld).'
        : 'Zonder admin-wachtwoord kan iedereen op dit netwerk de show bedienen. Vul er bij het starten van de server één in als je dat niet wilt.';
    }
  }

  // OSC-status: luistert 'ie, en zo niet, waarom niet.
  const osc = $('oscStatus');
  if (osc && serverInfo) {
    const info = serverInfo.osc || {};
    osc.textContent = info.enabled
      ? `Luistert op UDP-poort ${info.port}. Stuur OSC vanaf een lichttafel, QLab of ander show-control-systeem:`
      : serverInfo.adminLock
        ? 'Uit, omdat er een admin-wachtwoord is ingesteld en OSC geen wachtwoord kent. Toch aanzetten: CUEGO_OSC=on node server.mjs'
        : `Uit — poort ${info.port || 53000} was bezet of OSC staat op off. Andere poort: CUEGO_OSC_PORT=53001`;
    osc.classList.toggle('ok', !!info.enabled);
  }
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
  applyInspectorLayout();
}

// --- Inspector: breedte slepen ----------------------------------------------

const INSPECTOR_MIN = 240;
const INSPECTOR_MAX = 680;

const clampInspector = (w) => Math.min(INSPECTOR_MAX, Math.max(INSPECTOR_MIN, w || 290));

// Eén plek die de inspector-breedte zet: de variabele (voor de inner) én
// flex-basis rechtstreeks (die kan geen var() aan zolang hij getransitioneerd wordt).
function applyInspectorLayout() {
  const w = clampInspector(settings.inspectorWidth);
  document.documentElement.style.setProperty('--inspector-w', `${w}px`);
  const insp = $('inspector');
  if (insp) insp.style.flexBasis = settings.inspectorHidden ? '0px' : `${w}px`;
}

function bindInspectorResize() {
  const handle = $('inspectorResize');
  if (!handle) return;
  let startX = 0;
  let startW = 0;
  let liveW = 0;

  const onMove = (e) => {
    // Naar links slepen = breder (de inspector zit rechts).
    liveW = clampInspector(startW + (startX - e.clientX));
    document.documentElement.style.setProperty('--inspector-w', `${liveW}px`);
    $('inspector').style.flexBasis = `${liveW}px`;
  };
  const onUp = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    document.body.classList.remove('resizing-inspector');
    if (liveW) { settings.inspectorWidth = liveW; saveSettings(); }
  };

  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    startX = e.clientX;
    startW = $('inspector').getBoundingClientRect().width;
    liveW = startW;
    document.body.classList.add('resizing-inspector');
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  });

  // Dubbelklik op de greep → terug naar de standaardbreedte.
  handle.addEventListener('dblclick', () => {
    settings.inspectorWidth = 290;
    saveSettings();
    applyInspectorLayout();
  });
}

// --- Inspector: inklapbare secties ------------------------------------------

// Accordeon: er staat er één open. Klap je een andere open, dan gaat de vorige
// dicht — zo blijft de inspector overzichtelijk zonder te scrollen.
const INS_OPEN_KEY = 'webqlab.inspectorOpen.v1';

function loadInsOpen() {
  const v = localStorage.getItem(INS_OPEN_KEY);
  return v === null ? 'general' : v; // standaard: Algemeen ('' = alles dicht)
}
function saveInsOpen(id) {
  try { localStorage.setItem(INS_OPEN_KEY, id || ''); } catch { /* negeer */ }
}

function setOpenSection(id) {
  for (const s of document.querySelectorAll('.ins-section')) {
    s.classList.toggle('collapsed', s.dataset.section !== id);
  }
  saveInsOpen(id);
}

// Wat je tijdens een show nog mag bijstellen op een vergrendeld apparaat.
// De rest van de inspector heeft dan niets te bieden en wordt grijs.
const SECTIONS_EDITABLE_WHEN_LOCKED = ['fades', 'loop'];

function applyLockToSections() {
  const sections = [...document.querySelectorAll('.ins-section')];
  if (!sections.length) return;
  for (const s of sections) {
    const id = s.dataset.section;
    const usable = !locked || SECTIONS_EDITABLE_WHEN_LOCKED.includes(id);
    // MIDI regelt z'n eigen grijs (hangt ook van de MIDI-status af).
    if (id !== 'midi') s.classList.toggle('section-off', !usable);
  }
  if (!locked) return;
  // Sta je op een sectie die nu niets meer doet? Spring naar de eerste die wél werkt.
  const open = sections.find((s) => !s.classList.contains('collapsed'));
  const openId = open?.dataset.section;
  if (!openId || !SECTIONS_EDITABLE_WHEN_LOCKED.includes(openId)) {
    setOpenSection(SECTIONS_EDITABLE_WHEN_LOCKED[0]);
  }
}

function bindInspectorSections() {
  setOpenSection(loadInsOpen());
  applyLockToSections();
  for (const section of document.querySelectorAll('.ins-section')) {
    section.querySelector('.ins-head').addEventListener('click', () => {
      // Nogmaals op de open sectie klikken = dichtklappen (dan staat alles dicht).
      const isOpen = !section.classList.contains('collapsed');
      setOpenSection(isOpen ? '' : section.dataset.section);
    });
  }
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

function bindAudioSettings() {
  const select = $('audioDeviceSelect');
  const testBtn = $('audioTestBtn');
  const refreshBtn = $('audioRefreshBtn');
  const status = $('audioTestStatus');
  const note = $('audioSupportNote');
  if (!select) return;

  const supported = !!window.AudioContext?.prototype?.setSinkId;
  if (!supported) {
    note.textContent = '⚠️ Je browser ondersteunt het wisselen van audio-uitvoer niet. Gebruik Chrome of Edge.';
    select.disabled = true;
    testBtn.disabled = true;
    refreshBtn.disabled = true;
    return;
  } else {
    note.textContent = '✅ Je browser ondersteunt het wisselen van audio-uitvoer.';
  }

  // Houd een dummy-audiostream vast zodat de toestemming blijft bestaan
  let dummyStream = null;

  async function requestPermission() {
    if (dummyStream) return true;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      dummyStream = stream; // niet stoppen, anders vervalt de toestemming
      return true;
    } catch (err) {
      console.warn('Geen toestemming voor audio-apparaten:', err);
      note.textContent = '⚠️ Toestemming geweigerd. Alleen standaarduitvoer beschikbaar.';
      return false;
    }
  }

  async function refreshDevices() {
    const hasPerm = await requestPermission();
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const outputs = devices.filter(d => d.kind === 'audiooutput');
      console.log('Gevonden audio-uitvoerapparaten:', outputs); // voor debug

      select.innerHTML = '';

      if (outputs.length === 0) {
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = 'Geen uitvoerapparaten gevonden';
        select.appendChild(opt);
        return;
      }

      // Eerst de standaard (systeem)
      const def = document.createElement('option');
      def.value = '';
      def.textContent = 'Standaard (systeem)';
      select.appendChild(def);

      // De andere apparaten, met een leesbare naam
      let unknownCount = 0;
      for (const d of outputs) {
        const opt = document.createElement('option');
        opt.value = d.deviceId;
        // Label kan leeg zijn als er geen toestemming is; dan gebruiken we een nummer
        let label = d.label || d.deviceId;
        if (!label || label === '') {
          unknownCount++;
          label = `Apparaat ${unknownCount}`;
        }
        opt.textContent = label;
        select.appendChild(opt);
      }

      // Herstel de opgeslagen selectie
      const saved = settings.audioOutputDeviceId || '';
      if (outputs.some(d => d.deviceId === saved)) {
        select.value = saved;
      } else {
        select.value = '';
      }
    } catch (err) {
      console.warn('Kan audio-apparaten niet opsommen:', err);
      status.textContent = '❌ Fout bij ophalen apparaten';
    }
  }

  // Eerste keer laden
  refreshDevices();

  // Verversknop
  refreshBtn.addEventListener('click', refreshDevices);

  // Luister naar apparaatwijzigingen (in-/uitpluggen)
  navigator.mediaDevices.addEventListener('devicechange', () => {
    status.textContent = '🔄 Apparaten gewijzigd, vernieuwen…';
    refreshDevices();
    setTimeout(() => status.textContent = '', 2000);
  });

  // Selectie wijzigen
  select.addEventListener('change', async () => {
    const id = select.value;
    settings.audioOutputDeviceId = id;
    saveSettings();
    try {
      await engine.setSinkId(id || '');
      status.textContent = '✅ Toegepast';
      setTimeout(() => status.textContent = '', 2000);
    } catch (err) {
      status.textContent = '❌ Fout: ' + err.message;
    }
  });

  // Testtoon
  testBtn.addEventListener('click', async () => {
    try {
      const ctx = engine._ensureContext();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = 'sine';
      gain.gain.setValueAtTime(0.3, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.5);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.5);
      status.textContent = '🔊 Testtoon afgespeeld';
      setTimeout(() => status.textContent = '', 1500);
    } catch (err) {
      status.textContent = '❌ Test mislukt: ' + err.message;
    }
  });
}

async function restoreFromStorage() {
  engine.sinkId = settings.audioOutputDeviceId || '';
  const meta = loadMeta();
  if (!meta.length) return;
  for (const m of meta) {
    const file = await loadAudio(m.id);
    if (!file) continue;
    cues.addExisting(metaToCue(m, file));
  }
  if (cues.cues.length) selectOnly(cues.cues[0].id, 0);
  render();
  syncInspector();
}

bindAudioSettings();
bindTopbar();
bindTransportBar();
bindPreviewBar();
bindLoaders();
bindMenus();
bindInspector();
bindSettings();
bindMidiSettings();
bindDevices();
bindUnlock();
bindCueMidi();
bindEq();
bindSwitchBlur();
bindProjectTitle();
bindKeyboard();
bindInspectorResize();
bindInspectorSections();
applySingleCueBadge();
applyInspectorVisibility(); // roept applyInspectorLayout aan (breedte + in/uitgeklapt)
locked = hasPassword() && localStorage.getItem(LOCKED_KEY) === '1';
applyLockState();
updateProjectTitle();
render();
syncInspector();

// Volgorde is van belang: eerst de lokale show terug, dan pas de server-detectie.
// initSharedShow() moet weten of we al cues hebben — is de server leeg, dan wordt
// onze show de gedeelde show; heeft de server er een, dan wint die.
(async () => {
  await restoreFromStorage();
  await initServerDetection();
  initMidi();
})();
