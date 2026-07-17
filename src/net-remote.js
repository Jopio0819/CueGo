// net-remote.js — koppelt de app aan de lokale server-relay.
//
// Ontvangt commando's via SSE (van remote.html, curl, straks OSC) en stuurt de
// toestand terug zodat afstandsbedieningen live meekijken. Alleen actief als
// CueGo lokaal draait; op statische hosting bestaat /api/events niet.

const STATE_POLL_MS = 400; // achtergrond-check (vooral voor de looppositie)
const PUSH_DEBOUNCE_MS = 50; // samenvoegen van een reeks wijzigingen

export function connectAppLink({ dispatch, getState, on, onStatus }) {
  let es = null;
  let timer = null;
  let pushTimer = null;
  let lastSent = '';
  let stopped = false;
  let appId = null;
  let isPrimary = false; // meerdere tabs open? Alleen de nieuwste bestuurt de show.

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
    es = new EventSource('api/events?role=app');

    es.addEventListener('hello', (e) => {
      let info = {};
      try { info = JSON.parse(e.data); } catch { /* negeer */ }
      appId = info.appId ?? null;
      isPrimary = !!info.primary;
      onStatus?.({ connected: true, primary: isPrimary });
      pushState(true); // een verse remote moet meteen de juiste lijst zien
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
    clearTimeout(pushTimer);
    pushTimer = null;
    es?.close();
    es = null;
    onStatus?.({ connected: false });
  }

  start();
  return { stop, pushState };
}
