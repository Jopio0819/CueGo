// cue-types.test.mjs — het cue-type-fundament: serialisatie en round-trips.
//
// Bewaakt dat het nieuwe `type`-veld en de type-specifieke velden overal
// meelopen (cueToMeta ↔ metaToCue, projectbestand export ↔ import) en dat oude
// shows zonder `type` gewoon audio-cues blijven. De veldenlijst staat nu op één
// plek (CUE_FIELDS); deze test is de vangrail als daar iets misgaat.
//
// Draaien:  node test/cue-types.test.mjs

import { baseCue, createCue, cueToMeta, metaToCue, CUE_FIELDS, CUE_TYPES, CueList } from '../src/cue-model.js';
import { exportProject, importProject } from '../src/project.js';
import { encodeOsc, parseOsc, parseOscArgs } from '../osc.mjs';
import { midiMessageBytes } from '../src/midi.js';

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
    case 'audio': return baseCue({ ...common, fadeIn: 2, fadeOut: 4, volume: 0.8, loop: true, loopCount: '3', inPoint: 1.5, eq: [1, -2, 3, -4, 5, -6], cartSlot: 5 });
    case 'wait': return baseCue({ ...common, waitTime: 7 });
    case 'stop': return baseCue({ ...common, target: 'cue-xyz', stopFade: 2.5 });
    case 'fade': return baseCue({ ...common, target: 'cue-abc', fadeTo: 0.3, fadeTime: 5, stopAfter: true });
    case 'group': return baseCue({ ...common, mode: 'sequential', collapsed: true, parentId: 'p1' });
    case 'midi': return baseCue({ ...common, midiOut: { deviceId: 'dev1', type: 'cc', channel: 3, data1: 74, data2: 64 } });
    case 'osc': return baseCue({ ...common, oscOut: { host: '10.0.0.5', port: 8000, address: '/go', args: '1 2.5 hoi' } });
    case 'light': return baseCue({ ...common, dmx: { protocol: 'sacn', host: '', universe: 2, fadeTime: 3, channels: [{ ch: 1, value: 255 }] } });
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
  const m1 = baseCue({ type: 'midi' });
  const m2 = baseCue({ type: 'midi' });
  m1.midiOut.data1 = 99;
  check('twee midi-cues delen geen midiOut-object', m2.midiOut.data1 === 60, `m2=${m2.midiOut.data1}`);
  const o1 = baseCue({ type: 'osc' });
  const o2 = baseCue({ type: 'osc' });
  o1.oscOut.address = '/x';
  check('twee osc-cues delen geen oscOut-object', o2.oscOut.address === '', `o2=${o2.oscOut.address}`);
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

// --- 6. Nesting: de boom-operaties van CueList -------------------------------
console.log('  -- nesting (CueList) --');
{
  const L = new CueList();
  const mk = (name, type = 'wait') => { const c = baseCue({ type, name }); L.addExisting(c); return c; };
  const A = mk('A'), B = mk('B'), C = mk('C');

  // Groepeer B en C in een nieuwe groep.
  const G = baseCue({ type: 'group', name: 'G' });
  L.groupCues([B.id, C.id], G);
  check('groep komt op de plek van de eerste geselecteerde', L.cues.map((c) => c.name).join(',') === 'A,G,B,C', L.cues.map((c) => c.name).join(','));
  check('kinderen krijgen de parentId van de groep', L.getById(B.id).parentId === G.id && L.getById(C.id).parentId === G.id);
  check('diepte klopt (kind = 1)', L.depthOf(A) === 0 && L.depthOf(L.getById(B.id)) === 1);
  check('subtree van de groep = header + 2 kinderen', L.subtreeRange(G.id).end - L.subtreeRange(G.id).start === 3);
  check('childrenOf geeft de 2 kinderen in volgorde', L.childrenOf(G.id).map((c) => c.name).join(',') === 'B,C');

  // advance vanaf de groep slaat de kinderen over.
  const D = mk('D'); // top-level, achteraan → volgorde A,G,B,C,D
  L.selectById(G.id); L.advance();
  check('advance vanaf groep springt voorbij de kinderen naar D', L.selected.id === D.id, L.selected.name);

  // Verwijder de groep → de kinderen gaan mee.
  L.remove(G.id);
  check('groep verwijderen neemt de kinderen mee', L.cues.map((c) => c.name).join(',') === 'A,D', L.cues.map((c) => c.name).join(','));
}

