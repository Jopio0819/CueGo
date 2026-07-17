// Minimale statische server + besturings-relay voor CueGo.
// Alleen Node stdlib (geen npm install). Draait op http://localhost:4321
// (secure context → Web Audio werkt).
//
// Besturings-relay: de app verbindt als 'app' en luistert via SSE naar commando's;
// afstandsbedieningen (remote.html, curl, straks OSC) sturen commando's via POST.
// De app pusht zijn toestand terug, die naar de remotes wordt uitgezonden.
//
//   GET  /api/ping              → { cuego: true, ... } (detectie door de app)
//   GET  /api/events?role=app   → SSE-stroom met commando's
//   GET  /api/events?role=remote→ SSE-stroom met toestand
//   POST /api/command           → { cmd, args } → naar de app
//   POST /api/state             → toestand van de app → naar de remotes
//
// Optioneel wachtwoord op het netwerk: CUEGO_TOKEN=geheim node server.mjs
import { createServer } from 'node:http';
import { readFile, writeFile, readdir, stat, mkdir, unlink } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { networkInterfaces } from 'node:os';
import { createSocket } from 'node:dgram';
import { parseOsc, oscToCommand } from './osc.mjs';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PORT = process.env.PORT ? Number(process.env.PORT) : 4321;
const TOKEN = process.env.CUEGO_TOKEN || ''; // leeg = geen token vereist
const OSC_PORT = process.env.CUEGO_OSC_PORT ? Number(process.env.CUEGO_OSC_PORT) : 53000;
// OSC kent geen token. Staat er een token ingesteld, dan is de bedoeling "dicht",
// dus dan blijft OSC uit tenzij je 'm expliciet aanzet.
const OSC_SETTING = (process.env.CUEGO_OSC || '').toLowerCase();
const OSC_ENABLED = OSC_SETTING === 'off' ? false : (TOKEN ? OSC_SETTING === 'on' : true);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

// --- Projecten op schijf ----------------------------------------------------
// Draai je lokaal, dan bewaren we shows als echte bestanden in projects/ — te
// kopiëren en te backuppen. Statisch gehost gaat dit via IndexedDB in de browser.

const PROJECTS_DIR = join(ROOT, 'projects');

// Alleen een kale bestandsnaam met .webqlab. Weert path traversal (../).
function safeProjectName(raw) {
  const base = String(raw || '').replace(/[/\\]/g, '').replace(/^\.+/, '').trim();
  const name = base.replace(/\.webqlab$/i, '').replace(/[^\w\-. ]+/g, '_').slice(0, 120);
  return name ? `${name}.webqlab` : null;
}

async function listProjects() {
  try {
    const names = await readdir(PROJECTS_DIR);
    const out = [];
    for (const n of names) {
      if (!n.toLowerCase().endsWith('.webqlab')) continue;
      const s = await stat(join(PROJECTS_DIR, n)).catch(() => null);
      if (s?.isFile()) out.push({ name: n.replace(/\.webqlab$/i, ''), size: s.size, savedAt: s.mtimeMs });
    }
    return out.sort((a, b) => b.savedAt - a.savedAt);
  } catch {
    return []; // map bestaat nog niet
  }
}

// Lees een binaire body (projectbestanden bevatten de audio, dus ruim toestaan).
function readBuffer(req, limit = 2e9) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('Bestand te groot')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// --- Gedeelde show ----------------------------------------------------------
// Zelf-gehost is de server eigenaar van de show: alle clients zien dezelfde cues.
// De audio staat één keer hier i.p.v. in de IndexedDB van elke browser.
//   show/show.json      → de cue-lijst met een rev-nummer
//   show/audio/<cueId>  → de audiobestanden

const SHOW_DIR = join(ROOT, 'show');
const SHOW_FILE = join(SHOW_DIR, 'show.json');
const AUDIO_DIR = join(SHOW_DIR, 'audio');

let showRev = 0;

async function loadShow() {
  try {
    const data = JSON.parse(await readFile(SHOW_FILE, 'utf8'));
    showRev = data.rev || 0;
    return { rev: showRev, cues: data.cues || [], updatedAt: data.updatedAt || 0 };
  } catch {
    return { rev: showRev, cues: [], updatedAt: 0 }; // nog geen show
  }
}

// Schrijf de show weg en vertel de andere clients ervan. De afzender slaan we
// over: die heeft de wijziging zelf al doorgevoerd.
async function saveShow(cues, senderId) {
  showRev += 1;
  const data = { rev: showRev, cues, updatedAt: Date.now() };
  await mkdir(SHOW_DIR, { recursive: true });
  await writeFile(SHOW_FILE, JSON.stringify(data));
  for (const c of clients) {
    if (c.role === 'app' && c.appId !== senderId) sseSend(c, 'show', data);
  }
  return data;
}

