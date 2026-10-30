import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { testDatabaseUrl } from './db-env.mjs';

process.env.DATABASE_URL = testDatabaseUrl();
process.env.NODE_ENV = 'test';
const require = createRequire(import.meta.url);
const { Database } = require('../apps/api/dist/database.js');
const { Catalog } = require('../apps/api/dist/catalog.js');
const { BookmarkQueryDto } = require('../apps/api/dist/dto.js');
const db = new Database(), catalog = new Catalog();
const marker = 'bench-' + randomUUID().slice(0, 8);
const measurements = [];
const report = { database: 'NC PostgreSQL 16', node: process.version, temporaryRows: 5000, publicRows: 0, rolledBack: false, measurements };
const rollback = new Error('ROLLBACK_BENCHMARK');

try {
  await db.$connect();
  await db.$transaction(async tx => {
    const owner = await tx.user.findUniqueOrThrow({ where: { singleton: true } });
    const categoryIds = Array.from({ length: 5 }, () => randomUUID());
    await tx.category.createMany({ data: categoryIds.map((id, index) => ({ id, ownerId: owner.id, name: marker + '-' + index,
      parentId: index > 0 && index < 4 ? categoryIds[index - 1] : null, isPrivate: index === 4 })) });
    const books = Array.from({ length: 5000 }, (_, index) => ({ ownerId: owner.id, title: marker + '-' + index,
      url: 'https://benchmark.invalid/' + index, description: '中文压力样本', categoryId: categoryIds[index % 5 === 0 ? 4 : 3], isPrivate: index % 3 === 0 }));
    report.publicRows = books.filter(book => !book.isPrivate && book.categoryId !== categoryIds[4]).length;
    await tx.bookmark.createMany({ data: books });
    for (const includePrivate of [true, false]) {
      const scope = { ownerId: owner.id, includePrivate };
      const query = Object.assign(new BookmarkQueryDto(), { keyword: marker });
      const start = performance.now(); const page = await catalog.list(tx, scope, query);
      measurements.push({ query: includePrivate ? '所有者搜索与分页' : '访客授权搜索与分页', milliseconds: Math.round(performance.now() - start), returned: page.items.length, total: page.total });
      assert.equal(page.total, includePrivate ? 5000 : report.publicRows); assert.equal(page.items.length, 50);
      const firstIds = new Set(page.items.map(book => book.id));
      query.page = 2; const next = await catalog.list(tx, scope, query);
      assert.ok(next.items.every(book => !firstIds.has(book.id)));
      query.page = 1; query.categoryId = categoryIds[0];
      const categoryStart = performance.now(); const scoped = await catalog.list(tx, scope, query);
      measurements.push({ query: includePrivate ? '所有者四级分类后代筛选' : '访客四级分类后代筛选', milliseconds: Math.round(performance.now() - categoryStart), returned: scoped.items.length, total: scoped.total });
      assert.equal(scoped.total, includePrivate ? 4000 : report.publicRows);
      const tree = await catalog.categories(tx, scope);
      assert.equal(tree.find(category => category.id === categoryIds[0]).count, scoped.total);
    }
    throw rollback;
  }, { isolationLevel: 'RepeatableRead', timeout: 90000 });
} catch (error) {
  if (error !== rollback) throw error;
  report.rolledBack = true;
  assert.equal(await db.bookmark.count({ where: { title: { startsWith: marker } } }), 0);
} finally { await db.$disconnect(); }

const folder = fileURLToPath(new URL('../docs/verification/', import.meta.url));
mkdirSync(folder, { recursive: true });
writeFileSync(folder + 'benchmark.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
