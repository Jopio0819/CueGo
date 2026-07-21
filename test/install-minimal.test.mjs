// install-minimal.test.mjs — wat een normale installatie wél en niet bevat.
//
// Kloont de repo zoals het installatiecommando dat doet, draait setup.mjs
// --minimal, en controleert het resultaat. De belangrijkste controle is niet
// "staan de juiste bestanden er", maar "is git nog schoon": zou sparse-checkout
// bestanden als verwijderd markeren, dan slaat checkForUpdate() het bijwerken
// voorgoed over en krijgt niemand ooit nog een update binnen.
//
// Draaien:  node test/install-minimal.test.mjs

import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { request } from 'node:https';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TMP = join(process.env.TMPDIR || '/tmp', 'cuego-install-test');
const PORT = 4378;

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`); }
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function get(path) {
  return new Promise((resolve) => {
    const req = request({ host: '127.0.0.1', port: PORT, path, method: 'GET', rejectUnauthorized: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', () => resolve({ status: 0, body: '' }));
    req.end();
  });
}

const git = (dir, args) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });

async function run() {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  const inst = join(TMP, 'cuego');

  // Klonen zoals het installatiecommando: uit de repo zelf, niet van GitHub, zodat
  // we de code testen die nu op tafel ligt.
  const cloned = spawnSync('git', ['clone', '--quiet', ROOT, inst], { encoding: 'utf8' });
  if (cloned.status !== 0) {
    console.log(`  ✗ klonen mislukt — ${cloned.stderr}`);
    process.exit(1);
  }

  // Wat de installatie hoort te hebben, en wat niet.
  const MOET_ER_ZIJN = ['app.html', 'index.html', 'remote.html', '404.html', 'style.css', 'server.mjs', 'setup.mjs', 'src', 'assets'];
  const MOET_WEG = ['streamdeck', 'test', 'sitemap.xml', 'robots.txt', 'CNAME'];

  check('vóór --minimal zit alles er nog in', MOET_WEG.every((f) => existsSync(join(inst, f))));

  const server = spawn('node', ['setup.mjs', '--minimal'], {
    cwd: inst,
    env: {
      ...process.env,
      PORT: String(PORT),
      CUEGO_ADMIN_PASSWORD: 'x',
      CUEGO_NO_ALIAS: '1',        // niet aan het echte shell-profiel zitten
      CUEGO_NO_UPDATE_CHECK: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  server.stdout.on('data', (d) => { log += d; });
  server.stderr.on('data', (d) => { log += d; });
  await wait(6000);

  console.log('  -- moet aanwezig blijven --');
  for (const f of MOET_ER_ZIJN) check(`${f}`, existsSync(join(inst, f)));

  console.log('  -- moet weg zijn --');
  for (const f of MOET_WEG) check(`${f} is niet meegekopieerd`, !existsSync(join(inst, f)));

  console.log('  -- git --');
  const status = git(inst, ['status', '--porcelain']).stdout.trim();
  check('werkmap is schoon (anders stoppen updates voorgoed)', status === '', status.split('\n').slice(0, 4).join(' | '));
  check('git kent de weggelaten bestanden nog steeds',
    git(inst, ['ls-files', 'sitemap.xml', 'streamdeck']).stdout.trim().length > 0);
  const pull = git(inst, ['pull', '--ff-only']);
  check('git pull --ff-only werkt nog', pull.status === 0, pull.stderr.trim());
  check('na pull nog steeds schoon', git(inst, ['status', '--porcelain']).stdout.trim() === '');
  check('na pull blijft sitemap.xml weg', !existsSync(join(inst, 'sitemap.xml')));

  console.log('  -- de server draait gewoon --');
  const app = await get('/app.html');
  check('app.html wordt geserveerd', app.status === 200, `HTTP ${app.status}`);
  const appjs = await get('/src/app.js');
  check('src/app.js wordt geserveerd', appjs.status === 200, `HTTP ${appjs.status}`);
  const robots = await get('/robots.txt');
  check('robots.txt komt van de server zelf, niet van schijf',
    robots.status === 200 && /Disallow:\s*\//.test(robots.body), JSON.stringify(robots.body));
  const sitemap = await get('/sitemap.xml');
  check('sitemap.xml is er niet', sitemap.status === 404, `HTTP ${sitemap.status}`);

  console.log('  -- alles terughalen --');
  const herstel = git(inst, ['sparse-checkout', 'disable']);
  check('sparse-checkout disable werkt', herstel.status === 0, herstel.stderr.trim());
  check('daarna staat alles er weer', MOET_WEG.every((f) => existsSync(join(inst, f))));
  check('en git is nog steeds schoon', git(inst, ['status', '--porcelain']).stdout.trim() === '');

  server.kill('SIGKILL');
  await wait(300);
  rmSync(TMP, { recursive: true, force: true });

  if (fail) console.log(`\n--- log ---\n${log.slice(-1000)}`);
  console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass} geslaagd, ${fail} gefaald\n`);
  process.exit(fail === 0 ? 0 : 1);
}

run().catch((err) => { console.error(err); process.exit(1); });
