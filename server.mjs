// Minimale statische server + besturings-relay voor CueGo.
// Alleen Node stdlib (geen npm install). Draait op http://localhost:4321
// (secure context → Web Audio werkt).
//
// Besturings-relay: de app verbindt als 'app' en luistert via SSE naar commando's;
// afstandsbedieningen (remote.html, curl, straks OSC) sturen commando's via POST.
// De app pusht zijn toestand terug, die naar de remotes wordt uitgezonden.
//
//   GET  /api/ping              → { cuego: true, ... } (detectie door de app)
//   GET  /api/events?role=app   → SSE-stroom met commando's
//   GET  /api/events?role=remote→ SSE-stroom met toestand
//   POST /api/command           → { cmd, args } → naar de app
//   POST /api/state             → toestand van de app → naar de remotes
//
// Bij het starten wordt om een admin-wachtwoord gevraagd: dat vergrendelt elk
// apparaat tot het daar is ingevuld, en remotes moeten het meesturen.
import { createServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { readFile, writeFile, readdir, stat, mkdir, unlink } from 'node:fs/promises';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { networkInterfaces, homedir } from 'node:os';
import { createSocket } from 'node:dgram';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { parseOsc, oscToCommand } from './osc.mjs';
import { generateCert } from './cert.mjs';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PORT = process.env.PORT ? Number(process.env.PORT) : 4321;
// Geen apart netwerk-token meer: het admin-wachtwoord is het enige wachtwoord.
// Een token dat de app zelf niet kent sloot 'm buiten van z'n eigen endpoints.
const OSC_PORT = process.env.CUEGO_OSC_PORT ? Number(process.env.CUEGO_OSC_PORT) : 53000;
// OSC kent geen wachtwoord. Staat er een admin-wachtwoord, dan is de bedoeling
// "dicht", dus blijft OSC uit tenzij je 'm expliciet aanzet. (Pas te bepalen als
// het wachtwoord bekend is — zie startOsc.)
const OSC_SETTING = (process.env.CUEGO_OSC || '').toLowerCase();
function oscEnabled() {
  if (OSC_SETTING === 'off') return false;
  return adminPassword ? OSC_SETTING === 'on' : true;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

// --- Wat mag er van schijf gelezen worden? ----------------------------------
// Een allowlist, geen blocklist: de projectmap bevat te veel wat niemand hoort
// te krijgen (cert/key.pem, .git, show/, projects/, backups die je er zelf
// neerzet), en bij een blocklist vergeet je er vroeg of laat één. Alles wat de
// app nodig heeft staat hieronder; de rest bestaat simpelweg niet.
//
// Audio en projecten gaan wél de deur uit, maar via /api/audio en /api/projects:
// die hebben hun eigen controles.
const PUBLIC_DIRS = new Set(['src', 'assets']);
const PUBLIC_FILES = new Set([
  'index.html', 'app.html', 'remote.html', '404.html',
  'style.css', 'favicon.ico', 'robots.txt', 'sitemap.xml',
]);

function isPublicAsset(safePath) {
  const rel = safePath.replace(/^[/\\]+/, '').replace(/\\/g, '/');
  if (!rel) return false;
  const delen = rel.split('/');
  // Nooit verborgen bestanden of mappen (.git, .env, .DS_Store …).
  if (delen.some((d) => d.startsWith('.'))) return false;
  if (delen.length === 1) return PUBLIC_FILES.has(delen[0]);
  return PUBLIC_DIRS.has(delen[0]);
}

// --- Projecten op schijf ----------------------------------------------------
// Draai je lokaal, dan bewaren we shows als echte bestanden in projects/ — te
// kopiëren en te backuppen. Statisch gehost gaat dit via IndexedDB in de browser.

const PROJECTS_DIR = join(ROOT, 'projects');

// Alleen een kale bestandsnaam met .cgo. Weert path traversal (../).
function safeProjectName(raw) {
  const base = String(raw || '').replace(/[/\\]/g, '').replace(/^\.+/, '').trim();
  const name = base.replace(/\.cgo$/i, '').replace(/[^\w\-. ]+/g, '_').slice(0, 120);
  return name ? `${name}.cgo` : null;
}

async function listProjects() {
  try {
    const names = await readdir(PROJECTS_DIR);
    const out = [];
    for (const n of names) {
      if (!n.toLowerCase().endsWith('.cgo')) continue;
      const s = await stat(join(PROJECTS_DIR, n)).catch(() => null);
      if (s?.isFile()) out.push({ name: n.replace(/\.cgo$/i, ''), size: s.size, savedAt: s.mtimeMs });
    }
    return out.sort((a, b) => b.savedAt - a.savedAt);
  } catch {
    return []; // map bestaat nog niet
  }
}

// Lees een binaire body (projectbestanden bevatten de audio, dus ruim toestaan).
function readBuffer(req, limit = 2e9) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('Bestand te groot')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// --- Update-check -----------------------------------------------------------
// CueGo wordt als git-repo gekloond, dus kunnen we zien of er nieuwere code is.
// Regel één: dit mag een start NOOIT ophouden. Geen netwerk, geen git, geen
// upstream, GitHub traag → korte timeout, stil doorstarten. Een show die niet
// begint omdat een update-check hangt is oneindig veel erger dan verouderde code.
// Uitzetten kan met CUEGO_NO_UPDATE_CHECK=1.

const execFileAsync = promisify(execFile);
const git = (args, timeout = 5000) =>
  execFileAsync('git', args, { cwd: ROOT, timeout }).then((r) => r.stdout.trim());

async function checkForUpdate() {
  if (process.env.CUEGO_NO_UPDATE_CHECK) return null;
  try {
    await git(['rev-parse', '--is-inside-work-tree'], 2000); // zip-download? dan niets te doen
    await git(['fetch', '--quiet', 'origin'], 5000);
    const behind = Number(await git(['rev-list', '--count', 'HEAD..@{u}'], 3000));
    if (!behind) return null;
    const dirty = (await git(['status', '--porcelain'], 3000)).length > 0;
    return { behind, dirty };
  } catch {
    return null; // offline, geen upstream, geen git — allemaal prima
  }
}

// Klein pijltjes-menu in de terminal (puur Node, geen deps). Geeft de gekozen index
// terug, of -1 bij annuleren (Esc/Ctrl-C). Vereist een TTY. Tekent zichzelf ter
// plekke opnieuw bij elke toetsaanslag, zoals een moderne CLI.
function promptMenu({ title = '', subtitle = '', options = [], hint = '↑/↓ kiezen · Enter bevestigen' }) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    const out = process.stdout;
    const C = { reset: '\x1b[0m', dim: '\x1b[2m', cyan: '\x1b[36m', bold: '\x1b[1m', hide: '\x1b[?25l', show: '\x1b[?25h' };
    let sel = 0;
    let prevLen = 0;
    let done = false;

    function build() {
      const lines = [];
      if (title) lines.push(`${C.bold}${title}${C.reset}`);
      if (subtitle) lines.push(`${C.dim}${subtitle}${C.reset}`);
      lines.push('');
      options.forEach((opt, i) => {
        lines.push(i === sel ? `  ${C.cyan}› ${opt}${C.reset}` : `  ${C.dim}  ${opt}${C.reset}`);
      });
      lines.push('');
      if (hint) lines.push(`  ${C.dim}${hint}${C.reset}`);
      return lines;
    }
    function render() {
      const lines = build();
      if (prevLen) out.write(`\x1b[${prevLen}A\x1b[0J`); // terug naar boven + wis naar beneden
      out.write(lines.join('\n') + '\n');
      prevLen = lines.length;
    }
    function finish(result) {
      if (done) return;
      done = true;
      stdin.setRawMode?.(false);
      stdin.pause();
      stdin.removeListener('data', onData);
      out.write(C.show + '\n');
      resolve(result);
    }
    function onData(buf) {
      const s = buf.toString();
      const n = options.length;
      if (s === '\x03' || s === '\x1b') return finish(-1); // Ctrl-C / Esc
      if (s === '\r' || s === '\n') return finish(sel); // Enter
      if (s === '\x1b[A' || s === '\x1bOA' || s === 'k') { sel = (sel - 1 + n) % n; render(); return; }
      if (s === '\x1b[B' || s === '\x1bOB' || s === 'j') { sel = (sel + 1) % n; render(); return; }
      const num = parseInt(s, 10);
      if (num >= 1 && num <= n) { sel = num - 1; return finish(sel); }
    }

    // Scherm (en scrollback) leegmaken zodat er echt alleen het menu staat —
    // geen commando-ruis of git-uitvoer eromheen.
    out.write('\x1b[2J\x1b[3J\x1b[H' + C.hide);
    render();
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.on('data', onData);
  });
}

