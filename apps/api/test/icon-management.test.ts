import 'reflect-metadata';
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { createApplication } from '../src/app';
import { Database } from '../src/database';
import { SiteIconService } from '../src/site-icons';
import { DashboardIcons } from '../src/dashboard-icons';
import { IconUploads } from '../src/icon-uploads';
import { BookmarkIcons } from '../src/bookmark-icons';
import { seedFixtures, TEST_EMAIL, TEST_PASSWORD } from './fixtures';
import { animatedPngFixture, FakeIconTransport, realIcon, untilIcon } from './icon-fixtures';

assert.equal(process.env.NODE_ENV, 'test');
assert.ok(new URL(process.env.DATABASE_URL || '').pathname.endsWith('_test'));
process.env.SITE_URL = 'http://127.0.0.1:5173';
process.env.LOGIN_LIMIT = '1000';
const origin = process.env.SITE_URL, prefix = '/api/v1';
interface Auth { cookie: string; csrf: string }
interface Config { source: string; version: string | null; dashboardId: string | null }
interface Job { id: string; state: string; total: number; processed: number; success: number; failed: number; skipped: number; totalOrigins: number; processedOrigins: number; results: { id: string; reason: string }[] }

describe('图标管理真实 PostgreSQL 集成', () => {
  let app: INestApplication, db: Database, root: string, png: Buffer, webp: Buffer, fixture: Awaited<ReturnType<typeof seedFixtures>>, auth: Auth;
  let fail = false, delay = 0, active = 0, peak = 0, barrier: (() => Promise<void>) | null = null;
  const transport = new FakeIconTransport(async url => {
    active++; peak = Math.max(peak, active);
    try {
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
      if (barrier && url.hostname === 'github.com' && url.pathname === '/') await barrier();
      if (fail || url.pathname === '/') return null;
      const library = url.hostname === 'cdn.jsdelivr.net';
      return { status: 200, body: library ? webp : png, headers: { 'content-type': library ? 'image/webp' : 'image/png' }, finalUrl: url.href };
    } finally { active--; }
  });
  const api = () => request(app.getHttpServer());
  const id = (key: string) => fixture.ids[key];
  const signed = (call: request.Test) => call.set('Cookie', auth.cookie).set('Origin', origin).set('X-CSRF-Token', auth.csrf);
  const config = async (key = 'github'): Promise<Config> => (await signed(api().get(`${prefix}/bookmarks/${id(key)}/icon-config`)).expect(200)).body;
  const upload = (key: string, version: string | null, bytes = png, type = 'image/png') => signed(api().post(`${prefix}/bookmarks/${id(key)}/icon-upload`))
    .field('expectedVersion', version || 'null').attach('file', bytes, { filename: '../../logo.png', contentType: type });
  const choose = (key: string, current: Config, source: 'auto' | 'dashboard') => signed(api().patch(`${prefix}/bookmarks/${id(key)}/icon-config`))
    .send({ source, expectedVersion: current.version, ...(source === 'dashboard' ? { dashboardId: 'github' } : {}) });
  const done = async (jobId: string) => {
    let current!: Job;
    await untilIcon(async () => { current = (await signed(api().get(`${prefix}/icon-refresh-jobs/${jobId}?pageSize=60`)).expect(200)).body; return current.state === 'completed'; }, 15_000);
    return current;
  };

  before(async () => {
    root = await mkdtemp(join(tmpdir(), 'linkora-icon-integration-'));
    process.env.ICON_CACHE_DIR = join(root, 'cache'); process.env.ICON_UPLOAD_DIR = join(root, 'uploads');
    png = await realIcon(); webp = await realIcon('webp');
    db = new Database(); await db.$connect(); app = await createApplication(false); await app.init();
    Object.assign(app.get(SiteIconService), { transport }); Object.assign(app.get(DashboardIcons), { transport });
  });
  beforeEach(async () => {
    fixture = await seedFixtures(db); fail = false; delay = 0; peak = 0; barrier = null; transport.calls.length = 0;
    const login = await api().post(prefix + '/auth/login').set('Origin', origin).send({ email: TEST_EMAIL, password: TEST_PASSWORD }).expect(201);
    auth = { cookie: login.headers['set-cookie'][0].split(';')[0], csrf: login.body.csrfToken };
  });
  after(async () => { await app?.close(); await db?.$disconnect(); await rm(root, { recursive: true, force: true }); });

  test('目录与配置只对所有者开放，写入必须有 CSRF，参数不能指定路径', async () => {
    for (const path of ['/icon-library', '/icon-library/github/preview', `/bookmarks/${id('github')}/icon-config`, '/icon-refresh-jobs/' + randomUUID()]) {
      await api().get(prefix + path).expect(401);
    }
    await api().patch(`${prefix}/bookmarks/${id('github')}/icon-config`).set('Cookie', auth.cookie).set('Origin', origin).send({ source: 'auto', expectedVersion: null }).expect(403);
    await signed(api().patch(`${prefix}/bookmarks/${id('github')}/icon-config`)).send({ source: 'auto', expectedVersion: null, url: 'http://localhost' }).expect(400);
    await signed(api().patch(`${prefix}/bookmarks/${id('github')}/icon-config`)).send({ source: 'dashboard', expectedVersion: null, dashboardId: '../secret' }).expect(400);
    await signed(api().get(prefix + '/icon-library?keyword=GITHUB')).expect(200).expect(result => assert.ok(result.body.items.some((item: { id: string }) => item.id === 'github')));
    assert.equal(transport.calls.length, 0);
  });

  test('旧书签默认自动，人工来源独立且替换后无隐藏配置', async () => {
    const old = await db.bookmark.findUniqueOrThrow({ where: { id: id('github') } });
    assert.equal((await config()).version, null);
    const selected = (await choose('github', await config(), 'dashboard').expect(200)).body;
    assert.equal(selected.source, 'dashboard');
    const saved = await db.bookmarkIcon.findUniqueOrThrow({ where: { bookmarkId: id('github') } });
    assert.match(saved.dashboardCommit!, /^[a-f0-9]{40}$/);
    const uploaded = (await upload('github', selected.version).expect(201)).body;
    assert.equal(uploaded.source, 'upload');
    assert.equal((await db.bookmarkIcon.findUniqueOrThrow({ where: { bookmarkId: id('github') } })).dashboardId, null);
    const manual = await db.bookmarkIcon.findUniqueOrThrow({ where: { bookmarkId: id('github') } });
    await choose('github', uploaded, 'auto').expect(200);
    await assert.rejects(readFile(join(root, 'uploads', id('github'), `${manual.uploadKey}.webp`)));
    assert.equal((await config('react')).version, null);
    assert.ok((await db.bookmark.findUniqueOrThrow({ where: { id: old.id } })).updatedAt > old.updatedAt);
    assert.equal((await db.user.findFirstOrThrow()).contentRevision, 3);
  });

  test('并发人工变更返回 409，不覆盖先提交者', async () => {
    const requests = await Promise.all([choose('github', await config(), 'auto'), choose('github', await config(), 'auto')]);
    assert.deepEqual(requests.map(item => item.status).sort(), [200, 409]);
    assert.equal((await db.user.findFirstOrThrow()).contentRevision, 1);
  });

  test('新服务实例读取持久配置，资源准备期间删除不会留下悬空文件', async () => {
    const saved = (await upload('github', null).expect(201)).body;
    const fresh = new BookmarkIcons(db, app.get(DashboardIcons), app.get(IconUploads));
    assert.equal((await fresh.config(fixture.ownerId, id('github'))).version, saved.version);
    const uploads = app.get(IconUploads), prepare = uploads.prepare;
    uploads.prepare = async (bookmarkId, file) => {
      const key = await prepare.call(uploads, bookmarkId, file);
      await db.bookmark.delete({ where: { id: bookmarkId } }); return key;
    };
    try { await upload('react', null).expect(404); } finally { uploads.prepare = prepare; }
    assert.equal(await db.bookmarkIcon.count({ where: { bookmarkId: id('react') } }), 0);
    assert.deepEqual(await readdir(join(root, 'uploads', id('react'))), []);
  });

  test('数据库提交失败清理新文件并保留旧版本', async () => {
    const saved = (await upload('github', null).expect(201)).body;
    const appDb = app.get(Database), write = appDb.write;
    appDb.write = async () => { throw new Error('injected-commit-failure'); };
    try { await upload('github', saved.version).expect(500); } finally { appDb.write = write; }
    assert.equal((await config()).version, saved.version);
    assert.equal((await readdir(join(root, 'uploads', id('github')))).length, 1);
  });

  test('人工编辑使旧预览失效，导出仍保持现有字段', async () => {
    const body = { operation: 'SET_FAVORITE', bookmarkIds: [id('github')], payload: { value: true } };
    const preview = await signed(api().post(prefix + '/bookmarks/batch/preview')).send(body).expect(201);
    await upload('github', null).expect(201);
    await signed(api().post(prefix + '/bookmarks/batch')).send({ ...body, expectedRevision: preview.body.revision }).expect(409);
    const exportBody = { operation: 'EXPORT', bookmarkIds: [id('github')] };
    const next = await signed(api().post(prefix + '/bookmarks/batch/preview')).send(exportBody).expect(201);
    const exported = await signed(api().post(prefix + '/bookmarks/export')).send({ ...exportBody, expectedRevision: next.body.revision }).expect(201);
    assert.equal(exported.body.formatVersion, 1); assert.equal(exported.body.bookmarks.length, 1);
    assert.equal(exported.body.bookmarks[0].icon, undefined); assert.equal(exported.body.bookmarks[0].source, undefined);
  });

  test('上传图标可用于内网站点，实际图片只经授权接口返回', async () => {
    await upload('unclassified', null).expect(201);
    await api().get(`${prefix}/bookmarks/${id('unclassified')}/icon`).expect(200).expect('Content-Type', /image\/webp/).expect('Cache-Control', 'no-store');
    assert.equal(transport.calls.length, 0);
    await upload('inherited', null).expect(201);
    await api().get(`${prefix}/bookmarks/${id('inherited')}/icon`).expect(404);
    await signed(api().get(`${prefix}/bookmarks/${id('inherited')}/icon`)).expect(200);
  });

  test('损坏、动画、超限或冲突上传不改变当前图标且不遗留临时文件', async () => {
    const saved = (await upload('github', null).expect(201)).body;
    await upload('github', saved.version, Buffer.from('<svg/>')).expect(400);
    await upload('github', saved.version, animatedPngFixture()).expect(400);
    await upload('github', saved.version, Buffer.alloc(2 * 1024 * 1024 + 1)).expect(413);
    await upload('github', null).expect(409);
    assert.equal((await config()).version, saved.version);
    assert.equal((await readdir(join(root, 'uploads', id('github')))).length, 1);
  });

  test('下载或落盘失败保留旧配置，配置跨服务实例可读', async () => {
    const saved = (await upload('github', null).expect(201)).body;
    const library = app.get(DashboardIcons), previous = library.index;
    Object.assign(library, { index: { ...previous, commit: 'f'.repeat(40) } }); fail = true;
    try { await choose('github', saved, 'dashboard').expect(503); } finally { Object.assign(library, { index: previous }); fail = false; }
    const uploads = app.get(IconUploads), directory = uploads.directory, blocked = join(root, 'blocked');
    await writeFile(blocked, 'blocked'); Object.assign(uploads, { directory: blocked });
    try { await upload('github', saved.version).expect(500); } finally { Object.assign(uploads, { directory }); }
    assert.equal((await config()).version, saved.version);
    const stored = await db.bookmarkIcon.findUniqueOrThrow({ where: { bookmarkId: id('github') } });
    assert.ok(await new IconUploads(directory).read(stored.bookmarkId, stored.uploadKey));
  });

  test('人工文件缺失自动降级但保留来源，修改 URL 不清除人工选择', async () => {
    const saved = (await upload('github', null).expect(201)).body;
    const stored = await db.bookmarkIcon.findUniqueOrThrow({ where: { bookmarkId: id('github') } });
    await rm(join(root, 'uploads', id('github'), `${stored.uploadKey}.webp`));
    await api().get(`${prefix}/bookmarks/${id('github')}/icon`).expect(200).expect('Content-Type', /image\/png/);
    await db.bookmark.update({ where: { id: id('github') }, data: { url: 'https://new.example.com/path' } });
    assert.equal((await config()).version, saved.version);
  });

  test('图片读取期间来源变化不能返回旧图', async () => {
    let release!: () => void, reached = false;
    barrier = () => { reached = true; return new Promise<void>(resolve => { release = resolve; }); };
    await rm(join(root, 'cache'), { recursive: true, force: true });
    const pending = api().get(`${prefix}/bookmarks/${id('github')}/icon`).then(result => result);
    await untilIcon(() => reached);
    await choose('github', await config(), 'auto').expect(200); release();
    assert.equal((await pending).status, 204);
  });

  test('关闭预览请求会中止实际下载并释放共享任务', async () => {
    const library = app.get(DashboardIcons);
    let reached = false, cancelled = false;
    const slow = new FakeIconTransport((_url, _limit, signal) => new Promise(resolve => {
      reached = true; signal.addEventListener('abort', () => { cancelled = true; resolve(null); }, { once: true });
    }));
    await rm(join(root, 'cache', 'dashboard'), { recursive: true, force: true });
    Object.assign(library, { transport: slow });
    const pending = signed(api().get(prefix + '/icon-library/github/preview'));
    try {
      pending.end(() => undefined); await untilIcon(() => reached); pending.abort();
      await untilIcon(() => cancelled);
    } finally { Object.assign(library, { transport }); }
  });

  test('单条及批量删除级联配置，并在提交后清理上传文件', async () => {
    await upload('github', null).expect(201); await upload('react', null).expect(201);
    await signed(api().delete(`${prefix}/bookmarks/${id('github')}`)).expect(200);
    assert.equal(await db.bookmarkIcon.count({ where: { bookmarkId: id('github') } }), 0);
    assert.deepEqual(await readdir(join(root, 'uploads', id('github'))), []);
    const body = { operation: 'DELETE', bookmarkIds: [id('react')] };
    const preview = await signed(api().post(prefix + '/bookmarks/batch/preview')).send(body).expect(201);
    await signed(api().post(prefix + '/bookmarks/batch')).send({ ...body, expectedRevision: preview.body.revision, confirmedDelete: true }).expect(201);
    assert.deepEqual(await readdir(join(root, 'uploads', id('react'))), []);
  });

  test('刷新有明确范围并按 origin 去重，人工来源跳过且不推进内容修订', async () => {
    const extra = await db.bookmark.create({ data: { ownerId: fixture.ownerId, title: '另一 GitHub 路径', url: 'https://github.com/other' } });
    await upload('react', null).expect(201);
    const before = await db.user.findFirstOrThrow();
    const body = { scope: 'selected', bookmarkIds: [id('github'), extra.id, id('react'), id('github')] };
    const created = await signed(api().post(prefix + '/icon-refresh-jobs')).send(body).expect(202);
    const result = await done(created.body.id);
    assert.equal(result.total, 3); assert.equal(result.success, 2); assert.equal(result.skipped, 1); assert.equal(result.totalOrigins, 1);
    assert.equal(transport.calls.filter(call => call.url === 'https://github.com/favicon.ico').length, 1);
    assert.equal((await db.user.findFirstOrThrow()).contentRevision, before.contentRevision);
    await signed(api().post(prefix + '/icon-refresh-jobs')).send({ scope: 'all', bookmarkIds: [id('github')] }).expect(400);
    await signed(api().post(prefix + '/icon-refresh-jobs')).send({ scope: 'selected', bookmarkIds: [randomUUID()] }).expect(404);
  });

  test('全库超过 64 个站点逐步处理、全局并发不超过四个且支持分页结果', async () => {
    await db.bookmark.createMany({ data: Array.from({ length: 80 }, (_, index) => ({ ownerId: fixture.ownerId, title: `批量 ${index}`, url: `https://batch-${index}.example.com/` })) });
    delay = 2;
    const response = await signed(api().post(prefix + '/icon-refresh-jobs')).send({ scope: 'all' }).expect(202);
    const result = await done(response.body.id);
    assert.equal(result.total, 86); assert.equal(result.processed, 86); assert.equal(result.success + result.failed + result.skipped, 86);
    assert.ok(peak <= 4); assert.equal(result.processedOrigins, result.totalOrigins);
    assert.equal(result.results.length, 60);
    const page = await signed(api().get(`${prefix}/icon-refresh-jobs/${result.id}?page=2&pageSize=60`)).expect(200);
    assert.equal(page.body.results.length, 26);
  });

  test('活跃任务复用，刷新期间人工选择不被覆盖，重启/过期任务可重发', async () => {
    let release!: () => void, reached = false;
    barrier = () => { reached = true; return new Promise<void>(resolve => { release = resolve; }); };
    const created = await signed(api().post(prefix + '/icon-refresh-jobs')).send({ scope: 'selected', bookmarkIds: [id('github')] }).expect(202);
    await untilIcon(() => reached);
    const repeated = await signed(api().post(prefix + '/icon-refresh-jobs')).send({ scope: 'all' }).expect(409);
    assert.equal(repeated.body.jobId, created.body.id);
    await upload('github', null).expect(201); release();
    const result = await done(created.body.id); assert.equal(result.skipped, 1); assert.equal((await config()).source, 'upload');
    await signed(api().get(prefix + '/icon-refresh-jobs/' + randomUUID())).expect(404);
    const now = Date.now, future = now() + 31 * 60_000; Date.now = () => future;
    try { await signed(api().get(prefix + '/icon-refresh-jobs/' + result.id)).expect(404); } finally { Date.now = now; }
  });
});
