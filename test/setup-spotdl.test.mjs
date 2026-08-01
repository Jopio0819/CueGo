// Installerflow zonder netwerk: een nep-Python maakt een nep-venv, waarna we
// controleren dat setup ook de FFmpeg-stap uitvoert en geen server start.

import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = join(ROOT, 'test', 'fake-python.mjs');
const temp = mkdtempSync(join(tmpdir(), 'cuego-setup-spotdl-'));
const venv = join(temp, 'venv');
const marker = join(temp, 'ffmpeg-downloaded');
chmodSync(fixture, 0o755);

const run = spawnSync(process.execPath, ['setup.mjs', '--spotdl-only'], {
  cwd: ROOT,
  encoding: 'utf8',
  env: {
    ...process.env,
    CUEGO_INSTALL_SPOTDL: '1',
    CUEGO_SPOTDL: join(temp, 'bestaat-niet'),
    CUEGO_PYTHON: fixture,
    CUEGO_SPOTDL_VENV: venv,
    CUEGO_SPOTDL_TEST_MARKER: marker,
  },
});

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`); }
};

check('setup eindigt zonder server te starten', run.status === 0, run.stderr.trim());
check('lokale spotDL-executable aangemaakt', existsSync(join(venv, 'bin', 'spotdl')));
check('FFmpeg-installatiestap uitgevoerd', existsSync(marker));
check('duidelijke gereedmelding', run.stdout.includes('spotDL is klaar'));

rmSync(temp, { recursive: true, force: true });
console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass} geslaagd, ${fail} gefaald\n`);
process.exit(fail === 0 ? 0 : 1);