// Geeft true als CueGo opnieuw start (dan moet deze start stoppen).
async function maybeUpdate() {
  if (!process.stdin.isTTY) return false; // geen terminal om iets te vragen
  const info = await checkForUpdate();
  if (!info) return false;

  const aantal = info.behind === 1 ? '1 update' : `${info.behind} updates`;
  if (info.dirty) {
    // Niet stiekem over iemands eigen wijzigingen heen pullen.
    console.log(`Er ${info.behind === 1 ? 'is' : 'zijn'} ${aantal} beschikbaar, maar je hebt lokale wijzigingen. Bijwerken overgeslagen.`);
    return false;
  }

  const keuze = await promptMenu({
    title: `✨  Er ${info.behind === 1 ? 'is' : 'zijn'} ${aantal} beschikbaar voor CueGo`,
    subtitle: 'CueGo herstart even na het bijwerken.',
    options: ['Nu bijwerken en herstarten', 'Overslaan en starten'],
  });
  if (keuze !== 0) return false; // overslaan of geannuleerd

  try {
    await git(['pull', '--ff-only'], 30000);
  } catch (err) {
    console.log(`Bijwerken mislukt: ${err.message.split('\n')[0]}`);
    console.log('CueGo start met de huidige versie.');
    return false;
  }

  // De statische bestanden worden per verzoek van schijf gelezen, maar deze
  // server.mjs draait nog de oude code — dus opnieuw starten. Scherm eerst leeg,
  // zodat de herstart ook op een schone terminal begint.
  process.stdout.write('\x1b[2J\x1b[3J\x1b[H');
  console.log('Bijgewerkt. CueGo start opnieuw…\n');
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], { stdio: 'inherit', cwd: ROOT });
  child.on('exit', (code) => process.exit(code ?? 0));
  return true;
}

// --- Het cuego-commando -----------------------------------------------------
// Elke start zorgt dat `cuego` bestaat — ook voor wie ooit alleen kloonde, en
// op Windows, waar setup.mjs eerst niets kon. Een misser is stil: een ontbrekend
// commando mag een start nooit breken. Uitzetten kan met CUEGO_NO_ALIAS=1.
//
// Twee dingen zijn hier eerder misgegaan en worden nu bewust voorkomen:
//
// 1. Het commando was een kale alias naar een absoluut pad. Verdween die map,
//    dan kreeg je een rauwe Node-stacktrace ("Cannot find module …"). Daarom is
//    het nu een shell-functie die eerst kijkt of CueGo er nog staat.
// 2. Elke start eigende zich het commando toe. Had je twee kopieën, dan startte
//    `cuego` daarna ongemerkt de andere — mogelijk een oudere versie. Nu nemen we
//    het alleen over als het vrij is of als de vorige map niet meer bestaat.
//    Bewust wisselen kan met CUEGO_CLAIM=1.

const INSTALL_CMD = 'git clone https://github.com/Jopio0819/CueGo.git ~/cuego && node ~/cuego/setup.mjs';
const BLOCK_START = '# >>> CueGo >>>';
const BLOCK_END = '# <<< CueGo <<<';

// De shell-functie die in het profiel komt. Geen alias: een functie kan eerst
// controleren of CueGo er nog is en anders iets leesbaars zeggen.
function shellBlock(dir) {
  const server = `${dir}/server.mjs`;
  return [
    BLOCK_START,
    '# Start CueGo vanaf elke plek. Is CueGo weg, dan zegt hij dát,',
    '# in plaats van een onleesbare Node-foutmelding.',
    'cuego() {',
    `  if [ ! -f ${JSON.stringify(server)} ]; then`,
    `    echo "CueGo staat niet meer in ${dir}"`,
    '    echo "Verplaatst? Start CueGo daar één keer; dan wijst \'cuego\' er weer heen."',
    '    echo "Kwijt? Opnieuw installeren:"',
    `    echo "  ${INSTALL_CMD}"`,
    '    return 1',
    '  fi',
    `  node ${JSON.stringify(server)} "$@"`,
    '}',
    BLOCK_END,
  ].join('\n');
}

// Naar welke installatie wijst het commando nu? Kent zowel het nieuwe blok als
// de oude kale alias, zodat een bestaande installatie netjes meeverhuist.
function currentCommandDir(profileText) {
  return /^\s*node "(.+)\/server\.mjs" "\$@"$/m.exec(profileText)?.[1]
    ?? /^alias cuego='node "(.+)\/server\.mjs"'$/m.exec(profileText)?.[1]
    ?? null;
}

async function ensureCuegoCommand() {
  if (process.env.CUEGO_NO_ALIAS) return;
  const dir = ROOT.replace(/[\\/]$/, '');
  const server = join(ROOT, 'server.mjs');
  try {
    if (process.platform === 'win32') {
      // WindowsApps staat standaard in het gebruikers-PATH en is schrijfbaar
      // zonder adminrechten. Een .cmd werkt in cmd én PowerShell — anders dan
      // een PowerShell-profiel, dat de standaard execution policy blokkeert.
      const winDir = join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'Microsoft', 'WindowsApps');
      const target = join(winDir, 'cuego.cmd');
      const inhoud = [
        '@echo off',
        `if not exist "${server}" (`,
        `  echo CueGo staat niet meer in ${dir}`,
        '  echo Kwijt? Opnieuw installeren:',
        `  echo   ${INSTALL_CMD}`,
        '  exit /b 1',
        ')',
        `node "${server}" %*`,
        '',
      ].join('\r\n');
      const bestaand = await readFile(target, 'utf8').catch(() => null);
      if (bestaand === inhoud) return; // al goed

      // Wijst het naar een andere, nog bestaande installatie? Niet afpakken.
      const anderPad = /^node "(.+)\\server\.mjs" %\*$/m.exec(bestaand || '')?.[1];
      if (anderPad && anderPad !== server && !process.env.CUEGO_CLAIM && await readFile(anderPad, 'utf8').then(() => true).catch(() => false)) {
        console.log(`Het commando "cuego" hoort bij ${anderPad.replace(/\\server\.mjs$/, '')}.`);
        console.log('  Deze kopie laten we met rust. Wisselen? Start deze map één keer met:  CUEGO_CLAIM=1 node server.mjs');
        return;
      }
      await mkdir(winDir, { recursive: true });
      await writeFile(target, inhoud);
      console.log('Commando "cuego" geïnstalleerd — start CueGo voortaan met: cuego');
      return;
    }

    // macOS/Linux: een functie in het profiel van de eigen shell.
    const shell = process.env.SHELL || '';
    const profile = shell.includes('zsh') ? join(homedir(), '.zshrc')
      : shell.includes('bash') ? join(homedir(), '.bashrc')
      : null;
    if (!profile) return; // onbekende shell → niet gokken

    const huidig = await readFile(profile, 'utf8').catch(() => '');
    const blok = shellBlock(dir);
    if (huidig.includes(blok)) return; // staat er al, precies goed

    const vorige = currentCommandDir(huidig);

    // Hoort het commando bij een andere installatie die er nog gewoon staat?
    // Dan blijven we ervan af: stilletjes overnemen is hoe je later ongemerkt
    // een verouderde kopie start.
    if (vorige && vorige !== dir && !process.env.CUEGO_CLAIM) {
      const bestaatNog = await readFile(join(vorige, 'server.mjs'), 'utf8').then(() => true).catch(() => false);
      if (bestaatNog) {
        console.log(`Het commando "cuego" hoort bij ${vorige}`);
        console.log(`  Deze kopie (${dir}) laten we het met rust.`);
        console.log('  Wisselen? Start deze map één keer met:  CUEGO_CLAIM=1 node server.mjs');
        return;
      }
    }

    // Oud blok of oude losse alias eruit, nieuw blok erin.
    let nieuw = huidig
      .replace(new RegExp(`\\n?${BLOCK_START}[\\s\\S]*?${BLOCK_END}\\n?`), '\n')
      .replace(/^# CueGo vanaf elke plek starten\n/m, '')
      .replace(/^alias cuego=.*\n?/m, '');
    nieuw = `${nieuw.replace(/\n+$/, '')}\n\n${blok}\n`;
    await writeFile(profile, nieuw);

    if (vorige && vorige !== dir) {
      console.log(`Het commando "cuego" wees naar ${vorige} — die map bestaat niet meer.`);
      console.log(`  Wijst nu naar ${dir}.`);
    } else {
      console.log(`Commando "cuego" geïnstalleerd (${profile}) — nieuwe terminal, dan: cuego`);
    }
  } catch { /* stil */ }
}

