// setup.mjs — het installatiecommando van de website eindigt hier: start de
// server. Die installeert bij elke start zelf het `cuego`-commando (alias op
// macOS/Linux, cuego.cmd in WindowsApps op Windows), dus hier hoeft niets meer.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const child = spawn(process.execPath, [join(ROOT, 'server.mjs')], { stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 0));
