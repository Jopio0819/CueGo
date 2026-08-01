#!/usr/bin/env node
// Alleen voor de server-integratietest: bootst precies genoeg van spotDL na om
// tijdelijke bestanden, polling en ophalen te testen zonder netwerk of muziek.

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

if (process.argv.includes('--version')) {
  console.log('spotdl 4.test');
  process.exit(0);
}

const at = process.argv.indexOf('--output');
if (at === -1 || !process.argv[at + 1]) process.exit(2);
const threadsAt = process.argv.indexOf('--threads');
if (threadsAt === -1 || process.argv[threadsAt + 1] !== '8') {
  console.error('CueGo gaf niet de verwachte 8 downloadthreads door');
  process.exit(3);
}
const template = process.argv[at + 1];
const makeName = (position, artist, title) => template
  .replace('{list-position}', String(position))
  .replace('{artists}', artist)
  .replace('{title}', title)
  .replace('{output-ext}', 'mp3');

const one = makeName(1, 'Testartiest', 'Eerste');
const two = makeName(2, 'Testartiest', 'Tweede');
await mkdir(dirname(one), { recursive: true });
console.log('Downloading 1/2');
await writeFile(one, 'fake-one');
console.log('Downloading 2/2');
await writeFile(two, 'fake-two');