// Kloon je CueGo opnieuw terwijl je ín een bestaande kloon staat, dan komt de
// nieuwe kopie eronder te hangen: ~/cuego/cuego. Het oude installatiecommando
// ("… && cd cuego && …") liet je precies daar achter, dus dat gebeurde makkelijk.
// Ongedaan maken kunnen we het niet, maar zwijgen is erger: zonder melding draai
// je maanden later ongemerkt een verouderde kopie.
async function warnIfNested() {
  const eigen = ROOT.replace(/[\\/]$/, '');
  let dir = eigen;
  for (let i = 0; i < 12; i++) {
    const ouder = dirname(dir);
    if (!ouder || ouder === dir) return; // bij de wortel
    // Een CueGo-installatie herken je aan deze twee bestanden samen.
    const isCueGo = await Promise.all([
      readFile(join(ouder, 'server.mjs'), 'utf8').then(() => true).catch(() => false),
      readFile(join(ouder, 'src', 'app.js'), 'utf8').then(() => true).catch(() => false),
    ]).then(([a, b]) => a && b);
    if (isCueGo) {
      console.log('Let op: deze CueGo staat ín een andere CueGo-installatie.');
      console.log(`  deze:   ${eigen}`);
      console.log(`  binnen: ${ouder}`);
      console.log('  Dat ontstaat door opnieuw te klonen terwijl je in de map staat.');
      console.log('  Houd één installatie aan; anders start je later makkelijk een oude versie.');
      return;
    }
    dir = ouder;
  }
}

// --- Admin-wachtwoord -------------------------------------------------------
// Bij elke start gevraagd. Elk apparaat begint vergrendeld en wordt pas
// ontgrendeld als het wachtwoord dáár is ingevuld — dus per apparaat.
// Dit is een zachte lock: de server kent het wachtwoord, maar het afdwingen
// gebeurt in de browser, en over http gaat het onversleuteld over je netwerk.

let adminPassword = '';

// Vraag het wachtwoord zonder het op het scherm te zetten.
// Gemaskeerde wachtwoord-prompt in dezelfde stijl als het menu: schoon scherm,
// titel + uitleg, en een invoerveld dat de tekens als • toont. Puur Node, geen deps.
function promptPassword({ title = '', subtitle = '', label = 'Wachtwoord', hint = 'Enter bevestigen · leeg = geen slot' }) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    const out = process.stdout;
    const C = { reset: '\x1b[0m', dim: '\x1b[2m', cyan: '\x1b[36m', bold: '\x1b[1m', hide: '\x1b[?25l', show: '\x1b[?25h' };
    let value = '';
    let prevLen = 0;
    let done = false;

    function build() {
      const lines = [];
      if (title) lines.push(`${C.bold}${title}${C.reset}`);
      if (subtitle) subtitle.split('\n').forEach((l) => lines.push(`${C.dim}${l}${C.reset}`));
      lines.push('');
      lines.push(`  ${label} ${C.cyan}›${C.reset} ${'•'.repeat(value.length)}${C.dim}▏${C.reset}`);
      lines.push('');
      // De hint helpt alleen vóór je begint; zodra je typt is hij overbodig.
      if (hint && value.length === 0) lines.push(`  ${C.dim}${hint}${C.reset}`);
      return lines;
    }
    function render() {
      const lines = build();
      if (prevLen) out.write(`\x1b[${prevLen}A\x1b[0J`);
      out.write(lines.join('\n') + '\n');
      prevLen = lines.length;
    }
    function finish(result) {
      if (done) return;
      done = true;
      stdin.setRawMode?.(false);
      stdin.pause();
      stdin.removeListener('data', onData);
      if (prevLen) out.write(`\x1b[${prevLen}A\x1b[0J`); // de prompt (mét bolletjes) weghalen bij Enter
      out.write(C.show);
      resolve(result);
    }
    function onData(buf) {
      const s = buf.toString();
      if (s === '\x03') { stdin.setRawMode?.(false); out.write(C.show + '\n'); process.exit(130); } // Ctrl-C → afbreken
      if (s === '\r' || s === '\n') return finish(value.trim());
      if (s === '\x7f' || s === '\b') { value = value.slice(0, -1); render(); return; } // backspace
      if (!s.startsWith('\x1b') && [...s].every((ch) => ch >= ' ')) { value += s; render(); return; } // gewone tekens
    }

    out.write('\x1b[2J\x1b[3J\x1b[H' + C.hide);
    render();
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.on('data', onData);
  });
}

async function initAdminPassword() {
  // Geen terminal (achtergrond, launcher, script)? Dan kunnen we niets vragen;
  // zonder deze uitweg zou de server hier blijven hangen bij het starten.
  if (!process.stdin.isTTY) {
    adminPassword = process.env.CUEGO_ADMIN_PASSWORD || '';
    if (adminPassword) console.log('Admin-wachtwoord uit CUEGO_ADMIN_PASSWORD (geen terminal om te vragen).');
    else console.log('Geen terminal en geen CUEGO_ADMIN_PASSWORD — apparaten starten onvergrendeld.');
    return;
  }
  const pw = await promptPassword({
    title: '🔒  Admin-wachtwoord instellen',
    subtitle: 'Elk apparaat start vergrendeld tot dit wachtwoord daar is ingevuld.\nLeeg laten = geen slot.',
    hint: 'Enter bevestigen · typ exit om CueGo te stoppen',
  });
  if (pw.toLowerCase() === 'exit') {
    process.stdout.write('\x1b[2J\x1b[3J\x1b[H'); // scherm schoon achterlaten
    console.log('CueGo gestopt.');
    process.exit(0);
  }
  adminPassword = pw;
  // De status komt in de opstart-samenvatting (printStartup), niet als losse regel.
}

// --- Gedeelde show ----------------------------------------------------------
// Zelf-gehost is de server eigenaar van de show: alle clients zien dezelfde cues.
// De audio staat één keer hier i.p.v. in de IndexedDB van elke browser.
//   show/show.json      → de cue-lijst met een rev-nummer
//   show/audio/<cueId>  → de audiobestanden

const SHOW_DIR = join(ROOT, 'show');
const SHOW_FILE = join(SHOW_DIR, 'show.json');
const AUDIO_DIR = join(SHOW_DIR, 'audio');

let showRev = 0;

async function loadShow() {
  try {
    const data = JSON.parse(await readFile(SHOW_FILE, 'utf8'));
    showRev = data.rev || 0;
    return { rev: showRev, name: data.name || '', single: !!data.single, cues: data.cues || [], updatedAt: data.updatedAt || 0 };
  } catch {
    return { rev: showRev, name: '', single: false, cues: [], updatedAt: 0 }; // nog geen show
  }
}

