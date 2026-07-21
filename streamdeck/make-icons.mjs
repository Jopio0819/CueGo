// make-icons.mjs — genereert alle PNG's voor de Stream Deck-plugin.
//
// Waarom zelf tekenen: CueGo gebruikt nergens npm-pakketten, dus ook hier geen
// image-library. Node's zlib kan deflate, en meer heeft een PNG niet nodig.
// De vormen worden op 4× resolutie bemonsterd en daarna teruggeschaald; dat geeft
// nette randen zonder dat we anti-aliasing hoeven uit te rekenen.
//
// De uitvoer staat in de repo, dus je hoeft dit alleen te draaien als je de
// iconen wilt aanpassen:  node streamdeck/make-icons.mjs

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OUT = join(dirname(fileURLToPath(import.meta.url)), 'me.cue-go.sdPlugin', 'imgs');

// --- Kleuren (gelijk aan style.css, zodat de knoppen bij de app passen) -------
const C = {
  bg:     [0x14, 0x16, 0x1c],
  accent: [0x4c, 0x8d, 0xff],
  play:   [0x35, 0xc8, 0x8f],
  danger: [0xff, 0x5c, 0x5c],
  text:   [0xe8, 0xea, 0xf0],
};
const rgba = (c, a = 1) => [c[0], c[1], c[2], a];

// --- PNG schrijven -------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, pixels) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // 8 bits per kanaal
  ihdr[9] = 6;  // RGBA
  // 10..12 blijven 0: deflate, standaard filter, niet interlaced

  // Elke scanline krijgt een filter-byte (0 = geen filter).
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    const rowStart = y * (width * 4 + 1);
    raw[rowStart] = 0;
    pixels.copy
      ? pixels.copy(raw, rowStart + 1, y * width * 4, (y + 1) * width * 4)
      : Buffer.from(pixels.buffer).copy(raw, rowStart + 1, y * width * 4, (y + 1) * width * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- Tekenen -------------------------------------------------------------------
// Vormen werken in genormaliseerde coördinaten (0..1), zodat één definitie voor
// elke grootte werkt. Een 'laag' is een functie (u,v) → [r,g,b,a] of null.

const SS = 4; // supersampling-factor

function render(size, layers) {
  const big = size * SS;
  const px = Buffer.alloc(size * size * 4);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const u = (x * SS + sx + 0.5) / big;
          const v = (y * SS + sy + 0.5) / big;
          // source-over compositing, laag voor laag
          let pr = 0, pg = 0, pb = 0, pa = 0;
          for (const layer of layers) {
            const c = layer(u, v);
            if (!c) continue;
            const ca = c[3];
            if (ca <= 0) continue;
            pr = c[0] * ca + pr * (1 - ca);
            pg = c[1] * ca + pg * (1 - ca);
            pb = c[2] * ca + pb * (1 - ca);
            pa = ca + pa * (1 - ca);
          }
          r += pr; g += pg; b += pb; a += pa;
        }
      }
      const n = SS * SS;
      const i = (y * size + x) * 4;
      px[i] = Math.round(r / n);
      px[i + 1] = Math.round(g / n);
      px[i + 2] = Math.round(b / n);
      px[i + 3] = Math.round((a / n) * 255);
    }
  }
  return px;
}

// Vormen. Elk geeft een laag-functie terug.

const roundRect = (x0, y0, x1, y1, rad, color) => (u, v) => {
  if (u < x0 || u > x1 || v < y0 || v > y1) return null;
  const cx = Math.min(Math.max(u, x0 + rad), x1 - rad);
  const cy = Math.min(Math.max(v, y0 + rad), y1 - rad);
  const dx = u - cx, dy = v - cy;
  return dx * dx + dy * dy <= rad * rad ? color : null;
};

const rect = (x0, y0, x1, y1, color) => (u, v) =>
  u >= x0 && u <= x1 && v >= y0 && v <= y1 ? color : null;

// Driehoek via halfvlak-tests (punten met de klok mee).
const tri = (p, color) => (u, v) => {
  const side = (ax, ay, bx, by) => (bx - ax) * (v - ay) - (by - ay) * (u - ax);
  const d1 = side(p[0], p[1], p[2], p[3]);
  const d2 = side(p[2], p[3], p[4], p[5]);
  const d3 = side(p[4], p[5], p[0], p[1]);
  const neg = d1 < 0 || d2 < 0 || d3 < 0;
  const pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos) ? color : null;
};

