// cue-types.test.mjs — het cue-type-fundament: serialisatie en round-trips.
//
// Bewaakt dat het nieuwe `type`-veld en de type-specifieke velden overal
// meelopen (cueToMeta ↔ metaToCue, projectbestand export ↔ import) en dat oude
// shows zonder `type` gewoon audio-cues blijven. De veldenlijst staat nu op één
// plek (CUE_FIELDS); deze test is de vangrail als daar iets misgaat.
//
// Draaien:  node test/cue-types.test.mjs

import { baseCue, createCue, cueToMeta, metaToCue, CUE_FIELDS, CUE_TYPES } from '../src/cue-model.js';
import { exportProject, importProject } from '../src/project.js';

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`); }
};

// Vergelijk alle CUE_FIELDS van twee cues (niet de runtime-file).
function sameFields(a, b) {
  for (const f of CUE_FIELDS) {
    if (JSON.stringify(a[f.key]) !== JSON.stringify(b[f.key])) {
      return `veld "${f.key}": ${JSON.stringify(a[f.key])} ≠ ${JSON.stringify(b[f.key])}`;
    }
  }
  return null;
}

// Een cue per type, met niet-default waarden zodat we echt iets te vergelijken hebben.
function sampleCue(type) {
  const common = { type, number: `${type}-1`, name: `Test ${type}`, preWait: 0.5, autoFollow: true };
  switch (type) {
    case 'audio': return baseCue({ ...common, fadeIn: 2, fadeOut: 4, volume: 0.8, loop: true, loopCount: '3', inPoint: 1.5, eq: [1, -2, 3, -4, 5, -6] });
    case 'wait': return baseCue({ ...common, waitTime: 7 });
    case 'stop': return baseCue({ ...common, target: 'cue-xyz', stopFade: 2.5 });
    case 'fade': return baseCue({ ...common, target: 'cue-abc', fadeTo: 0.3, fadeTime: 5, stopAfter: true });
    case 'group': return baseCue({ ...common, mode: 'sequential', children: ['a', 'b', 'c'] });
    case 'midi': return baseCue({ ...common, midiOut: { deviceId: 'dev1', messages: [{ status: 144, d1: 60, d2: 100 }] } });
    case 'osc': return baseCue({ ...common, oscOut: { host: '10.0.0.5', port: 8000, address: '/go', args: '1 2.5 hoi' } });
    case 'light': return baseCue({ ...common, dmx: { universe: 2, protocol: 'sacn', fadeTime: 3, channels: [{ ch: 1, value: 255 }] } });
    default: return baseCue(common);
  }
}

// --- 1. cueToMeta ↔ metaToCue round-trip voor elk type -----------------------
console.log('  -- cueToMeta ↔ metaToCue --');
for (const type of CUE_TYPES) {
  const cue = sampleCue(type);
  const back = metaToCue(cueToMeta(cue), cue.file || null);
  check(`round-trip ${type}`, sameFields(cue, back) === null, sameFields(cue, back));
}

// --- 2. Defaults zijn vers (geen gedeelde array/object-referenties) -----------
console.log('  -- verse defaults --');
{
  const a = baseCue({ type: 'audio' });
  const b = baseCue({ type: 'audio' });
  a.eq[0] = 99;
  check('twee cues delen geen eq-array', b.eq[0] === 0, `b.eq[0]=${b.eq[0]}`);
  const g1 = baseCue({ type: 'group' });
  const g2 = baseCue({ type: 'group' });
  g1.children.push('x');
  check('twee groups delen geen children-array', g2.children.length === 0, `len=${g2.children.length}`);
  const m1 = baseCue({ type: 'midi' });
  const m2 = baseCue({ type: 'midi' });
  m1.midiOut.messages.push({});
  check('twee midi-cues delen geen midiOut-object', m2.midiOut.messages.length === 0);
}

// --- 3. Achterwaartse compatibiliteit: oude show zonder `type` ---------------
console.log('  -- oude data --');
{
  // Zoals een show van vóór deze wijziging: geen type, geen preWait/autoFollow.
  const oud = { id: 'old-1', number: '1', name: 'Oude cue', fadeIn: 1, fadeOut: 3, volume: 1, loop: false, eq: [0, 0, 0, 0, 0, 0] };
  const cue = metaToCue(oud, null);
  check('oude cue wordt type "audio"', cue.type === 'audio', cue.type);
  check('oude cue krijgt preWait-default', cue.preWait === 0);
  check('oude cue krijgt autoFollow-default', cue.autoFollow === false);
  check('oude naam/fades blijven behouden', cue.name === 'Oude cue' && cue.fadeIn === 1 && cue.fadeOut === 3);
}

// --- 4. Rommelige waarden worden genormaliseerd ------------------------------
console.log('  -- normalisatie --');
{
  const rommel = metaToCue({ id: 'x', type: 'onzin', eq: [1, 2] }, null);
  check('onbekend type valt terug op audio', rommel.type === 'audio', rommel.type);
  check('kapotte eq valt terug op 6 nullen', JSON.stringify(rommel.eq) === JSON.stringify([0, 0, 0, 0, 0, 0]), JSON.stringify(rommel.eq));
}

// --- 5. Projectbestand: export → import met gemengde cue-types ---------------
console.log('  -- projectbestand round-trip --');
{
  const audio = createCue(new File([new Uint8Array([1, 2, 3, 4, 5])], 'song.wav', { type: 'audio/wav' }));
  audio.volume = 0.5; audio.fadeIn = 2;
  const wait = sampleCue('wait');
  const stop = sampleCue('stop');
  const group = sampleCue('group');
  const cues = [audio, wait, stop, group];

  const blob = await exportProject(cues, { singleCueMode: true }, null);
  const buf = await blob.arrayBuffer();
  const { cues: back, settings } = await importProject(buf);

  check('zelfde aantal cues terug', back.length === cues.length, `${back.length} vs ${cues.length}`);
  check('instellingen komen mee', settings.singleCueMode === true);
  let allOk = true, firstErr = '';
  for (let i = 0; i < cues.length; i++) {
    const err = sameFields(cues[i], back[i]);
    if (err) { allOk = false; firstErr = `cue ${i} (${cues[i].type}): ${err}`; break; }
  }
  check('alle cue-velden identiek na round-trip', allOk, firstErr);
  // De audio-bytes moeten ook terug zijn, en control-cues juist géén file.
  const audioBack = back[0];
  check('audio-cue heeft z\'n bestand terug', audioBack.file && audioBack.file.size === 5, `size=${audioBack.file?.size}`);
  check('wait-cue heeft geen bestand', back[1].file === null);
  const bytes = new Uint8Array(await audioBack.file.arrayBuffer());
  check('audio-bytes kloppen', JSON.stringify([...bytes]) === JSON.stringify([1, 2, 3, 4, 5]), [...bytes].join(','));
}

console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass} geslaagd, ${fail} gefaald\n`);
process.exit(fail === 0 ? 0 : 1);
