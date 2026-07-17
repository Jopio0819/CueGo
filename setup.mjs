// setup.mjs — eenmalige installatie: voegt het `cuego`-commando toe aan je shell
// en start daarna meteen de server. Alleen Node stdlib, net als de rest.
//
// Het commando werkt vanaf elke plek: server.mjs leidt z'n eigen map af uit de
// bestandslocatie, dus `node /pad/naar/server.mjs` heeft geen cd nodig.
import { appendFileSync, readFileSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { homedir } from 'node:os';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const SERVER = join(ROOT, 'server.mjs');

function installCommand() {
  if (process.platform === 'win32') {
    // Windows heeft geen shell-profiel waar een alias betrouwbaar landt zonder
    // PATH-gerommel. Eerlijk zijn is beter dan half werken.
    console.log('Windows: start CueGo voortaan met  node server.mjs  in deze map.');
    return;
  }

  // Profiel van de eigen shell; macOS is standaard zsh, veel Linux bash.
  const shell = process.env.SHELL || '';
  const profile = shell.includes('zsh') ? join(homedir(), '.zshrc') : join(homedir(), '.bashrc');
  const aliasLine = `alias cuego='node "${SERVER}"'`;

  const current = existsSync(profile) ? readFileSync(profile, 'utf8') : '';
  if (current.includes('alias cuego=')) {
    console.log(`Het commando "cuego" bestaat al (${profile}).`);
    return;
  }
  appendFileSync(profile, `\n# CueGo vanaf elke plek starten\n${aliasLine}\n`);
  console.log(`Commando toegevoegd aan ${profile}.`);
  console.log('Vanaf je volgende terminal start je CueGo met:  cuego');
}

installCommand();
console.log('');

// En meteen door: de server starten (stdio delen zodat de wachtwoordprompt werkt).
const child = spawn(process.execPath, [SERVER], { stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 0));
