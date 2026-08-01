#!/usr/bin/env node
// Bootst Python/venv na voor setup-spotdl.test.mjs. Er wordt geen netwerk- of
// pakketdownload uitgevoerd; de fixture maakt alleen de verwachte executables.

import { chmod, copyFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--version') process.exit(0);

if (args[0] === '-m' && args[1] === 'spotdl') {
  // Het nep-systeem-Python heeft spotDL juist nog niet.
  process.exit(1);
}

if (args[0] === '-m' && args[1] === 'venv' && args[2]) {
  const bin = join(args[2], 'bin');
  await mkdir(bin, { recursive: true });
  const self = fileURLToPath(import.meta.url);
  await copyFile(self, join(bin, 'python'));
  await chmod(join(bin, 'python'), 0o755);
  const spotdl = `#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
if (process.argv.includes('--version')) process.exit(0);
if (process.argv.includes('--download-ffmpeg') && process.env.CUEGO_SPOTDL_TEST_MARKER) {
  await mkdir(dirname(process.env.CUEGO_SPOTDL_TEST_MARKER), { recursive: true });
  await writeFile(process.env.CUEGO_SPOTDL_TEST_MARKER, 'ok');
  process.exit(0);
}
process.exit(1);
`;
  await writeFile(join(bin, 'spotdl'), spotdl, { mode: 0o755 });
  process.exit(0);
}

// De Python in onze nep-venv krijgt `-m pip install spotdl`.
if (args[0] === '-m' && args[1] === 'pip' && args[2] === 'install' && args[3] === 'spotdl') process.exit(0);
process.exit(1);
