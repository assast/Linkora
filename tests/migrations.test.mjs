import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

async function migrationFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'linkora-migration-runner-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, 'scripts'));
  for (const name of ['migrate.mjs', 'db-env.mjs', 'migration-files.mjs']) {
    const source = new URL(`../scripts/${name}`, import.meta.url);
    if (existsSync(source)) await cp(source, join(directory, 'scripts', name));
  }
  const migrations = join(directory, 'apps/api/prisma/migrations');
  await mkdir(join(migrations, '202611010001_icons'), { recursive: true });
  await writeFile(join(migrations, 'migration_lock.toml'), 'provider = "postgresql"\n');
  await writeFile(join(migrations, '202611010001_icons/migration.sql'), 'CREATE TABLE bookmark_icons(id UUID PRIMARY KEY);\n');
  await writeFile(join(directory, 'apps/api/prisma/schema.prisma'), 'datasource db { provider = "postgresql" url = env("DATABASE_URL") }\n');
  const cli = join(directory, 'apps/api/node_modules/prisma/build'); await mkdir(cli, { recursive: true });
  await writeFile(join(cli, 'index.js'), `
    const fs = require('node:fs'), path = require('node:path');
    const schema = process.argv[process.argv.indexOf('--schema') + 1];
    const migrations = path.join(path.dirname(schema), 'migrations');
    const entries = fs.readdirSync(migrations, { withFileTypes: true }).filter(entry => entry.isDirectory());
    for (const entry of entries) {
      if (!fs.existsSync(path.join(migrations, entry.name, 'migration.sql'))) {
        console.error('P3015: missing migration.sql: ' + entry.name); process.exit(15);
      }
    }
    console.log(JSON.stringify({ database: process.env.DATABASE_URL,
      sql: entries.map(entry => fs.readFileSync(path.join(migrations, entry.name, 'migration.sql'), 'utf8')),
      lock: fs.readFileSync(path.join(migrations, 'migration_lock.toml'), 'utf8') }));
  `);
  return { directory, migrations, run: (...args) => spawnSync(process.execPath, [join(directory, 'scripts/migrate.mjs'), ...args], {
    cwd: directory, encoding: 'utf8', env: { ...process.env, DATABASE_URL: 'postgresql://example.invalid/app', TEST_DATABASE_URL: 'postgresql://example.invalid/app_test' },
  }) };
}

test('迁移命令忽略遗留空目录，保留真实 SQL 和锁文件，且不删除源目录', async t => {
  const fixture = await migrationFixture(t);
  const empty = join(fixture.migrations, '202611010002_unfinished'); await mkdir(empty);
  const result = fixture.run();
  assert.equal(result.status, 0, result.stderr);
  const data = JSON.parse(result.stdout.split('\n').find(line => line.startsWith('{')));
  assert.deepEqual(data.sql, ['CREATE TABLE bookmark_icons(id UUID PRIMARY KEY);\n']);
  assert.equal(data.lock, 'provider = "postgresql"\n');
  assert.ok(existsSync(empty));
  assert.equal(await readFile(join(fixture.migrations, '202611010001_icons/migration.sql'), 'utf8'), data.sql[0]);
});

test('迁移命令保持测试数据库隔离选择', async t => {
  const fixture = await migrationFixture(t);
  const result = fixture.run('--test');
  assert.equal(result.status, 0, result.stderr);
  const data = JSON.parse(result.stdout.split('\n').find(line => line.startsWith('{')));
  assert.equal(data.database, 'postgresql://example.invalid/app_test');
});

test('非空目录缺少 migration.sql 仍然报错，不能掩盖丢失的迁移', async t => {
  const fixture = await migrationFixture(t);
  const invalid = join(fixture.migrations, '202611010002_broken'); await mkdir(invalid);
  await writeFile(join(invalid, 'README.md'), 'missing SQL');
  const result = fixture.run();
  assert.notEqual(result.status, 0); assert.match(result.stderr, /202611010002_broken/);
});
