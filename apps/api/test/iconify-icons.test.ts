import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { IconifyIcons } from '../src/iconify-icons';
import { IconWorkQueue } from '../src/icon-work';
import { FakeIconTransport, untilIcon } from './icon-fixtures';

const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path fill="currentColor" d="M2 2h20v20H2z"/></svg>');

test('Iconify 按关键词搜索并在本地分页，空关键词不请求上游，失败不缓存', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'linkora-iconify-search-')); t.after(() => rm(directory, { recursive: true, force: true }));
  let failed = false;
  const transport = new FakeIconTransport(async url => failed ? null : ({ status: 200, headers: { 'content-type': 'application/json' }, finalUrl: url.href,
    body: Buffer.from(JSON.stringify({ icons: Array.from({ length: 30 }, (_, index) => `mdi:github-${index}`) })) }));
  const library = new IconifyIcons(directory, new IconWorkQueue(), transport);
  assert.equal((await library.search('', 1, 24))?.total, 0); assert.equal(transport.calls.length, 0);
  const first = await library.search(' GitHub ', 1, 24), second = await library.search('GITHUB', 2, 24);
  assert.equal(first?.items.length, 24); assert.equal(second?.items.length, 6); assert.equal(second?.items[0].id, 'mdi:github-24');
  assert.equal(second?.total, 30); assert.equal(transport.calls.length, 1);
  const url = new URL(transport.calls[0].url); assert.equal(url.origin, 'https://api.iconify.design'); assert.equal(url.searchParams.get('query'), 'github');
  failed = true; assert.equal(await library.search('docker', 1, 24), null);
  failed = false; assert.ok(await library.search('docker', 1, 24)); assert.equal(transport.calls.length, 3);
});

test('Iconify 将 SVG 转为静态 WebP，同一下载去重并跨实例使用本地缓存', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'linkora-iconify-image-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const transport = new FakeIconTransport(async url => ({ status: 200, headers: { 'content-type': 'image/svg+xml; charset=utf-8' }, body: svg, finalUrl: url.href }));
  const library = new IconifyIcons(directory, new IconWorkQueue(), transport);
  const [first, second] = await Promise.all([library.read('mdi:github'), library.read('mdi:github')]);
  assert.ok(first); assert.deepEqual(first, second); assert.equal(first.mediaType, 'image/webp');
  const metadata = await sharp(first.bytes).metadata(); assert.equal(metadata.format, 'webp'); assert.equal(metadata.width, 256); assert.equal(metadata.pages, undefined);
  assert.equal(transport.calls.length, 1); assert.equal(new URL(transport.calls[0].url).pathname, '/mdi/github.svg');
  const restarted = new IconifyIcons(directory, new IconWorkQueue(), transport);
  assert.deepEqual(await restarted.read('mdi:github'), first); assert.equal(transport.calls.length, 1);
  const files = await readdir(join(directory, 'iconify')); await writeFile(join(directory, 'iconify', files[0]), '<html>');
  assert.ok(await restarted.read('mdi:github')); assert.equal(transport.calls.length, 2);
  for (const id of ['../secret', 'https://example.com/logo.svg', 'mdi:../../secret', 'mdi:', 'mdi:' + 'a'.repeat(160)]) assert.equal(await library.read(id), null);
  assert.equal(transport.calls.length, 2);
});

test('Iconify 拒绝损坏的搜索结果和图片，取消请求时释放下载任务', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'linkora-iconify-failure-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const invalid = new FakeIconTransport(async url => ({ status: 200, headers: { 'content-type': 'image/svg+xml' }, body: Buffer.from('<html>broken'), finalUrl: url.href }));
  const library = new IconifyIcons(directory, new IconWorkQueue(), invalid);
  assert.equal(await library.search('github', 1, 24), null); assert.equal(await library.read('mdi:github'), null);
  let reached = false, cancelled = false;
  const slow = new FakeIconTransport((_url, _limit, signal) => new Promise(resolve => {
    reached = true; signal.addEventListener('abort', () => { cancelled = true; resolve(null); }, { once: true });
  }));
  const queue = new IconWorkQueue(), pending = new IconifyIcons(directory, queue, slow), controller = new AbortController();
  const image = pending.read('mdi:github', controller.signal); await untilIcon(() => reached); controller.abort();
  assert.equal(await image, null); await untilIcon(() => cancelled); await queue.waitForSlot();
});
