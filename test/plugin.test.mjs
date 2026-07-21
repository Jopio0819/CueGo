// plugin.test.mjs — de plugin end-to-end, zonder Stream Deck-hardware.
//
// Opstelling:
//   [nep-Stream Deck] ←ws→ [plugin.mjs] ←https→ [echte CueGo-server] ←sse→ [nep-app]
//
// De nep-app is een gewone SSE-client zoals de echte CueGo-app: hij ontvangt de
// commando's die de plugin stuurt en pusht een showtoestand terug. Zo testen we
// niet alleen "de plugin doet iets", maar dat het commando écht bij de show
// aankomt en dat de knoptitels kloppen met wat er speelt.
//
// Draaien:  node streamdeck/test/plugin.test.mjs

import { spawn } from 'node:child_process';
import { request as httpsRequest } from 'node:https';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { startFakeStreamDeck } from './fake-streamdeck.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const PLUGIN = join(ROOT, 'streamdeck', 'me.cue-go.sdPlugin', 'plugin.mjs');
const PORT = 4396;
const PASSWORD = 'showtijd';

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`); }
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// De show die de nep-app naar de server pusht.
const SHOW = {
  projectName: 'Testshow',
  locked: false,
  remoteEnabled: true,
  selectedId: 'cue-2',
  cues: [
    { id: 'cue-1', index: 1, number: '1', name: 'Intro',   selected: false, playing: true,  paused: false, position: 10, duration: 70 },
    { id: 'cue-2', index: 2, number: '2', name: 'Applaus', selected: true,  playing: false, paused: false, position: 0,  duration: 30 },
  ],
};

// --- Nep-app: SSE-client die commando's opvangt en de toestand pusht -----------

function startFakeApp() {
  return new Promise((resolve) => {
    const commands = [];
    let appId = null;
    let buf = '';

    const req = httpsRequest(
      {
        host: '127.0.0.1', port: PORT, path: '/api/events?role=app&deviceId=faketest',
        method: 'GET', rejectUnauthorized: false, headers: { Accept: 'text/event-stream' },
      },
      (res) => {
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          buf += chunk;
          let i;
          while ((i = buf.indexOf('\n\n')) !== -1) {
            const block = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const ev = /^event:\s*(.+)$/m.exec(block)?.[1]?.trim();
            const dataLine = /^data:\s*(.*)$/m.exec(block)?.[1];
            if (!ev || dataLine == null) continue;
            let data; try { data = JSON.parse(dataLine); } catch { continue; }
            if (ev === 'hello') { appId = data.appId; pushState(); }
            if (ev === 'command') commands.push(data);
          }
        });
      }
    );
    req.on('error', () => {});
    req.end();

    // De showcomputer pusht zijn toestand; daar leest de plugin straks uit.
    function pushState() {
      const body = Buffer.from(JSON.stringify({ appId, state: SHOW }));
      const r = httpsRequest({
        host: '127.0.0.1', port: PORT, path: '/api/state', method: 'POST',
        rejectUnauthorized: false,
        headers: { 'Content-Type': 'application/json', 'Content-Length': body.length },
      }, (res) => res.resume());
      r.on('error', () => {});
      r.write(body); r.end();
    }

    setTimeout(() => resolve({ commands, pushState, stop: () => req.destroy() }), 1200);
  });
}

// --- Test ------------------------------------------------------------------------

async function run() {
  const server = spawn('node', ['server.mjs'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), CUEGO_ADMIN_PASSWORD: PASSWORD },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  server.stdout.on('data', (d) => { serverLog += d; });
  server.stderr.on('data', (d) => { serverLog += d; });
  await wait(4000);

  const app = await startFakeApp();
  const sd = await startFakeStreamDeck();

  // De plugin starten precies zoals Stream Deck dat doet.
  const plugin = spawn('node', [
    PLUGIN,
    '-port', String(sd.port),
    '-pluginUUID', 'TESTUUID123',
    '-registerEvent', 'registerPlugin',
    '-info', JSON.stringify({ application: { platform: 'mac', version: '6.4' } }),
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  let pluginLog = '';
  plugin.stdout.on('data', (d) => { pluginLog += d; });
  plugin.stderr.on('data', (d) => { pluginLog += d; });

  try {
    // 1. Registratie
    const reg = await sd.wait((m) => m.event === 'registerPlugin');
    check('plugin registreert zich bij Stream Deck', reg.uuid === 'TESTUUID123', JSON.stringify(reg));

    // 2. De plugin vraagt zelf om de globale instellingen
    await sd.wait((m) => m.event === 'getGlobalSettings');
    check('plugin vraagt de globale instellingen op', true);

    // 3. Instellingen aanleveren (zoals de Property Inspector zou doen)
    sd.send({
      event: 'didReceiveGlobalSettings',
      payload: { settings: { host: '127.0.0.1', port: PORT, password: PASSWORD } },
    });

    // 4. Knoppen laten verschijnen
    const appear = (context, action, settings = {}) =>
      sd.send({ event: 'willAppear', context, action, payload: { settings, coordinates: { column: 0, row: 0 } } });

    appear('ctx-go', 'me.cue-go.streamdeck.go');
    appear('ctx-toggle', 'me.cue-go.streamdeck.toggle');
    appear('ctx-next', 'me.cue-go.streamdeck.next');
    appear('ctx-panic', 'me.cue-go.streamdeck.panic');
    appear('ctx-play', 'me.cue-go.streamdeck.playcue', { cue: '2' });

    // 5. Titels moeten binnen een pollronde kloppen met de show
    await wait(1400);
    const titleFor = (ctx) => [...sd.received].reverse()
      .find((m) => m.event === 'setTitle' && m.context === ctx)?.payload?.title;

    check('GO-knop toont de geselecteerde cue', titleFor('ctx-go') === 'Applaus', String(titleFor('ctx-go')));
    check('Pauze-knop toont spelende cue + resttijd', titleFor('ctx-toggle') === 'Intro\n1:00', JSON.stringify(titleFor('ctx-toggle')));
    check('Cue-knop toont nummer en naam', titleFor('ctx-play') === '2 Applaus', String(titleFor('ctx-play')));

    const stateMsg = [...sd.received].reverse().find((m) => m.event === 'setState' && m.context === 'ctx-toggle');
    check('Pauze-knop staat op het "speelt"-icoon', stateMsg?.payload?.state === 1, JSON.stringify(stateMsg?.payload));

    // 6. Knopdrukken moeten als commando bij de show aankomen
    const before = app.commands.length;
    sd.send({ event: 'keyDown', context: 'ctx-go', action: 'me.cue-go.streamdeck.go', payload: { settings: {} } });
    await wait(500);
    check('GO stuurt het commando "go" naar de show', app.commands.slice(before).some((c) => c.cmd === 'go'), JSON.stringify(app.commands.slice(before)));

    sd.send({ event: 'keyDown', context: 'ctx-next', action: 'me.cue-go.streamdeck.next', payload: { settings: {} } });
    await wait(500);
    check('Volgende cue stuurt select {dir:"down"}',
      app.commands.some((c) => c.cmd === 'select' && c.args?.dir === 'down'),
      JSON.stringify(app.commands));

    sd.send({ event: 'keyDown', context: 'ctx-panic', action: 'me.cue-go.streamdeck.panic', payload: { settings: {} } });
    await wait(500);
    check('Panic stuurt het commando "panic"', app.commands.some((c) => c.cmd === 'panic'));

    // 7. "Cue afspelen" moet het cuenummer vertalen naar het interne id
    sd.send({ event: 'keyDown', context: 'ctx-play', action: 'me.cue-go.streamdeck.playcue', payload: { settings: { cue: '2' } } });
    await wait(700);
    check('Cue afspelen vertaalt cuenummer "2" naar id "cue-2"',
      app.commands.some((c) => c.cmd === 'play' && c.args?.cue === 'cue-2'),
      JSON.stringify(app.commands.filter((c) => c.cmd === 'play')));

    // 8. Een cue die niet bestaat → waarschuwing, geen commando en geen crash
    const playsBefore = app.commands.filter((c) => c.cmd === 'play').length;
    sd.send({ event: 'keyDown', context: 'ctx-play', action: 'me.cue-go.streamdeck.playcue', payload: { settings: { cue: 'bestaat-niet' } } });
    await wait(600);
    check('onbekende cue geeft een waarschuwing', sd.received.some((m) => m.event === 'showAlert' && m.context === 'ctx-play'));
    check('onbekende cue stuurt geen play-commando', app.commands.filter((c) => c.cmd === 'play').length === playsBefore);

    // 9. Fout wachtwoord → waarschuwing + leesbare titel, plugin blijft leven
    sd.send({ event: 'didReceiveGlobalSettings', payload: { settings: { host: '127.0.0.1', port: PORT, password: 'fout' } } });
    await wait(300);
    const alertsBefore = sd.received.filter((m) => m.event === 'showAlert' && m.context === 'ctx-go').length;
    sd.send({ event: 'keyDown', context: 'ctx-go', action: 'me.cue-go.streamdeck.go', payload: { settings: {} } });
    await wait(600);
    check('fout wachtwoord geeft een waarschuwing op de knop',
      sd.received.filter((m) => m.event === 'showAlert' && m.context === 'ctx-go').length > alertsBefore);
    check('fout wachtwoord zet een leesbare titel',
      titleFor('ctx-go') === 'wachtwoord', String(titleFor('ctx-go')));
    check('plugin draait nog na een fout wachtwoord', plugin.exitCode === null, `exit=${plugin.exitCode}`);

    // 10. Server weg → offline op de knop, nog steeds geen crash
    sd.send({ event: 'didReceiveGlobalSettings', payload: { settings: { host: '127.0.0.1', port: 4321 + 998, password: PASSWORD } } });
    await wait(1500);
    check('onbereikbare server toont "offline"', titleFor('ctx-go') === 'offline', String(titleFor('ctx-go')));
    check('plugin draait nog met een onbereikbare server', plugin.exitCode === null, `exit=${plugin.exitCode}`);

    // 11. Verdwijnt de knop, dan stopt het pollen voor die knop
    sd.send({ event: 'willDisappear', context: 'ctx-toggle', action: 'me.cue-go.streamdeck.toggle', payload: { settings: {} } });
    await wait(300);
    const cnt = sd.received.filter((m) => m.event === 'setTitle' && m.context === 'ctx-toggle').length;
    await wait(1200);
    check('verdwenen knop krijgt geen titels meer',
      sd.received.filter((m) => m.event === 'setTitle' && m.context === 'ctx-toggle').length === cnt);

    // 12. Sluit Stream Deck de verbinding, dan stopt de plugin netjes
    sd.close();
    await wait(800);
    check('plugin stopt netjes als Stream Deck de verbinding sluit', plugin.exitCode === 0, `exit=${plugin.exitCode}`);
  } catch (err) {
    fail++;
    console.log(`  ✗ onverwachte fout — ${err.message}`);
  } finally {
    try { plugin.kill('SIGKILL'); } catch {}
    try { app.stop(); } catch {}
    try { sd.close(); } catch {}
    server.kill('SIGKILL');
    await wait(300);
  }

  if (fail) {
    console.log(`\n--- pluginlog ---\n${pluginLog || '(leeg)'}`);
    console.log(`--- serverlog ---\n${serverLog.slice(-1500)}`);
  }
  console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass} geslaagd, ${fail} gefaald\n`);
  process.exit(fail === 0 ? 0 : 1);
}

run().catch((err) => { console.error(err); process.exit(1); });
