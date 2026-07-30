// project.js — sla een volledige show op/laad 'm: volgorde, de audio zelf én instellingen,
// in één bestand. Binair containerformaat (geen base64-opblazing):
//   "WQL1" | uint32 headerlengte (LE) | header-JSON (utf8) | audio-bytes achter elkaar
// De header bevat per cue de metadata en de bytegrootte; de audio staat in cue-volgorde.

import { cueToMeta, metaToCue } from './cue-model.js';

const MAGIC = 'WQL1';

export async function exportProject(cues, settings, keybinds = null) {
  const audioBuffers = [];
  const cueMeta = [];
  for (const c of cues) {
    // Besturings-cues (wait/stop/fade/…) hebben geen bestand; die schrijven size 0.
    const buf = c.file ? await c.file.arrayBuffer() : null;
    if (buf) audioBuffers.push(buf);
    const meta = cueToMeta(c); // bevat al fileName/fileType via CUE_FIELDS
    meta.size = buf ? buf.byteLength : 0;
    cueMeta.push(meta);
  }
  const header = { version: 1, settings, cues: cueMeta };
  if (keybinds) header.keybinds = keybinds; // optioneel: sneltoetsen meenemen
  const headerBytes = new TextEncoder().encode(JSON.stringify(header));
  const lenBytes = new Uint8Array(4);
  new DataView(lenBytes.buffer).setUint32(0, headerBytes.length, true);
  return new Blob([MAGIC, lenBytes, headerBytes, ...audioBuffers], { type: 'application/octet-stream' });
}

export async function importProject(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  const magic = new TextDecoder().decode(bytes.subarray(0, 4));
  if (magic !== MAGIC) throw new Error('Geen geldig CueGo-projectbestand.');
  const headerLen = new DataView(arrayBuffer, 4, 4).getUint32(0, true);
  const headerStart = 8;
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(headerStart, headerStart + headerLen)));

  let offset = headerStart + headerLen;
  const cues = [];
  for (const m of header.cues) {
    let file = null;
    if (m.size > 0) {
      const slice = arrayBuffer.slice(offset, offset + m.size);
      file = new File([slice], m.fileName || `${m.name}.audio`, { type: m.fileType || 'audio/*' });
    }
    offset += m.size; // ook 0 voor besturings-cues, zodat de offsets kloppen
    cues.push(metaToCue(m, file));
  }
  return { settings: header.settings || {}, keybinds: header.keybinds || null, cues };
}
