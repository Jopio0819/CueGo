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

import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('.', import.meta.url));

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

const child = spawn(process.execPath, [join(ROOT, 'server.mjs')], { stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 0));