// Dikke lijn tussen twee punten (afgeronde uiteinden).
const seg = (x1, y1, x2, y2, thick, color) => (u, v) => {
  const dx = x2 - x1, dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((u - x1) * dx + (v - y1) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const px = x1 + t * dx - u, py = y1 + t * dy - v;
  return px * px + py * py <= (thick / 2) ** 2 ? color : null;
};

// --- Glyphs ---------------------------------------------------------------------

const playTri = (color) => tri([0.36, 0.26, 0.75, 0.5, 0.36, 0.74], color);
const stopSq = (color) => roundRect(0.32, 0.32, 0.68, 0.68, 0.04, color);
const pauseBars = (color) => {
  const a = roundRect(0.34, 0.28, 0.45, 0.72, 0.03, color);
  const b = roundRect(0.55, 0.28, 0.66, 0.72, 0.03, color);
  return (u, v) => a(u, v) || b(u, v);
};
const cross = (color) => {
  const a = seg(0.34, 0.34, 0.66, 0.66, 0.13, color);
  const b = seg(0.66, 0.34, 0.34, 0.66, 0.13, color);
  return (u, v) => a(u, v) || b(u, v);
};
const arrow = (down, color) => (u, v) => {
  // Steel + punt; omgedraaid voor 'omhoog'.
  const vv = down ? v : 1 - v;
  const stem = u >= 0.45 && u <= 0.55 && vv >= 0.28 && vv <= 0.6;
  if (stem) return color;
  return tri([0.32, 0.56, 0.68, 0.56, 0.5, 0.76], color)(u, down ? v : 1 - v);
};

// Achtergrond voor de knopplaatjes (72×72 e.d.).
const keyBg = roundRect(0.03, 0.03, 0.97, 0.97, 0.14, rgba(C.bg, 1));

// --- Wat we genereren -------------------------------------------------------------

// Knopplaatjes: donkere tegel met een gekleurd symbool.
const KEYS = {
  go:            [keyBg, playTri(rgba(C.play))],
  stop:          [keyBg, stopSq(rgba(C.danger))],
  'toggle-play': [keyBg, playTri(rgba(C.play))],   // staat 0: stil → indrukken speelt
  'toggle-pause':[keyBg, pauseBars(rgba(C.text))], // staat 1: speelt → indrukken pauzeert
  panic:         [keyBg, cross(rgba(C.danger))],
  next:          [keyBg, arrow(true, rgba(C.accent))],
  prev:          [keyBg, arrow(false, rgba(C.accent))],
  playcue:       [keyBg, playTri(rgba(C.accent))],
};

// Lijst-iconen in Stream Deck: licht symbool op transparant.
const ACTION_ICONS = {
  go:      [playTri(rgba(C.text))],
  stop:    [stopSq(rgba(C.text))],
  toggle:  [pauseBars(rgba(C.text))],
  panic:   [cross(rgba(C.text))],
  next:    [arrow(true, rgba(C.text))],
  prev:    [arrow(false, rgba(C.text))],
  playcue: [playTri(rgba(C.text))],
};

// Plugin- en categorie-icoon: het CueGo-merkteken.
const BRAND = [
  roundRect(0.02, 0.02, 0.98, 0.98, 0.22, rgba(C.accent)),
  playTri(rgba([0xff, 0xff, 0xff])),
];

function write(relPath, size, layers) {
  const full = join(OUT, `${relPath}.png`);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, encodePng(size, size, render(size, layers)));
  writeFileSync(join(OUT, `${relPath}@2x.png`), encodePng(size * 2, size * 2, render(size * 2, layers)));
}

write('plugin', 28, BRAND);
write('category', 28, BRAND);
for (const [name, layers] of Object.entries(ACTION_ICONS)) write(`actions/${name}`, 20, layers);
for (const [name, layers] of Object.entries(KEYS)) write(`keys/${name}`, 72, layers);

console.log(`Iconen geschreven naar ${OUT}`);
