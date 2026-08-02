// dmx-send.test.mjs — de DMX-cue-brug end-to-end.
//
// Start een echte CueGo-server, laat 'm via /api/dmx-send Art-Net versturen, en
// vangt de UDP-pakketten op poort 6454 op. Controleert de set, de fade (meerdere
// frames richting het doel) en dat sACN geaccepteerd wordt.
//
// Draaien:  node test/dmx-send.test.mjs

import { spawn } from 'node:child_process';
import { request } from 'node:https';
import { createSocket } from 'node:dgram';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4375;
const ARTNET = 6454;

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

// Uitpakken van een ArtDMX-pakket → { universe, data }.
function parseArtnet(buf) {
  if (buf.toString('ascii', 0, 8) !== 'Art-Net\0') return null;
  if (buf.readUInt16LE(8) !== 0x5000) return null;
  const universe = buf.readUInt16LE(14) & 0x7fff;
  const len = buf.readUInt16BE(16);
  return { universe, data: buf.subarray(18, 18 + len) };
}

async function run() {
  const recv = createSocket('udp4');
  const packets = [];
  recv.on('message', (buf) => { const p = parseArtnet(buf); if (p) packets.push(p); });
  await new Promise((r) => recv.bind(ARTNET, '127.0.0.1', r));

  const server = spawn('node', ['server.mjs'], { // rechtstreeks, niet setup.mjs
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), CUEGO_NO_ALIAS: '1', CUEGO_OSC: 'off' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = ''; server.stdout.on('data', (d) => { log += d; }); server.stderr.on('data', (d) => { log += d; });
  await wait(4000);

  // 1) Directe set (fade 0): één frame met de juiste waarden.
  packets.length = 0;
  const set = await post('/api/dmx-send', { protocol: 'artnet', host: '127.0.0.1', universe: 1, channels: [{ ch: 1, value: 255 }, { ch: 5, value: 128 }], fadeTime: 0 });
  check('server accepteert /api/dmx-send', set.status === 200 && set.body.ok === true, `HTTP ${set.status}`);
  await wait(200);
  check('Art-Net-frame komt aan', packets.length >= 1, `ontvangen: ${packets.length}`);
  if (packets[0]) {
    check('juiste universe', packets[0].universe === 1, String(packets[0].universe));
    check('kanaal 1 = 255', packets[0].data[0] === 255, String(packets[0].data[0]));
    check('kanaal 5 = 128', packets[0].data[4] === 128, String(packets[0].data[4]));
    check('ongenoemd kanaal 2 = 0', packets[0].data[1] === 0);
  }

  // 2) Fade: meerdere frames, laatste op het doel; ongenoemde kanalen behouden.
  packets.length = 0;
  await post('/api/dmx-send', { protocol: 'artnet', host: '127.0.0.1', universe: 1, channels: [{ ch: 1, value: 0 }], fadeTime: 0.3 });
  await wait(600);
  check('fade stuurt meerdere frames', packets.length >= 5, `frames: ${packets.length}`);
  const last = packets[packets.length - 1];
  check('fade eindigt op het doel (kanaal 1 = 0)', last && last.data[0] === 0, String(last?.data[0]));
  check('ongenoemd kanaal 5 blijft 128 tijdens de fade', last && last.data[4] === 128, String(last?.data[4]));

  // 3) sACN wordt geaccepteerd (multicast vangen we hier niet op).
  const sacn = await post('/api/dmx-send', { protocol: 'sacn', universe: 1, channels: [{ ch: 1, value: 10 }], fadeTime: 0 });
  check('sACN wordt geaccepteerd', sacn.status === 200 && sacn.body.ok === true, `HTTP ${sacn.status}`);

  // 4) Zonder kanalen → 400, geen crash.
  const bad = await post('/api/dmx-send', { protocol: 'artnet' });
  check('zonder kanalen → 400', bad.status === 400, `HTTP ${bad.status}`);
  check('server draait nog', server.exitCode === null);

  server.kill('SIGKILL'); recv.close();
  await wait(200);
  if (fail) console.log(`\n--- serverlog ---\n${log.slice(-600)}`);
  console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass} geslaagd, ${fail} gefaald\n`);
  process.exit(fail === 0 ? 0 : 1);
}

run().catch((err) => { console.error(err); process.exit(1); });
