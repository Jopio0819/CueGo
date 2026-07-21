// setup.mjs — het installatiecommando van de website eindigt hier: start de
// server. Die installeert bij elke start zelf het `cuego`-commando (een functie
// in je shell-profiel op macOS/Linux, cuego.cmd in WindowsApps op Windows), dus
// daar hoeft hier niets voor te gebeuren.
//
// Met --minimal (dat het installatiecommando meegeeft) laten we eerst de
// ontwikkelspullen buiten de installatie: de Stream Deck-plugin en de tests
// hoeven niet op een showcomputer te staan. Dat gaat met sparse-checkout, en dat
// is bewust gekozen boven ze weggooien:
//
//   - git blíjft ze kennen, dus de werkmap blijft schoon. Zou je de bestanden
//     écht verwijderen, dan staat er "deleted" in `git status` en slaat de
//     updatecheck het bijwerken voorgoed over (zie checkForUpdate in server.mjs).
//   - je haalt ze er later alsnog bij met één commando:
//         git -C ~/cuego sparse-checkout set src assets streamdeck
//
// Zonder --minimal (bijvoorbeeld als je zelf `node setup.mjs` draait in een
// ontwikkelkopie) blijft alles gewoon staan.

import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('.', import.meta.url));

if (process.argv.includes('--minimal')) {
  // In cone-modus horen de bestanden in de hoofdmap er altijd bij; we noemen dus
  // alleen de mappen die de app nodig heeft. Mislukt het (git ouder dan 2.25, of
  // een zip-download zonder git), dan krijg je gewoon alles: hooguit wat groter,
  // nooit stuk. Vandaar geen foutmelding.
  const res = spawnSync('git', ['-C', ROOT, 'sparse-checkout', 'set', 'src', 'assets'], { stdio: 'ignore' });
  if (res.status === 0) {
    console.log('Alleen de app geïnstalleerd — Stream Deck-plugin en tests overgeslagen.');
    console.log('Later alsnog nodig?  git -C ~/cuego sparse-checkout set src assets streamdeck\n');
  }
}

const child = spawn(process.execPath, [join(ROOT, 'server.mjs')], { stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 0));