// Cue-id's zijn UUID's; alleen die vorm toestaan als bestandsnaam.
function safeCueId(raw) {
  const id = String(raw || '').trim();
  return /^[\w-]{1,64}$/.test(id) ? id : null;
}

// --- Besturings-relay -------------------------------------------------------

const clients = new Set(); // { res, role: 'app' | 'remote', appId? }
let lastState = null; // laatst bekende toestand van de actieve app
// Er kan maar één actieve app zijn. Met twee open tabs zouden ze allebei hun
// toestand pushen (remote flikkert heen en weer) én allebei audio afspelen op GO.
// De nieuwste tab wint; oudere tabs worden 'passief'.
let appSeq = 0;
let primaryAppId = null;

function appClients() {
  return [...clients].filter((c) => c.role === 'app');
}
function primaryApp() {
  return appClients().find((c) => c.appId === primaryAppId) || null;
}

function sseSend(client, event, data) {
  try {
    client.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch {
    clients.delete(client);
  }
}
function broadcast(role, event, data) {
  for (const c of clients) if (c.role === role) sseSend(c, event, data);
}
function countRole(role) {
  let n = 0;
  for (const c of clients) if (c.role === role) n++;
  return n;
}

// Eén weg naar de app, of het commando nu via HTTP of via OSC binnenkomt.
// Alleen de actieve app krijgt 'm — anders speelt elke open tab de cue af.
function sendCommand(cmd, args) {
  const app = primaryApp();
  if (!app) return 0;
  sseSend(app, 'command', { cmd, args: args || null });
  return 1;
}

function tokenOk(url) {
  if (!TOKEN) return true;
  return url.searchParams.get('token') === TOKEN;
}

function json(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
    .end(JSON.stringify(data));
}

// Lees een JSON-body (met een limiet, zodat een grote POST de server niet opblaast).
function readJson(req, limit = 1e6) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('Body te groot')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch (err) { reject(err); }
    });
    req.on('error', reject);
  });
}

// IPv4-adressen op het LAN, zodat de app kan tonen waar de remote te vinden is.
function lanIps() {
  const out = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
    }
  }
  return out;
}

function openSse(req, res, role) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const client = { res, role };
  if (role === 'app') client.appId = ++appSeq;
  clients.add(client);

  if (role === 'app') {
    // Nieuwste tab wordt de actieve; een eventuele vorige gaat passief.
    const prev = primaryApp();
    primaryAppId = client.appId;
    if (prev && prev !== client) sseSend(prev, 'primary', { primary: false });
    sseSend(client, 'hello', { role, token: !!TOKEN, appId: client.appId, primary: true });
  } else {
    sseSend(client, 'hello', { role, token: !!TOKEN, appOnline: !!primaryApp() });
    // Een nieuwe remote krijgt meteen de laatst bekende toestand — maar alleen als de
    // app ook echt verbonden is, anders tonen we een oude sessie als 'live'.
    if (lastState && primaryApp()) sseSend(client, 'state', lastState);
    else sseSend(client, 'state', { offline: true, projectName: '', cues: [] });
  }

  // Heartbeat houdt de verbinding open door proxies/slaapstand heen.
  const beat = setInterval(() => {
    try { res.write(': ping\n\n'); } catch { /* opgeruimd bij close */ }
  }, 25000);
  const cleanup = () => {
    clearInterval(beat);
    clients.delete(client);
    if (role !== 'app') return;
    if (client.appId !== primaryAppId) return; // passieve tab weg → verandert niets

    // De actieve app is weg: draag over aan de nieuwste overgebleven tab.
    const next = appClients().sort((a, b) => b.appId - a.appId)[0];
    if (next) {
      primaryAppId = next.appId;
      sseSend(next, 'primary', { primary: true });
      return;
    }
    // Geen app meer: bewaarde toestand is niet langer 'live'.
    primaryAppId = null;
    lastState = null;
    broadcast('remote', 'state', { offline: true, projectName: '', cues: [] });
  };
  req.on('close', cleanup);
  req.on('error', cleanup);
}

