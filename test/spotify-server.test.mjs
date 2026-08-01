// End-to-end van de lokale playlistjob, met fake-spotdl zodat de test offline en
// auteursrechtvrij blijft.

import { spawn } from 'node:child_process';
import { request } from 'node:https';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4394;
const PLAYLIST = 'https://open.spotify.com/playlist/37i9dQZF1E8UXBoz02kGID';
let pass = 0, fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`); }
};

function http(path, { method = 'GET', body } = {}) {
  return new Promise((resolve) => {
    const data = body == null ? null : Buffer.from(JSON.stringify(body));
    const req = request({
      host: '127.0.0.1', port: PORT, path, method, rejectUnauthorized: false,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {},
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    });
    req.on('error', () => resolve({ status: 0, body: Buffer.alloc(0) }));
    if (data) req.write(data);
    req.end();
  });
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const json = (res) => JSON.parse(res.body.toString('utf8') || '{}');

const server = spawn(process.execPath, ['server.mjs'], {
  cwd: ROOT,
  env: {
    ...process.env, PORT: String(PORT), CUEGO_SPOTDL: join(ROOT, 'test', 'fake-spotdl.mjs'),
    CUEGO_NO_UPDATE_CHECK: '1', CUEGO_NO_ALIAS: '1', CUEGO_NO_OPEN: '1', CUEGO_OSC: 'off',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
server.stdout.on('data', (d) => { log += d; });
server.stderr.on('data', (d) => { log += d; });

try {
  for (let i = 0; i < 50; i++) {
    if ((await http('/api/ping')).status === 200) break;
    await wait(100);
  }

  const bad = await http('/api/spotify-import', { method: 'POST', body: { url: 'https://example.com/playlist/nope' } });
  check('ongeldige URL wordt geweigerd', bad.status === 400, `HTTP ${bad.status}`);

  const started = await http('/api/spotify-import', { method: 'POST', body: { url: PLAYLIST } });
  const startData = json(started);
  check('playlistjob start', started.status === 202 && /^[a-f0-9]{32}$/.test(startData.id || ''), `HTTP ${started.status}`);

  let state = startData;
  for (let i = 0; i < 50 && state.status === 'running'; i++) {
    await wait(100);
    state = json(await http(`/api/spotify-import/${startData.id}`));
  }
  check('job rondt af', state.status === 'done', state.error || state.status);
  check('twee bestanden in playlistvolgorde', state.files?.length === 2 && state.files[0].name.startsWith('1.') && state.files[1].name.startsWith('2.'), JSON.stringify(state.files));

  const audio = await http(`/api/spotify-import/${startData.id}/files/0`);
  check('audiobestand is op te halen', audio.status === 200 && audio.body.toString() === 'fake-one', `HTTP ${audio.status}`);

  const removed = await http(`/api/spotify-import/${startData.id}`, { method: 'DELETE' });
  check('tijdelijke job wordt opgeruimd', removed.status === 200);
  const gone = await http(`/api/spotify-import/${startData.id}`);
  check('opgeruimde job is weg', gone.status === 404, `HTTP ${gone.status}`);
} finally {
  server.kill('SIGKILL');
  await wait(100);
}

if (fail) console.log(`\n--- serverlog ---\n${log.slice(-1200)}`);
console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass} geslaagd, ${fail} gefaald\n`);
process.exit(fail === 0 ? 0 : 1);
