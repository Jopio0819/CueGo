// ws.mjs — minimale WebSocket-client (RFC 6455) in pure Node-stdlib.
//
// Stream Deck praat met plugins over een gewone ws://127.0.0.1:<poort>-verbinding.
// Node 20 heeft nog geen ingebouwde WebSocket en CueGo gebruikt nergens npm, dus
// doen we het zelf: handshake, frames in- en uitpakken, ping/pong, close.
//
// Bewust beperkt tot wat Stream Deck nodig heeft: JSON-tekstberichten over een
// onversleutelde loopback-verbinding. Geen wss, geen extensies, geen compressie.

import { connect as tcpConnect } from 'node:net';
import { createHash, randomBytes } from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'; // vaste waarde uit de RFC
const OP = { cont: 0x0, text: 0x1, binary: 0x2, close: 0x8, ping: 0x9, pong: 0xa };

// Eén frame bouwen. Een client moet altijd maskeren — servers weigeren het anders.
function buildFrame(opcode, payload) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = 0x80 | len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | opcode; // FIN + opcode; we versturen nooit gefragmenteerd
  const mask = randomBytes(4);
  const masked = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i & 3];
  return Buffer.concat([header, mask, masked]);
}

// Losse TCP-brokken → complete frames. Een frame kan over meerdere chunks komen
// én één chunk kan meerdere frames bevatten, dus we bufferen tot het compleet is.
function createParser(onFrame, onProtocolError) {
  let buf = Buffer.alloc(0);
  return function feed(chunk) {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    for (;;) {
      if (buf.length < 2) return;
      const fin = (buf[0] & 0x80) !== 0;
      const opcode = buf[0] & 0x0f;
      const isMasked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f;
      let off = 2;

      if (len === 126) {
        if (buf.length < off + 2) return;
        len = buf.readUInt16BE(off);
        off += 2;
      } else if (len === 127) {
        if (buf.length < off + 8) return;
        const big = buf.readBigUInt64BE(off);
        // Stream Deck stuurt nooit zulke berichten; accepteren we het toch, dan
        // zou één kapot frame het geheugen laten vollopen.
        if (big > 0x4000000n) { onProtocolError?.(new Error('WebSocket-frame te groot')); return; }
        len = Number(big);
        off += 8;
      }

      let maskKey = null;
      if (isMasked) {
        if (buf.length < off + 4) return;
        maskKey = buf.subarray(off, off + 4);
        off += 4;
      }
      if (buf.length < off + len) return; // rest komt in een volgende chunk

      let payload = buf.subarray(off, off + len);
      if (maskKey) {
        const copy = Buffer.from(payload);
        for (let i = 0; i < copy.length; i++) copy[i] ^= maskKey[i & 3];
        payload = copy;
      }
      buf = buf.subarray(off + len);
      onFrame({ fin, opcode, payload });
    }
  };
}

// Verbind met een ws://-url. Geeft { send, close } terug.
export function connect(url, { onOpen, onMessage, onClose, onError } = {}) {
  const u = new URL(url);
  const port = Number(u.port) || 80;
  const path = (u.pathname || '/') + (u.search || '');
  const key = randomBytes(16).toString('base64');
  const expectedAccept = createHash('sha1').update(key + GUID).digest('base64');

  let open = false;
  let closed = false;
  let handshakeDone = false;
  let handshakeBuf = Buffer.alloc(0);
  // Gefragmenteerde berichten: opcode onthouden en de stukken verzamelen.
  let fragOpcode = null;
  let fragParts = [];

  const sock = tcpConnect({ host: u.hostname, port });
  sock.setNoDelay(true);

  const fail = (err) => {
    if (closed) return;
    closed = true;
    try { sock.destroy(); } catch { /* al dicht */ }
    onError?.(err);
    onClose?.(err);
  };

  function handleFrame({ fin, opcode, payload }) {
    if (opcode === OP.ping) { write(buildFrame(OP.pong, payload)); return; }
    if (opcode === OP.pong) return;
    if (opcode === OP.close) {
      if (!closed) { closed = true; try { sock.end(buildFrame(OP.close, Buffer.alloc(0))); } catch { /* al dicht */ } }
      onClose?.(null);
      return;
    }
    // Tekst/binair, eventueel in stukken (opcode 0 = vervolg van het vorige).
    if (opcode === OP.text || opcode === OP.binary) { fragOpcode = opcode; fragParts = [payload]; }
    else if (opcode === OP.cont) fragParts.push(payload);
    else return; // onbekende opcode → negeren

    if (!fin) return;
    const full = fragParts.length === 1 ? fragParts[0] : Buffer.concat(fragParts);
    fragParts = [];
    const wasText = fragOpcode === OP.text;
    fragOpcode = null;
    if (wasText) onMessage?.(full.toString('utf8'));
  }

  const parser = createParser(handleFrame, fail);

  function write(buf) {
    if (closed) return;
    try { sock.write(buf); } catch (err) { fail(err); }
  }

  sock.on('connect', () => {
    sock.write(
      `GET ${path} HTTP/1.1\r\n` +
      `Host: ${u.hostname}:${port}\r\n` +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Key: ${key}\r\n` +
      'Sec-WebSocket-Version: 13\r\n\r\n'
    );
  });

  sock.on('data', (chunk) => {
    if (handshakeDone) { parser(chunk); return; }

    handshakeBuf = Buffer.concat([handshakeBuf, chunk]);
    const end = handshakeBuf.indexOf('\r\n\r\n');
    if (end === -1) {
      if (handshakeBuf.length > 65536) fail(new Error('Onzinnig lange handshake-respons'));
      return; // headers nog niet compleet
    }

    const head = handshakeBuf.subarray(0, end).toString('utf8');
    const rest = handshakeBuf.subarray(end + 4);
    handshakeBuf = Buffer.alloc(0);

    if (!/^HTTP\/1\.1 101/i.test(head)) {
      fail(new Error(`Handshake geweigerd: ${head.split('\r\n')[0]}`));
      return;
    }
    // Het accept-antwoord bewijst dat we echt met een WebSocket-server praten.
    const accept = /sec-websocket-accept:\s*(\S+)/i.exec(head)?.[1];
    if (accept !== expectedAccept) {
      fail(new Error('Ongeldige Sec-WebSocket-Accept'));
      return;
    }

    handshakeDone = true;
    open = true;
    onOpen?.();
    if (rest.length) parser(rest); // data die al meekwam na de headers
  });

  sock.on('error', (err) => fail(err));
  sock.on('close', () => {
    if (closed) return;
    closed = true;
    onClose?.(open ? null : new Error('Verbinding gesloten voor de handshake'));
  });

  return {
    send(text) {
      if (!open || closed) return false;
      write(buildFrame(OP.text, Buffer.from(String(text), 'utf8')));
      return true;
    },
    close() {
      if (closed) return;
      closed = true;
      try { sock.end(buildFrame(OP.close, Buffer.alloc(0))); } catch { /* al dicht */ }
      try { sock.destroy(); } catch { /* al dicht */ }
    },
    get isOpen() { return open && !closed; },
  };
}
