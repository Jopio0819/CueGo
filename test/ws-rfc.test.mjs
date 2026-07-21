// ws-rfc.test.mjs — de WebSocket-client toetsen aan RFC 6455.
//
// De frames hieronder komen letterlijk uit paragraaf 5.7 van de RFC ("Examples").
// Zo testen we tegen de standaard en niet tegen onze eigen aannames: een fout die
// in zowel de zender als de ontvanger zit, zou anders gewoon slagen.
//
// Draaien:  node streamdeck/test/ws-rfc.test.mjs

import { createServer } from 'node:net';
import { createHash } from 'node:crypto';
import { connect } from '../streamdeck/me.cue-go.sdPlugin/ws.mjs';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
let pass = 0, fail = 0;

function check(name, ok, extra = '') {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`); }
}

// --- 1. Handshake-formule tegen de testvector uit RFC 6455 §1.3 --------------
{
  const accept = createHash('sha1').update('dGhlIHNhbXBsZSBub25jZQ==' + GUID).digest('base64');
  check('Sec-WebSocket-Accept volgt de RFC-testvector', accept === 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=', accept);
}

// Een server die de handshake correct afhandelt en daarna ruwe bytes stuurt die
// wij aanleveren. Onafhankelijk van de client geschreven (eigen unmask-code).
function startServer({ onClientFrame }) {
  return new Promise((resolve) => {
    const srv = createServer((sock) => {
      let buf = Buffer.alloc(0);
      let upgraded = false;
      sock.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        if (!upgraded) {
          const end = buf.indexOf('\r\n\r\n');
          if (end === -1) return;
          const head = buf.subarray(0, end).toString();
          buf = buf.subarray(end + 4);
          const key = /sec-websocket-key:\s*(\S+)/i.exec(head)?.[1];
          const accept = createHash('sha1').update(key + GUID).digest('base64');
          sock.write(
            'HTTP/1.1 101 Switching Protocols\r\n' +
            'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
            `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
          );
          upgraded = true;
          srv.emit('ready', sock);
        }
        // Frames van de client uitpakken (die zijn altijd gemaskeerd).
        for (;;) {
          if (buf.length < 2) return;
          const opcode = buf[0] & 0x0f;
          const masked = (buf[1] & 0x80) !== 0;
          let len = buf[1] & 0x7f;
          let off = 2;
          if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
          else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
          if (!masked) { onClientFrame?.({ opcode, masked: false, text: '' }); buf = buf.subarray(off + len); continue; }
          if (buf.length < off + 4 + len) return;
          const mk = buf.subarray(off, off + 4);
          const raw = Buffer.from(buf.subarray(off + 4, off + 4 + len));
          for (let i = 0; i < raw.length; i++) raw[i] ^= mk[i & 3];
          buf = buf.subarray(off + 4 + len);
          onClientFrame?.({ opcode, masked: true, text: raw.toString('utf8') });
        }
      });
      sock.on('error', () => {});
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}

