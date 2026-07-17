// control.js — één command-bus + publieke API + server-detectie.
//
// Alle manieren om CueGo te besturen (toetsenbord, window.cuego, straks de
// netwerk-remote, MIDI en OSC) vertalen naar dezelfde set commando's en lopen
// via dispatch(). Zo bestaat de besturingslogica één keer, met meerdere ingangen.

// Maak een besturing rond een set 'acties' (functies uit app.js).
export function createControl(actions) {
  const listeners = new Map(); // event -> Set<callback>

  function on(event, cb) {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(cb);
    return () => off(event, cb);
  }
  function off(event, cb) { listeners.get(event)?.delete(cb); }
  function emit(event, data) {
    listeners.get(event)?.forEach((cb) => { try { cb(data); } catch (err) { console.error('cuego listener:', err); } });
    // 'any' krijgt elk event mee (handig voor loggen / een transport dat alles doorstuurt).
    listeners.get('any')?.forEach((cb) => { try { cb({ event, data }); } catch (err) { console.error(err); } });
  }

  // Commando → actie. Elk commando krijgt een optioneel args-object.
  const COMMANDS = {
    go: () => actions.go(),
    playAll: () => actions.playAll(),
    play: (a) => actions.play(a?.cue),
    stop: () => actions.stop(),
    reset: () => actions.reset(),
    panic: () => actions.panic(),
    pause: () => actions.pause(),
    resume: () => actions.resume(),
    toggle: () => actions.toggle(),
    select: (a) => actions.select(a?.dir ?? a?.cue),
    transition: () => actions.transition(),
    state: () => actions.state(),
  };

  // Voer een commando uit. Onbekende commando's geven een nette fout terug.
  function dispatch(cmd, args) {
    const fn = COMMANDS[cmd];
    if (!fn) throw new Error(`Onbekend commando: ${cmd}`);
    emit('command', { cmd, args });
    return fn(args);
  }

  return { dispatch, on, off, emit, commands: Object.keys(COMMANDS) };
}

// Bouw het publieke window.cuego-object bovenop een control.
export function publicApi(control) {
  const d = control.dispatch;
  return {
    go: () => d('go'),
    playAll: () => d('playAll'),
    play: (cue) => d('play', { cue }),
    stop: () => d('stop'),
    reset: () => d('reset'),
    panic: () => d('panic'),
    pause: () => d('pause'),
    resume: () => d('resume'),
    toggle: () => d('toggle'),
    select: (dir) => d('select', { dir }),
    transition: () => d('transition'),
    state: () => d('state'),
    dispatch: (cmd, args) => d(cmd, args),
    on: control.on,
    off: control.off,
    commands: control.commands,
  };
}

// Detecteer of CueGo lokaal via server.mjs draait (dan bestaat /api/ping).
// Op statische hosting (GitHub Pages, los bestand) faalt dit → false, waardoor
// server-afhankelijke opties (netwerk-remote, OSC) verborgen blijven.
export async function detectServer(timeoutMs = 1500) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch('api/ping', { cache: 'no-store', signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) return null;
    const info = await res.json().catch(() => null);
    return info && info.cuego === true ? info : null;
  } catch {
    return null;
  }
}
