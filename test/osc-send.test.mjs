// osc-send.test.mjs — de OSC-cue-brug end-to-end.
//
// Start een echte CueGo-server, laat 'm via /api/osc-send een OSC-pakket
// versturen, en vang dat op een eigen UDP-socket op. Zo testen we dat de
// browser→server→UDP-keten (waar een OSC-cue op leunt) echt werkt.
//
// Draaien:  node test/osc-send.test.mjs

import { spawn } from 'node:child_process';
import { request } from 'node:https';
import { createSocket } from 'node:dgram';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseOsc } from '../osc.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4376;
const OSC_RECV = 9931;

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`); }
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function post(path, body) {
  return new Promise((resolve) => {
    const data = Buffer.from(JSON.stringify(body));
    const req = request({ host: '127.0.0.1', port: PORT, path, method: 'POST', rejectUnauthorized: false, headers: { 'Content-Type': 'application/json', 'Content-Length': data.length } }, (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c));
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString() || '{}') }); } catch { resolve({ status: res.statusCode, body: {} }); } });
    });
    req.on('error', () => resolve({ status: 0, body: {} }));
    req.write(data); req.end();
  });
}

async function run() {
  // UDP-ontvanger die doet alsof 'ie een lichttafel/ander systeem is.
  const recv = createSocket('udp4');
  const got = [];
  recv.on('message', (buf) => { try { got.push(...parseOsc(buf)); } catch { /* rommel */ } });
  await new Promise((r) => recv.bind(OSC_RECV, '127.0.0.1', r));

  const server = spawn('node', ['server.mjs'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), CUEGO_NO_ALIAS: '1' }, // geen wachtwoord → open
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = ''; server.stdout.on('data', (d) => { log += d; }); server.stderr.on('data', (d) => { log += d; });
  await wait(4000);

  // 1) Een OSC-cue verstuurt een bericht met gemengde args.
  const res = await post('/api/osc-send', { host: '127.0.0.1', port: OSC_RECV, address: '/cue/3/go', args: [1, 2.5, 'hoi'] });
  check('server accepteert /api/osc-send', res.status === 200 && res.body.ok === true, `HTTP ${res.status} ${JSON.stringify(res.body)}`);
  await wait(200);
  check('UDP-pakket komt aan bij de ontvanger', got.length === 1, `ontvangen: ${got.length}`);
  if (got[0]) {
    check('adres klopt', got[0].address === '/cue/3/go', got[0].address);
    check('args kloppen (int/float/string)', got[0].args[0] === 1 && Math.abs(got[0].args[1] - 2.5) < 1e-6 && got[0].args[2] === 'hoi', JSON.stringify(got[0].args));
  }

  // 2) Ontbrekend adres → nette 400, geen crash.
  const bad = await post('/api/osc-send', { host: '127.0.0.1', port: OSC_RECV });
  check('zonder adres → 400', bad.status === 400, `HTTP ${bad.status}`);
  check('server draait nog', server.exitCode === null);

  server.kill('SIGKILL'); recv.close();
  await wait(200);
  if (fail) console.log(`\n--- serverlog ---\n${log.slice(-600)}`);
  console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass} geslaagd, ${fail} gefaald\n`);
  process.exit(fail === 0 ? 0 : 1);
}

run().catch((err) => { console.error(err); process.exit(1); });
