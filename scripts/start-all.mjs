// Dev convenience: launch the API server + all three discovery daemons together,
// each auto-restarting if it exits. Ctrl+C stops everything.
// (For the UI, run `npm run dev` in a second terminal.)
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const SERVICES = [
  { name: 'api    ', file: 'server/server.mjs' },
  { name: 'old    ', file: 'discovery/old-prebond.mjs' },
  { name: 'new    ', file: 'discovery/new-pairs.mjs' },
  { name: 'bonded ', file: 'discovery/bonded.mjs' },
];

let shuttingDown = false;
const children = [];

function launch(svc) {
  const child = spawn('node', [svc.file], { cwd: root, env: process.env });
  child.stdout.on('data', (d) => process.stdout.write(`[${svc.name}] ${d}`));
  child.stderr.on('data', (d) => process.stderr.write(`[${svc.name}] ${d}`));
  child.on('exit', (code) => {
    if (shuttingDown) return;
    console.log(`[${svc.name}] exited (${code}) — restarting in 3s`);
    setTimeout(() => launch(svc), 3000);
  });
  return child;
}

for (const svc of SERVICES) children.push(launch(svc));

function shutdown() {
  shuttingDown = true;
  for (const c of children) { try { c.kill('SIGTERM'); } catch { /* noop */ } }
  setTimeout(() => process.exit(0), 500);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

console.log('Lily up: API + old/new/bonded daemons. Run `npm run dev` for the UI.');
