// dmx.test.mjs — de DMX-over-IP-pakketten (Art-Net + sACN) op byte-niveau.
//
// DMX-interfaces zijn onvergevingsgezind: één verkeerd byte-offset en er gebeurt
// niets (of het verkeerde). Daarom controleren we de pakketten tegen de spec.
//
// Draaien:  node test/dmx.test.mjs

import { artnetPacket, sacnPacket, sacnMulticastAddr, parseDmxChannels, formatDmxChannels } from '../dmx.mjs';

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`); }
};

// --- Art-Net ---------------------------------------------------------------
console.log('  -- Art-Net --');
{
  const data = new Uint8Array(512);
  data[0] = 255; data[4] = 128; data[511] = 1;
  const p = artnetPacket(0x0102, data, 7); // universe: Net=1, SubUni=2
  check('begint met "Art-Net\\0"', p.toString('ascii', 0, 8) === 'Art-Net\0');
  check('OpCode = ArtDMX (0x5000, LE)', p.readUInt16LE(8) === 0x5000);
  check('ProtVer = 14 (BE)', p.readUInt16BE(10) === 14);
  check('Sequence = 7', p[12] === 7);
  check('SubUni = 2', p[14] === 2);
  check('Net = 1', p[15] === 1);
  check('Length = 512 (BE)', p.readUInt16BE(16) === 512);
  check('kanaal 1 = 255', p[18] === 255);
  check('kanaal 5 = 128', p[18 + 4] === 128);
  check('kanaal 512 = 1', p[18 + 511] === 1);
  check('totale lengte = 18 + 512', p.length === 18 + 512);

  // Korte data (bv. 4 kanalen) → Length telt alleen die kanalen.
  const q = artnetPacket(0, new Uint8Array([10, 20, 30, 40]));
  check('korte data: Length = 4', q.readUInt16BE(16) === 4 && q.length === 22);
}

// --- sACN / E1.31 ----------------------------------------------------------
console.log('  -- sACN (E1.31) --');
{
  const cid = Buffer.from('0123456789abcdef', 'ascii'); // 16 bytes
  const data = new Uint8Array([255, 0, 128]);
  const p = sacnPacket(1, data, cid, 'CueGo', 3, 100);
  const total = 126 + 3;
  check('totale lengte klopt (126 + kanalen)', p.length === total, `${p.length}`);
  check('Root PID = ASC-E1.17', p.toString('ascii', 4, 13) === 'ASC-E1.17');
  check('Root flags&length', p.readUInt16BE(16) === (0x7000 | (total - 16)));
  check('Root vector = 0x04', p.readUInt32BE(18) === 4);
  check('CID komt mee', p.subarray(22, 38).equals(cid));
  check('Framing flags&length', p.readUInt16BE(38) === (0x7000 | (total - 38)));
  check('Framing vector = 0x02', p.readUInt32BE(40) === 2);
  check('Source Name = CueGo', p.toString('utf8', 44, 49) === 'CueGo');
  check('Priority = 100', p[108] === 100);
  check('Sequence = 3', p[111] === 3);
  check('Universe = 1 (BE)', p.readUInt16BE(113) === 1);
  check('DMP flags&length', p.readUInt16BE(115) === (0x7000 | (total - 115)));
  check('DMP vector = 0x02', p[117] === 0x02);
  check('Address type = 0xa1', p[118] === 0xa1);
  check('Property count = kanalen + startcode', p.readUInt16BE(123) === 3 + 1);
  check('DMX start code = 0', p[125] === 0);
  check('kanaaldata komt mee', p[126] === 255 && p[127] === 0 && p[128] === 128);
}

// --- Multicast-adres + kanaal-parsing --------------------------------------
console.log('  -- adres + parsing --');
{
  check('multicast universe 1 = 239.255.0.1', sacnMulticastAddr(1) === '239.255.0.1');
  check('multicast universe 300 = 239.255.1.44', sacnMulticastAddr(300) === '239.255.1.44');
  const ch = parseDmxChannels('1:255, 5:128, 10=0');
  check('kanalen parsen (: en =)', JSON.stringify(ch) === JSON.stringify([{ ch: 1, value: 255 }, { ch: 5, value: 128 }, { ch: 10, value: 0 }]), JSON.stringify(ch));
  check('waarden clampen', JSON.stringify(parseDmxChannels('600:999')) === JSON.stringify([{ ch: 512, value: 255 }]));
  check('rommel wordt genegeerd', JSON.stringify(parseDmxChannels('abc, 3:50, x')) === JSON.stringify([{ ch: 3, value: 50 }]));
  check('terug naar tekst', formatDmxChannels([{ ch: 1, value: 255 }, { ch: 5, value: 128 }]) === '1:255, 5:128');
}

console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass} geslaagd, ${fail} gefaald\n`);
process.exit(fail === 0 ? 0 : 1);
