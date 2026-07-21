// cuego-client.test.mjs — de CueGo-client tegen een échte server.
//
// Start zelf een CueGo-server op een vrije poort met een admin-wachtwoord en
// controleert of goede/foute wachtwoorden, statusopvragen en een onbereikbare
// server allemaal het juiste resultaat geven (en niets laten crashen).
//
// Draaien:  node streamdeck/test/cuego-client.test.mjs

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createClient, REASON } from '../me.cue-go.sdPlugin/cuego.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = 4397;
const PASSWORD = 'geheim123';

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`); }
};

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function run() {
  const server = spawn('node', ['server.mjs'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), CUEGO_ADMIN_PASSWORD: PASSWORD, CUEGO_NO_OPEN: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  server.stdout.on('data', (d) => { log += d; });
  server.stderr.on('data', (d) => { log += d; });

  // Even wachten tot hij luistert (certificaat maken kost de eerste keer wat tijd).
  await wait(4000);

  let settings = { host: '127.0.0.1', port: PORT, password: PASSWORD };
  const client = createClient(() => settings);

  // 1. Status opvragen moet lukken (nog geen app verbonden → lege toestand).
  const st = await client.state();
  check('status opvragen lukt over https met zelfgemaakt certificaat', st.reason === REASON.ok, `${st.reason} / scheme=${client.scheme}`);

  // 2. Commando met het juiste wachtwoord.
  const good = await client.command('go');
  check('commando met juist wachtwoord wordt geaccepteerd', good.reason === REASON.ok, good.reason);
  check('server meldt hoeveel clients het commando kregen', good.data && typeof good.data.delivered === 'number', JSON.stringify(good.data));

  // 3. Commando met een fout wachtwoord → auth, geen crash.
  settings = { ...settings, password: 'fout' };
  const bad = await client.command('go');
  check('fout wachtwoord geeft auth-fout (geen crash)', bad.reason === REASON.auth, bad.reason);

  // 4. Argumenten meesturen (select/play gebruiken die).
  settings = { ...settings, password: PASSWORD };
  const withArgs = await client.command('select', { dir: 'down' });
  check('commando mét argumenten wordt geaccepteerd', withArgs.reason === REASON.ok, withArgs.reason);

  // 5. De server leeft nog na al die verzoeken (incl. het foute wachtwoord).
  check('server draait nog na een fout wachtwoord', server.exitCode === null, `exit=${server.exitCode}`);

  // 6. Onbereikbare server → offline, geen exception.
  settings = { host: '127.0.0.1', port: 4321 + 999, password: PASSWORD };
  const off = await client.command('go');
  check('onbereikbare server geeft offline (geen exception)', off.reason === REASON.offline, off.reason);

  server.kill('SIGKILL');
  await wait(300);

  if (fail) console.log(`\n--- serverlog ---\n${log}`);
  console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass} geslaagd, ${fail} gefaald\n`);
  process.exit(fail === 0 ? 0 : 1);
}

run().catch((err) => { console.error(err); process.exit(1); });