// Schrijf de show weg en vertel de andere clients ervan. De afzender slaan we
// over: die heeft de wijziging zelf al doorgevoerd.
async function saveShow(cues, senderId, name, single) {
  // Single cue-modus hoort bij de show: het afspelen gebeurt op de showcomputer,
  // dus een instelling die alleen op het bedienende apparaat leeft doet niets.
  // Een oudere client die het veld niet meestuurt mag de stand niet terugzetten.
  if (single == null) single = (await loadShow()).single;
  showRev += 1;
  const data = { rev: showRev, name: name || '', single: !!single, cues, updatedAt: Date.now() };
  await mkdir(SHOW_DIR, { recursive: true });
  await writeFile(SHOW_FILE, JSON.stringify(data));
  for (const c of clients) {
    if (c.role === 'app' && c.appId !== senderId) sseSend(c, 'show', data);
  }
  return data;
}

// Cue-id's zijn UUID's; alleen die vorm toestaan als bestandsnaam.
function safeCueId(raw) {
  const id = String(raw || '').trim();
  return /^[\w-]{1,64}$/.test(id) ? id : null;
}

// --- Besturings-relay -------------------------------------------------------

const clients = new Set(); // { res, role: 'app' | 'remote', appId?, deviceId?, label? }
let lastState = null; // laatst bekende toestand van de showcomputer
// Eén client is de showcomputer: díe speelt het geluid af en krijgt de commando's
// van remotes en van de andere clients. Zonder dit zou elke open tab meespelen.
//
// We houden dat bij per APPARAAT (deviceId uit localStorage), niet per verbinding:
// bij een refresh krijg je anders een nieuwe verbinding terwijl de oude nog even
// blijft hangen — dan zou je showcomputer een spook worden en GO nergens landen.
let appSeq = 0;
let primaryDeviceId = null;
// De rol die de gebruiker ooit expliciet koos, overleeft een herstart. Zonder dit
// pakt na elke herstart (ook een update!) de eerste de beste client de rol — en
// een apparaat dat speelt zonder de rol te hebben, wordt door niemand gevolgd.
const PREF_FILE = join(SHOW_DIR, 'server-state.json');
let preferredShowDeviceId = null;

async function loadPreferredShow() {
  try { preferredShowDeviceId = JSON.parse(await readFile(PREF_FILE, 'utf8')).showDeviceId || null; }
  catch { /* nog geen voorkeur */ }
}
function savePreferredShow() {
  mkdir(SHOW_DIR, { recursive: true })
    .then(() => writeFile(PREF_FILE, JSON.stringify({ showDeviceId: preferredShowDeviceId })))
    .catch(() => { /* niet kunnen bewaren is geen ramp */ });
}

// Een open TCP-verbinding bewijst niet dat er iemand thuis is: een bevroren of
// bfcached tab houdt 'm open terwijl er niets meer draait. Zonder deze check kan
// zo'n dode client de showcomputer-rol vasthouden en landt GO in het niets.
// Clients pingen daarom actief; bevroren tabs hebben bevroren timers en vallen af.
// Ruim boven de ~60s waartoe browsers timers in achtergrond-tabs afknijpen. Korter
// en je ruimt een prima draaiende, maar niet-actieve client op zodra je naar een
// ander venster klikt. Een tab die je gewoon sluit merken we meteen via het
// verbreken van de SSE-verbinding; deze grens is puur de vangnet voor bevroren
// pagina's, die helemaal geen timers meer draaien.
const HEARTBEAT_TIMEOUT_MS = process.env.CUEGO_HEARTBEAT_TIMEOUT_MS ? Number(process.env.CUEGO_HEARTBEAT_TIMEOUT_MS) : 90000;
const REAP_INTERVAL_MS = process.env.CUEGO_REAP_INTERVAL_MS ? Number(process.env.CUEGO_REAP_INTERVAL_MS) : 5000;

function appClients() {
  return [...clients].filter((c) => c.role === 'app');
}
// Clients die aantoonbaar draaien: hebben minstens één keer gepingd. Verbonden
// zijn is geen bewijs — de browser herverbindt ook vanuit een bevroren pagina.
function liveApps() {
  return appClients().filter((c) => c.alive);
}

// Twee identieke laptops geven dezelfde standaardnaam ("Chrome op Mac"). Nummer
// die dan door, anders kun je ze in de lijst niet uit elkaar houden.
function uniqueLabel(label, deviceId) {
  const taken = appClients().filter((c) => c.deviceId !== deviceId).map((c) => c.label);
  if (!taken.includes(label)) return label;
  for (let n = 2; n < 50; n++) {
    const candidate = `${label} (${n})`;
    if (!taken.includes(candidate)) return candidate;
  }
  return label;
}

// Wie is de showcomputer? Eén bron van waarheid, telkens opnieuw bepaald zodra de
// set levende clients verandert (verbinden, wegvallen, opruimen, ontwaken):
//   1. het gekózen apparaat, als dat leeft — het wint altijd, en pakt de rol dus
//      vanzelf terug zodra het weer online is;
//   2. anders de huidige showcomputer, als die nog leeft — geen onnodig geschuif;
//   3. anders de langst-verbonden levende client — zodat de show blijft werken;
//   4. niemand, als er geen levende client is.
// Zo blijft de rol nooit op een dood/opgeruimd apparaat plakken (dan landt GO in
// het niets en ziet iedereen 'offline'), en springt hij ook niet naar een
// willekeurig tabblad terwijl het gekozen apparaat nog gewoon draait.
// Geeft true als de rol daadwerkelijk wisselde.
function resolvePrimary() {
  const live = liveApps();
  const isLive = (id) => !!id && live.some((c) => c.deviceId === id);
  const before = primaryDeviceId;

  let next;
  if (isLive(preferredShowDeviceId)) next = preferredShowDeviceId;
  else if (isLive(primaryDeviceId)) next = primaryDeviceId;
  else next = live.slice().sort((a, b) => a.appId - b.appId)[0]?.deviceId || null;

  if (next === before) return false;
  primaryDeviceId = next;
  lastState = null; // toestand van de vórige showcomputer is niet meer geldig
  if (next) {
    const label = live.find((c) => c.deviceId === next)?.label || next.slice(0, 8);
    const waarom = next === preferredShowDeviceId ? 'gekozen apparaat'
      : (before ? 'vorige showcomputer offline' : 'eerste levende client');
    console.log(`Showcomputer is nu: ${label} (${waarom})`);
  } else {
    console.log('Geen levende client meer — geen showcomputer.');
    broadcast('remote', 'state', { offline: true, projectName: '', cues: [] });
  }
  return true;
}

// Alleen een echte ping telt als levensteken. Een client die nog nooit pingde is
// 'niet levend': hij telt niet mee in de lijst en krijgt de showcomputer-rol niet.
function touchDevice(deviceId) {
  let seen = false;
  let wokeUp = false;
  for (const c of appClients()) {
    if (c.deviceId !== deviceId) continue;
    c.lastSeen = Date.now();
    if (!c.alive) { c.alive = true; wokeUp = true; }
    seen = true;
  }
  // Een nieuw levend apparaat verandert de lijst (en misschien de showcomputer).
  if (wokeUp) { resolvePrimary(); broadcastDevices(); }
  return seen;
}

// Gooi clients eruit die te lang niets van zich lieten horen (bevroren/bfcached
// tabs die de verbinding openhouden maar geen timers meer draaien).
function reapDeadClients() {
  const now = Date.now();
  let changed = false;
  for (const c of appClients()) {
    if (now - (c.lastSeen || 0) <= HEARTBEAT_TIMEOUT_MS) continue;
    try { c.res.end(); } catch { /* al dicht */ }
    clients.delete(c);
    changed = true;
  }
  if (!changed) return;
  // Was de showcomputer erbij, dan wijst resolvePrimary de rol toe aan een levend
  // apparaat; blijft die gewoon leven, dan verandert er niets aan de rol.
  resolvePrimary();
  broadcastDevices();
}

