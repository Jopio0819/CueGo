// fake-streamdeck.mjs — doet zich voor als de Stream Deck-software.
//
// Genoeg van het protocol om de plugin écht te draaien: WebSocket-server met een
// correcte handshake, frames uitpakken (de plugin maskeert) en inpakken (wij als
// server juist niet). Daarmee kunnen we de plugin end-to-end testen zonder dat er
// hardware aan te pas komt.
//
// Bewust een eigen implementatie, los van ws.mjs: als beide dezelfde fout zouden
// bevatten, zou de test die niet opmerken.

import { createServer } from 'node:net';
import { createHash } from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function frame(opcode, payload) {
  const len = payload.length;
  let header;
  if (len < 126) { header = Buffer.alloc(2); header[1] = len; }
  else if (len < 65536) { header = Buffer.alloc(4); header[1] = 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2); }
  header[0] = 0x80 | opcode; // FIN + opcode; server maskeert niet
  return Buffer.concat([header, payload]);
}

export function startFakeStreamDeck() {
  return new Promise((resolve) => {
    const received = [];       // alle berichten van de plugin, als objecten
    const waiters = [];        // wachtende beloftes op een bepaald bericht
    let sock = null;

    function deliver(msg) {
      received.push(msg);
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i].match(msg)) { waiters[i].resolve(msg); waiters.splice(i, 1); }
      }
    }

    const srv = createServer((s) => {
      sock = s;
      let buf = Buffer.alloc(0);
      let upgraded = false;

      s.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);

        if (!upgraded) {
          const end = buf.indexOf('\r\n\r\n');
          if (end === -1) return;
          const head = buf.subarray(0, end).toString();
          buf = buf.subarray(end + 4);
          const key = /sec-websocket-key:\s*(\S+)/i.exec(head)?.[1];
          s.write(
            'HTTP/1.1 101 Switching Protocols\r\n' +
            'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
            `Sec-WebSocket-Accept: ${createHash('sha1').update(key + GUID).digest('base64')}\r\n\r\n`
          );
          upgraded = true;
        }

        // Frames van de plugin uitpakken (altijd gemaskeerd).
        for (;;) {
          if (buf.length < 2) return;
          const opcode = buf[0] & 0x0f;
          const masked = (buf[1] & 0x80) !== 0;
          let len = buf[1] & 0x7f;
          let off = 2;
          if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
          else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
          const need = off + (masked ? 4 : 0) + len;
          if (buf.length < need) return;

          let payload;
          if (masked) {
            const mk = buf.subarray(off, off + 4);
            payload = Buffer.from(buf.subarray(off + 4, off + 4 + len));
            for (let i = 0; i < payload.length; i++) payload[i] ^= mk[i & 3];
          } else {
            payload = buf.subarray(off, off + len);
          }
          buf = buf.subarray(need);

          if (opcode === 0x08) { try { s.end(); } catch {} return; }  // close
          if (opcode === 0x09) { s.write(frame(0x0a, payload)); continue; } // ping → pong
          if (opcode !== 0x01) continue;
          try { deliver(JSON.parse(payload.toString('utf8'))); } catch { /* geen JSON */ }
        }
      });

      s.on('error', () => {});
    });

    srv.listen(0, '127.0.0.1', () => {
      resolve({
        port: srv.address().port,
        received,

        // Een event naar de plugin sturen, zoals Stream Deck dat doet.
        send(obj) {
          if (!sock) throw new Error('Plugin nog niet verbonden');
          sock.write(frame(0x01, Buffer.from(JSON.stringify(obj), 'utf8')));
        },

        // Wachten tot de plugin een bepaald bericht stuurt.
        wait(match, timeoutMs = 3000) {
          const already = received.find(match);
          if (already) return Promise.resolve(already);
          return new Promise((res, rej) => {
            const w = { match, resolve: res };
            waiters.push(w);
            setTimeout(() => {
              const i = waiters.indexOf(w);
              if (i >= 0) {
                waiters.splice(i, 1);
                rej(new Error(`Geen bericht dat voldoet binnen ${timeoutMs}ms. Ontvangen: ${JSON.stringify(received.map((m) => m.event))}`));
              }
            }, timeoutMs);
          });
        },

        close() { try { sock?.destroy(); } catch {} srv.close(); },
      });
    });
  });
}