// Sleep-operaties (reorder): in een groep, eruit, en lus-preventie.
{
  const L = new CueList();
  const mk = (name, type = 'wait') => { const c = baseCue({ type, name }); L.addExisting(c); return c; };
  const A = mk('A'); const G = baseCue({ type: 'group', name: 'G' }); L.addExisting(G); const X = mk('X');
  // volgorde nu: A, G, X

  L.reorder(A.id, G.id, false, true); // A ín G
  check('sleep-in-groep: A wordt kind van G', L.getById(A.id).parentId === G.id);
  check('sleep-in-groep: volgorde G,A,X', L.cues.map((c) => c.name).join(',') === 'G,A,X', L.cues.map((c) => c.name).join(','));

  L.reorder(A.id, X.id, false, false); // A eruit, vóór X (broer op topniveau)
  check('sleep-eruit: A weer op topniveau', L.getById(A.id).parentId === '');
  check('sleep-eruit: volgorde G,A,X', L.cues.map((c) => c.name).join(',') === 'G,A,X', L.cues.map((c) => c.name).join(','));

  L.reorder(A.id, G.id, false, true); // A terug in G
  L.reorder(G.id, A.id, false, true); // G in z'n eigen kind → moet geweigerd worden
  check('lus voorkomen: groep niet in z\'n eigen kind', L.getById(G.id).parentId === '', L.getById(G.id).parentId);
}

// --- 7. OSC-uitsturen: encode → decode moet exact terugkomen -----------------
console.log('  -- OSC encode/decode --');
{
  const args = parseOscArgs('1 2.5 hoi -3');
  check('args-string wordt getypeerd (int/float/string)', JSON.stringify(args) === JSON.stringify([1, 2.5, 'hoi', -3]), JSON.stringify(args));
  const [msg] = parseOsc(encodeOsc('/cue/3/go', args));
  check('adres komt terug', msg.address === '/cue/3/go', msg.address);
  check('int-arg komt terug', msg.args[0] === 1);
  check('float-arg komt ~terug', Math.abs(msg.args[1] - 2.5) < 1e-6, String(msg.args[1]));
  check('string-arg komt terug', msg.args[2] === 'hoi', msg.args[2]);
  const [empty] = parseOsc(encodeOsc('/go', []));
  check('bericht zonder args werkt', empty.address === '/go' && empty.args.length === 0);
}

// --- 8. MIDI-cue: de juiste bytes per berichttype ----------------------------
console.log('  -- MIDI-bytes --');
{
  check('Note On kan.1 noot60 vel100', JSON.stringify(midiMessageBytes({ type: 'noteon', channel: 1, data1: 60, data2: 100 })) === JSON.stringify([0x90, 60, 100]));
  check('Note Off kan.16', JSON.stringify(midiMessageBytes({ type: 'noteoff', channel: 16, data1: 60, data2: 0 })) === JSON.stringify([0x8f, 60, 0]));
  check('CC kan.3 ctrl74 waarde64', JSON.stringify(midiMessageBytes({ type: 'cc', channel: 3, data1: 74, data2: 64 })) === JSON.stringify([0xb2, 74, 64]));
  check('Program Change = 2 bytes', JSON.stringify(midiMessageBytes({ type: 'pc', channel: 1, data1: 5 })) === JSON.stringify([0xc0, 5]));
  check('waarden worden geclampt (kanaal/data)', JSON.stringify(midiMessageBytes({ type: 'noteon', channel: 99, data1: 999, data2: -5 })) === JSON.stringify([0x9f, 127, 0]));
}

console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass} geslaagd, ${fail} gefaald\n`);
process.exit(fail === 0 ? 0 : 1);