setInterval(reapDeadClients, REAP_INTERVAL_MS).unref?.();
function primaryApp() {
  return liveApps().find((c) => c.deviceId === primaryDeviceId) || null;
}

// Wie zijn er verbonden, en wie speelt het geluid af?
function deviceList() {
  return liveApps()
    .sort((a, b) => a.appId - b.appId)
    .map((c) => ({
      deviceId: c.deviceId,
      label: c.label || 'Onbekend apparaat',
      isShow: c.deviceId === primaryDeviceId,
      locked: !!c.locked,
    }));
}

// Vertel alle clients wie de showcomputer is (en welke apparaten er zijn).
function broadcastDevices() {
  const devices = deviceList();
  for (const c of appClients()) {
    sseSend(c, 'devices', { showDeviceId: primaryDeviceId, you: c.deviceId, devices });
  }
}

function setShowComputer(deviceId) {
  if (!liveApps().some((c) => c.deviceId === deviceId)) return false; // nooit aan een dode client
  // Expliciete keuze van de gebruiker: onthouden, ook voorbij een herstart. Het
  // gekozen apparaat leeft, dus resolvePrimary maakt het meteen de showcomputer.
  preferredShowDeviceId = deviceId;
  savePreferredShow();
  resolvePrimary();
  broadcastDevices();
  return true;
}

// Gooit een geweigerde state-push in de log — maar hooguit eens per 10s per
// afzender, want een scheve client pusht een paar keer per seconde.
const stateRejectLog = new Map();
function logStateReject(body) {
  const key = String(body.appId ?? '?');
  const now = Date.now();
  if (now - (stateRejectLog.get(key) || 0) < 10000) return;
  stateRejectLog.set(key, now);
  const speelt = (body.state?.cues || []).filter((c) => c.playing).length;
  const wie = appClients().find((c) => c.appId === body.appId);
  console.log(`State-push geweigerd van ${wie?.label || `appId ${key}`}${speelt ? ` (speelt ${speelt} cue(s)!)` : ''} — die client denkt showcomputer te zijn, de server niet.`);
}

function sseSend(client, event, data) {
  try {
    client.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch {
    clients.delete(client);
  }
}
function broadcast(role, event, data) {
  for (const c of clients) if (c.role === role) sseSend(c, event, data);
}
function countRole(role) {
  let n = 0;
  for (const c of clients) if (c.role === role) n++;
  return n;
}

// Eén weg naar de app, of het commando nu via HTTP of via OSC binnenkomt.
// Alleen de actieve app krijgt 'm — anders speelt elke open tab de cue af.
function sendCommand(cmd, args) {
  const app = primaryApp();
  if (!app) return 0;
  sseSend(app, 'command', { cmd, args: args || null });
  return 1;
}

// Alleen de remote-kant (telefoon, curl, OSC) zit achter het admin-wachtwoord.
// De app zelf niet: die endpoints heeft hij nodig om te kunnen bestaan, en de
// app kent geen wachtwoord tot je 't invult. Eigen clients herkennen we aan hun
// deviceId. Dat is een zachte drempel, geen echte beveiliging: over http gaat
// alles onversleuteld over je netwerk.
function remoteAuthOk(url, body) {
  if (!adminPassword) return true;
  const given = url.searchParams.get('pw') ?? body?.password;
  return given === adminPassword;
}

// --- Bewerk-rechten (server-side afgedwongen) -------------------------------
// Het slot mag niet alleen client-side zijn (velden op `disabled` zijn via DevTools
// weg te halen). Bij een juist admin-wachtwoord krijgt een apparaat een token; alle
// bewerkende endpoints controleren dát token, niet wat de client over z'n eigen
// lock-status beweert (dat is te vervalsen). Zonder admin-wachtwoord blijft alles open.
const unlockTokens = new Map(); // token → deviceId

function issueUnlockToken(deviceId) {
  const token = randomBytes(24).toString('base64url');
  unlockTokens.set(token, deviceId || null);
  return token;
}
function revokeDeviceTokens(deviceId) {
  for (const [t, dev] of unlockTokens) if (dev === deviceId) unlockTokens.delete(t);
}
// Mag deze request de gedeelde show/audio/projecten bewerken?
function canEdit(req) {
  if (!adminPassword) return true; // geen slot ingesteld → open, zoals altijd
  const t = req.headers['x-cuego-token'];
  return !!(t && unlockTokens.has(String(t)));
}

// Een vergrendeld apparaat mag alleen fade-in/uit en loop aan/uit van BESTAANDE cues
// wijzigen. Neem de opgeslagen cues als waarheid en overlay enkel die velden; al het
// andere (naam, nummer, volume, in/uit, toevoegen/verwijderen/herordenen, ...) valt weg.
function mergeLockedCues(incoming, storedCues) {
  const byId = new Map((incoming || []).map((c) => [c.id, c]));
  return (storedCues || []).map((c) => {
    const inc = byId.get(c.id);
    if (!inc) return c;
    return {
      ...c,
      fadeIn: Number.isFinite(+inc.fadeIn) ? +inc.fadeIn : c.fadeIn,
      fadeOut: Number.isFinite(+inc.fadeOut) ? +inc.fadeOut : c.fadeOut,
      loop: !!inc.loop,
    };
  });
}

function json(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
    .end(JSON.stringify(data));
}

// Lees een JSON-body (met een limiet, zodat een grote POST de server niet opblaast).
function readJson(req, limit = 1e6) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('Body te groot')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch (err) { reject(err); }
    });
    req.on('error', reject);
  });
}

// IPv4-adressen op het LAN, zodat de app kan tonen waar de remote te vinden is.
function lanIps() {
  const out = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
    }
  }
  return out;
}

function openSse(req, res, role, deviceId, label) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const client = { res, role };
  if (role === 'app') {
    client.appId = ++appSeq;
    client.deviceId = deviceId;
    client.lastSeen = Date.now();
    if (label) client.label = uniqueLabel(String(label).slice(0, 60), deviceId);

    // Zelfde apparaat, nieuwe verbinding = een refresh. De oude verbinding is dood
    // maar hangt nog even; die gooien we er meteen uit.
    for (const old of appClients()) {
      if (old.deviceId === client.deviceId) {
        try { old.res.end(); } catch { /* al dicht */ }
        clients.delete(old);
      }
    }
  }
  clients.add(client);

  if (role === 'app') {
    // Is er nog geen levende showcomputer? Dan telt verbinden meteen als
    // levensteken en wordt deze tab de showcomputer — anders zou je na een
    // (her)start van de server eerst een hartslag moeten afwachten (tot 8s, op de
    // achtergrond langer) voor je iets kunt afspelen. Een écht bevroren pagina kan
    // geen nieuwe verbinding openen, dus verbinden bewíjst leven. We kapen nooit
    // een rol die al bij een levende client ligt: resolvePrimary laat die met rust
    // (en een gekozen apparaat pakt 'm bij z'n eerste hartslag alsnog terug).
    if (!primaryApp()) {
      client.alive = true;
      client.lastSeen = Date.now();
      resolvePrimary();
    }
    sseSend(client, 'hello', {
      role, appId: client.appId, deviceId: client.deviceId,
      primary: client.deviceId === primaryDeviceId,
    });
    // Meekijkende client: meteen de huidige afspeeltoestand, anders staat z'n
    // balk leeg tot de showcomputer de volgende keer pusht.
    if (lastState && client.deviceId !== primaryDeviceId) sseSend(client, 'state', lastState);
    broadcastDevices();
  } else {
    sseSend(client, 'hello', { role, appOnline: !!primaryApp() });
    // Een nieuwe remote krijgt meteen de laatst bekende toestand — maar alleen als de
    // app ook echt verbonden is, anders tonen we een oude sessie als 'live'.
    if (lastState && primaryApp()) sseSend(client, 'state', lastState);
    else sseSend(client, 'state', { offline: true, projectName: '', cues: [] });
  }

  // Heartbeat houdt de verbinding open door proxies/slaapstand heen.
  const beat = setInterval(() => {
    try { res.write(': ping\n\n'); } catch { /* opgeruimd bij close */ }
  }, 25000);
  const cleanup = () => {
    clearInterval(beat);
    clients.delete(client);
    if (role !== 'app') return;
    // Verving een nieuwere verbinding van hetzelfde apparaat ons al? Dan niets doen.
    if (appClients().some((c) => c.deviceId === client.deviceId)) return;
    // Sluit de gebruiker het tabblad, dan valt deze verbinding meteen weg. Was het
    // de showcomputer, dan schuift resolvePrimary de rol direct naar een levend
    // apparaat — geen wachten op de opruim-timer, geen rol die op een dood
    // apparaat blijft plakken.
    resolvePrimary();
    broadcastDevices();
  };
  req.on('close', cleanup);
  req.on('error', cleanup);
}

