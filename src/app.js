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
const defaultSettings = { defaultFadeIn: 0, escFade: 3, singleCueMode: false, blockBrowserKeys: true };
const settings = { ...defaultSettings, ...loadSettings() };

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
  { id: 'fadeOut', label: 'Fade uit (2× = direct stop)' },
  { id: 'delete', label: 'Verwijder selectie' },
  { id: 'fullscreen', label: 'Volledig scherm' },
];
const KEY_PRESETS = {
  default: { go: ' ', playPause: '', selectUp: 'ArrowUp', selectDown: 'ArrowDown', selectNext: '', fadeOut: 'Escape', delete: 'Backspace', fullscreen: 'f' },
  vlc: { go: '', playPause: ' ', selectUp: 'ArrowUp', selectDown: 'ArrowDown', selectNext: '', fadeOut: 'Escape', delete: 'Backspace', fullscreen: 'f' },
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

// --- Rendering -------------------------------------------------------------

function render() {
  cueBody.innerHTML = '';
  cueListWrap.classList.toggle('has-cues', cues.cues.length > 0);

  cues.cues.forEach((cue, i) => {
    const tr = document.createElement('tr');
    tr.dataset.id = cue.id;
    tr.draggable = true;
    if (selection.has(cue.id)) tr.classList.add('selected');
    if (engine.isPlaying(cue.id)) tr.classList.add('playing');
    else if (engine.isPaused(cue.id)) tr.classList.add('paused');

    tr.innerHTML = `
      <td class="col-num">${cue.number ? escapeHtml(cue.number) : i + 1}</td>
      <td class="col-status"></td>
      <td class="col-name">${escapeHtml(cue.name)}</td>
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
    numCell.addEventListener('dblclick', (e) => { e.stopPropagation(); startInlineNumberEdit(numCell, cue); });
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
  $('insVolume').value = cue.volume;
  $('insVolumeVal').textContent = `${Math.round(cue.volume * 100)}%`;
}

function persist() { saveMeta(cues.cues); }

function bindInspector() {
  $('insNumber').addEventListener('input', (e) => withSelected((c) => { c.number = e.target.value; render(); persist(); }));
  $('insName').addEventListener('input', (e) => withSelected((c) => { c.name = e.target.value; render(); persist(); }));
  $('insFadeIn').addEventListener('input', (e) => withSelected((c) => { c.fadeIn = num(e.target.value, 0); render(); persist(); }));
  $('insFadeOut').addEventListener('input', (e) => withSelected((c) => { c.fadeOut = num(e.target.value, 0); render(); persist(); }));
  $('insVolume').addEventListener('input', (e) => withSelected((c) => {
    c.volume = num(e.target.value, 1);
    $('insVolumeVal').textContent = `${Math.round(c.volume * 100)}%`;
    render();
    persist();
  }));
  $('moveUpBtn').addEventListener('click', () => withSelected((c) => { cues.move(c.id, -1); render(); persist(); }));
  $('moveDownBtn').addEventListener('click', () => withSelected((c) => { cues.move(c.id, 1); render(); persist(); }));
  $('deleteBtn').addEventListener('click', deleteSelected);
}

function withSelected(fn) { const cue = cues.selected; if (cue) fn(cue); }
function num(v, fallback) { const n = parseFloat(v); return Number.isNaN(n) ? fallback : n; }

function deleteSelected() {
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
      selectOnly(cues.cues[idx + 1].id, idx + 1);
      syncInspector();
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

function go() {
  const cue = cues.selected;
  if (!cue) return;
  playCue(cue); // herstart als hij al speelt → nooit dubbel
  cues.advance();
  selectOnly(cues.selected.id, cues.selectedIndex);
  render();
  syncInspector();
}

function escFadeSeconds() { return Number.isFinite(settings.escFade) ? settings.escFade : 3; }

function panic() {
  const secs = escFadeSeconds();
  engine.fadeOutAll(secs);
  setTimeout(render, secs * 1000 + 100);
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
      const dur = engine.duration(cueId) || 1;
      const pct = Math.min(1, engine.position(cueId) / dur);
      const fill = document.querySelector(`[data-fill="${cueId}"]`);
      if (fill) fill.style.width = `${pct * 100}%`;
    }
    syncTransportProgress();
    rafId = anyActive ? requestAnimationFrame(tick) : null;
  };
  rafId = requestAnimationFrame(tick);
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

function syncTransport() {
  const cue = transportCue();
  if (!cue) {
    tpName.textContent = '';
    tpCurrent.textContent = '0:00';
    tpDuration.textContent = '0:00';
    seekEl.value = 0;
    setPlayIcon(false);
    return;
  }
  tpName.textContent = cue.name;
  const known = engine.duration(cue.id);
  if (known) tpDuration.textContent = fmtTime(known);
  else engine.prepare(cue).then(() => { if (transportCue() === cue) tpDuration.textContent = fmtTime(engine.duration(cue.id)); }).catch(() => {});
  syncTransportProgress();
}

function syncTransportProgress() {
  const cue = transportCue();
  if (!cue) { setPlayIcon(false); return; }
  const dur = engine.duration(cue.id) || 0;
  const pos = engine.position(cue.id);
  tpCurrent.textContent = fmtTime(pos);
  if (!seeking) seekEl.value = dur ? Math.round((pos / dur) * 1000) : 0;
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
    const cue = transportCue();
    if (!cue) return;
    const dur = engine.duration(cue.id) || 0;
    tpCurrent.textContent = fmtTime((seekEl.value / 1000) * dur);
  });

  seekEl.addEventListener('change', async () => {
    seeking = false;
    const cue = transportCue();
    if (!cue) return;
    const dur = engine.duration(cue.id) || (await engine.prepare(cue));
    await engine.seek(cue, (seekEl.value / 1000) * dur, { onEnded: onCueEnded });
    render();
    if (engine.isPlaying(cue.id)) animateProgress();
    syncTransportProgress();
  });
}

// --- Bestanden inladen -----------------------------------------------------

function addFiles(fileList) {
  let added = 0;
  for (const file of fileList) {
    if (!isAudioFile(file)) continue;
    const cue = cues.add(file);
    cue.fadeIn = settings.defaultFadeIn; // standaard fade-in uit instellingen
    saveAudio(cue.id, file).catch((err) => console.warn('Opslaan mislukt:', err));
    added += 1;
  }
  if (added > 0) {
    cues.sortByTitleNumber(); // sorteer op nummer in de titel bij importeren
    selectOnly(cues.cues[0].id, 0);
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
    if (!isFileDrag(e)) return; // interne herorden-drag → geen "toevoegen"-overlay
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    showDrop();
    clearTimeout(dragHideTimer);
    dragHideTimer = setTimeout(hideDrop, 150);
  });
  window.addEventListener('dragend', () => { clearTimeout(dragHideTimer); hideDrop(); });
  window.addEventListener('drop', async (e) => {
    if (!isFileDrag(e)) return;
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

function isModalOpen() { return !settingsModal.hidden; }
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
  $('setEscFade').value = settings.escFade;
  $('setSingleCue').checked = settings.singleCueMode;
  $('setBlockKeys').checked = settings.blockBrowserKeys;
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
    btn.addEventListener('click', () => { capturingAction = capturing ? null : a.id; renderKeybinds(); });
    row.append(label, btn);
    list.appendChild(row);
  }
}

function applyPreset(name) {
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
  $('setEscFade').addEventListener('input', (e) => { settings.escFade = num(e.target.value, 3); saveSettings(); });
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

  $('saveProjectBtn').addEventListener('click', saveProject);
  $('openProjectBtn').addEventListener('click', () => $('projectInput').click());
  $('projectInput').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (file) await openProjectFile(file);
  });
}

async function saveProject() {
  if (cues.cues.length === 0) { alert('Er zijn nog geen cues om op te slaan.'); return; }
  try {
    const blob = await exportProject(cues.cues, settings);
    downloadBlob(blob, 'show.webqlab');
  } catch (err) {
    console.error(err);
    alert('Opslaan mislukt: ' + err.message);
  }
}

async function openProjectFile(file) {
  try {
    const proj = await importProject(await file.arrayBuffer());
    await loadProject(proj);
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

  for (const c of proj.cues) {
    cues.addExisting(c);
    saveAudio(c.id, c.file).catch(() => {});
  }
  if (cues.cues.length) selectOnly(cues.cues[0].id, 0);
  render();
  syncInspector();
  persist();
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

function isTyping() { return ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName); }

function runAction(id, e) {
  switch (id) {
    case 'go': go(); break;
    case 'playPause': transportToggle(); break;
    case 'selectUp': moveSel(-1, e.shiftKey); break;
    case 'selectDown': moveSel(1, e.shiftKey); break;
    case 'selectNext': moveSel(1, false); break;
    case 'delete': deleteSelected(); break;
    case 'fullscreen': toggleFullscreen(); break;
    default: break;
  }
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
  if (!document.fullscreenElement) document.documentElement.requestFullscreen?.().catch(() => {});
  else document.exitFullscreen?.();
}

function bindTopbar() { $('fsBtn').addEventListener('click', toggleFullscreen); }

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
      volume: m.volume ?? 1,
    });
  }
  if (cues.cues.length) selectOnly(cues.cues[0].id, 0);
  render();
  syncInspector();
}

bindTopbar();
bindTransportBar();
bindLoaders();
bindMenus();
bindInspector();
bindSettings();
bindKeyboard();
applySingleCueBadge();
render();
syncInspector();
restoreFromStorage();
