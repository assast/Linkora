import 'reflect-metadata';
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import type { INestApplication } from '@nestjs/common';
import type { Request } from 'express';
import request from 'supertest';
import { createApplication } from '../src/app';
import { AuthService } from '../src/auth';
import { AppConfig } from '../src/config';
import { Database } from '../src/database';
import { seedFixtures, TEST_EMAIL, TEST_PASSWORD } from './fixtures';

assert.equal(process.env.NODE_ENV, 'test');
assert.ok(new URL(process.env.DATABASE_URL || '').pathname.endsWith('_test'));
const domain = 'https://nav.icio.eu.org';
const internal = 'http://10.144.144.10:8080';
process.env.SITE_URL = domain;
process.env.ALLOWED_ORIGINS = internal;
const prefix = '/api/v1';
const isForbidden = (error: unknown) => (error as { getStatus(): number }).getStatus() === 403;

function withEnv(values: Record<string, string | undefined>, check: () => void) {
  const original = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    check();
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

test('未配置额外来源时仍只允许 SITE_URL', () => {
  withEnv({ ALLOWED_ORIGINS: undefined }, () => {
    const service = new AuthService({} as Database, new AppConfig());
    assert.doesNotThrow(() => service.origin({ get: () => domain } as unknown as Request));
    assert.throws(() => service.origin({ get: () => internal } as unknown as Request), isForbidden);
  });
});

test('显式配置的内网来源与主站域名都允许登录', () => {
  const service = new AuthService({} as Database, new AppConfig());
  for (const origin of [domain, internal]) {
    assert.doesNotThrow(() => service.origin({ get: () => origin } as unknown as Request));
  }
});

test('逗号分隔来源会去除空白并规范化主机和默认端口', () => {
  withEnv({ ALLOWED_ORIGINS: ` , ${internal}, https://EXTRA.example.test:443/, ,` }, () => {
    const service = new AuthService({} as Database, new AppConfig());
    for (const origin of [domain, internal, 'https://extra.example.test']) {
      assert.doesNotThrow(() => service.origin({ get: () => origin } as unknown as Request));
    }
  });
});

test('来源配置拒绝通配符、非 HTTP 协议、凭据和路径', () => {
  for (const value of ['*', 'https://*.example.test', 'null', 'ftp://files.test', 'https://user:password@example.test', 'https://example.test/path', 'https://example.test/?query=1', 'https://example.test/#hash']) {
    withEnv({ ALLOWED_ORIGINS: value }, () => assert.throws(() => new AppConfig()));
  }
});

test('生产环境额外 HTTP 来源需要显式允许，HTTPS 来源不需要', () => {
  withEnv({ NODE_ENV: 'production', ALLOW_INSECURE_HTTP: 'false' }, () => assert.throws(() => new AppConfig(), /HTTP/));
  withEnv({ NODE_ENV: 'production', ALLOW_INSECURE_HTTP: 'true' }, () => assert.doesNotThrow(() => new AppConfig()));
  withEnv({ NODE_ENV: 'production', ALLOW_INSECURE_HTTP: 'false', ALLOWED_ORIGINS: 'https://internal.example.test' }, () => assert.doesNotThrow(() => new AppConfig()));
});

describe('域名和内网 IP 会话', () => {
  let app: INestApplication;
  let db: Database;
  const api = () => request(app.getHttpServer());
  const login = (origin: string, sessionDays: number | null = 7) => api().post(prefix + '/auth/login')
    .set('Host', new URL(origin).host).set('Origin', origin)
    .send({ email: TEST_EMAIL, password: TEST_PASSWORD, sessionDays });
  const checkCookie = (response: request.Response, origin: string) => {
    const cookie = (response.headers['set-cookie'] as unknown as string[])[0];
    assert.match(cookie, /HttpOnly/); assert.match(cookie, /SameSite=Lax/); assert.match(cookie, /Path=\/api/);
    assert.equal(/; Secure(?:;|$)/.test(cookie), origin.startsWith('https:'));
    assert.doesNotMatch(cookie, /Domain=/);
    return cookie.split(';')[0];
  };

  before(async () => {
    db = new Database(); await db.$connect();
    app = await createApplication(false); await app.init();
  });
  beforeEach(async () => { await seedFixtures(db); });
  after(async () => { await app?.close(); await db?.$disconnect(); });

  for (const origin of [domain, internal]) {
    test(`${origin} 可以登录、读取身份、修改偏好和退出`, async () => {
      const response = await login(origin).expect(201);
      const cookie = checkCookie(response, origin);
      await api().get(prefix + '/auth/me').set('Host', new URL(origin).host).set('Cookie', cookie)
        .expect(200).expect(result => assert.equal(result.body.authenticated, true));
      await api().patch(prefix + '/preferences').set('Host', new URL(origin).host).set('Origin', origin)
        .set('Cookie', cookie).set('X-CSRF-Token', response.body.csrfToken).send({ theme: 'dark' })
        .expect(200).expect(result => assert.equal(result.body.theme, 'dark'));
      const logout = await api().post(prefix + '/auth/logout').set('Host', new URL(origin).host).set('Origin', origin)
        .set('Cookie', cookie).set('X-CSRF-Token', response.body.csrfToken).expect(201);
      checkCookie(logout, origin);
      await api().get(prefix + '/auth/me').set('Cookie', cookie)
        .expect(200).expect(result => assert.equal(result.body.authenticated, false));
    });

    test(`${origin} 永久会话在没有 Origin 的读取请求中正确续期`, async () => {
      const response = await login(origin, null).expect(201);
      const cookie = checkCookie(response, origin);
      assert.equal((await db.session.findFirstOrThrow()).expiresAt, null);
      const refreshed = await api().get(prefix + '/auth/me').set('Host', new URL(origin).host).set('Cookie', cookie)
        .expect(200).expect(result => assert.equal(result.body.authenticated, true));
      assert.equal(checkCookie(refreshed, origin), cookie);
    });
  }

  test('域名和内网会话独立，退出一个入口不撤销另一个入口', async () => {
    const publicSession = await login(domain).expect(201);
    const internalSession = await login(internal).expect(201);
    const publicCookie = checkCookie(publicSession, domain), internalCookie = checkCookie(internalSession, internal);
    assert.notEqual(publicCookie, internalCookie);
    await api().post(prefix + '/auth/logout').set('Host', new URL(internal).host).set('Origin', internal)
      .set('Cookie', internalCookie).set('X-CSRF-Token', internalSession.body.csrfToken).expect(201);
    await api().get(prefix + '/auth/me').set('Host', new URL(domain).host).set('Cookie', publicCookie)
      .expect(200).expect(result => assert.equal(result.body.authenticated, true));
  });

  test('未授权来源、错误端口、协议及缺少 Origin 仍拒绝登录', async () => {
    for (const origin of ['https://untrusted.test', 'http://10.144.144.10:8081', 'http://nav.icio.eu.org', 'https://nav.icio.eu.org.untrusted.test']) {
      await login(origin).expect(403);
    }
    await api().post(prefix + '/auth/login').set('Host', new URL(internal).host)
      .send({ email: TEST_EMAIL, password: TEST_PASSWORD }).expect(403);
    assert.equal(await db.session.count(), 0);
  });

  test('内网写操作仍要求可信来源和正确 CSRF', async () => {
    const response = await login(internal).expect(201);
    const cookie = checkCookie(response, internal);
    for (const [origin, csrf] of [[internal, ''], [internal, 'incorrect'], ['https://untrusted.test', response.body.csrfToken], ['', response.body.csrfToken]]) {
      const call = api().patch(prefix + '/preferences').set('Host', new URL(internal).host).set('Cookie', cookie);
      if (origin) call.set('Origin', origin);
      if (csrf) call.set('X-CSRF-Token', csrf);
      await call.send({ theme: 'dark' }).expect(403);
    }
  });

  test('内网 Origin 和转发头不能降低域名入口 Cookie 的 Secure 属性', async () => {
    const response = await login(domain).set('Origin', internal).set('X-Forwarded-Proto', 'http').expect(201);
    checkCookie(response, domain);
  });
});
