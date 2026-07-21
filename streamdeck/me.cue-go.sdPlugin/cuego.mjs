// cuego.mjs — praten met een draaiende CueGo-server.
//
// Twee dingen die deze client bijzonder maken:
//
// 1. CueGo serveert https met een zelfgemaakt certificaat (zie cert.mjs). Dat is
//    per definitie niet door een CA ondertekend, dus zetten we de controle uit —
//    alleen voor het adres dat de gebruiker zélf heeft ingevuld. Zonder dit kan
//    een Stream Deck-plugin überhaupt geen verbinding maken.
// 2. Lukt het certificaat op de server niet, dan valt CueGo terug op http. We
//    proberen daarom beide en onthouden welke werkte, zodat dat maar één keer
//    misgaat in plaats van bij elk verzoek.

import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';

const TIMEOUT_MS = 4000; // een show wacht niet; liever snel falen dan hangen

// Waarom een verzoek mislukte. De plugin vertaalt dit naar wat er op de knop komt.
export const REASON = {
  ok: 'ok',
  auth: 'auth',        // 401 — verkeerd of ontbrekend admin-wachtwoord
  disabled: 'disabled', // 403 — "Afstandsbediening staat uit" op de showcomputer
  offline: 'offline',   // niets bereikbaar
  error: 'error',       // iets anders (5xx, onzin-antwoord)
};

export function createClient(getSettings) {
  let scheme = 'https'; // CueGo's standaard; valt automatisch terug op http

  function once(method, path, bodyObj, useScheme) {
    return new Promise((resolve) => {
      const { host, port } = getSettings();
      const isHttps = useScheme === 'https';
      const doRequest = isHttps ? httpsRequest : httpRequest;
      const body = bodyObj ? Buffer.from(JSON.stringify(bodyObj)) : null;

      const req = doRequest(
        {
          host,
          port,
          path,
          method,
          // Zelfgemaakt certificaat: geen CA-controle mogelijk. Bewust en beperkt
          // tot het adres dat de gebruiker zelf instelt.
          ...(isHttps ? { rejectUnauthorized: false } : {}),
          headers: body
            ? { 'Content-Type': 'application/json', 'Content-Length': body.length }
            : {},
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            if (res.statusCode === 401) return resolve({ reason: REASON.auth });
            if (res.statusCode === 403) return resolve({ reason: REASON.disabled });
            if (res.statusCode >= 400) return resolve({ reason: REASON.error, status: res.statusCode });
            try { resolve({ reason: REASON.ok, data: text ? JSON.parse(text) : {} }); }
            catch { resolve({ reason: REASON.error }); }
          });
        }
      );

      req.setTimeout(TIMEOUT_MS, () => { req.destroy(); resolve({ reason: REASON.offline }); });
      req.on('error', () => resolve({ reason: REASON.offline }));
      if (body) req.write(body);
      req.end();
    });
  }

  // Eerst het onthouden schema; is dat onbereikbaar, dan één keer het andere
  // proberen. Zo werkt zowel een https-server als de http-fallback vanzelf.
  async function send(method, path, bodyObj) {
    let res = await once(method, path, bodyObj, scheme);
    if (res.reason === REASON.offline) {
      const other = scheme === 'https' ? 'http' : 'https';
      const alt = await once(method, path, bodyObj, other);
      if (alt.reason !== REASON.offline) { scheme = other; return alt; }
    }
    return res;
  }

  return {
    // Een commando naar de showcomputer sturen. Het wachtwoord gaat in de body,
    // niet in de URL: query-strings belanden te makkelijk in logs.
    command(cmd, args) {
      const { password } = getSettings();
      const body = { cmd };
      if (args) body.args = args;
      if (password) body.password = password;
      return send('POST', '/api/command', body);
    },
    // De huidige toestand van de show (cues, wat er speelt). Zie apiState() in
    // src/app.js — dit is exact wat remote.html ook gebruikt.
    state() {
      return send('GET', '/api/state', null);
    },
    get scheme() { return scheme; },
  };
}
