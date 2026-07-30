// midi.js — Web MIDI: knoppen van een controller (of foot pedal) aan CueGo-commando's koppelen.
//
// Draait volledig in de browser, dus dit werkt ook zonder server (ook op GitHub Pages).
// Wel een secure context vereist (https of localhost) — net als de map-kiezer.

export const MIDI_SUPPORTED = !!(typeof navigator !== 'undefined' && navigator.requestMIDIAccess);

// Zet een MIDI-bericht om in een korte handtekening waarop we kunnen matchen.
// We reageren alleen op 'indrukken' (note-on / CC met waarde) — loslaten negeren we,
// anders vuurt één druk op een knop het commando twee keer af.
export function signatureOf(data) {
  if (!data || data.length < 2) return null;
  const type = data[0] & 0xf0;
  const channel = data[0] & 0x0f;
  const d1 = data[1];
  const d2 = data.length > 2 ? data[2] : 0;
  if (type === 0x90 && d2 > 0) return `note:${channel}:${d1}`; // note-on
  if (type === 0xb0 && d2 > 0) return `cc:${channel}:${d1}`; // control change (ingedrukt)
  if (type === 0xc0) return `pc:${channel}:${d1}`; // program change (heeft geen velocity)
  return null; // note-off, aftertouch, pitchbend, clock, …
}

// Leesbare weergave voor in de instellingen.
const KIND_LABEL = { note: 'Noot', cc: 'CC', pc: 'PC' };
export function describeSignature(sig) {
  if (!sig) return '—';
  const [kind, ch, num] = sig.split(':');
  return `${KIND_LABEL[kind] || kind} ${num} · kan. ${Number(ch) + 1}`;
}

export function createMidi({ onTrigger, onDevices } = {}) {
  let access = null;
  let enabled = false;
  let learnCb = null;

  function handleMessage(e) {
    const sig = signatureOf(e.data);
    if (!sig) return;
    // Bezig met 'leren'? Dan vangt de eerstvolgende druk de koppeling af.
    if (learnCb) {
      const cb = learnCb;
      learnCb = null;
      cb(sig);
      return;
    }
    onTrigger?.(sig);
  }

  function deviceNames() {
    return access ? [...access.inputs.values()].map((i) => i.name || 'MIDI-apparaat') : [];
  }

  function attach() {
    if (!access) return;
    for (const input of access.inputs.values()) input.onmidimessage = enabled ? handleMessage : null;
    onDevices?.(deviceNames());
  }

  // Zorg dat we MIDI-toegang hebben (vraagt 'm de eerste keer). Nodig voor zowel
  // input (triggers) als output (MIDI-cues die berichten versturen).
  async function ensureAccess() {
    if (!MIDI_SUPPORTED) throw new Error('Web MIDI wordt niet ondersteund in deze browser.');
    if (!access) {
      access = await navigator.requestMIDIAccess({ sysex: false });
      access.onstatechange = attach; // apparaat in-/uitpluggen tijdens de show
    }
    return access;
  }

  async function enable() {
    await ensureAccess();
    enabled = true;
    attach();
  }

  // --- Output (MIDI-cues) ---
  function outputList() {
    return access ? [...access.outputs.values()].map((o) => ({ id: o.id, name: o.name || 'MIDI-uitgang' })) : [];
  }

  // Stuur ruwe MIDI-bytes naar een uitgang. Zonder deviceId (of onbekend): de
  // eerste beschikbare uitgang. Geeft terug of het lukte.
  function send(deviceId, bytes) {
    if (!access) return false;
    let out = deviceId ? access.outputs.get(deviceId) : null;
    if (!out) out = [...access.outputs.values()][0];
    if (!out) return false;
    try { out.send(bytes); return true; } catch { return false; }
  }

  function disable() {
    enabled = false;
    learnCb = null;
    attach();
  }

  return {
    enable,
    disable,
    ensureAccess,
    send,
    learn: (cb) => { learnCb = cb; },
    cancelLearn: () => { learnCb = null; },
    get enabled() { return enabled; },
    get devices() { return deviceNames(); },
    get outputs() { return outputList(); },
  };
}

// Bouw de ruwe bytes voor een MIDI-cue-bericht. Kanaal is 1..16 in de UI, maar
// 0-gebaseerd in het protocol. Program Change heeft geen tweede databyte.
export function midiMessageBytes({ type, channel, data1, data2 }) {
  const ch = Math.max(0, Math.min(15, (parseInt(channel, 10) || 1) - 1));
  const d1 = Math.max(0, Math.min(127, parseInt(data1, 10) || 0));
  const d2 = Math.max(0, Math.min(127, parseInt(data2, 10) || 0));
  switch (type) {
    case 'noteoff': return [0x80 | ch, d1, d2];
    case 'cc': return [0xb0 | ch, d1, d2];
    case 'pc': return [0xc0 | ch, d1];
    case 'noteon':
    default: return [0x90 | ch, d1, d2];
  }
}
