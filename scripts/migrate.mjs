import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { testDatabaseUrl } from './db-env.mjs';

if (process.argv.includes('--test')) process.env.DATABASE_URL = testDatabaseUrl();
const root = fileURLToPath(new URL('../', import.meta.url));
const result = spawnSync(process.execPath, ['apps/api/node_modules/prisma/build/index.js', 'migrate', 'deploy', '--schema', 'apps/api/prisma/schema.prisma'], { cwd: root, env: process.env, stdio: 'inherit' });
process.exit(result.status ?? 1);
