// project.js — sla een volledige show op/laad 'm: volgorde, de audio zelf én instellingen,
// in één bestand. Binair containerformaat (geen base64-opblazing):
//   "WQL1" | uint32 headerlengte (LE) | header-JSON (utf8) | audio-bytes achter elkaar
// De header bevat per cue de metadata en de bytegrootte; de audio staat in cue-volgorde.

const MAGIC = 'WQL1';

export async function exportProject(cues, settings, keybinds = null) {
  const audioBuffers = [];
  const cueMeta = [];
  for (const c of cues) {
    const buf = await c.file.arrayBuffer();
    audioBuffers.push(buf);
    cueMeta.push({
      id: c.id,
      number: c.number || '',
      name: c.name,
      fadeIn: c.fadeIn,
      fadeOut: c.fadeOut,
      volume: c.volume,
      loop: !!c.loop,
      loopCount: c.loopCount || '',
      fileName: c.file.name,
      fileType: c.file.type,
      size: buf.byteLength,
    });
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
  if (magic !== MAGIC) throw new Error('Geen geldig WebQLab-projectbestand.');
  const headerLen = new DataView(arrayBuffer, 4, 4).getUint32(0, true);
  const headerStart = 8;
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(headerStart, headerStart + headerLen)));

  let offset = headerStart + headerLen;
  const cues = [];
  for (const m of header.cues) {
    const slice = arrayBuffer.slice(offset, offset + m.size);
    offset += m.size;
    const file = new File([slice], m.fileName || `${m.name}.audio`, { type: m.fileType || 'audio/*' });
    cues.push({ id: m.id, number: m.number || '', name: m.name, fadeIn: m.fadeIn, fadeOut: m.fadeOut, volume: m.volume, loop: !!m.loop, loopCount: m.loopCount || '', file });
  }
  return { settings: header.settings || {}, keybinds: header.keybinds || null, cues };
}
