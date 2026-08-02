// dmx.mjs — DMX-over-IP-pakketten bouwen: Art-Net en sACN (E1.31). Puur Node.
//
// Net als osc.mjs is dit alleen het binaire pakket; server.mjs verstuurt het over
// een dgram-socket (de browser kan geen UDP). Een "universe" is één DMX-lijn van
// 512 kanalen (waarden 0-255).

// --- Art-Net ---------------------------------------------------------------
// ArtDMX-pakket naar UDP-poort 6454. universe 0..32767 (15 bits: Net + SubUni).
export function artnetPacket(universe, data, sequence = 0) {
  const len = Math.min(512, data.length);
  const buf = Buffer.alloc(18 + len);
  buf.write('Art-Net\0', 0, 'ascii');        // 8-byte ID
  buf.writeUInt16LE(0x5000, 8);              // OpCode ArtDMX (little-endian)
  buf.writeUInt16BE(14, 10);                 // ProtVerHi/Lo = 14 (big-endian)
  buf[12] = sequence & 0xff;                 // Sequence (0 = uit)
  buf[13] = 0;                               // Physical (informatief)
  buf.writeUInt16LE(universe & 0x7fff, 14);  // SubUni (laag) + Net (hoog)
  buf.writeUInt16BE(len, 16);                // Length (aantal kanalen, big-endian)
  for (let i = 0; i < len; i++) buf[18 + i] = data[i] & 0xff;
  return buf;
}
export const ARTNET_PORT = 6454;

// --- sACN / E1.31 ----------------------------------------------------------
// Multicast-adres voor een universe (239.255.<hi>.<lo>), UDP-poort 5568.
export function sacnMulticastAddr(universe) {
  return `239.255.${(universe >> 8) & 0xff}.${universe & 0xff}`;
}
export const SACN_PORT = 5568;

const ACN_PID = Buffer.from([0x41, 0x53, 0x43, 0x2d, 0x45, 0x31, 0x2e, 0x31, 0x37, 0x00, 0x00, 0x00]); // "ASC-E1.17"

// E1.31 data-pakket. cid: 16 bytes (stabiel per bron). sourceName: max 63 tekens.
export function sacnPacket(universe, data, cid, sourceName = 'CueGo', sequence = 0, priority = 100) {
  const len = Math.min(512, data.length);
  const total = 126 + len;
  const buf = Buffer.alloc(total);

  // --- Root layer ---
  buf.writeUInt16BE(0x0010, 0);              // Preamble Size
  buf.writeUInt16BE(0x0000, 2);              // Post-amble Size
  ACN_PID.copy(buf, 4);                      // ACN Packet Identifier (12)
  buf.writeUInt16BE(0x7000 | (total - 16), 16); // Flags & Length
  buf.writeUInt32BE(0x00000004, 18);         // Vector VECTOR_ROOT_E131_DATA
  (cid && cid.length === 16 ? cid : Buffer.alloc(16)).copy(buf, 22); // CID (16)

  // --- Framing layer (start byte 38) ---
  buf.writeUInt16BE(0x7000 | (total - 38), 38); // Flags & Length
  buf.writeUInt32BE(0x00000002, 40);         // Vector VECTOR_E131_DATA_PACKET
  buf.write(String(sourceName).slice(0, 63), 44, 'utf8'); // Source Name (64, rest = 0)
  buf[108] = priority & 0xff;                // Priority (0-200)
  buf.writeUInt16BE(0, 109);                 // Synchronization Address
  buf[111] = sequence & 0xff;                // Sequence Number
  buf[112] = 0;                              // Options
  buf.writeUInt16BE(universe & 0xffff, 113); // Universe

  // --- DMP layer (start byte 115) ---
  buf.writeUInt16BE(0x7000 | (total - 115), 115); // Flags & Length
  buf[117] = 0x02;                           // Vector VECTOR_DMP_SET_PROPERTY
  buf[118] = 0xa1;                           // Address Type & Data Type
  buf.writeUInt16BE(0x0000, 119);            // First Property Address
  buf.writeUInt16BE(0x0001, 121);            // Address Increment
  buf.writeUInt16BE(len + 1, 123);           // Property value count (startcode + kanalen)
  buf[125] = 0x00;                           // DMX Start Code
  for (let i = 0; i < len; i++) buf[126 + i] = data[i] & 0xff;
  return buf;
}

// "1:255, 5:128, 10=0" → [{ch:1,value:255}, …]. Kanaal 1-512, waarde 0-255.
export function parseDmxChannels(str) {
  const out = [];
  for (const tok of String(str || '').split(/[,\n]+/)) {
    const m = /^\s*(\d{1,3})\s*[:=]\s*(\d{1,3})\s*$/.exec(tok);
    if (!m) continue;
    const ch = Math.max(1, Math.min(512, parseInt(m[1], 10)));
    const value = Math.max(0, Math.min(255, parseInt(m[2], 10)));
    out.push({ ch, value });
  }
  return out;
}

// [{ch,value}] → "1:255, 5:128" (voor het invoerveld).
export function formatDmxChannels(channels) {
  return (Array.isArray(channels) ? channels : []).map((c) => `${c.ch}:${c.value}`).join(', ');
}
