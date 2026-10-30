import 'reflect-metadata';
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import type { Request, Response } from 'express';
import { createApplication } from '../src/app';
import { Database } from '../src/database';
import { AppConfig } from '../src/config';
import { AuthService } from '../src/auth';
import { initializeOwner } from '../src/owner-init';
import { seedFixtures, TEST_EMAIL, TEST_PASSWORD } from './fixtures';

assert.equal(process.env.NODE_ENV, 'test');
assert.ok(new URL(process.env.DATABASE_URL || '').pathname.endsWith('_test'));
process.env.SITE_URL = 'http://127.0.0.1:5173';
process.env.LOGIN_LIMIT = '1000';
const origin = process.env.SITE_URL;
const prefix = '/api/v1';
type Login = { cookie: string; csrf: string };

describe('真实 PostgreSQL API 业务边界', () => {
  let app: INestApplication;
  let db: Database;
  let fixture: Awaited<ReturnType<typeof seedFixtures>>;
  const api = () => request(app.getHttpServer());
  const ownerId = () => fixture.ownerId;
  const id = (name: string) => fixture.ids[name];
  const authorized = (call: request.Test, auth: Login) => call.set('Cookie', auth.cookie).set('Origin', origin).set('X-CSRF-Token', auth.csrf);
  const login = async (): Promise<Login> => {
    const result = await api().post(prefix + '/auth/login').set('Origin', origin).send({ email: TEST_EMAIL, password: TEST_PASSWORD }).expect(201);
    return { cookie: (result.headers['set-cookie'] as unknown as string[])[0].split(';')[0], csrf: result.body.csrfToken };
  };
  const batch = async (auth: Login, operation: string, ids: string[], payload: object = {}, extra: object = {}) => {
    const body = { operation, bookmarkIds: ids, payload };
    const preview = await authorized(api().post(prefix + '/bookmarks/batch/preview'), auth).send(body).expect(201);
    return { expect: (status: number) => authorized(api().post(prefix + (operation === 'EXPORT' ? '/bookmarks/export' : '/bookmarks/batch')), auth)
      .send({ ...body, expectedRevision: preview.body.revision, ...extra }).expect(status) };
  };

  before(async () => { db = new Database(); await db.$connect(); app = await createApplication(false); await app.init(); });
  beforeEach(async () => { fixture = await seedFixtures(db); });
  after(async () => { await app?.close(); await db?.$disconnect(); });

  test('初始化不覆盖现有所有者，并由数据库保证唯一账号', async () => {
    await assert.rejects(initializeOwner(db, 'other@example.test', TEST_PASSWORD), /已存在/);
    await assert.rejects(db.user.create({ data: { email: 'other@example.test', passwordHash: 'unused', singleton: false } }));
    assert.equal(await db.user.count(), 1);
    assert.equal(await db.bookmark.count(), 6);
    await assert.rejects(db.bookmark.create({ data: { ownerId: ownerId(), categoryId: randomUUID(), title: '无效引用', url: 'https://invalid.test/' } }));
  });

  test('登录返回 HttpOnly 会话，数据库只保存令牌哈希', async () => {
    const response = await api().post(prefix + '/auth/login').set('Origin', origin).send({ email: TEST_EMAIL, password: TEST_PASSWORD }).expect(201);
    const cookie = (response.headers['set-cookie'] as unknown as string[])[0];
    assert.match(cookie, /HttpOnly/); assert.match(cookie, /SameSite=Lax/);
    const raw = cookie.split(';')[0].split('=')[1];
    const session = await db.session.findFirstOrThrow();
    assert.notEqual(session.tokenHash, raw);
    assert.equal(response.body.owner.email, TEST_EMAIL);
    await api().get(prefix + '/auth/me').set('Cookie', cookie).expect(200).expect(res => assert.equal(res.body.authenticated, true));
  });

  test('错误凭据、来源和缺少 CSRF 均被拒绝', async () => {
    for (const email of [TEST_EMAIL, 'missing@example.test']) {
      await api().post(prefix + '/auth/login').set('Origin', origin).send({ email, password: 'incorrect-password' }).expect(401);
    }
    await api().post(prefix + '/auth/login').set('Origin', 'https://untrusted.test').send({ email: TEST_EMAIL, password: TEST_PASSWORD }).expect(403);
    const auth = await login();
    await api().post(prefix + '/categories').set('Cookie', auth.cookie).set('Origin', origin).send({ name: '拒绝创建' }).expect(403);
    assert.equal(await db.category.count(), 8);
  });

  test('访客不能写入、上报、保存偏好或导出', async () => {
    const endpoints = ['/bookmarks', '/categories', '/bookmarks/batch', '/bookmarks/export', `/bookmarks/${id('github')}/visits`];
    for (const path of endpoints) await api().post(prefix + path).set('Origin', origin).send({}).expect(401);
    await api().patch(prefix + '/preferences').send({ theme: 'dark' }).expect(401);
    assert.equal(await db.bookmark.count(), 6);
    assert.equal((await db.user.findFirstOrThrow()).contentRevision, 0);
  });

  test('退出和过期会话立即失去授权', async () => {
    const auth = await login();
    await authorized(api().post(prefix + '/auth/logout'), auth).expect(201);
    await api().get(prefix + '/auth/me').set('Cookie', auth.cookie).expect(200).expect(res => assert.equal(res.body.authenticated, false));
    await api().get(prefix + `/bookmarks/${id('secret')}`).set('Cookie', auth.cookie).expect(404);
    const expired = await login();
    await db.session.updateMany({ data: { expiresAt: new Date(0) } });
    await authorized(api().post(prefix + '/categories'), expired).send({ name: '不能创建' }).expect(401);
  });

  test('配置限流阈值后返回 429', async () => {
    const config = new AppConfig(); Object.assign(config, { loginLimit: 2 });
    const service = new AuthService(db, config);
    const req = { ip: 'rate-test', get: () => origin } as unknown as Request;
    for (let i = 0; i < 2; i++) await assert.rejects(service.login({ email: TEST_EMAIL, password: 'incorrect-password' }, req, {} as Response), error => (error as { getStatus(): number }).getStatus() === 401);
    await assert.rejects(service.login({ email: TEST_EMAIL, password: 'incorrect-password' }, req, {} as Response), error => (error as { getStatus(): number }).getStatus() === 429);
  });

  test('访客列表、树、标签和首页均过滤私密内容与数量', async () => {
    for (const path of ['/bookmarks', '/categories/tree', '/tags', '/home']) {
      const response = await api().get(prefix + path).expect(200);
      const text = JSON.stringify(response.body);
      for (const secret of ['显式私密网址', '继承私密笔记', '个人收藏', '私人资料', '独有私密标签', 'secret-marker', 'inherited-marker']) assert.ok(!text.includes(secret), path + ':' + secret);
      assert.match(response.headers['cache-control'], /no-store/);
    }
    const response = await api().get(prefix + '/bookmarks').expect(200);
    assert.equal(response.body.total, 4);
    const home = await api().get(prefix + '/home').expect(200);
    assert.equal(home.body.counts.bookmarks, 4); assert.ok(!('private' in home.body.counts));
    const auth = await login();
    const owned = await authorized(api().get(prefix + '/bookmarks'), auth).expect(200);
    assert.equal(owned.body.total, 6);
  });

  test('私密与未知 ID 均 404，祖先私密与自身标志分离', async () => {
    await api().get(prefix + `/bookmarks/${id('secret')}`).expect(404);
    await api().get(prefix + `/bookmarks/${randomUUID()}`).expect(404);
    await api().get(prefix + '/bookmarks').query({ categoryId: id('private') }).expect(404);
    const auth = await login();
    const response = await authorized(api().get(prefix + `/bookmarks/${id('inherited')}`), auth).expect(200);
    assert.equal(response.body.isPrivate, false); assert.equal(response.body.effectivePrivate, true);
  });

  test('四级分类筛选含后代、根级重名被拒绝', async () => {
    const auth = await login();
    await authorized(api().post(prefix + '/categories'), auth).send({ name: '开发工具' }).expect(409);
    const all = await api().get(prefix + '/bookmarks').query({ categoryId: id('root') }).expect(200);
    assert.ok(all.body.items.some((book: { id: string }) => book.id === id('deep')));
    const direct = await api().get(prefix + '/bookmarks').query({ categoryId: id('root'), includeDescendants: false }).expect(200);
    assert.equal(direct.body.total, 1);
    await assert.rejects(db.category.create({ data: { ownerId: ownerId(), name: '开发工具' } }));
  });

  test('禁止分类环，并发互移也不能产生环', async () => {
    const auth = await login();
    await authorized(api().patch(prefix + `/categories/${id('root')}`), auth).send({ parentId: id('nest') }).expect(400);
    assert.equal((await db.user.findFirstOrThrow()).contentRevision, 0);
    const second = await authorized(api().post(prefix + '/categories'), auth).send({ name: '另一空分类' }).expect(201);
    const results = await Promise.all([
      authorized(api().patch(prefix + `/categories/${id('empty')}`), auth).send({ parentId: second.body.id }),
      authorized(api().patch(prefix + `/categories/${second.body.id}`), auth).send({ parentId: id('empty') }),
    ]);
    assert.deepEqual(results.map(value => value.status).sort(), [200, 400]);
    await api().get(prefix + '/categories/tree').expect(200);
  });

  test('只删除空分类，不级联删除内容', async () => {
    const auth = await login();
    await authorized(api().delete(prefix + `/categories/${id('root')}`), auth).expect(409);
    await authorized(api().delete(prefix + `/categories/${id('empty')}`), auth).expect(200);
    assert.equal(await db.bookmark.count(), 6);
  });

  test('书签校验内网 URL、未知字段、空标题和非法协议', async () => {
    const auth = await login();
    const created = await authorized(api().post(prefix + '/bookmarks'), auth).send({ title: '  本地文档  ', url: 'http://localhost:8080/', tags: ['React', ' react ', '', '工具'] }).expect(201);
    assert.equal(created.body.title, '本地文档'); assert.equal(created.body.categoryId, null);
    assert.equal(created.body.tags.length, 2);
    for (const data of [{ title: '', url: 'https://valid.test/' }, { title: 'x', url: 'javascript:alert(1)' }, { title: 'x'.repeat(201), url: 'https://valid.test/' }, { title: 'x', url: 'https://valid.test/', ownerId: randomUUID() }]) {
      await authorized(api().post(prefix + '/bookmarks'), auth).send(data).expect(400);
    }
    await authorized(api().patch(prefix + `/bookmarks/${id('github')}`), auth).send({ title: null }).expect(400);
    await authorized(api().post(prefix + '/bookmarks'), auth).send({ title: 'x', url: 'https://valid.test/', categoryId: randomUUID() }).expect(404);
  });

  test('普通资料修改不误写继承私密标志', async () => {
    const auth = await login();
    const response = await authorized(api().patch(prefix + `/bookmarks/${id('inherited')}`), auth).send({ title: '更新标题', notes: '我的备注' }).expect(200);
    assert.equal(response.body.isPrivate, false); assert.equal(response.body.effectivePrivate, true);
  });

  test('中文备注、分类路径、字面百分号和标签交集可检索', async () => {
    assert.equal((await api().get(prefix + '/bookmarks').query({ keyword: '中文备注' })).body.total, 1);
    assert.equal((await api().get(prefix + '/bookmarks').query({ keyword: '%' })).body.total, 1);
    const deep = await api().get(prefix + '/bookmarks').query({ keyword: '后端开发', tagIds: [id('backendTag'), id('typescriptTag')] }).expect(200);
    assert.equal(deep.body.total, 1); assert.equal(deep.body.items[0].id, id('deep'));
    assert.equal((await api().get(prefix + '/bookmarks').query({ privacy: 'private' })).body.total, 0);
  });

  test('稳定分页同值记录不重不漏，非法页大小拒绝', async () => {
    await db.bookmark.createMany({ data: Array.from({ length: 101 }, (_, index) => ({ ownerId: ownerId(), title: `同值-${index}`, url: 'https://paging.test/', createdAt: new Date('2026-01-01') })) });
    const auth = await login();
    const ids: string[] = [];
    for (let page = 1; page <= 3; page++) {
      const response = await authorized(api().get(prefix + '/bookmarks').query({ page, pageSize: 50 }), auth).expect(200);
      assert.equal(response.body.total, 107); ids.push(...response.body.items.map((book: { id: string }) => book.id));
    }
    assert.equal(ids.length, 107); assert.equal(new Set(ids).size, 107);
    await api().get(prefix + '/bookmarks').query({ pageSize: 101 }).expect(400);
    await api().get(prefix + '/bookmarks').query({ page: -1 }).expect(400);
  });

  test('私密分类移出祖先先预览、确认，显式标志保留', async () => {
    const auth = await login();
    const body = { parentId: id('root') };
    const preview = await authorized(api().post(prefix + `/categories/${id('privateChild')}/preview`), auth).send(body).expect(201);
    assert.equal(preview.body.becomingPublicBookmarks, 1);
    assert.equal((await db.user.findFirstOrThrow()).contentRevision, 0);
    await authorized(api().patch(prefix + `/categories/${id('privateChild')}`), auth).send(body).expect(409);
    await authorized(api().patch(prefix + `/categories/${id('privateChild')}`), auth).send({ ...body, expectedRevision: preview.body.revision, confirmedPublic: true }).expect(200);
    await api().get(prefix + `/bookmarks/${id('inherited')}`).expect(200);
    assert.equal((await db.bookmark.findUniqueOrThrow({ where: { id: id('inherited') } })).isPrivate, false);
    await api().get(prefix + `/bookmarks/${id('secret')}`).expect(404);
  });

  test('内容变化使旧预览失效，安全写入也不静默重提', async () => {
    const auth = await login();
    const body = { operation: 'SET_FAVORITE', bookmarkIds: [id('deep')], payload: { value: true } };
    const preview = await authorized(api().post(prefix + '/bookmarks/batch/preview'), auth).send(body).expect(201);
    await authorized(api().post(prefix + '/categories'), auth).send({ name: '让预览过期' }).expect(201);
    await authorized(api().post(prefix + '/bookmarks/batch'), auth).send({ ...body, expectedRevision: preview.body.revision }).expect(409);
    assert.equal((await db.bookmark.findUniqueOrThrow({ where: { id: id('deep') } })).isFavorite, false);
  });

  test('单项书签移入与移出私密分类须正确预览', async () => {
    const auth = await login();
    const incoming = await authorized(api().patch(prefix + `/bookmarks/${id('github')}`), auth).send({ categoryId: id('private') }).expect(200);
    assert.equal(incoming.body.isPrivate, false); assert.equal(incoming.body.effectivePrivate, true);
    const payload = { categoryId: null };
    const preview = await authorized(api().post(prefix + `/bookmarks/${id('github')}/preview`), auth).send(payload).expect(201);
    assert.equal(preview.body.becomingPublicBookmarks, 1);
    await authorized(api().patch(prefix + `/bookmarks/${id('github')}`), auth).send(payload).expect(409);
    await authorized(api().patch(prefix + `/bookmarks/${id('github')}`), auth).send({ ...payload, expectedRevision: preview.body.revision, confirmedPublic: true }).expect(200);
    await api().get(prefix + `/bookmarks/${id('github')}`).expect(200);
  });

  test('访问计数原子递增，偏好与访问不推进内容修订', async () => {
    const auth = await login();
    await Promise.all([1, 2].map(() => authorized(api().post(prefix + `/bookmarks/${id('github')}/visits`), auth).expect(201)));
    await authorized(api().patch(prefix + '/preferences'), auth).send({ theme: 'dark', defaultEngine: 'github', defaultView: 'grid' }).expect(200);
    assert.equal((await db.bookmark.findUniqueOrThrow({ where: { id: id('github') } })).visitCount, 14);
    assert.equal((await db.user.findFirstOrThrow()).contentRevision, 0);
    assert.equal((await authorized(api().get(prefix + '/preferences'), auth)).body.theme, 'dark');
  });

  test('批量 ID 校验先于写入，去重且限制当前请求范围', async () => {
    const auth = await login();
    await authorized(api().post(prefix + '/bookmarks/batch/preview'), auth).send({ operation: 'DELETE', bookmarkIds: [id('github'), randomUUID()] }).expect(404);
    await authorized(api().post(prefix + '/bookmarks/batch/preview'), auth).send({ operation: 'DELETE', bookmarkIds: [] }).expect(400);
    await authorized(api().post(prefix + '/bookmarks/batch/preview'), auth).send({ operation: 'DELETE', bookmarkIds: Array.from({ length: 101 }, randomUUID) }).expect(400);
    const preview = await authorized(api().post(prefix + '/bookmarks/batch/preview'), auth).send({ operation: 'DELETE', bookmarkIds: [id('github'), id('github')] }).expect(201);
    assert.equal(preview.body.affectedBookmarks, 1); assert.equal(await db.bookmark.count(), 6);
  });

  test('批量标签添加、移除、替换与二十条范围', async () => {
    const auth = await login();
    const selected = Array.from({ length: 20 }, () => randomUUID());
    await db.bookmark.createMany({ data: selected.map((bookId, index) => ({ id: bookId, ownerId: ownerId(), title: '批量-' + index, url: 'https://batch.test/' })) });
    await (await batch(auth, 'ADD_TAGS', selected, { tags: ['学习', ' 学习 '] })).expect(201);
    assert.equal(await db.bookmarkTag.count({ where: { bookmarkId: { in: selected } } }), 20);
    await (await batch(auth, 'REMOVE_TAGS', selected, { tags: ['学习'] })).expect(201);
    assert.equal(await db.bookmarkTag.count({ where: { bookmarkId: { in: selected } } }), 0);
    await (await batch(auth, 'REPLACE_TAGS', [id('github')], { tags: [] })).expect(201);
    assert.equal(await db.bookmarkTag.count({ where: { bookmarkId: id('github') } }), 0);
    assert.equal(await db.bookmarkTag.count({ where: { bookmarkId: id('deep') } }), 2);
  });

  test('批量星标可设置及取消，移动保留显式私密', async () => {
    const auth = await login();
    await (await batch(auth, 'SET_FAVORITE', [id('github'), id('deep')], { value: false })).expect(201);
    assert.equal(await db.bookmark.count({ where: { id: { in: [id('github'), id('deep')] }, isFavorite: true } }), 0);
    await (await batch(auth, 'SET_FAVORITE', [id('deep')], { value: true })).expect(201);
    await (await batch(auth, 'MOVE_CATEGORY', [id('github'), id('secret')], { categoryId: id('private') })).expect(201);
    assert.equal((await db.bookmark.findUniqueOrThrow({ where: { id: id('github') } })).isPrivate, false);
    assert.equal((await db.bookmark.findUniqueOrThrow({ where: { id: id('secret') } })).isPrivate, true);
    await api().get(prefix + `/bookmarks/${id('github')}`).expect(404);
  });

  test('取消显式私密不绕过祖先，移出私密需公开确认', async () => {
    const auth = await login();
    await (await batch(auth, 'SET_PRIVACY', [id('inherited')], { value: false })).expect(201);
    await api().get(prefix + `/bookmarks/${id('inherited')}`).expect(404);
    await (await batch(auth, 'MOVE_CATEGORY', [id('inherited')], { categoryId: null })).expect(409);
    await (await batch(auth, 'MOVE_CATEGORY', [id('inherited')], { categoryId: null }, { confirmedPublic: true })).expect(201);
    await api().get(prefix + `/bookmarks/${id('inherited')}`).expect(200);
  });

  test('批量删除确认范围，保留其他书签和分类', async () => {
    const auth = await login();
    const selected = [id('github'), id('secret')];
    await (await batch(auth, 'DELETE', selected)).expect(400);
    assert.equal(await db.bookmark.count(), 6);
    await (await batch(auth, 'DELETE', selected, {}, { confirmedDelete: true })).expect(201);
    assert.equal(await db.bookmark.count(), 4); assert.equal(await db.category.count(), 8);
  });

  test('数据库中途失败回滚标签、关联与内容修订', async () => {
    const auth = await login();
    await db.$executeRawUnsafe("CREATE FUNCTION linkora_test_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test rollback'; END $$");
    await db.$executeRawUnsafe(`CREATE TRIGGER linkora_test_failure BEFORE INSERT ON bookmark_tags FOR EACH ROW WHEN (NEW.bookmark_id = '${id('react')}'::uuid) EXECUTE FUNCTION linkora_test_fail()`);
    try {
      await (await batch(auth, 'ADD_TAGS', [id('github'), id('react')], { tags: ['应回滚的标签'] })).expect(500);
      assert.equal(await db.tag.count({ where: { name: '应回滚的标签' } }), 0);
      assert.equal(await db.bookmarkTag.count({ where: { bookmarkId: id('github') } }), 1);
      assert.equal((await db.user.findFirstOrThrow()).contentRevision, 0);
    } finally {
      await db.$executeRawUnsafe('DROP TRIGGER linkora_test_failure ON bookmark_tags');
      await db.$executeRawUnsafe('DROP FUNCTION linkora_test_fail()');
    }
  });

  test('私密导出需要确认并保留分类祖先和显式标志', async () => {
    const auth = await login();
    await (await batch(auth, 'EXPORT', [id('inherited')])).expect(409);
    const response = await (await batch(auth, 'EXPORT', [id('inherited')], {}, { confirmedPrivateExport: true })).expect(201);
    assert.equal(response.body.formatVersion, 1); assert.equal(response.body.bookmarks.length, 1);
    assert.equal(response.body.bookmarks[0].isPrivate, false); assert.equal(response.body.categories.length, 2);
    assert.ok(!JSON.stringify(response.body).includes('passwordHash')); assert.ok(!JSON.stringify(response.body).includes(id('github')));
    assert.equal((await db.user.findFirstOrThrow()).contentRevision, 0);
  });
});
