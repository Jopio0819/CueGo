// net-remote.js — koppelt de app aan de lokale server-relay.
//
// Ontvangt commando's via SSE (van remote.html, curl, straks OSC) en stuurt de
// toestand terug zodat afstandsbedieningen live meekijken. Alleen actief als
// CueGo lokaal draait; op statische hosting bestaat /api/events niet.

const STATE_POLL_MS = 400; // achtergrond-check (vooral voor de looppositie)
const PUSH_DEBOUNCE_MS = 50; // samenvoegen van een reeks wijzigingen
const HEARTBEAT_MS = 8000; // ruim binnen de 25s die de server aanhoudt

// Standaardnaam op basis van browser + systeem. "Client 3" zegt niets als je
// drie apparaten in de zaal hebt staan; "Safari op iPad" wel.
export function defaultDeviceLabel() {
  const ua = navigator.userAgent;
  const browser = /Edg\//.test(ua) ? 'Edge'
    : /OPR\//.test(ua) ? 'Opera'
    : /Firefox\//.test(ua) ? 'Firefox'
    : /Chrome\//.test(ua) ? 'Chrome'
    : /Safari\//.test(ua) ? 'Safari'
    : 'Browser';
  const os = /iPhone/.test(ua) ? 'iPhone'
    : /iPad/.test(ua) ? 'iPad'
    : /Android/.test(ua) ? 'Android'
    : /Macintosh|Mac OS X/.test(ua) ? 'Mac'
    : /Windows/.test(ua) ? 'Windows'
    : /Linux/.test(ua) ? 'Linux'
    : '';
  return os ? `${browser} op ${os}` : browser;
}

// Stabiel id per venster/tab. Bewust sessionStorage en niet localStorage:
// - overleeft een refresh → we krijgen onze showcomputer-rol terug in plaats van
//   als 'nieuwe client' te verschijnen naast onze eigen, nog hangende verbinding;
// - is per tab → twee tabs in dezelfde browser zijn twee clients. Met localStorage
//   zouden ze hetzelfde id delen en elkaars verbinding blijven verbreken.
const DEVICE_ID_KEY = 'webqlab.deviceId';

export function deviceId() {
  let id = sessionStorage.getItem(DEVICE_ID_KEY);
  if (!id) {
    id = (crypto.randomUUID?.() || `dev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
    sessionStorage.setItem(DEVICE_ID_KEY, id);
  }
  return id;
}

export function connectAppLink({ dispatch, getState, on, onStatus, onShow, onDevices, onState, onLock, isLocked, label }) {
  let es = null;
  let timer = null;
  let pushTimer = null;
  let beatTimer = null;
  let lastSent = '';
  let stopped = false;
  let appId = null;
  let isPrimary = false; // is dit apparaat de showcomputer (die het geluid maakt)?

  // Levensteken: hiermee weet de server dat we echt nog draaien. Wordt deze tab
  // bevroren (bfcache/achtergrond), dan staan de timers stil, blijft de ping uit
  // en ruimt de server ons op — precies de bedoeling.
  function beat() {
    fetch('api/heartbeat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: deviceId(), locked: !!isLocked?.() }),
    }).catch(() => {});
  }

  function pushState(force = false) {
    if (!isPrimary || appId == null) return; // passieve tab pusht niets
    let snapshot;
    try { snapshot = getState(); } catch { return; }
    const body = JSON.stringify(snapshot);
    if (!force && body === lastSent) return; // niets veranderd → geen verkeer
    lastSent = body;
    fetch('api/state', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appId, state: snapshot }),
      keepalive: true,
    }).catch(() => { /* server weg → onError regelt de status */ });
  }

  function start() {
    if (stopped) return;
    const q = new URLSearchParams({ role: 'app', deviceId: deviceId() });
    if (label) q.set('label', label);
    es = new EventSource(`api/events?${q}`);

    es.addEventListener('hello', (e) => {
      let info = {};
      try { info = JSON.parse(e.data); } catch { /* negeer */ }
      appId = info.appId ?? null;
      isPrimary = !!info.primary;
      onStatus?.({ connected: true, primary: isPrimary });
      pushState(true); // een verse remote moet meteen de juiste lijst zien
    });

    // Wie is er verbonden en wie is de showcomputer? Bepaalt of wij zelf afspelen.
    es.addEventListener('devices', (e) => {
      let data;
      try { data = JSON.parse(e.data); } catch { return; }
      const was = isPrimary;
      isPrimary = data.showDeviceId != null && data.showDeviceId === deviceId();
      onDevices?.(data);
      onStatus?.({ connected: true, primary: isPrimary });
      if (isPrimary && !was) pushState(true); // net showcomputer geworden → bron van waarheid
    });

    // Vanaf een ander apparaat (ont)grendeld via het Multi-device-paneel.
    es.addEventListener('lock', (e) => {
      let data;
      try { data = JSON.parse(e.data); } catch { return; }
      onLock?.(!!data.locked);
    });

    // Afspeeltoestand van de showcomputer. Krijgen we alleen als wij het níét zijn:
    // dan spelen we zelf niets af, maar tonen we wél zijn afspeelbalk en voortgang.
    es.addEventListener('state', (e) => {
      let data;
      try { data = JSON.parse(e.data); } catch { return; }
      onState?.(data);
    });

    // Een andere client heeft de gedeelde show gewijzigd.
    es.addEventListener('show', (e) => {
      let data;
      try { data = JSON.parse(e.data); } catch { return; }
      onShow?.(data);
    });

    // De server draagt de rol over als er elders een nieuwere tab opengaat.
    es.addEventListener('primary', (e) => {
      let info = {};
      try { info = JSON.parse(e.data); } catch { /* negeer */ }
      isPrimary = !!info.primary;
      onStatus?.({ connected: true, primary: isPrimary });
      if (isPrimary) pushState(true);
    });

    es.addEventListener('command', (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      try {
        dispatch(msg.cmd, msg.args || undefined);
      } catch (err) {
        console.warn('Commando van remote mislukt:', msg.cmd, err.message);
      }
      // NIET hier pushen: dispatch is deels async (play moet eerst decoderen), dus
      // we zouden de óude toestand sturen. De statechange-listener doet het zodra
      // de app écht bijgewerkt is.
    });

    es.onerror = () => {
      onStatus?.({ connected: false });
      // EventSource verbindt zelf opnieuw; niets te doen.
    };

    // Toestand bewaken: alleen versturen als er echt iets veranderd is
    // (dus ook tijdens het spelen, want de positie loopt dan op).
    clearInterval(timer);
    timer = setInterval(() => pushState(false), STATE_POLL_MS);
    clearInterval(beatTimer);
    beat(); // meteen één, niet pas na 8s
    beatTimer = setInterval(beat, HEARTBEAT_MS);
  }

  // De app rendert → toestand is nu écht bij. Even samenvoegen zodat een reeks
  // wijzigingen (select + play + render) één push wordt.
  function schedulePush() {
    if (pushTimer) return;
    pushTimer = setTimeout(() => { pushTimer = null; pushState(false); }, PUSH_DEBOUNCE_MS);
  }
  on?.('statechange', schedulePush);

  function stop() {
    stopped = true;
    clearInterval(timer);
    clearInterval(beatTimer);
    clearTimeout(pushTimer);
    pushTimer = null;
    es?.close();
    es = null;
    onStatus?.({ connected: false });
  }

  start();
  // appId identificeert deze tab bij de server (afzender van show-wijzigingen).
  return { stop, pushState, appId: () => appId, isPrimary: () => isPrimary };
}
