import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const target = new URL(process.env.DATABASE_URL || '');
assert.equal(process.env.ICON_CONTAINER_VERIFICATION, '1', '仅允许显式隔离容器验证');
assert.equal(target.hostname, 'pg');
assert.match(target.pathname, /^\/linkora_icons(?:_restore)?_test$/);
const require = createRequire('/app/package.json');
const mode = process.argv[2];
const statePath = '/verification/state.json';
const site = process.env.SITE_URL;
let cookie = '';
let csrf = '';
let base;

async function call(path, { method = 'GET', body, owner = true } = {}) {
  const multipart = body instanceof FormData;
  return fetch(base + '/api/v1' + path, { method,
    headers: { Origin: site, ...(owner && cookie ? { Cookie: cookie, 'X-CSRF-Token': csrf } : {}), ...(body && !multipart ? { 'Content-Type': 'application/json' } : {}) },
    body: body === undefined ? undefined : multipart ? body : JSON.stringify(body) });
}

async function login() {
  const response = await call('/auth/login', { method: 'POST', body: { email: 'icons@example.test', password: 'Icon-verification-only-2026!' }, owner: false });
  assert.equal(response.status, 201); cookie = response.headers.get('set-cookie').split(';')[0]; csrf = (await response.json()).csrfToken;
}

if (mode === 'proxy') {
  base = 'http://web';
  assert.match(await (await fetch(base)).text(), /Linkora/);
  await login();
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  const before = await (await call(`/bookmarks/${state.upload}/icon-config`)).json();
  const body = new FormData(); body.append('expectedVersion', before.version); body.append('file', new Blob([Buffer.alloc(2 * 1024 * 1024 + 1)], { type: 'image/png' }), 'oversized.png');
  const rejected = await call(`/bookmarks/${state.upload}/icon-upload`, { method: 'POST', body });
  assert.equal(rejected.status, 413); assert.match(rejected.headers.get('content-type'), /application\/json/);
  assert.equal((await (await call(`/bookmarks/${state.upload}/icon-config`)).json()).version, before.version);
  assert.equal((await call(`/bookmarks/${state.upload}/icon`)).status, 200);
  console.log('PASS proxy: 配对 Web/API、同源图片、代理上传上限及失败保旧');
} else {
  const { createApplication } = require('/app/dist/app.js');
  const { Database } = require('/app/dist/database.js');
  const { SiteIconService } = require('/app/dist/site-icons.js');
  const app = await createApplication(false);
  try {
    await app.listen(0, '127.0.0.1'); base = await app.getUrl();
    const db = app.get(Database), automatic = app.get(SiteIconService);
    const legacy = mode === 'legacy';
    const library = legacy ? null : app.get(require('/app/dist/dashboard-icons.js').DashboardIcons);
    const sharp = legacy ? null : require('sharp');
    const png = sharp ? await sharp({ create: { width: 32, height: 16, channels: 4, background: { r: 90, g: 120, b: 210, alpha: 0.5 } } }).png().toBuffer() : null;
    const webp = sharp ? await sharp(png).webp().toBuffer() : null;
    let requests = 0;
    const transport = { async fetch(url) {
      requests++;
      if (mode === 'check' || legacy) throw new Error('有效缓存不应访问外网');
      if (url.hostname === 'failure.example.com' || url.pathname === '/') return null;
      const dashboard = url.hostname === 'cdn.jsdelivr.net';
      return { status: 200, headers: { 'content-type': dashboard ? 'image/webp' : 'image/png' }, body: dashboard ? webp : png, finalUrl: url.href };
    } };
    Object.assign(automatic, { transport }); if (library) Object.assign(library, { transport });
    let state;
    if (mode === 'seed') {
      assert.equal(await db.user.count(), 0, '验证库必须为空');
      const owner = await require('/app/dist/owner-init.js').initializeOwner(db, 'icons@example.test', 'Icon-verification-only-2026!');
      const category = await db.category.create({ data: { ownerId: owner.id, name: 'private-icons', isPrivate: true } });
      const book = (title, url, categoryId = null) => db.bookmark.create({ data: { ownerId: owner.id, title, url, categoryId } });
      const upload = await book('upload', 'http://localhost:8080/upload');
      const secret = await book('private-upload', 'http://localhost:8080/private', category.id);
      const dashboard = await book('dashboard', 'http://localhost:8080/dashboard');
      const auto = await book('auto', 'https://example.com/page');
      const failure = await book('failure', 'https://failure.example.com/page');
      state = { upload: upload.id, secret: secret.id, dashboard: dashboard.id, auto: auto.id, failure: failure.id };
      const saved = app.get(require('/app/dist/bookmark-icons.js').BookmarkIcons);
      for (const id of [upload.id, secret.id]) await saved.upload(owner.id, id, null, { buffer: png, mimetype: 'image/png' });
      await saved.select(owner.id, dashboard.id, { source: 'dashboard', dashboardId: 'github', expectedVersion: null });
      assert.ok(await automatic.getForBookmark(auto.url)); assert.equal(await automatic.getForBookmark(failure.url), null);
      await writeFile(statePath, JSON.stringify(state));
      console.log('PASS seed: 真实 Linux sharp、三种来源、继承私密、成功缓存及失败冷却');
    } else state = JSON.parse(await readFile(statePath, 'utf8'));
    if (mode === 'restored') await Promise.all((await readdir(process.env.ICON_CACHE_DIR)).map(name => rm(join(process.env.ICON_CACHE_DIR, name), { recursive: true, force: true })));
    await login();
    if (legacy) {
      assert.equal((await call(`/bookmarks/${state.auto}/icon`, { owner: false })).status, 200);
      assert.equal((await call(`/bookmarks/${state.upload}/icon`, { owner: false })).status, 204);
      assert.equal((await call(`/bookmarks/${state.secret}/icon`, { owner: false })).status, 404);
      assert.equal(await db.$queryRawUnsafe('SELECT count(*)::int AS count FROM bookmark_icons').then(rows => rows[0].count), 3);
      assert.equal(requests, 0);
      console.log('PASS legacy: 旧 API 仍可读自动缓存，人工配置与上传资源保留');
    } else {
      for (const id of [state.upload, state.dashboard, state.auto]) {
        const response = await call(`/bookmarks/${id}/icon`, { owner: false }); assert.equal(response.status, 200); assert.ok((await response.arrayBuffer()).byteLength);
      }
      assert.equal((await call(`/bookmarks/${state.secret}/icon`, { owner: false })).status, 404);
      assert.equal((await call(`/bookmarks/${state.secret}/icon`)).status, 200);
      assert.equal((await call(`/bookmarks/${state.failure}/icon`, { owner: false })).status, 204);
      if (mode === 'check') assert.equal(requests, 0, '成功缓存与失败冷却应跨实例复用');
      if (mode === 'readonly') {
        assert.ok(await automatic.getForBookmark('https://readonly.example.com/'));
        const config = await (await call(`/bookmarks/${state.upload}/icon-config`)).json();
        const body = new FormData(); body.append('expectedVersion', config.version); body.append('file', new Blob([png], { type: 'image/png' }), 'icon.png');
        assert.equal((await call(`/bookmarks/${state.upload}/icon-upload`, { method: 'POST', body })).status, 500);
        assert.equal((await (await call(`/bookmarks/${state.upload}/icon-config`)).json()).version, config.version);
        assert.equal((await call('/bookmarks')).status, 200);
      }
      console.log(`PASS ${mode}: 上传及配置持久化、图片可读、私密授权、缓存降级`);
    }
  } finally { await app.close(); }
}
