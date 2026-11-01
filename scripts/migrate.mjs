import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { testDatabaseUrl } from './db-env.mjs';
import { prepareMigrationSchema } from './migration-files.mjs';

if (process.argv.includes('--test')) process.env.DATABASE_URL = testDatabaseUrl();
const root = fileURLToPath(new URL('../', import.meta.url));
const prepared = await prepareMigrationSchema(fileURLToPath(new URL('../apps/api/prisma/schema.prisma', import.meta.url)));
if (prepared.ignored.length) console.log(`忽略空迁移目录：${prepared.ignored.join(', ')}`);
let result;
try {
  result = spawnSync(process.execPath, ['apps/api/node_modules/prisma/build/index.js', 'migrate', 'deploy', '--schema', prepared.schemaPath], { cwd: root, env: process.env, stdio: 'inherit' });
} finally { await prepared.cleanup(); }
process.exit(result.status ?? 1);