// --- HTTP -------------------------------------------------------------------

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    let urlPath = decodeURIComponent(url.pathname);

    // Detectie: laat de browser weten dat CueGo lokaal draait, zodat
    // server-afhankelijke opties (netwerk-remote, OSC) getoond worden.
    if (urlPath === '/api/ping') {
      json(res, 200, {
        cuego: true, version: 1, port: PORT, ips: lanIps(), tokenRequired: !!TOKEN,
        osc: { enabled: oscListening, port: OSC_PORT },
      });
      return;
    }

    // Gedeelde show: alle clients lezen en schrijven dezelfde cue-lijst.
    if (urlPath === '/api/show') {
      if (req.method === 'GET') { json(res, 200, await loadShow()); return; }
      if (req.method === 'PUT' || req.method === 'POST') {
        if (!tokenOk(url)) { json(res, 401, { error: 'Ongeldig token' }); return; }
        const body = await readJson(req, 5e7).catch(() => null);
        if (!body || !Array.isArray(body.cues)) { json(res, 400, { error: 'Verwacht { appId, cues }' }); return; }
        const data = await saveShow(body.cues, body.appId);
        json(res, 200, { ok: true, rev: data.rev });
        return;
      }
      json(res, 405, { error: 'Gebruik GET of PUT' });
      return;
    }

    // Audio van de gedeelde show: één keer uploaden, elke client haalt 'm hier op.
    if (urlPath.startsWith('/api/audio/')) {
      const id = safeCueId(urlPath.slice('/api/audio/'.length));
      if (!id) { json(res, 400, { error: 'Ongeldig cue-id' }); return; }
      const file = join(AUDIO_DIR, id);

      if (req.method === 'PUT' || req.method === 'POST') {
        if (!tokenOk(url)) { json(res, 401, { error: 'Ongeldig token' }); return; }
        const buf = await readBuffer(req).catch((err) => { json(res, 413, { error: err.message }); return null; });
        if (!buf) return;
        await mkdir(AUDIO_DIR, { recursive: true });
        await writeFile(file, buf);
        json(res, 200, { ok: true, size: buf.length });
        return;
      }
      if (req.method === 'HEAD' || req.method === 'GET') {
        const buf = await readFile(file).catch(() => null);
        if (!buf) { json(res, 404, { error: 'Niet gevonden' }); return; }
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': buf.length, 'Cache-Control': 'no-store' });
        res.end(req.method === 'HEAD' ? undefined : buf);
        return;
      }
      if (req.method === 'DELETE') {
        if (!tokenOk(url)) { json(res, 401, { error: 'Ongeldig token' }); return; }
        await unlink(file).catch(() => {});
        json(res, 200, { ok: true });
        return;
      }
      json(res, 405, { error: 'Methode niet toegestaan' });
      return;
    }

    // Projecten: lijst + opslaan/openen/verwijderen als bestand in projects/.
    if (urlPath === '/api/projects') {
      json(res, 200, await listProjects());
      return;
    }
    if (urlPath.startsWith('/api/projects/')) {
      const name = safeProjectName(urlPath.slice('/api/projects/'.length));
      if (!name) { json(res, 400, { error: 'Ongeldige projectnaam' }); return; }
      const file = join(PROJECTS_DIR, name);

      if (req.method === 'PUT' || req.method === 'POST') {
        if (!tokenOk(url)) { json(res, 401, { error: 'Ongeldig token' }); return; }
        const buf = await readBuffer(req).catch((err) => { json(res, 413, { error: err.message }); return null; });
        if (!buf) return;
        await mkdir(PROJECTS_DIR, { recursive: true });
        await writeFile(file, buf);
        json(res, 200, { ok: true, name: name.replace(/\.webqlab$/i, ''), size: buf.length });
        return;
      }
      if (req.method === 'DELETE') {
        if (!tokenOk(url)) { json(res, 401, { error: 'Ongeldig token' }); return; }
        await unlink(file).catch(() => {});
        json(res, 200, { ok: true });
        return;
      }
      if (req.method === 'GET') {
        const buf = await readFile(file).catch(() => null);
        if (!buf) { json(res, 404, { error: 'Niet gevonden' }); return; }
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store' }).end(buf);
        return;
      }
      json(res, 405, { error: 'Methode niet toegestaan' });
      return;
    }

    if (urlPath === '/api/events') {
      if (!tokenOk(url)) { json(res, 401, { error: 'Ongeldig token' }); return; }
      const role = url.searchParams.get('role') === 'app' ? 'app' : 'remote';
      openSse(req, res, role);
      return;
    }

    if (urlPath === '/api/command') {
      if (req.method !== 'POST') { json(res, 405, { error: 'Gebruik POST' }); return; }
      if (!tokenOk(url)) { json(res, 401, { error: 'Ongeldig token' }); return; }
      // De app bepaalt of afstandsbediening mag; dat staat in de toestand die hij pusht.
      if (lastState && lastState.remoteEnabled === false) {
        json(res, 403, { error: 'Afstandsbediening staat uit' });
        return;
      }
      const body = await readJson(req).catch(() => null);
      if (!body || !body.cmd) { json(res, 400, { error: 'Verwacht { cmd, args }' }); return; }
      json(res, 200, { ok: true, delivered: sendCommand(body.cmd, body.args) });
      return;
    }

    if (urlPath === '/api/state') {
      if (req.method === 'GET') { json(res, 200, lastState || {}); return; }
      if (req.method !== 'POST') { json(res, 405, { error: 'Gebruik POST of GET' }); return; }
      if (!tokenOk(url)) { json(res, 401, { error: 'Ongeldig token' }); return; }
      const body = await readJson(req).catch(() => null);
      if (!body || !body.state) { json(res, 400, { error: 'Verwacht { appId, state }' }); return; }
      // Alleen de actieve app bepaalt de toestand. Zonder dit overschrijft een
      // tweede open tab de show en flikkert elke remote heen en weer.
      if (body.appId !== primaryAppId) { json(res, 200, { ok: true, ignored: 'niet de actieve app' }); return; }
      lastState = body.state;
      broadcast('remote', 'state', lastState);
      json(res, 200, { ok: true, remotes: countRole('remote') });
      return;
    }

    // Lokaal hosten = direct de app (niet de publieke landingspagina, die is voor
    // statische hosting en blijft bereikbaar op /index.html).
    if (urlPath === '/') urlPath = '/app.html';
    const safePath = normalize(urlPath).replace(/^(\.\.[/\\])+/, '');
    const filePath = join(ROOT, safePath);
    if (!filePath.startsWith(ROOT)) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    const body = await readFile(filePath);
    const type = MIME[extname(filePath).toLowerCase()] || 'application/octet-stream';
    // Geen caching: tijdens ontwikkelen altijd de nieuwste bestanden serveren.
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' }).end(body);
  } catch (err) {
    if (err.code === 'ENOENT') {
      // Serveer de nette 404-pagina (zoals GitHub Pages), val terug op tekst.
      try {
        const page = await readFile(join(ROOT, '404.html'));
        res.writeHead(404, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' }).end(page);
      } catch {
        res.writeHead(404).end('Not found');
      }
    } else {
      console.error(err);
      res.writeHead(500).end('Server error');
    }
  }
});