// --- 2. Frames uit RFC 6455 §5.7 --------------------------------------------
async function run() {
  // (a) enkel ongemaskeerd tekstframe "Hello"
  await new Promise(async (resolve) => {
    const msgs = [];
    const { srv, port } = await startServer({});
    srv.once('ready', (sock) => {
      sock.write(Buffer.from([0x81, 0x05, 0x48, 0x65, 0x6c, 0x6c, 0x6f]));
      setTimeout(() => {
        check('enkel tekstframe "Hello" (RFC §5.7)', msgs[0] === 'Hello', JSON.stringify(msgs));
        ws.close(); srv.close(); resolve();
      }, 120);
    });
    const ws = connect(`ws://127.0.0.1:${port}`, { onMessage: (m) => msgs.push(m) });
  });

  // (b) gefragmenteerd "Hel" + "lo" → moet als één bericht "Hello" aankomen
  await new Promise(async (resolve) => {
    const msgs = [];
    const { srv, port } = await startServer({});
    srv.once('ready', (sock) => {
      sock.write(Buffer.from([0x01, 0x03, 0x48, 0x65, 0x6c])); // FIN=0, text
      sock.write(Buffer.from([0x80, 0x02, 0x6c, 0x6f]));       // FIN=1, continuation
      setTimeout(() => {
        check('gefragmenteerd "Hel"+"lo" wordt één "Hello" (RFC §5.7)', msgs.length === 1 && msgs[0] === 'Hello', JSON.stringify(msgs));
        ws.close(); srv.close(); resolve();
      }, 120);
    });
    const ws = connect(`ws://127.0.0.1:${port}`, { onMessage: (m) => msgs.push(m) });
  });

  // (c) payload van 256 bytes → 16-bits lengteveld (0x7E)
  await new Promise(async (resolve) => {
    const msgs = [];
    const body = 'x'.repeat(256);
    const { srv, port } = await startServer({});
    srv.once('ready', (sock) => {
      const h = Buffer.alloc(4); h[0] = 0x81; h[1] = 0x7e; h.writeUInt16BE(256, 2);
      sock.write(Buffer.concat([h, Buffer.from(body)]));
      setTimeout(() => {
        check('256 bytes via 16-bits lengte (RFC §5.7)', msgs[0] === body, `len=${msgs[0]?.length}`);
        ws.close(); srv.close(); resolve();
      }, 120);
    });
    const ws = connect(`ws://127.0.0.1:${port}`, { onMessage: (m) => msgs.push(m) });
  });

  // (d) payload van 70000 bytes → 64-bits lengteveld (0x7F)
  await new Promise(async (resolve) => {
    const msgs = [];
    const body = 'y'.repeat(70000);
    const { srv, port } = await startServer({});
    srv.once('ready', (sock) => {
      const h = Buffer.alloc(10); h[0] = 0x81; h[1] = 0x7f; h.writeBigUInt64BE(BigInt(70000), 2);
      sock.write(Buffer.concat([h, Buffer.from(body)]));
      setTimeout(() => {
        check('70000 bytes via 64-bits lengte (RFC §5.7)', msgs[0] === body, `len=${msgs[0]?.length}`);
        ws.close(); srv.close(); resolve();
      }, 250);
    });
    const ws = connect(`ws://127.0.0.1:${port}`, { onMessage: (m) => msgs.push(m) });
  });

  // (e) een frame dat in losse TCP-brokken binnenkomt
  await new Promise(async (resolve) => {
    const msgs = [];
    const { srv, port } = await startServer({});
    srv.once('ready', (sock) => {
      sock.write(Buffer.from([0x81, 0x05, 0x48]));           // half frame
      setTimeout(() => sock.write(Buffer.from([0x65, 0x6c, 0x6c, 0x6f])), 40); // rest
      setTimeout(() => {
        check('frame verdeeld over twee TCP-brokken', msgs[0] === 'Hello', JSON.stringify(msgs));
        ws.close(); srv.close(); resolve();
      }, 180);
    });
    const ws = connect(`ws://127.0.0.1:${port}`, { onMessage: (m) => msgs.push(m) });
  });

  // (f) twee frames in één TCP-brok
  await new Promise(async (resolve) => {
    const msgs = [];
    const { srv, port } = await startServer({});
    srv.once('ready', (sock) => {
      sock.write(Buffer.concat([
        Buffer.from([0x81, 0x02, 0x68, 0x69]),   // "hi"
        Buffer.from([0x81, 0x02, 0x6a, 0x61]),   // "ja"
      ]));
      setTimeout(() => {
        check('twee frames in één TCP-brok', msgs.join(',') === 'hi,ja', JSON.stringify(msgs));
        ws.close(); srv.close(); resolve();
      }, 150);
    });
    const ws = connect(`ws://127.0.0.1:${port}`, { onMessage: (m) => msgs.push(m) });
  });

  // (g) ping van de server → client moet een pong terugsturen
  await new Promise(async (resolve) => {
    const frames = [];
    const { srv, port } = await startServer({ onClientFrame: (f) => frames.push(f) });
    srv.once('ready', (sock) => {
      sock.write(Buffer.from([0x89, 0x00])); // ping, lege payload
      setTimeout(() => {
        check('ping wordt beantwoord met pong', frames.some((f) => f.opcode === 0x0a), JSON.stringify(frames.map((f) => f.opcode)));
        ws.close(); srv.close(); resolve();
      }, 180);
    });
    const ws = connect(`ws://127.0.0.1:${port}`, {});
  });

  // (h) wat de client stuurt is gemaskeerd (verplicht) en komt goed aan
  await new Promise(async (resolve) => {
    const frames = [];
    const { srv, port } = await startServer({ onClientFrame: (f) => frames.push(f) });
    // Wachten op de open-callback van de cliént: pas dán is de handshake bij ons
    // verwerkt. Op srv 'ready' wachten is te vroeg — die vuurt al bij het versturen.
    const ws = connect(`ws://127.0.0.1:${port}`, {
      onOpen: () => {
        ws.send(JSON.stringify({ event: 'registerPlugin', uuid: 'ABC123' }));
        setTimeout(() => {
          const f = frames.find((x) => x.opcode === 0x01);
          check('client maskeert zijn frames (RFC-eis)', !!f && f.masked === true);
          check('verstuurde JSON komt onbeschadigd aan', f?.text === '{"event":"registerPlugin","uuid":"ABC123"}', f?.text);
          ws.close(); srv.close(); resolve();
        }, 180);
      },
    });
  });

  // (i) verkeerde Sec-WebSocket-Accept moet geweigerd worden
  await new Promise((resolve) => {
    const srv = createServer((sock) => {
      sock.on('data', () => {
        sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: FOUT\r\n\r\n');
      });
      sock.on('error', () => {});
    });
    srv.listen(0, '127.0.0.1', () => {
      let errored = false;
      const ws = connect(`ws://127.0.0.1:${srv.address().port}`, { onError: () => { errored = true; } });
      setTimeout(() => {
        check('handshake met foute Accept wordt geweigerd', errored);
        ws.close(); srv.close(); resolve();
      }, 200);
    });
  });

  console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass} geslaagd, ${fail} gefaald\n`);
  process.exit(fail === 0 ? 0 : 1);
}

run();
