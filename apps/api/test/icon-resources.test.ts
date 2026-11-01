import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { AppConfig } from '../src/config';
import { DashboardIcons } from '../src/dashboard-icons';
import { IconWorkQueue } from '../src/icon-work';
import { IconUploads, normalizeIconUpload } from '../src/icon-uploads';
import { SiteIconService, type IconHttpResponse } from '../src/site-icons';
import { animatedPngFixture, FakeIconTransport, realIcon, untilIcon } from './icon-fixtures';

test('上传真实图片归一化并保留比例和透明度，拒绝伪装、动画、大小和像素超限', async () => {
  for (const format of ['png', 'jpeg', 'webp'] as const) {
    const bytes = await normalizeIconUpload({ buffer: await realIcon(format, 512, 256), mimetype: `image/${format}` });
    const info = await sharp(bytes).metadata();
    assert.equal(info.format, 'webp'); assert.equal(info.width, 256); assert.equal(info.height, 128);
    if (format !== 'jpeg') assert.equal(info.hasAlpha, true);
    assert.ok(bytes.length <= 256 * 1024); assert.equal(info.exif, undefined);
  }
  for (const [buffer, mimetype] of [[Buffer.from('<svg/>'), 'image/png'], [Buffer.alloc(0), 'image/png'],
    [animatedPngFixture(), 'image/png'], [await realIcon('png', 4097, 1), 'image/png'], [Buffer.alloc(2 * 1024 * 1024 + 1), 'image/png']] as const) {
    await assert.rejects(normalizeIconUpload({ buffer, mimetype }));
  }
});

test('上传文件独立持久化、损坏降级及失败临时文件清理', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'linkora-upload-unit-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const uploads = new IconUploads(directory), id = '00000000-0000-4000-8000-000000000001';
  const key = await uploads.prepare(id, { buffer: await realIcon(), mimetype: 'image/png' });
  assert.ok(await new IconUploads(directory).read(id, key));
  await writeFile(join(directory, id, `${key}.webp`), '<html>'); assert.equal(await uploads.read(id, key), null);
  await uploads.removeMany([{ bookmarkId: id, uploadKey: key }]); assert.deepEqual(await readdir(join(directory, id)), []);
  const file = join(directory, 'not-a-directory'); await writeFile(file, 'blocked');
  await assert.rejects(new IconUploads(file).prepare(id, { buffer: await realIcon(), mimetype: 'image/png' }));
});

test('图标库离线搜索、固定版本缓存、跨实例复用和损坏重建', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'linkora-library-unit-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const bytes = await realIcon('webp');
  const transport = new FakeIconTransport(async url => ({ status: 200, body: bytes, headers: { 'content-type': 'image/webp' }, finalUrl: url.href }));
  const index = { repository: 'homarr-labs/dashboard-icons', commit: 'a'.repeat(40), icons: [{ id: 'github-light', name: 'GitHub Light', formats: ['webp'] }] };
  const library = new DashboardIcons(directory, new IconWorkQueue(), transport, index);
  assert.equal(library.search('GITHUB', 1, 24).total, 1); assert.equal(transport.calls.length, 0);
  const selected = await Promise.all([library.select('github-light'), library.select('github-light')]);
  assert.equal(transport.calls.length, 1); assert.ok(selected[0]); assert.match(transport.calls[0].url, new RegExp('@' + 'a'.repeat(40)));
  const restarted = new DashboardIcons(directory, new IconWorkQueue(), transport, { ...index, commit: 'b'.repeat(40), icons: [] });
  assert.ok(await restarted.read(selected[0]!.reference)); assert.equal(transport.calls.length, 1);
  assert.equal(await library.select('../private'), null);
  const files = await readdir(join(directory, 'dashboard'));
  await writeFile(join(directory, 'dashboard', files[0]), '{}');
  assert.ok(await restarted.read(selected[0]!.reference)); assert.equal(transport.calls.length, 2);
});

test('自动发现和图标库共用四个执行槽及取消清理', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'linkora-shared-work-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const blocked: { release: (value: IconHttpResponse | null) => void }[] = [];
  const transport = new FakeIconTransport((url, _limit, signal) => new Promise(resolve => {
    blocked.push({ release: resolve }); signal.addEventListener('abort', () => resolve(null), { once: true });
  }));
  const queue = new IconWorkQueue(), auto = new SiteIconService(directory, transport, Date.now, 200, queue);
  const library = new DashboardIcons(directory, queue, transport, { repository: '', commit: 'a'.repeat(40), icons: [{ id: 'github', name: 'GitHub', formats: ['webp'] }] });
  const controller = new AbortController();
  const tasks = Array.from({ length: 4 }, (_, index) => auto.getForBookmark(`https://site-${index}.com`, controller.signal));
  await untilIcon(() => blocked.length === 4);
  const preview = library.select('github', controller.signal);
  await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(blocked.length, 4);
  controller.abort(); await Promise.all([...tasks, preview]);
  await queue.waitForSlot();
});

test('强制刷新绕过 TTL 与冷却，失败保旧但不能计为成功', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'linkora-force-unit-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const bytes = await realIcon(); let fail = true;
  const transport = new FakeIconTransport(async url => !fail && url.pathname === '/favicon.ico' ? { status: 200, body: bytes, headers: { 'content-type': 'image/png' }, finalUrl: url.href } : null);
  const service = new SiteIconService(directory, transport);
  assert.equal(await service.getForBookmark('https://example.com'), null);
  fail = false; assert.equal((await service.refreshForBookmark('https://example.com')).status, 'success');
  fail = true; assert.equal((await service.refreshForBookmark('https://example.com')).status, 'failed');
  assert.ok(await service.getForBookmark('https://example.com')); assert.equal((await service.refreshForBookmark('http://localhost')).status, 'blocked');
});

test('上传目录不能与缓存目录相同或嵌套', () => {
  const old = { cache: process.env.ICON_CACHE_DIR, uploads: process.env.ICON_UPLOAD_DIR };
  try {
    process.env.ICON_CACHE_DIR = '/tmp/linkora-icons';
    for (const directory of ['/tmp/linkora-icons', '/tmp/linkora-icons/uploads', '/tmp']) {
      process.env.ICON_UPLOAD_DIR = directory; assert.throws(() => new AppConfig(), /不能嵌套/);
    }
  } finally {
    if (old.cache === undefined) delete process.env.ICON_CACHE_DIR; else process.env.ICON_CACHE_DIR = old.cache;
    if (old.uploads === undefined) delete process.env.ICON_UPLOAD_DIR; else process.env.ICON_UPLOAD_DIR = old.uploads;
  }
});
