// cuego-command.test.mjs — het `cuego`-commando in het shell-profiel.
//
// Dit ging eerder mis op twee manieren die allebei pas weken later opvielen:
// een verdwenen map gaf een rauwe Node-stacktrace, en elke start eigende zich
// het commando toe waardoor je ongemerkt een oude kopie startte. Beide gedragen
// worden hier vastgelegd, met een echte zsh die de gegenereerde functie uitvoert.
//
// Draaien:  node streamdeck/test/cuego-command.test.mjs

import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TMP = join(process.env.TMPDIR || '/tmp', 'cuego-cmd-test');

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`); }
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Start de server heel even met een nagebootste HOME en geef de uitvoer terug.
async function runServer({ home, port, env = {} }) {
  const out = join(home, 'out.txt');
  const fd = spawn('node', ['server.mjs'], {
    cwd: ROOT,
    env: { ...process.env, HOME: home, SHELL: '/bin/zsh', PORT: String(port), CUEGO_ADMIN_PASSWORD: 'x', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  fd.stdout.on('data', (d) => { log += d; });
  fd.stderr.on('data', (d) => { log += d; });
  await wait(4500);
  fd.kill('SIGKILL');
  await wait(200);
  writeFileSync(out, log);
  return log;
}

// Een nep-CueGo-installatie (genoeg om als 'echte installatie' te tellen).
function fakeInstall(dir) {
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'server.mjs'), '// nep\n');
  writeFileSync(join(dir, 'src', 'app.js'), '// nep\n');
  return dir;
}

function freshHome(name) {
  const home = join(TMP, name);
  rmSync(home, { recursive: true, force: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, '.zshrc'), '');
  return home;
}

const zshrc = (home) => readFileSync(join(home, '.zshrc'), 'utf8');

async function run() {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });

  // --- 1. Verse installatie ---------------------------------------------------
  {
    const home = freshHome('vers');
    const log = await runServer({ home, port: 4381 });
    const rc = zshrc(home);
    check('verse installatie meldt dat het commando is geïnstalleerd', /Commando "cuego" ge/.test(log), log.split('\n')[0]);
    check('verse installatie schrijft een shell-functie (geen kale alias)', rc.includes('cuego() {') && !/^alias cuego=/m.test(rc));
    check('functie wijst naar deze installatie', rc.includes(join(ROOT, 'server.mjs').replace(/\/$/, '')));
  }

  // --- 2. Twee keer draaien verandert niets meer -------------------------------
  {
    const home = freshHome('idempotent');
    await runServer({ home, port: 4382 });
    const eerste = zshrc(home);
    const log2 = await runServer({ home, port: 4383 });
    check('tweede start laat het profiel ongemoeid', zshrc(home) === eerste);
    check('tweede start zegt er niets meer over', !/Commando "cuego"/.test(log2));
  }

  // --- 3. Oude losse alias wordt netjes vervangen -------------------------------
  {
    const home = freshHome('migratie');
    writeFileSync(join(home, '.zshrc'),
      `export FOO=1\n# CueGo vanaf elke plek starten\nalias cuego='node "${join(ROOT, 'server.mjs')}"'\nexport BAR=2\n`);
    await runServer({ home, port: 4384 });
    const rc = zshrc(home);
    check('oude alias is weg', !/^alias cuego=/m.test(rc), rc);
    check('nieuwe functie staat er', rc.includes('cuego() {'));
    check('de rest van het profiel blijft staan', rc.includes('export FOO=1') && rc.includes('export BAR=2'));
  }

  // --- 3b. Meerdere oude aliassen: er mag er GEEN één blijven staan --------------
  // Zsh weigert een functie te maken als er nog een alias met die naam is
  // ("defining function based on alias") en geeft dan een parse-fout waardoor
  // het hele profiel niet meer laadt. Eén vergeten regel is dus fataal.
  {
    const home = freshHome('meerdere-aliassen');
    writeFileSync(join(home, '.zshrc'),
      'export A=1\n'
      + `alias cuego='node "/weg/een/server.mjs"'\n`
      + 'export B=2\n'
      + `alias cuego='node "/weg/twee/server.mjs"'\n`
      + `alias cuego='node "/weg/drie/server.mjs"'\n`
      + 'export C=3\n');
    await runServer({ home, port: 4390 });
    const rc = zshrc(home);
    check('álle oude aliassen zijn weg', !/alias cuego=/.test(rc), rc.match(/alias cuego=.*/g)?.join(' | '));
    check('de rest van het profiel blijft staan', ['export A=1', 'export B=2', 'export C=3'].every((l) => rc.includes(l)));

    // De echte toets: laadt het profiel nog, en werkt cuego?
    const res = spawnSync('/bin/zsh', ['-c', `source ${JSON.stringify(join(home, '.zshrc'))}; type cuego`], { encoding: 'utf8' });
    check('het profiel laadt zonder parse-fout', !/parse error|defining function based on alias/.test(res.stderr), res.stderr.trim());
    check('cuego is daarna de nieuwe functie', /cuego is a shell function/.test(res.stdout), res.stdout.trim());
  }

  // --- 4. Commando hoort bij een ANDERE, nog bestaande installatie --------------
  {
    const home = freshHome('nietafpakken');
    const ander = fakeInstall(join(TMP, 'andere-cuego'));
    writeFileSync(join(home, '.zshrc'),
      `# >>> CueGo >>>\ncuego() {\n  node "${join(ander, 'server.mjs')}" "$@"\n}\n# <<< CueGo <<<\n`);
    const voor = zshrc(home);
    const log = await runServer({ home, port: 4385 });
    check('pakt het commando NIET af van een bestaande installatie', zshrc(home) === voor, 'profiel is gewijzigd');
    check('legt uit bij wie het commando hoort', log.includes(ander), log.split('\n').slice(0, 3).join(' | '));
    check('vertelt hoe je bewust wisselt', /CUEGO_CLAIM=1/.test(log));
  }

  // --- 5. Met CUEGO_CLAIM=1 mag het wél ------------------------------------------
  {
    const home = freshHome('claim');
    const ander = fakeInstall(join(TMP, 'andere-cuego2'));
    writeFileSync(join(home, '.zshrc'),
      `# >>> CueGo >>>\ncuego() {\n  node "${join(ander, 'server.mjs')}" "$@"\n}\n# <<< CueGo <<<\n`);
    await runServer({ home, port: 4386, env: { CUEGO_CLAIM: '1' } });
    check('CUEGO_CLAIM=1 neemt het commando wél over', zshrc(home).includes(join(ROOT, 'server.mjs')));
  }

  // --- 6. Commando wees naar een map die niet meer bestaat -------------------------
  {
    const home = freshHome('verdwenen');
    const weg = join(TMP, 'bestaat-niet');
    writeFileSync(join(home, '.zshrc'),
      `# >>> CueGo >>>\ncuego() {\n  node "${join(weg, 'server.mjs')}" "$@"\n}\n# <<< CueGo <<<\n`);
    const log = await runServer({ home, port: 4387 });
    check('neemt het commando over als de oude map weg is', zshrc(home).includes(join(ROOT, 'server.mjs')));
    check('meldt dat de oude map niet meer bestaat', /bestaat niet meer/.test(log), log.split('\n')[0]);
  }

  // --- 7. De gegenereerde functie werkt écht in zsh ----------------------------------
  {
    const home = freshHome('zsh');
    await runServer({ home, port: 4388 });
    const rc = join(home, '.zshrc');

    // (a) installatie aanwezig → moet node aanroepen (we checken via --help-achtig gedrag)
    const aanwezig = spawnSync('/bin/zsh', ['-c', `source ${JSON.stringify(rc)}; type cuego`], { encoding: 'utf8' });
    check('zsh kent de functie cuego na source', /cuego is a shell function/.test(aanwezig.stdout), aanwezig.stdout.trim());

    // (b) installatie weg → nette melding en exitcode 1, géén Node-stacktrace
    const kapot = join(home, '.zshrc-kapot');
    writeFileSync(kapot, readFileSync(rc, 'utf8').replaceAll(ROOT.replace(/\/$/, ''), join(TMP, 'weg-hier')));
    const res = spawnSync('/bin/zsh', ['-c', `source ${JSON.stringify(kapot)}; cuego`], { encoding: 'utf8' });
    check('verdwenen installatie geeft exitcode 1', res.status === 1, `status=${res.status}`);
    check('verdwenen installatie geeft een leesbare melding', /CueGo staat niet meer in/.test(res.stdout), res.stdout.trim());
    check('verdwenen installatie geeft GEEN Node-stacktrace',
      !/Cannot find module|MODULE_NOT_FOUND/.test(res.stdout + res.stderr), (res.stdout + res.stderr).slice(0, 120));
    check('verdwenen installatie noemt het installatiecommando', /git clone .*CueGo\.git/.test(res.stdout));
  }

  // --- 8. Geneste installatie wordt gemeld -------------------------------------------
  {
    const home = freshHome('nested');
    const buiten = fakeInstall(join(TMP, 'buitenste'));
    // Een echte CueGo in een submap van een andere "installatie" zetten.
    const binnen = join(buiten, 'cuego');
    mkdirSync(binnen, { recursive: true });
    for (const f of ['server.mjs', 'cert.mjs', 'osc.mjs']) {
      writeFileSync(join(binnen, f), readFileSync(join(ROOT, f)));
    }
    mkdirSync(join(binnen, 'src'), { recursive: true });
    for (const f of ['app.js', 'control.js', 'audio-engine.js', 'cue-model.js', 'midi.js', 'net-remote.js', 'project.js', 'projects-store.js', 'show-sync.js', 'storage.js']) {
      writeFileSync(join(binnen, 'src', f), readFileSync(join(ROOT, 'src', f)));
    }
    const fd = spawn('node', ['server.mjs'], {
      cwd: binnen,
      env: { ...process.env, HOME: home, SHELL: '/bin/zsh', PORT: '4389', CUEGO_ADMIN_PASSWORD: 'x' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = '';
    fd.stdout.on('data', (d) => { log += d; });
    fd.stderr.on('data', (d) => { log += d; });
    await wait(4500);
    fd.kill('SIGKILL');
    await wait(200);
    check('geneste installatie wordt gemeld', /staat ín een andere CueGo-installatie/.test(log), log.split('\n')[0]);
    check('de melding noemt beide paden', log.includes(binnen) && log.includes(buiten));
  }

  rmSync(TMP, { recursive: true, force: true });
  console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass} geslaagd, ${fail} gefaald\n`);
  process.exit(fail === 0 ? 0 : 1);
}

run().catch((err) => { console.error(err); process.exit(1); });
