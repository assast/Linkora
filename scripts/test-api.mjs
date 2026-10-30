import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { testDatabaseUrl } from './db-env.mjs';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = testDatabaseUrl();
const directory = fileURLToPath(new URL('../apps/api/dist-test/test/', import.meta.url));
const files = readdirSync(directory).filter(name => name.endsWith('.test.js')).map(name => directory + name);
if (!files.length) throw new Error('没有可执行的 API 测试');
const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...process.argv.slice(2), ...files], { env: process.env, stdio: 'inherit' });
process.exit(result.status ?? 1);