// --- HTTP -------------------------------------------------------------------

const handleRequest = async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    let urlPath = decodeURIComponent(url.pathname);

    // Detectie: laat de browser weten dat CueGo lokaal draait, zodat
    // server-afhankelijke opties (netwerk-remote, OSC) getoond worden.
    if (urlPath === '/api/ping') {
      json(res, 200, {
        cuego: true, version: 1, port: PORT, ips: lanIps(), secure: serving === 'https', httpsPort: serving === 'https' ? PORT : null,
        adminLock: !!adminPassword, // apparaten starten dan vergrendeld
        osc: { enabled: oscListening, port: OSC_PORT },
      });
      return;
    }

    // Admin-wachtwoord controleren om dít apparaat te ontgrendelen.
    if (urlPath === '/api/unlock') {
      if (req.method !== 'POST') { json(res, 405, { error: 'Gebruik POST' }); return; }
      const body = await readJson(req).catch(() => null);
      if (!body) { json(res, 400, { error: 'Ongeldige JSON' }); return; }
      if (!adminPassword) { json(res, 200, { ok: true }); return; } // geen slot ingesteld
      const ok = String(body.password || '') === adminPassword;
      if (!ok) { json(res, 401, { error: 'Onjuist wachtwoord' }); return; }
      if (body.deviceId) {
        for (const c of appClients()) if (c.deviceId === body.deviceId) c.locked = false;
        broadcastDevices();
      }
      // Token = het bewijs dat dit apparaat het wachtwoord kende. De client stuurt 'm
      // mee bij bewerkingen; zo hangen de rechten niet aan de (vervalsbare) UI-status.
      json(res, 200, { ok: true, token: issueUnlockToken(body.deviceId) });
      return;
    }

    // Levensteken van een client. Blijft dit uit, dan ruimen we 'm op.
    if (urlPath === '/api/heartbeat') {
      if (req.method !== 'POST') { json(res, 405, { error: 'Gebruik POST' }); return; }
      const body = await readJson(req).catch(() => null);
      if (!body?.deviceId) { json(res, 400, { error: 'deviceId ontbreekt' }); return; }
      const known = touchDevice(body.deviceId);
      // De client vertelt hier ook of hij vergrendeld is. Verandert dat, dan moeten
      // de panelen het horen — anders tonen die de verkeerde knop (Vergrendel op
      // een al vergrendeld apparaat).
      if (body.locked != null) {
        let changed = false;
        for (const c of appClients()) {
          if (c.deviceId !== body.deviceId) continue;
          if (!!c.locked !== !!body.locked) { c.locked = !!body.locked; changed = true; }
        }
        if (changed) broadcastDevices();
      }
      // De rol gaat mee terug: rolwissels lopen via eenmalige events, en een
      // client die er net één mist (reconnect, bevroren tab) zou anders vóórgoed
      // denken dat hij geen showcomputer is — en dus nooit zijn toestand pushen.
      // Zo herstelt dat zichzelf binnen één hartslag.
      json(res, 200, { ok: true, known, primary: body.deviceId === primaryDeviceId });
      return;
    }

    // Multi-device: wie is de showcomputer, en hoe heten de apparaten?
    if (urlPath === '/api/devices') {
      if (req.method === 'GET') { json(res, 200, { showDeviceId: primaryDeviceId, devices: deviceList() }); return; }
      if (req.method !== 'POST' && req.method !== 'PUT') { json(res, 405, { error: 'Gebruik GET of POST' }); return; }
      const body = await readJson(req).catch(() => null);
      if (!body) { json(res, 400, { error: 'Ongeldige JSON' }); return; }

      // Apparaatnaam zetten (zodat je ze in de lijst uit elkaar houdt).
      if (body.label != null && body.deviceId != null) {
        const l = uniqueLabel(String(body.label).slice(0, 60), body.deviceId);
        for (const c of appClients()) if (c.deviceId === body.deviceId) c.label = l;
      }

      // Een ander apparaat op afstand (ont)grendelen vanuit het Multi-device-paneel.
      // Dit is een beheeractie: alleen een ontgrendeld apparaat mag het.
      if (body.lockDeviceId != null && body.locked != null) {
        if (!canEdit(req)) { json(res, 403, { error: 'Vergrendeld — geen apparaatbeheer' }); return; }
        const targets = appClients().filter((c) => c.deviceId === body.lockDeviceId);
        if (!targets.length) { json(res, 404, { error: 'Dat apparaat is niet (meer) verbonden' }); return; }
        const lockIt = !!body.locked;
        // Vergrendelen → token intrekken (echt geen bewerkrechten meer). Ontgrendelen
        // via het paneel → een token uitgeven en meesturen, zodat dat apparaat ook
        // server-side mag bewerken zonder zelf het wachtwoord te hoeven kennen.
        if (lockIt) revokeDeviceTokens(body.lockDeviceId);
        const token = lockIt ? null : issueUnlockToken(body.lockDeviceId);
        for (const c of targets) {
          c.locked = lockIt;
          sseSend(c, 'lock', { locked: lockIt, token });
        }
      }
      // Showcomputer aanwijzen (ook een beheeractie).
      if (body.showDeviceId != null) {
        if (!canEdit(req)) { json(res, 403, { error: 'Vergrendeld' }); return; }
        if (!setShowComputer(body.showDeviceId)) {
          json(res, 404, { error: 'Dat apparaat is niet (meer) verbonden' });
          return;
        }
      }
      broadcastDevices();
      json(res, 200, { ok: true, showDeviceId: primaryDeviceId, devices: deviceList() });
      return;
    }

    // Gedeelde show: alle clients lezen en schrijven dezelfde cue-lijst.
    if (urlPath === '/api/show') {
      if (req.method === 'GET') { json(res, 200, await loadShow()); return; }
      if (req.method === 'PUT' || req.method === 'POST') {
        const body = await readJson(req, 5e7).catch(() => null);
        if (!body || !Array.isArray(body.cues)) { json(res, 400, { error: 'Verwacht { appId, cues, name }' }); return; }
        let cues = body.cues;
        let name = body.name;
        let single = typeof body.single === 'boolean' ? body.single : null;
        if (!canEdit(req)) {
          // Vergrendeld: alleen fade/loop van bestaande cues; naam en single-cue
          // blijven zoals opgeslagen, en toevoegen/verwijderen/herordenen telt niet.
          const stored = await loadShow();
          cues = mergeLockedCues(body.cues, stored.cues);
          name = stored.name;
          single = stored.single;
        }
        const data = await saveShow(cues, body.appId, name, single);
        json(res, 200, { ok: true, rev: data.rev });
        return;
      }
      json(res, 405, { error: 'Gebruik GET of PUT' });
      return;
    }

    // Audio van de gedeelde show: één keer uploaden, elke client haalt 'm hier op.
    if (urlPath.startsWith('/api/audio/')) {
      const id = safeCueId(urlPath.slice('/api/audio/'.length));
      if (!id) { json(res, 400, { error: 'Ongeldig cue-id' }); return; }
      const file = join(AUDIO_DIR, id);

      if (req.method === 'PUT' || req.method === 'POST') {
        if (!canEdit(req)) { json(res, 403, { error: 'Vergrendeld — geen audio-wijzigingen' }); return; }
        const buf = await readBuffer(req).catch((err) => { json(res, 413, { error: err.message }); return null; });
        if (!buf) return;
        await mkdir(AUDIO_DIR, { recursive: true });
        await writeFile(file, buf);
        json(res, 200, { ok: true, size: buf.length });
        return;
      }
      if (req.method === 'HEAD' || req.method === 'GET') {
        const buf = await readFile(file).catch(() => null);
        if (!buf) { json(res, 404, { error: 'Niet gevonden' }); return; }
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': buf.length, 'Cache-Control': 'no-store' });
        res.end(req.method === 'HEAD' ? undefined : buf);
        return;
      }
      if (req.method === 'DELETE') {
        if (!canEdit(req)) { json(res, 403, { error: 'Vergrendeld' }); return; }
        await unlink(file).catch(() => {});
        json(res, 200, { ok: true });
        return;
      }
      json(res, 405, { error: 'Methode niet toegestaan' });
      return;
    }

    // Projecten: lijst + opslaan/openen/verwijderen als bestand in projects/.
    if (urlPath === '/api/projects') {
      json(res, 200, await listProjects());
      return;
    }
    if (urlPath.startsWith('/api/projects/')) {
      const name = safeProjectName(urlPath.slice('/api/projects/'.length));
      if (!name) { json(res, 400, { error: 'Ongeldige projectnaam' }); return; }
      const file = join(PROJECTS_DIR, name);

      if (req.method === 'PUT' || req.method === 'POST') {
        if (!canEdit(req)) { json(res, 403, { error: 'Vergrendeld — geen projecten opslaan' }); return; }
        const buf = await readBuffer(req).catch((err) => { json(res, 413, { error: err.message }); return null; });
        if (!buf) return;
        await mkdir(PROJECTS_DIR, { recursive: true });
        await writeFile(file, buf);
        json(res, 200, { ok: true, name: name.replace(/\.cgo$/i, ''), size: buf.length });
        return;
      }
      if (req.method === 'DELETE') {
        if (!canEdit(req)) { json(res, 403, { error: 'Vergrendeld' }); return; }
        await unlink(file).catch(() => {});
        json(res, 200, { ok: true });
        return;
      }
      if (req.method === 'GET') {
        const buf = await readFile(file).catch(() => null);
        if (!buf) { json(res, 404, { error: 'Niet gevonden' }); return; }
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store' }).end(buf);
        return;
      }
      json(res, 405, { error: 'Methode niet toegestaan' });
      return;
    }

    if (urlPath === '/api/events') {
      const role = url.searchParams.get('role') === 'app' ? 'app' : 'remote';
      // Remotes achter het admin-wachtwoord; de app zelf niet (die kent 'm niet).
      if (role === 'remote' && !remoteAuthOk(url)) { json(res, 401, { error: 'Onjuist wachtwoord' }); return; }
      const dev = url.searchParams.get('deviceId');
      // Een app moet zich identificeren. Zonder id kunnen we een refresh niet van
      // een nieuw apparaat onderscheiden, en zou zo'n naamloze (mogelijk dode)
      // verbinding de showcomputer-rol kunnen claimen.
      if (role === 'app' && !dev) { json(res, 400, { error: 'deviceId ontbreekt' }); return; }
      openSse(req, res, role, dev, url.searchParams.get('label'));
      return;
    }

    if (urlPath === '/api/command') {
      if (req.method !== 'POST') { json(res, 405, { error: 'Gebruik POST' }); return; }
      const body = await readJson(req).catch(() => null);
      if (!body || !body.cmd) { json(res, 400, { error: 'Verwacht { cmd, args }' }); return; }

      // "Afstandsbediening uit" is bedoeld tegen telefoons/OSC van buitenaf, niet
      // tegen je eigen CueGo-clients: die tonen dezelfde show en sturen hun GO
      // alleen door omdat zij niet de showcomputer zijn. Een client identificeert
      // zich met z'n deviceId; alleen echte remotes vallen onder de blokkade.
      const fromOwnClient = body.deviceId && appClients().some((c) => c.deviceId === body.deviceId);
      if (!fromOwnClient) {
        if (!remoteAuthOk(url, body)) { json(res, 401, { error: 'Onjuist wachtwoord' }); return; }
        if (lastState && lastState.remoteEnabled === false) {
          json(res, 403, { error: 'Afstandsbediening staat uit' });
          return;
        }
      }
      json(res, 200, { ok: true, delivered: sendCommand(body.cmd, body.args) });
      return;
    }

    if (urlPath === '/api/state') {
      if (req.method === 'GET') { json(res, 200, lastState || {}); return; }
      if (req.method !== 'POST') { json(res, 405, { error: 'Gebruik POST of GET' }); return; }
      const body = await readJson(req).catch(() => null);
      if (!body || !body.state) { json(res, 400, { error: 'Verwacht { appId, state }' }); return; }
      // Alleen de actieve app bepaalt de toestand. Zonder dit overschrijft een
      // tweede open tab de show en flikkert elke remote heen en weer.
      // Alleen de showcomputer bepaalt de toestand. Zonder dit overschrijft een
      // tweede client de show en flikkert elke remote heen en weer.
      const show = primaryApp();
      if (!show || body.appId !== show.appId) {
        logStateReject(body); // dit hoort zeldzaam te zijn; gebeurt het structureel, dan zit een client scheef
        json(res, 200, { ok: true, ignored: 'niet de showcomputer' });
        return;
      }
      lastState = body.state;
      broadcast('remote', 'state', lastState);
      // Ook naar de andere clients: die spelen zelf niets af, maar moeten wél de
      // afspeelbalk en de spelende cue van de showcomputer kunnen tonen.
      for (const c of appClients()) {
        if (c.deviceId !== primaryDeviceId) sseSend(c, 'state', lastState);
      }
      json(res, 200, { ok: true, remotes: countRole('remote') });
      return;
    }

    // Lokaal hosten = direct de app (niet de publieke landingspagina, die is voor
    // statische hosting en blijft bereikbaar op /index.html).
    if (urlPath === '/') urlPath = '/app.html';
    const safePath = normalize(urlPath).replace(/^(\.\.[/\\])+/, '');
    const filePath = join(ROOT, safePath);
    if (!filePath.startsWith(ROOT)) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    // Alleen wat de webapp echt nodig heeft. De projectmap bevat namelijk ook
    // dingen die niemand mag downloaden: cert/key.pem (de private sleutel van
    // het https-certificaat), .git met de hele geschiedenis, show/ en projects/.
    // "Het draait toch maar lokaal" gaat niet op — CueGo is juist bedoeld om op
    // je LAN bereikbaar te zijn, dus alles hier is bereikbaar voor iedereen op
    // dat netwerk.
    // Precies dezelfde 404 als een bestand dat niet bestaat: zo verraadt het
    // antwoord ook niet wat er wél op schijf staat.
    if (!isPublicAsset(safePath)) {
      const err = new Error('Not found');
      err.code = 'ENOENT';
      throw err;
    }
    const body = await readFile(filePath);
    const type = MIME[extname(filePath).toLowerCase()] || 'application/octet-stream';
    // Geen caching: tijdens ontwikkelen altijd de nieuwste bestanden serveren.
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' }).end(body);
  } catch (err) {
    if (err.code === 'ENOENT') {
      // Serveer de nette 404-pagina (zoals GitHub Pages), val terug op tekst.
      try {
        const page = await readFile(join(ROOT, '404.html'));
        res.writeHead(404, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' }).end(page);
      } catch {
        res.writeHead(404).end('Not found');
      }
    } else {
      console.error(err);
      res.writeHead(500).end('Server error');
    }
  }
};

