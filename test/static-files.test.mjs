// static-files.test.mjs — wat de server wél en niet van schijf geeft.
//
// De server serveerde eerder élk bestand uit de projectmap. Omdat CueGo bedoeld
// is om op je LAN bereikbaar te zijn, betekende dat: iedereen op het netwerk kon
// cert/key.pem ophalen — de private sleutel van het https-certificaat — plus
// .git, de show en je projecten. Deze test legt de allowlist vast.
//
// Draaien:  node streamdeck/test/static-files.test.mjs

import { spawn } from 'node:child_process';
import { request } from 'node:https';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4391;

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

// Alles wat de app nodig heeft moet blijven werken …
const MOET_WERKEN = [
  '/', '/app.html', '/index.html', '/remote.html', '/404.html',
  '/style.css', '/src/app.js', '/src/control.js', '/src/audio-engine.js',
  '/assets/logo.png', '/robots.txt', '/sitemap.xml',
];

// … en dit mag er niet uit, ook niet vanaf het LAN.
const MOET_DICHT = [
  '/cert/key.pem',        // de private sleutel — het ergste lek
  '/cert/cert.pem',
  '/cert/meta.json',
  '/.git/config',
  '/.git/HEAD',
  '/server.mjs',
  '/cert.mjs',
  '/osc.mjs',
  '/setup.mjs',
  '/README.md',
  '/show/show.json',
  '/package.json',
  '/streamdeck/me.cue-go.sdPlugin/plugin.mjs',
  '/.DS_Store',
  // Klassieke trucs om er alsnog langs te komen:
  '/src/../cert/key.pem',
  '/./cert/key.pem',
  '/src/./../cert/key.pem',
];

async function run() {
  const server = spawn('node', ['server.mjs'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), CUEGO_ADMIN_PASSWORD: 'x', CUEGO_NO_ALIAS: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  server.stdout.on('data', (d) => { log += d; });
  server.stderr.on('data', (d) => { log += d; });
  await wait(4000);

  console.log('  -- moet bereikbaar blijven --');
  for (const p of MOET_WERKEN) {
    const r = await get(p);
    check(`${p} werkt`, r.status === 200 && r.body.length > 0, `HTTP ${r.status}`);
  }

  console.log('  -- moet geblokkeerd zijn --');
  for (const p of MOET_DICHT) {
    const r = await get(p);
    const geblokkeerd = r.status === 404 || r.status === 403;
    check(`${p} is dicht`, geblokkeerd, `HTTP ${r.status}`);
  }

  // De sleutel mag onder geen enkele omstandigheid in een antwoord opduiken.
  console.log('  -- inhoudscontrole --');
  const key = await get('/cert/key.pem');
  check('private sleutel lekt niet in de body', !/BEGIN (RSA )?PRIVATE KEY/.test(key.body), key.body.slice(0, 40));

  // De app zelf moet echt bruikbaar zijn, niet alleen HTTP 200 geven.
  const app = await get('/app.html');
  check('app.html bevat de echte app', app.body.includes('src/app.js'));
  const appjs = await get('/src/app.js');
  check('src/app.js is de echte broncode', appjs.body.includes('function apiState'));

  server.kill('SIGKILL');
  await wait(200);
  if (fail) console.log(`\n--- serverlog ---\n${log.slice(-800)}`);
  console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass} geslaagd, ${fail} gefaald\n`);
  process.exit(fail === 0 ? 0 : 1);
}

run().catch((err) => { console.error(err); process.exit(1); });
