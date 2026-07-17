// cert.mjs — self-signed certificaat in puur Node (geen openssl, geen npm).
//
// Waarom: Web MIDI en andere browser-API's vereisen een secure context, en een
// LAN-IP over http is dat nooit. Met dit certificaat kan de server https praten;
// per apparaat accepteer je één keer de browserwaarschuwing en daarna is
// https://<ip>:<poort> een volwaardige secure context.
//
// We bouwen het X.509-certificaat met de hand in DER. Node kan sleutels maken
// en ondertekenen, maar geen certificaten uitschrijven — dat stukje ASN.1 doen
// we dus zelf. Klein, saai en volledig te verifiëren.

import { generateKeyPairSync, createSign, randomBytes } from 'node:crypto';

// --- DER-bouwstenen ---------------------------------------------------------

function derLen(n) {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  while (n > 0) { bytes.unshift(n & 0xff); n >>= 8; }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag, content) {
  return Buffer.concat([Buffer.from([tag]), derLen(content.length), content]);
}

const seq = (...parts) => tlv(0x30, Buffer.concat(parts));
const set = (...parts) => tlv(0x31, Buffer.concat(parts));
const derNull = () => Buffer.from([0x05, 0x00]);
const octetString = (b) => tlv(0x04, b);
const utf8String = (s) => tlv(0x0c, Buffer.from(s, 'utf8'));
const ia5String = (s) => tlv(0x16, Buffer.from(s, 'ascii'));

function derInt(buf) {
  // INTEGER is signed: een voorloopnul voorkomt dat een hoge eerste bit
  // het getal negatief maakt.
  if (buf[0] & 0x80) buf = Buffer.concat([Buffer.from([0]), buf]);
  return tlv(0x02, buf);
}

function derOid(oid) {
  const arcs = oid.split('.').map(Number);
  const bytes = [arcs[0] * 40 + arcs[1]];
  for (const arc of arcs.slice(2)) {
    if (arc < 0x80) { bytes.push(arc); continue; }
    // Base-128 met continuatiebit; de laatste byte zonder dat bit.
    const chunk = [];
    let v = arc;
    while (v > 0) { chunk.unshift((v & 0x7f) | 0x80); v >>= 7; }
    chunk[chunk.length - 1] &= 0x7f;
    bytes.push(...chunk);
  }
  return tlv(0x06, Buffer.from(bytes));
}

function bitString(b) {
  return tlv(0x03, Buffer.concat([Buffer.from([0]), b])); // 0 ongebruikte bits
}

function utcTime(date) {
  const p = (n) => String(n).padStart(2, '0');
  const s = `${p(date.getUTCFullYear() % 100)}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}` +
    `${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}Z`;
  return tlv(0x17, Buffer.from(s, 'ascii'));
}

// --- Certificaat ------------------------------------------------------------

const OID_SHA256_RSA = '1.2.840.113549.1.1.11';
const OID_CN = '2.5.4.3';
const OID_SAN = '2.5.29.17';
const OID_BASIC = '2.5.29.19';

// Geldigheid onder Chrome's 398-dagen-grens, anders klaagt de browser extra.
const VALID_DAYS = 397;

function name(cn) {
  return seq(set(seq(derOid(OID_CN), utf8String(cn))));
}

// Genereer sleutel + self-signed certificaat voor de gegeven hostnamen en IP's.
export function generateCert({ ips = [], hostnames = ['localhost'] } = {}) {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const spki = publicKey.export({ type: 'spki', format: 'der' });

  const algId = seq(derOid(OID_SHA256_RSA), derNull());
  const now = new Date(Date.now() - 24 * 3600 * 1000); // gisteren: klokverschil-marge
  const until = new Date(now.getTime() + VALID_DAYS * 24 * 3600 * 1000);

  // SubjectAltName: DNS-namen + IP's — Chrome matcht uitsluitend hierop.
  const altNames = [
    ...hostnames.map((h) => tlv(0x82, Buffer.from(h, 'ascii'))), // [2] dNSName
    ...ips.map((ip) => tlv(0x87, Buffer.from(ip.split('.').map(Number)))), // [7] iPAddress
  ];
  const extensions = tlv(0xa3, seq( // [3] EXPLICIT wrapper om de extensielijst
    seq(derOid(OID_BASIC), octetString(seq())), // basicConstraints: geen CA
    seq(derOid(OID_SAN), octetString(seq(...altNames)))
  ));

  const tbs = seq(
    tlv(0xa0, derInt(Buffer.from([2]))), // [0] versie: v3
    derInt(randomBytes(8)), // serienummer
    algId,
    name('CueGo'), // uitgever = onderwerp (self-signed)
    seq(utcTime(now), utcTime(until)),
    name('CueGo'),
    spki,
    extensions
  );

  const signature = createSign('sha256').update(tbs).sign(privateKey);
  const cert = seq(tbs, algId, bitString(signature));

  const pem = (label, der) =>
    `-----BEGIN ${label}-----\n${der.toString('base64').replace(/(.{64})/g, '$1\n').trim()}\n-----END ${label}-----\n`;

  return {
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    cert: pem('CERTIFICATE', cert),
  };
}