// --- OSC (UDP) --------------------------------------------------------------
// Een lichttafel of show-control-systeem stuurt OSC over UDP; de browser kan geen
// UDP, dus we vertalen het hier en zetten het op dezelfde bus als de remote.

let oscListening = false;

function startOsc() {
  if (!OSC_ENABLED) return;
  // Geen reuseAddr: we willen juist een nette EADDRINUSE als een ander programma
  // (of een tweede CueGo) de poort al heeft, i.p.v. stilletjes half meeluisteren.
  const sock = createSocket({ type: 'udp4' });

  sock.on('message', (buf, rinfo) => {
    let messages;
    try { messages = parseOsc(buf); } catch { return; } // rommel op de poort → negeren
    for (const m of messages) {
      const mapped = oscToCommand(m.address, m.args);
      if (!mapped) { console.log(`OSC genegeerd: ${m.address} (van ${rinfo.address})`); continue; }
      sendCommand(mapped.cmd, mapped.args);
    }
  });

  sock.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.log(`OSC-poort ${OSC_PORT} is bezet (draait QLab?) — OSC uit. Andere poort: CUEGO_OSC_PORT=53001`);
    } else {
      console.log(`OSC-fout: ${err.message} — OSC uit.`);
    }
    oscListening = false;
    try { sock.close(); } catch { /* al dicht */ }
  });

  sock.bind(OSC_PORT, () => {
    oscListening = true;
    console.log(`OSC luistert op UDP ${OSC_PORT} — bv. /cue/3/start, /go, /panic`);
  });
}

server.listen(PORT, () => {
  console.log(`CueGo draait op http://localhost:${PORT}`);
  const ips = lanIps();
  if (ips.length) {
    console.log(`Afstandsbediening: ${ips.map((ip) => `http://${ip}:${PORT}/remote.html`).join('  ')}`);
  }
  if (TOKEN) console.log('Token vereist (CUEGO_TOKEN) — voeg ?token=… toe aan de remote-URL.');
  else if (ips.length) console.log('Let op: iedereen op dit netwerk kan de show bedienen. Zet CUEGO_TOKEN=… voor een token.');
  if (TOKEN && !OSC_ENABLED) console.log('OSC uit: OSC kent geen token. Toch aanzetten? CUEGO_OSC=on');
  startOsc();
});
