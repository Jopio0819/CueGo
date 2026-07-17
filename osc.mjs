// osc.mjs — minimale OSC-parser + vertaling naar CueGo-commando's.
// Alleen Node stdlib. OSC is UDP en binair; de browser kan dat niet, dus
// server.mjs luistert en zet de commando's op dezelfde relay-bus als de remote.

// OSC-string: null-terminated, opgevuld tot een veelvoud van 4 bytes.
function readString(buf, pos) {
  let end = pos;
  while (end < buf.length && buf[end] !== 0) end++;
  const str = buf.toString('ascii', pos, end);
  let next = end + 1; // voorbij de null-byte
  next += (4 - (next % 4)) % 4; // uitlijnen op 4
  return [str, next];
}

// Parse één OSC-pakket → lijst met { address, args }. Bundles worden uitgepakt.
export function parseOsc(buf) {
  if (buf.length >= 8 && buf.toString('ascii', 0, 7) === '#bundle') {
    const out = [];
    let pos = 16; // '#bundle\0' (8) + timetag (8) — timetag negeren we (direct uitvoeren)
    while (pos + 4 <= buf.length) {
      const size = buf.readInt32BE(pos);
      pos += 4;
      if (size <= 0 || pos + size > buf.length) break;
      out.push(...parseOsc(buf.subarray(pos, pos + size)));
      pos += size;
    }
    return out;
  }

  if (!buf.length || buf[0] !== 0x2f) return []; // moet met '/' beginnen
  let [address, pos] = readString(buf, 0);
  const args = [];

  if (pos < buf.length) {
    const [tags, next] = readString(buf, pos);
    pos = next;
    if (tags.startsWith(',')) {
      for (const t of tags.slice(1)) {
        try {
          if (t === 'i') { args.push(buf.readInt32BE(pos)); pos += 4; }
          else if (t === 'f') { args.push(buf.readFloatBE(pos)); pos += 4; }
          else if (t === 's') { const [s, p] = readString(buf, pos); args.push(s); pos = p; }
          else if (t === 'b') {
            const n = buf.readInt32BE(pos); pos += 4;
            args.push(buf.subarray(pos, pos + n));
            pos += n + ((4 - (n % 4)) % 4);
          } else if (t === 'T') args.push(true);
          else if (t === 'F') args.push(false);
          else if (t === 'N') args.push(null);
          else if (t === 'I') args.push(Infinity);
          else break; // onbekend type → rest is onbetrouwbaar
        } catch {
          break; // te kort pakket
        }
      }
    }
  }
  return [{ address, args }];
}

// Vertaal een OSC-adres naar een CueGo-commando, of null als we 't niet kennen.
// Het '/cuego'-voorvoegsel is optioneel, zodat QLab-stijl adressen (/cue/3/start,
// /go, /panic) rechtstreeks werken.
export function oscToCommand(address, args = []) {
  let a = String(address || '').trim();
  if (!a.startsWith('/')) return null;
  a = a.replace(/^\/cuego(?=\/|$)/i, ''); // voorvoegsel eraf indien aanwezig
  const parts = a.split('/').filter(Boolean).map((p) => p.toLowerCase());
  if (!parts.length) return null;

  // /cue/<ref>/start  ·  /cue/<ref>/select  ·  /cue/<ref>
  if (parts[0] === 'cue' && parts.length >= 2) {
    const ref = a.split('/').filter(Boolean)[1]; // originele casing behouden
    const verb = parts[2] || 'start';
    if (verb === 'start' || verb === 'go' || verb === 'play') return { cmd: 'play', args: { cue: ref } };
    if (verb === 'select' || verb === 'load') return { cmd: 'select', args: { cue: ref } };
    return null;
  }

  // /select/next  ·  /select/prev  ·  /select/first  ·  /select/last
  if (parts[0] === 'select' && parts.length >= 2) {
    const dir = { next: 'down', down: 'down', prev: 'up', previous: 'up', up: 'up', first: 'first', last: 'last' }[parts[1]];
    return dir ? { cmd: 'select', args: { dir } } : null;
  }

  const simple = {
    go: 'go',
    panic: 'panic',
    stop: 'stop',
    reset: 'reset',
    pause: 'pause',
    resume: 'resume',
    toggle: 'toggle',
    transition: 'transition',
    playall: 'playAll',
    play_all: 'playAll',
  };
  const cmd = simple[parts[0]];
  if (!cmd || parts.length > 1) return null;

  // /go 3 → start cue 3 (QLab-achtig gemak)
  if (cmd === 'go' && args.length && (typeof args[0] === 'number' || typeof args[0] === 'string')) {
    return { cmd: 'play', args: { cue: String(args[0]) } };
  }
  return { cmd, args: null };
}
