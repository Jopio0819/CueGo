// plugin.mjs — de CueGo-plugin voor Stream Deck.
//
// Stream Deck start dit bestand met argumenten (-port, -pluginUUID, -registerEvent,
// -info) en verwacht dat we een WebSocket openen en ons registreren. Daarna komen
// er events binnen (knop verschijnt, knop ingedrukt) en sturen wij opdrachten terug
// (titel zetten, waarschuwing tonen).
//
// De plugin bewaart zelf geen showtoestand: hij vraagt die op bij CueGo en zet 'm
// op de knoppen. Zo is er altijd maar één bron van waarheid — de showcomputer.

import { connect } from './ws.mjs';
import { createClient, REASON } from './cuego.mjs';

// --- Argumenten van Stream Deck ---------------------------------------------

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('-') && argv[i + 1] != null) { out[a.slice(1)] = argv[++i]; }
  }
  return out;
}
const ARGS = parseArgs(process.argv.slice(2));
const PORT = Number(ARGS.port);
const UUID = ARGS.pluginUUID;
const REGISTER_EVENT = ARGS.registerEvent || 'registerPlugin';

if (!PORT || !UUID) {
  console.error('Deze plugin hoort door Stream Deck gestart te worden (-port/-pluginUUID ontbreken).');
  process.exit(1);
}

// --- Instellingen ------------------------------------------------------------

// Eén keer instellen, geldt voor alle knoppen (globale instellingen van Stream Deck).
let settings = { host: '127.0.0.1', port: 4321, password: '' };
const cuego = createClient(() => settings);

// --- Acties -------------------------------------------------------------------

const PREFIX = 'me.cue-go.streamdeck';

// Welke actie stuurt welk CueGo-commando. Exact de commando's die remote.html
// ook gebruikt, zodat er maar één contract is.
const ACTIONS = {
  [`${PREFIX}.go`]:     { cmd: 'go' },
  [`${PREFIX}.stop`]:   { cmd: 'stop' },
  [`${PREFIX}.toggle`]: { cmd: 'toggle' },
  [`${PREFIX}.panic`]:  { cmd: 'panic' },
  [`${PREFIX}.next`]:   { cmd: 'select', args: { dir: 'down' } },
  [`${PREFIX}.prev`]:   { cmd: 'select', args: { dir: 'up' } },
  [`${PREFIX}.playcue`]: { cmd: 'play' }, // cue komt uit de knopinstellingen
};

// Knoppen die live meelezen met de show. De rest houdt gewoon z'n eigen titel.
const FEEDBACK_ACTIONS = new Set([`${PREFIX}.go`, `${PREFIX}.toggle`, `${PREFIX}.playcue`]);

// Zichtbare knoppen: context → { action, settings }.
const visible = new Map();

// --- Verbinding met Stream Deck ------------------------------------------------

let ws = null;

function sendSD(event, context, payload) {
  if (!ws?.isOpen) return;
  const msg = { event, context };
  if (payload !== undefined) msg.payload = payload;
  ws.send(JSON.stringify(msg));
}

const setTitle = (context, title) => sendSD('setTitle', context, { title: String(title ?? ''), target: 0 });
const setState = (context, state) => sendSD('setState', context, { state });
const showAlert = (context) => sendSD('showAlert', context);
const showOk = (context) => sendSD('showOk', context);

// --- Cue opzoeken --------------------------------------------------------------

// De gebruiker vult een cuenummer, volgnummer of naam in — niet het interne id.
// We zoeken 'm op in de laatst opgehaalde toestand.
function findCue(state, wanted) {
  const q = String(wanted ?? '').trim();
  if (!q || !state?.cues?.length) return null;
  const lower = q.toLowerCase();
  return (
    state.cues.find((c) => String(c.number || '').toLowerCase() === lower) ||
    (/^\d+$/.test(q) ? state.cues.find((c) => c.index === Number(q)) : null) ||
    state.cues.find((c) => String(c.name || '').toLowerCase() === lower) ||
    null
  );
}

// --- Knopdruk -------------------------------------------------------------------

async function onKeyDown(context, action, keySettings) {
  const spec = ACTIONS[action];
  if (!spec) return;

  let args = spec.args;

  // "Cue afspelen" heeft een cue nodig; die zoeken we op in de actuele toestand.
  if (action === `${PREFIX}.playcue`) {
    const st = await cuego.state();
    if (st.reason !== REASON.ok) { flagProblem(context, st.reason); return; }
    const cue = findCue(st.data, keySettings?.cue);
    if (!cue) { setTitle(context, 'cue?'); showAlert(context); return; }
    args = { cue: cue.id };
  }

  const res = await cuego.command(spec.cmd, args);
  if (res.reason === REASON.ok) {
    problem = null; // gelukt → meteen weer de gewone titels tonen
    showOk(context);
    poll().catch(() => {});
  } else {
    flagProblem(context, res.reason);
  }
}

// Een probleem blijft even staan. Anders zie je het niet: /api/state vraagt géén
// wachtwoord, dus de statuspolling slaagt ook bij een fout wachtwoord gewoon en
// zou de melding binnen een halve seconde weer overschrijven met de cue-naam.
const PROBLEM_MS = 5000;
let problem = null; // { reason, until }

const problemTitle = (reason) =>
  reason === REASON.auth ? 'wachtwoord'
  : reason === REASON.disabled ? 'remote uit'
  : 'offline';