// --- Https op de hoofdpoort -------------------------------------------------
// Web MIDI en consorten vereisen een secure context, en http://<lan-ip> is dat
// nooit. Daarom serveert CueGo standaard https, met een zelfgemaakt certificaat
// (puur Node — zie cert.mjs), op dezelfde poort (4321). Eén keer per apparaat de
// browserwaarschuwing accepteren en dat apparaat is 'm voorgoed: een volwaardige
// secure context. Lukt het certificaat onverhoopt niet, dan valt de server terug
// op http zodat een show nooit strandt op een certificaat-fout.
const CERT_DIR = join(ROOT, 'cert');
let serving = 'http'; // wordt 'https' zodra het certificaat er is

async function ensureCertFiles() {
  const ips = ['127.0.0.1', ...lanIps()];
  const hostnames = ['localhost'];
  const metaFile = join(CERT_DIR, 'meta.json');
  try {
    const meta = JSON.parse(await readFile(metaFile, 'utf8'));
    const dekt = ips.every((ip) => meta.ips?.includes(ip));
    const vers = (meta.madeAt || 0) > Date.now() - 380 * 24 * 3600 * 1000; // vóór de 397-dagen-afloop
    if (dekt && vers) {
      return {
        key: await readFile(join(CERT_DIR, 'key.pem')),
        cert: await readFile(join(CERT_DIR, 'cert.pem')),
      };
    }
  } catch { /* nog geen certificaat */ }

  // Nieuw certificaat (eerste keer, ander IP, of bijna verlopen).
  const { key, cert } = generateCert({ ips, hostnames });
  await mkdir(CERT_DIR, { recursive: true });
  await writeFile(join(CERT_DIR, 'key.pem'), key);
  await writeFile(join(CERT_DIR, 'cert.pem'), cert);
  await writeFile(metaFile, JSON.stringify({ ips, madeAt: Date.now() }));
  console.log('Nieuw https-certificaat gemaakt — apparaten zien de waarschuwing (eenmalig) opnieuw.');
  return { key: Buffer.from(key), cert: Buffer.from(cert) };
}

