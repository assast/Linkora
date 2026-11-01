import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { test } from 'node:test';

const root = new URL('../', import.meta.url);
const sqlRoot = new URL('docs/SQL/', root);
const migrationsRoot = new URL('apps/api/prisma/migrations/', root);

async function migrations() {
  const result = [];
  for (const entry of await readdir(migrationsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try { result.push({ name: entry.name, sql: await readFile(new URL(`${entry.name}/migration.sql`, migrationsRoot), 'utf8') }); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return result.sort((a, b) => a.name.localeCompare(b.name));
}

test('每次实际 DDL 迁移都保存完全一致的历史 SQL', async () => {
  const entries = await migrations();
  const files = (await readdir(new URL('变更记录/', sqlRoot))).filter(name => name.endsWith('.sql')).sort();
  assert.deepEqual(files, entries.map(entry => `${entry.name}.sql`));
  for (const entry of entries) assert.equal(await readFile(new URL(`变更记录/${entry.name}.sql`, sqlRoot), 'utf8'), entry.sql, entry.name);
});

test('全量 SQL 覆盖当前所有业务表和枚举，并标记最新迁移', async () => {
  const [schema, init, entries] = await Promise.all([
    readFile(new URL('apps/api/prisma/schema.prisma', root), 'utf8'), readFile(new URL('init.sql', sqlRoot), 'utf8'), migrations(),
  ]);
  const models = [...schema.matchAll(/model\s+\w+\s*\{([\s\S]*?)\n\}/g)];
  const expectedTables = models.map(match => /@@map\("([^"]+)"\)/.exec(match[1])[1]).sort();
  const actualTables = [...init.matchAll(/CREATE\s+TABLE\s+(?:"([^"]+)"|([a-z_][a-z0-9_]*))\s*\(/gi)].map(match => match[1] || match[2]).sort();
  assert.deepEqual(actualTables, expectedTables);
  const expectedEnums = [...schema.matchAll(/enum\s+(\w+)\s*\{/g)].map(match => match[1]).sort();
  const actualEnums = [...init.matchAll(/CREATE\s+TYPE\s+"?(\w+)"?\s+AS\s+ENUM/gi)].map(match => match[1]).sort();
  assert.deepEqual(actualEnums, expectedEnums);
  assert.ok(init.includes(`-- 最新迁移：${entries.at(-1).name}`));
});