// Eén plek voor "het ging mis": zowel de waarschuwing als een leesbare titel.
function flagProblem(context, reason) {
  showAlert(context);
  problem = { reason, until: Date.now() + PROBLEM_MS };
  showProblemTitles();
}

function showProblemTitles() {
  for (const [context, info] of visible) {
    if (FEEDBACK_ACTIONS.has(info.action)) setTitle(context, problemTitle(problem.reason));
  }
}

// --- Live meekijken met de show --------------------------------------------------

const POLL_MS = 500;
let pollTimer = null;

function fmtTime(sec) {
  const s = Math.max(0, Math.round(sec || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// Titel korten zodat 'm op een knop past (Stream Deck breekt zelf af, maar dan
// midden in een woord en zonder dat je ziet dat er meer was).
function short(text, max = 12) {
  const t = String(text || '').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function applyState(state) {
  // Staat er nog een verse foutmelding van een knopdruk? Die laten we uitlezen —
  // anders overschrijft de eerstvolgende geslaagde polling 'm meteen.
  if (problem && Date.now() < problem.until) { showProblemTitles(); return; }
  problem = null;

  for (const [context, info] of visible) {
    if (!FEEDBACK_ACTIONS.has(info.action)) continue;

    if (state.remoteEnabled === false) { setTitle(context, 'remote uit'); continue; }

    const cues = state.cues || [];

    if (info.action === `${PREFIX}.go`) {
      // Wat gaat er gebeuren als je nu op GO drukt: de geselecteerde cue.
      const sel = cues.find((c) => c.selected) || cues.find((c) => c.id === state.selectedId);
      setTitle(context, sel ? short(sel.name) : '');
      continue;
    }

    if (info.action === `${PREFIX}.toggle`) {
      // Wat er nu klinkt + hoelang nog. Het icoon volgt play/pause.
      const playing = cues.find((c) => c.playing) || cues.find((c) => c.paused);
      if (!playing) { setTitle(context, ''); setState(context, 0); continue; }
      const left = (playing.duration || 0) - (playing.position || 0);
      setTitle(context, `${short(playing.name, 10)}\n${fmtTime(left)}`);
      setState(context, playing.playing ? 1 : 0);
      continue;
    }

    if (info.action === `${PREFIX}.playcue`) {
      const cue = findCue(state, info.settings?.cue);
      if (!cue) { setTitle(context, 'cue?'); continue; }
      const label = cue.number ? `${cue.number} ${short(cue.name, 9)}` : short(cue.name);
      setTitle(context, cue.playing ? `▶ ${label}` : label);
    }
  }
}

async function poll() {
  // Niets zichtbaar → niet pollen. Scheelt verkeer als de Stream Deck op een
  // andere pagina staat of in de kast ligt.
  if (!visible.size) return;
  const res = await cuego.state();
  if (res.reason === REASON.ok) { applyState(res.data); return; }
  // Lukt het opvragen zélf niet, dan is dat het meest actuele nieuws — ook als er
  // nog een oudere melding van een knopdruk stond.
  problem = { reason: res.reason, until: Date.now() + PROBLEM_MS };
  showProblemTitles();
}

function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(() => { poll().catch(() => {}); }, POLL_MS);
}

// --- Events van Stream Deck --------------------------------------------------------

function onMessage(raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch { return; }
  const { event, context, action, payload } = msg;

  switch (event) {
    case 'willAppear':
      visible.set(context, { action, settings: payload?.settings || {} });
      poll().catch(() => {});
      break;

    case 'willDisappear':
      visible.delete(context);
      break;

    case 'keyDown':
      onKeyDown(context, action, payload?.settings || {}).catch((err) => {
        console.error('keyDown mislukt:', err?.message);
        showAlert(context);
      });
      break;

    case 'didReceiveSettings':
      if (visible.has(context)) visible.get(context).settings = payload?.settings || {};
      poll().catch(() => {});
      break;

    case 'didReceiveGlobalSettings': {
      const s = payload?.settings || {};
      settings = {
        host: String(s.host || '127.0.0.1').trim() || '127.0.0.1',
        port: Number(s.port) || 4321,
        password: String(s.password || ''),
      };
      problem = null; // andere server/wachtwoord → oude melding is niet meer waar
      poll().catch(() => {});
      break;
    }

    // De Property Inspector vraagt om een verbindingstest.
    case 'sendToPlugin': {
      if (payload?.test) {
        cuego.state().then((res) => {
          sendSD('sendToPropertyInspector', context, {
            result: res.reason,
            projectName: res.data?.projectName || '',
            cues: res.data?.cues?.length || 0,
          });
        });
      }
      break;
    }
  }
}

// --- Opstarten ----------------------------------------------------------------------

ws = connect(`ws://127.0.0.1:${PORT}`, {
  onOpen: () => {
    ws.send(JSON.stringify({ event: REGISTER_EVENT, uuid: UUID }));
    // Instellingen ophalen; het antwoord komt als didReceiveGlobalSettings terug.
    sendSD('getGlobalSettings', UUID);
    startPolling();
  },
  onMessage,
  onClose: () => {
    // Stream Deck start plugins zelf opnieuw op; blijven draaien zonder verbinding
    // heeft geen zin en zou een zombie-proces achterlaten.
    clearInterval(pollTimer);
    process.exit(0);
  },
  onError: (err) => console.error('WebSocket-fout:', err?.message),
});
