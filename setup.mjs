// setup.mjs — het installatiecommando van de website eindigt hier: start de
// server. Die installeert bij elke start zelf het `cuego`-commando (een functie
// in je shell-profiel op macOS/Linux, cuego.cmd in WindowsApps op Windows), dus
// daar hoeft hier niets voor te gebeuren.
//
// Met --minimal (dat het installatiecommando meegeeft) laten we alles buiten de
// installatie wat een showcomputer niet nodig heeft:
//
//   - streamdeck/ en test/ — ontwikkelspullen;
//   - sitemap.xml, robots.txt en CNAME — die horen bij de website cue-go.me.
//     Ze moeten in de hoofdmap van de repo staan omdat GitHub Pages ze daar
//     verwacht, maar op jouw server hebben ze niets te zoeken. (De server
//     beantwoordt /robots.txt zelf, met Disallow, zodat een CueGo die naar
//     buiten openstaat niet in zoekmachines belandt.)
//
// Dat gaat met sparse-checkout, bewust gekozen boven ze weggooien:
//
//   - git blíjft ze kennen, dus de werkmap blijft schoon. Zou je de bestanden
//     écht verwijderen, dan staat er "deleted" in `git status` en slaat de
//     updatecheck het bijwerken voorgoed over (zie checkForUpdate in server.mjs).
//   - alles terughalen is één commando:  git -C ~/cuego sparse-checkout disable
//
// Non-cone-modus is nodig omdat je in cone-modus alleen mappen kunt kiezen:
// losse bestanden in de hoofdmap komen daar altijd mee.
//
// Zonder --minimal (bijvoorbeeld als je zelf `node setup.mjs` draait in een
// ontwikkelkopie) blijft alles gewoon staan.
//
// Spotify-playlists voorbereiden gebruikt spotDL. Ontbreekt dat, dan vraagt de
// installer of het in een lokale virtualenv naast CueGo mag worden gezet. Die
// map staat in .gitignore en raakt systeem-Python dus niet.

import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const SPOTDL_VENV = process.env.CUEGO_SPOTDL_VENV || join(ROOT, '.spotdl-venv');
const SPOTDL_BIN = process.platform === 'win32'
  ? join(SPOTDL_VENV, 'Scripts', 'spotdl.exe')
  : join(SPOTDL_VENV, 'bin', 'spotdl');
const SPOTDL_PYTHON = process.platform === 'win32'
  ? join(SPOTDL_VENV, 'Scripts', 'python.exe')
  : join(SPOTDL_VENV, 'bin', 'python');
const SPOTDL_SETUP_COMMAND = `node "${join(ROOT, 'setup.mjs')}" --spotdl-only`;

function works(command, args = []) {
  if (!command) return false;
  const result = spawnSync(command, args, { stdio: 'ignore', windowsHide: true, timeout: 10000 });
  return result.status === 0;
}

function findPython() {
  if (process.env.CUEGO_PYTHON) {
    return works(process.env.CUEGO_PYTHON, ['--version'])
      ? { command: process.env.CUEGO_PYTHON, prefix: [] }
      : null;
  }
  const candidates = process.platform === 'win32'
    ? [{ command: 'py', prefix: ['-3'] }, { command: 'python', prefix: [] }, { command: 'python3', prefix: [] }]
    : [{ command: 'python3', prefix: [] }, { command: 'python', prefix: [] }];
  return candidates.find((c) => works(c.command, [...c.prefix, '--version'])) || null;
}

function hasSpotdl() {
  if (process.env.CUEGO_SPOTDL) return works(process.env.CUEGO_SPOTDL, ['--version']);
  if (existsSync(SPOTDL_BIN) && works(SPOTDL_BIN, ['--version'])) return true;
  if (works('spotdl', ['--version'])) return true;
  const python = findPython();
  return !!(python && works(python.command, [...python.prefix, '-m', 'spotdl', '--version']));
}

