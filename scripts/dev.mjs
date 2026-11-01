import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const watching = !process.argv.includes('--no-watch');
const webPort = process.env.WEB_PORT || '5173';
const build = spawnSync(process.execPath, [join(root, 'apps/api/node_modules/typescript/bin/tsc'), '-p', join(root, 'apps/api/tsconfig.json')], { stdio: 'inherit' });
if (build.status !== 0) process.exit(build.status || 1);
if (!watching) {
  const frontend = spawnSync(process.execPath, [join(root, 'apps/web/node_modules/vite/bin/vite.js'), 'build'], { cwd: join(root, 'apps/web'), env: { ...process.env, NODE_ENV: 'production' }, stdio: 'inherit' });
  if (frontend.status !== 0) process.exit(frontend.status || 1);
}
const children = [
  ...(watching ? [spawn(process.execPath, [join(root, 'apps/api/node_modules/typescript/bin/tsc'), '-p', join(root, 'apps/api/tsconfig.json'), '--watch', '--preserveWatchOutput', '--watchFile', 'useFsEventsOnParentDirectory'], { cwd: root, env: process.env, stdio: 'inherit' })] : []),
  spawn(process.execPath, [...(watching ? ['--watch-path', join(root, 'apps/api/dist')] : []), join(root, 'apps/api/dist/main.js')], { cwd: root, env: process.env, stdio: 'inherit' }),
  spawn(process.execPath, [join(root, 'apps/web/node_modules/vite/bin/vite.js'), ...(watching ? [] : ['preview']), '--host', '127.0.0.1', '--port', webPort, '--strictPort'], { cwd: join(root, 'apps/web'), env: process.env, stdio: 'inherit' }),
];
let stopping = false;
function stop(code = 0) {
  if (stopping) return; stopping = true;
  for (const child of children) child.kill('SIGTERM');
  process.exitCode = code;
}
process.on('SIGINT', () => stop()); process.on('SIGTERM', () => stop());
for (const child of children) child.on('exit', code => stop(code || 0));