// Bouw de hoofdserver: https met het zelfgemaakte certificaat, of http als het
// certificaat niet te maken is (dan start de show tenminste).
async function makeServer() {
  try {
    const { key, cert } = await ensureCertFiles();
    serving = 'https';
    return createHttpsServer({ key, cert }, handleRequest);
  } catch (err) {
    console.log(`Https-certificaat niet beschikbaar (${err.message}) — val terug op http.`);
    return createServer(handleRequest);
  }
}

// --- OSC (UDP) --------------------------------------------------------------
// Een lichttafel of show-control-systeem stuurt OSC over UDP; de browser kan geen
// UDP, dus we vertalen het hier en zetten het op dezelfde bus als de remote.

let oscListening = false;

function startOsc() {
  if (!oscEnabled()) return;
  // Geen reuseAddr: we willen juist een nette EADDRINUSE als een ander programma
  // (of een tweede CueGo) de poort al heeft, i.p.v. stilletjes half meeluisteren.
  const sock = createSocket({ type: 'udp4' });

  sock.on('message', (buf, rinfo) => {
    let messages;
    try { messages = parseOsc(buf); } catch { return; } // rommel op de poort → negeren
    for (const m of messages) {
      const mapped = oscToCommand(m.address, m.args);
      if (!mapped) { console.log(`OSC genegeerd: ${m.address} (van ${rinfo.address})`); continue; }
      sendCommand(mapped.cmd, mapped.args);
    }
  });

  sock.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.log(`OSC-poort ${OSC_PORT} is bezet (draait QLab?) — OSC uit. Andere poort: CUEGO_OSC_PORT=53001`);
    } else {
      console.log(`OSC-fout: ${err.message} — OSC uit.`);
    }
    oscListening = false;
    try { sock.close(); } catch { /* al dicht */ }
  });

  sock.bind(OSC_PORT, () => {
    oscListening = true;
    console.log(`OSC luistert op UDP ${OSC_PORT} — bv. /cue/3/start, /go, /panic`);
  });
}

// Open de app in de standaardbrowser. Alleen bij een interactieve start (TTY):
// een achtergrondproces of script dat browservensters laat opploppen is een
// plaag. Uitzetten kan met CUEGO_NO_OPEN=1.
function openBrowser(url) {
  if (process.env.CUEGO_NO_OPEN || !process.stdin.isTTY) return;
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '""', url] : [url];
  try { spawn(cmd, args, { stdio: 'ignore', detached: true }).unref(); } catch { /* stil — de URL staat in de log */ }
}

// Nette opstart-samenvatting i.p.v. losse regels. In een echte terminal met kleur en
// op een schoon scherm; gepipet naar een logbestand gewoon platte tekst zonder codes.
function printStartup() {
  const isTTY = process.stdout.isTTY;
  const C = { reset: '\x1b[0m', dim: '\x1b[2m', cyan: '\x1b[36m', bold: '\x1b[1m', green: '\x1b[32m', amber: '\x1b[33m' };
  const c = (code, s) => (isTTY ? code + s + C.reset : s);
  const ips = lanIps();
  const row = (label, val) => `  ${c(C.dim, label.padEnd(18))}${c(C.cyan, val)}`;
  const L = [];
  L.push(`  ${c(C.green, '●')}  ${c(C.bold, 'CueGo draait')}`);
  L.push('');
  L.push(row('Op deze computer', `${serving}://localhost:${PORT}`));
  for (const ip of ips) L.push(row('Op je netwerk', `${serving}://${ip}:${PORT}`));
  if (ips.length) L.push(row('Afstandsbediening', `${serving}://${ips[0]}:${PORT}/remote.html`));
  L.push('');
  if (serving === 'https') L.push(`  ${c(C.amber, '›')}  Eerste keer per apparaat: certificaat accepteren (Geavanceerd → Doorgaan)`);
  if (adminPassword) L.push(`  ${c(C.amber, '🔒')}  Admin-wachtwoord actief — elk apparaat start vergrendeld tot het is ingevuld`);
  else if (ips.length) L.push(`  ${c(C.dim, '○')}  Geen wachtwoord — iedereen op dit netwerk kan de show bedienen`);
  if (adminPassword && !oscEnabled()) L.push(`  ${c(C.dim, '○')}  OSC uit (geen wachtwoord). Aanzetten: CUEGO_OSC=on`);
  if (isTTY) process.stdout.write('\x1b[2J\x1b[3J\x1b[H');
  process.stdout.write('\n' + L.join('\n') + '\n\n');
}

// Volgorde bij het starten: eerst de update-check (herstart eventueel met nieuwe
// code), dan het wachtwoord vragen, dán pas luisteren — anders kan een apparaat
// al verbinden voordat we weten of er een slot op zit.
if (!(await maybeUpdate())) {
  await warnIfNested();
  await ensureCuegoCommand();
  await loadPreferredShow(); // gekozen showcomputer overleeft een herstart
  await initAdminPassword();

  // Een verzoek waarvan de body nooit afkomt (bevroren tab die halverwege een
  // POST stilvalt) bleef anders tot 5 minuten hangen — en alle vólgende verzoeken
  // over dezelfde verbinding wachtten erachter in de rij: het beruchte 'pending'.
  // Na 15s kappen we zo'n verzoek af; de browser begint dan gewoon opnieuw.
  const server = await makeServer();
  server.requestTimeout = 15000;
  server.headersTimeout = 16000;

  // Nette melding i.p.v. een onbehandelde 'error'-crash met stacktrace. Meestal is
  // de poort bezet omdat CueGo al ergens draait (of een oude sessie hangt nog).
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\nPoort ${PORT} is al in gebruik — draait CueGo hier al?`);
      console.error('Sluit die eerst (of open gewoon de bestaande in je browser),');
      console.error(`of start op een andere poort:  PORT=4322 cuego\n`);
    } else if (err.code === 'EACCES') {
      console.error(`\nGeen toestemming voor poort ${PORT}. Kies een poort boven 1024:  PORT=4321 cuego\n`);
    } else {
      console.error(`\nCueGo kon niet starten: ${err.message}\n`);
    }
    process.exit(1);
  });

  server.listen(PORT, () => {
    printStartup();
    startOsc();
    openBrowser(`${serving}://localhost:${PORT}`);
  });
}
