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

  async function enable() {
    if (!MIDI_SUPPORTED) throw new Error('Web MIDI wordt niet ondersteund in deze browser.');
    if (!access) {
      access = await navigator.requestMIDIAccess({ sysex: false });
      access.onstatechange = attach; // apparaat in-/uitpluggen tijdens de show
    }
    enabled = true;
    attach();
  }

  function disable() {
    enabled = false;
    learnCb = null;
    attach();
  }

  return {
    enable,
    disable,
    learn: (cb) => { learnCb = cb; },
    cancelLearn: () => { learnCb = null; },
    get enabled() { return enabled; },
    get devices() { return deviceNames(); },
  };
}