async function wantsSpotdl() {
  const forced = String(process.env.CUEGO_INSTALL_SPOTDL || '').toLowerCase();
  if (['1', 'true', 'yes', 'ja'].includes(forced)) return true;
  if (['0', 'false', 'no', 'nee'].includes(forced)) return false;
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;

  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await prompt.question(
      'Spotify-playlists offline voorbereiden gebruikt spotDL. Nu lokaal installeren? [J/n] '
    );
    return !/^(n|nee|no)$/i.test(answer.trim());
  } finally {
    prompt.close();
  }
}

async function ensureSpotdl() {
  if (hasSpotdl()) {
    console.log('spotDL is al beschikbaar — Spotify-playlists kunnen offline worden voorbereid.\n');
    return;
  }
  if (!(await wantsSpotdl())) {
    console.log(`spotDL overgeslagen. Later toevoegen? Draai: ${SPOTDL_SETUP_COMMAND}\n`);
    return;
  }

  const python = findPython();
  if (!python) {
    console.log(`spotDL niet geïnstalleerd: Python 3 is niet gevonden. Installeer Python 3 en draai daarna: ${SPOTDL_SETUP_COMMAND}\n`);
    return;
  }

  console.log('\nspotDL installeren in een eigen CueGo-omgeving…');
  const made = spawnSync(python.command, [...python.prefix, '-m', 'venv', SPOTDL_VENV], { stdio: 'inherit', windowsHide: true });
  if (made.status !== 0 || !existsSync(SPOTDL_PYTHON)) {
    console.log('Kon de lokale Python-omgeving niet maken. CueGo start zonder Spotify-import.\n');
    return;
  }

  const installed = spawnSync(SPOTDL_PYTHON, ['-m', 'pip', 'install', 'spotdl'], { stdio: 'inherit', windowsHide: true });
  if (installed.status !== 0 || !existsSync(SPOTDL_BIN)) {
    console.log('spotDL installeren is mislukt. CueGo start verder zonder Spotify-import.\n');
    return;
  }

  console.log('\nFFmpeg voor spotDL installeren…');
  const ffmpeg = spawnSync(SPOTDL_BIN, ['--download-ffmpeg'], { stdio: 'inherit', windowsHide: true });
  if (ffmpeg.status !== 0) {
    console.log(`spotDL staat erop, maar FFmpeg downloaden mislukte. Probeer later: "${SPOTDL_BIN}" --download-ffmpeg\n`);
    return;
  }
  console.log('spotDL is klaar — geïmporteerde Spotify-playlists werken tijdens de show volledig offline.\n');
}

if (process.argv.includes('--minimal')) {
  // '/*' = neem alles, daarna gericht uitzonderen. Mislukt het (git ouder dan
  // 2.25, of een zip-download zonder git), dan krijg je gewoon alles: hooguit
  // wat groter, nooit stuk. Vandaar geen foutmelding.
  const res = spawnSync('git', [
    '-C', ROOT, 'sparse-checkout', 'set', '--no-cone',
    '/*', '!/streamdeck/', '!/test/', '!/sitemap.xml', '!/robots.txt', '!/CNAME',
  ], { stdio: 'ignore' });
  if (res.status === 0) {
    console.log('Alleen de app geïnstalleerd — plugin, tests en websitebestanden overgeslagen.');
    console.log('Alles alsnog nodig?  git -C ~/cuego sparse-checkout disable\n');
  }
}

await ensureSpotdl();

// Tests en beheer kunnen via de omgevingsvariabele of --spotdl-only alleen de
// installatiecontrole draaien. Het normale installatiecommando start de server.
if (!process.env.CUEGO_SETUP_ONLY && !process.argv.includes('--spotdl-only')) {
  const child = spawn(process.execPath, [join(ROOT, 'server.mjs')], { stdio: 'inherit' });
  child.on('exit', (code) => process.exit(code ?? 0));
}
