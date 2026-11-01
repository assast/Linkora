import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { createServer } from 'node:http';
import { EventEmitter } from 'node:events';
import { NotFoundException } from '@nestjs/common';
import type { Response } from 'express';
import type { Catalog } from '../src/catalog';
import type { Database } from '../src/database';
import type { Viewer } from '../src/auth';
import { SiteIconsController } from '../src/site-icons-controller';
import type { BookmarkIcons } from '../src/bookmark-icons';
import { FakeIconTransport as FakeTransport } from './icon-fixtures';
import {
  HTML_MAX_BYTES, ICON_FAILURE_TTL_MS, ICON_MAX_BYTES, CachedIcon, IconHttpResponse, IconTransport, SafeIconTransport, SiteIconService,
  bookmarkOrigin, isAllowedHttpTarget, isPublicAddress, requestOnceAtPinnedAddress, validateIcon,
} from '../src/site-icons';

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
const otherPng = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
const html = (url: URL, content: string) => response(url, 'text/html; charset=utf-8', Buffer.from(content));
const image = (url: URL, body = png, type = 'image/png') => response(url, type, body);

function response(url: URL, contentType: string, body: Buffer, status = 200, extra: Record<string, string> = {}): IconHttpResponse {
  return { status, headers: { 'content-type': contentType, ...extra }, body, finalUrl: url.href };
}

async function serviceFixture(t: TestContext, transport: IconTransport, now: () => number = Date.now, directory?: string) {
  const cacheDirectory = directory || await mkdtemp(join(tmpdir(), 'linkora-icons-'));
  if (!directory) t.after(() => rm(cacheDirectory, { recursive: true, force: true }));
  return { directory: cacheDirectory, service: new SiteIconService(cacheDirectory, transport, now) };
}

async function until(predicate: () => boolean | Promise<boolean>, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!await predicate()) {
    if (Date.now() >= deadline) throw new Error('等待异步图标任务超时');
    await new Promise(resolve => setTimeout(resolve, 2));
  }
}

test('origin 规范化忽略路径查询片段并保留协议、子域及有效端口', () => {
  assert.equal(bookmarkOrigin('https://EXAMPLE.com:443/docs?a=1#part'), 'https://example.com');
  assert.equal(bookmarkOrigin('https://example.com/account'), 'https://example.com');
  assert.notEqual(bookmarkOrigin('http://example.com'), bookmarkOrigin('https://example.com'));
  assert.notEqual(bookmarkOrigin('https://www.example.com'), bookmarkOrigin('https://example.com'));
  assert.notEqual(bookmarkOrigin('https://example.com:8443'), bookmarkOrigin('https://example.com'));
  assert.equal(bookmarkOrigin('https://user:pass@example.com/docs'), 'https://example.com');
});

test('公网目标过滤拒绝内网主机名及 IPv4/IPv6 特殊地址', () => {
  for (const address of [
    '0.0.0.0', '10.1.2.3', '100.64.0.1', '127.0.0.1', '169.254.1.1', '172.16.1.1',
    '192.0.2.1', '192.168.1.1', '198.18.0.1', '198.51.100.1', '203.0.113.1', '224.0.0.1', '240.0.0.1',
    '::', '::1', 'fc00::1', 'fe80::1', '2001:db8::1', '::ffff:127.0.0.1', '2002:7f00:1::1',
  ]) assert.equal(isPublicAddress(address), false, address);
  for (const address of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '::ffff:8.8.8.8']) assert.equal(isPublicAddress(address), true, address);
  for (const target of ['http://localhost/', 'https://router/', 'http://printer.local/', 'http://10.0.0.1/', 'https://[::1]/', 'ftp://example.com/']) {
    assert.equal(isAllowedHttpTarget(new URL(target)), false, target);
  }
  assert.equal(isAllowedHttpTarget(new URL('https://example.com/')), true);
  assert.equal(isAllowedHttpTarget(new URL('https://user:pass@example.com/')), false);
});

test('图标服务收到公网书签但拒绝 localhost、内网主机名、IPv4 和 IPv6 目标', async t => {
  const attempted: string[] = [];
  const transport = new FakeTransport(async url => { attempted.push(url.href); return null; });
  const { service } = await serviceFixture(t, transport);
  for (const url of ['http://localhost:8080/', 'http://router/', 'http://10.1.2.3/', 'https://[::1]/']) {
    assert.equal(await service.getForBookmark(url), null);
  }
  assert.deepEqual(attempted, []);
});

test('统一传输校验 DNS 全部地址并将连接固定到已验证的 IP', async () => {
  let resolverCalls = 0;
  let connected: string[] = [];
  const transport = new SafeIconTransport(async () => { resolverCalls++; return ['93.184.216.34']; }, async (url, addresses, maxBytes) => {
    connected = addresses;
    assert.equal(maxBytes, ICON_MAX_BYTES);
    assert.equal(url.hostname, 'safe.example.com');
    return image(url);
  });
  const result = await transport.fetch(new URL('https://safe.example.com/icon.png'), ICON_MAX_BYTES, new AbortController().signal);
  assert.equal(result?.body.equals(png), true);
  assert.equal(resolverCalls, 1);
  assert.deepEqual(connected, ['93.184.216.34']);

  let attempted = false;
  const mixed = new SafeIconTransport(async () => ['93.184.216.34', '192.168.1.2'], async () => {
    attempted = true;
    return image(new URL('https://mixed.example.com/icon.png'));
  });
  assert.equal(await mixed.fetch(new URL('https://mixed.example.com/icon.png'), ICON_MAX_BYTES, new AbortController().signal), null);
  assert.equal(attempted, false);
});

test('每一跳重定向重新校验 DNS 和公网目标，最多跟随三跳', async () => {
  const visited: string[] = [];
  const safeRedirect = new SafeIconTransport(async () => ['93.184.216.34'], async url => {
    visited.push(url.href);
    if (url.pathname === '/') return { ...response(url, 'text/html', Buffer.alloc(0), 302), headers: { location: 'http://127.0.0.1/private' } };
    return image(url);
  });
  assert.equal(await safeRedirect.fetch(new URL('https://public.example.com/'), ICON_MAX_BYTES, new AbortController().signal), null);
  assert.deepEqual(visited, ['https://public.example.com/']);

  let count = 0;
  const loop = new SafeIconTransport(async () => ['93.184.216.34'], async url => {
    count++;
    return { ...response(url, 'text/html', Buffer.alloc(0), 302), headers: { location: `/hop-${count}` } };
  });
  assert.equal(await loop.fetch(new URL('https://public.example.com/'), ICON_MAX_BYTES, new AbortController().signal), null);
  assert.equal(count, 4);
});

test('安全传输以实际 body 大小拒绝超限响应并尊重取消信号', async () => {
  let receivedLimit = 0;
  const tooLarge = new SafeIconTransport(async () => ['93.184.216.34'], async (url, _addresses, limit) => {
    receivedLimit = limit;
    return image(url, Buffer.alloc(4));
  });
  assert.equal(await tooLarge.fetch(new URL('https://large.example.com/'), 3, new AbortController().signal), null);
  assert.equal(receivedLimit, 3);

  let requestSignal: AbortSignal | undefined;
  const pending = new SafeIconTransport(async () => ['93.184.216.34'], async (_url, _addresses, _limit, signal) => {
    requestSignal = signal;
    return new Promise<IconHttpResponse>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }));
  });
  const controller = new AbortController();
  const task = pending.fetch(new URL('https://slow.example.com/'), ICON_MAX_BYTES, controller.signal);
  await until(() => requestSignal !== undefined);
  controller.abort();
  assert.equal(await task, null);
});

test('流式限制和请求超时会关闭实际响应，不依赖 Content-Length', async () => {
  let htmlClosed = false, iconClosed = false, stalledClosed = false;
  const observedHeaders: import('node:http').IncomingHttpHeaders[] = [];
  const server = createServer((request, response) => {
    observedHeaders.push(request.headers);
    response.writeHead(200, { 'content-type': 'text/html' });
    if (request.url === '/oversized-html' || request.url === '/oversized-icon') {
      const isHtml = request.url === '/oversized-html';
      const interval = setInterval(() => response.write(Buffer.alloc(64 * 1024)), 2);
      response.on('close', () => { clearInterval(interval); if (isHtml) htmlClosed = true; else iconClosed = true; });
    } else {
      response.write('waiting');
      response.on('close', () => { stalledClosed = true; });
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const largeHtmlUrl = new URL(`http://pinned.example.com:${address.port}/oversized-html`);
    await assert.rejects(requestOnceAtPinnedAddress(largeHtmlUrl, ['127.0.0.1'], HTML_MAX_BYTES, new AbortController().signal, 500));
    await until(() => htmlClosed);
    const largeIconUrl = new URL(`http://pinned.example.com:${address.port}/oversized-icon`);
    await assert.rejects(requestOnceAtPinnedAddress(largeIconUrl, ['127.0.0.1'], ICON_MAX_BYTES, new AbortController().signal, 500));
    await until(() => iconClosed);

    const slowUrl = new URL(`http://pinned.example.com:${address.port}/slow`);
    await assert.rejects(requestOnceAtPinnedAddress(slowUrl, ['127.0.0.1'], 128, new AbortController().signal, 40));
    await until(() => stalledClosed);
    assert.equal(observedHeaders[0]?.host, `pinned.example.com:${address.port}`);
    for (const headers of observedHeaders) for (const name of ['cookie', 'authorization', 'origin', 'referer']) assert.equal(headers[name], undefined);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('origin 发现预算涵盖请求等待并中止挂起传输', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'linkora-icons-budget-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const transport = new FakeTransport((_url, _limit, signal) => new Promise(resolve => {
    signal.addEventListener('abort', () => resolve(null), { once: true });
  }));
  const service = new SiteIconService(directory, transport, Date.now, 25);
  const started = Date.now();
  assert.equal(await service.getForBookmark('https://budget.example.com/'), null);
  assert.ok(Date.now() - started < 1_000);
  assert.equal(transport.calls.length, 1);
  assert.equal(transport.calls[0]?.signal.aborted, true);
  await until(async () => {
    try { await readFile(join(directory, createHash('sha256').update('https://budget.example.com').digest('hex'), 'metadata.json')); return true; }
    catch { return false; }
  });
});

test('Content-Type 与签名同时匹配才接受 PNG、JPEG、WebP 和 ICO', () => {
  assert.equal(validateIcon(png, 'image/png'), 'image/png');
  assert.equal(validateIcon(Buffer.from([0xff, 0xd8, 0xff, 0x00]), 'image/jpeg'), 'image/jpeg');
  assert.equal(validateIcon(Buffer.from('RIFF0000WEBPdata'), 'image/webp'), 'image/webp');
  assert.equal(validateIcon(Buffer.from([0, 0, 1, 0, 1, 0]), 'image/vnd.microsoft.icon'), 'image/x-icon');
  for (const [body, type] of [
    [Buffer.from('<html>error</html>'), 'image/png'], [png, 'image/jpeg'], [png, 'image/svg+xml'], [Buffer.alloc(0), 'image/png'],
  ] as const) assert.equal(validateIcon(body, type), null);
});

test('HTML 声明按 rel token、优先级、base URL 和去重规则尝试最多两个候选', async t => {
  const origin = 'https://icons.example.com';
  const page = '<base href="/assets/"><link rel="apple-touch-icon" href="touch.png">'
    + '<link rel="preload shortcut icon" href="site.ico"><link rel="icon" href="site.ico">'
    + '<link rel="icon" href="app.png"><link rel="apple-touch-icon" href="last.png">';
  const transport = new FakeTransport(async url => {
    if (url.pathname === '/') return { ...html(url, page), finalUrl: `${origin}/redirected/index.html` };
    if (url.pathname === '/assets/site.ico') return response(url, 'text/html', Buffer.from('<html>not an icon</html>'));
    if (url.pathname === '/assets/app.png') return image(url);
    return null;
  });
  const { service } = await serviceFixture(t, transport);
  assert.equal((await service.getForBookmark(`${origin}/docs/page?q=secret`))?.mediaType, 'image/png');
  assert.deepEqual(transport.calls.map(call => new URL(call.url).pathname), ['/', '/assets/site.ico', '/assets/app.png']);
  assert.equal(transport.calls.some(call => new URL(call.url).pathname === '/favicon.ico'), false);
  assert.equal(transport.calls[0]?.maxBytes, 512 * 1024);
});

test('首页失败或无声明时仍请求原 origin 的 favicon.ico，命中后停止', async t => {
  const origin = 'https://fallback.example.com';
  const transport = new FakeTransport(async url => url.pathname === '/' ? null : url.pathname === '/favicon.ico' ? image(url) : null);
  const { service } = await serviceFixture(t, transport);
  assert.equal((await service.getForBookmark(`${origin}/saved/path?private=1`))?.bytes.equals(png), true);
  assert.deepEqual(transport.calls.map(call => call.url), [`${origin}/`, `${origin}/favicon.ico`]);
});

test('无效、HTML、空、类型不匹配和 SVG 候选继续尝试默认图标', async t => {
  const origin = 'https://invalid-icons.example.com';
  const transport = new FakeTransport(async url => {
    if (url.pathname === '/') return html(url, '<link rel="icon" href="bad.svg"><link rel="icon" href="fake.png">');
    if (url.pathname === '/bad.svg') return image(url, Buffer.from('<svg/>'), 'image/svg+xml');
    if (url.pathname === '/fake.png') return image(url, Buffer.from('<html>error</html>'));
    if (url.pathname === '/favicon.ico') return image(url);
    return null;
  });
  const { service } = await serviceFixture(t, transport);
  assert.equal((await service.getForBookmark(`${origin}/`))?.mediaType, 'image/png');
  assert.deepEqual(transport.calls.map(call => new URL(call.url).pathname), ['/', '/bad.svg', '/fake.png', '/favicon.ico']);
});

test('成功缓存跨服务实例复用，origin 目录与资源名只由哈希计算', async t => {
  const now = 1_800_000_000_000;
  const firstTransport = new FakeTransport(async url => url.pathname === '/' ? html(url, '<link rel="icon" href="/site.png">') : image(url));
  const { directory, service } = await serviceFixture(t, firstTransport, () => now);
  const first = await service.getForBookmark('https://EXAMPLE.com:443/docs?token=one');
  assert.equal(first?.bytes.equals(png), true);
  const directories = await readdir(directory);
  assert.deepEqual(directories, [createHash('sha256').update('https://example.com').digest('hex')]);
  const files = await readdir(join(directory, directories[0]!));
  assert.ok(files.includes(`${createHash('sha256').update(png).digest('hex')}.icon`));
  assert.ok(files.includes('metadata.json'));

  const secondTransport = new FakeTransport(async () => { throw new Error('有效缓存不应发起网络请求'); });
  const second = new SiteIconService(directory, secondTransport, () => now + 1);
  assert.equal((await second.getForBookmark('https://example.com/account#profile'))?.bytes.equals(png), true);
  assert.equal(secondTransport.calls.length, 0);
});

test('失败冷却跨服务实例保存 24 小时，结束后允许重试', async t => {
  let now = 1_800_000_000_000;
  const origin = 'https://missing-icon.example.com';
  const failed = new FakeTransport(async () => null);
  const { directory, service } = await serviceFixture(t, failed, () => now);
  assert.equal(await service.getForBookmark(origin), null);
  assert.deepEqual(failed.calls.map(call => new URL(call.url).pathname), ['/', '/favicon.ico']);

  const retry = new FakeTransport(async url => url.pathname === '/' ? html(url, '') : image(url));
  const restarted = new SiteIconService(directory, retry, () => now + ICON_FAILURE_TTL_MS - 1);
  assert.equal(await restarted.getForBookmark(origin), null);
  assert.equal(retry.calls.length, 0);
  now += ICON_FAILURE_TTL_MS;
  const allowed = new SiteIconService(directory, retry, () => now);
  assert.equal((await allowed.getForBookmark(origin))?.bytes.equals(png), true);
  assert.equal(retry.calls.length, 2);
});

test('旧图标在过期刷新期间立即返回，刷新失败保留旧文件并重新冷却', async t => {
  let now = 1_800_000_000_000;
  const origin = 'https://stale.example.com';
  const initialTransport = new FakeTransport(async url => url.pathname === '/' ? html(url, '') : image(url));
  const { directory, service } = await serviceFixture(t, initialTransport, () => now);
  await service.getForBookmark(origin);
  now += 31 * 24 * 60 * 60 * 1000;

  const refresh = new FakeTransport(async () => null);
  const restarted = new SiteIconService(directory, refresh, () => now);
  assert.equal((await restarted.getForBookmark(`${origin}/another-page`))?.bytes.equals(png), true);
  await until(() => refresh.calls.length === 2);
  const metadataPath = join(directory, createHash('sha256').update(origin).digest('hex'), 'metadata.json');
  const metadata = JSON.parse(await readFile(metadataPath, 'utf8')) as { contentHash: string; nextCheckAt: number };
  assert.equal(metadata.contentHash, createHash('sha256').update(png).digest('hex'));
  assert.equal(metadata.nextCheckAt, now + ICON_FAILURE_TTL_MS);
  const beforeRetry = refresh.calls.length;
  assert.equal((await restarted.getForBookmark(origin))?.bytes.equals(png), true);
  assert.equal(refresh.calls.length, beforeRetry);
});

test('缓存缺失或元数据损坏按未命中处理，目录不可写时以内存图片降级', async t => {
  const origin = 'https://repair.example.com';
  const initial = new FakeTransport(async url => url.pathname === '/' ? html(url, '') : image(url));
  const { directory, service } = await serviceFixture(t, initial);
  await service.getForBookmark(origin);
  const originDirectory = join(directory, createHash('sha256').update(origin).digest('hex'));
  const metadataPath = join(originDirectory, 'metadata.json');
  const metadata = JSON.parse(await readFile(metadataPath, 'utf8')) as { contentHash: string };
  await rm(join(originDirectory, `${metadata.contentHash}.icon`));
  const repair = new FakeTransport(async url => url.pathname === '/' ? html(url, '') : image(url, otherPng));
  const repaired = new SiteIconService(directory, repair);
  assert.equal((await repaired.getForBookmark(origin))?.bytes.equals(otherPng), true);
  await writeFile(metadataPath, '{damaged metadata');
  const rebuild = new FakeTransport(async url => url.pathname === '/' ? html(url, '') : image(url));
  assert.equal((await new SiteIconService(directory, rebuild).getForBookmark(origin))?.bytes.equals(png), true);

  const blockedPath = join(directory, 'not-a-directory');
  await writeFile(blockedPath, 'file');
  const memoryOnly = new SiteIconService(blockedPath, new FakeTransport(async url => url.pathname === '/' ? html(url, '') : image(url)));
  assert.equal((await memoryOnly.getForBookmark('https://memory.example.com/'))?.bytes.equals(png), true);
});

test('元数据原子发布失败时移除本次资源并保留上一份有效图标', async t => {
  const origin = 'https://atomic.example.com';
  const transport = new FakeTransport(async url => url.pathname === '/' ? html(url, '') : image(url));
  const { directory, service } = await serviceFixture(t, transport);
  assert.equal((await service.getForBookmark(origin))?.bytes.equals(png), true);
  const originDirectory = join(directory, createHash('sha256').update(origin).digest('hex'));
  const metadataPath = join(originDirectory, 'metadata.json');
  const originalMetadata = JSON.parse(await readFile(metadataPath, 'utf8')) as { contentHash: string; mediaType: string };
  const savedMetadataPath = join(directory, 'saved-metadata.json');
  await rename(metadataPath, savedMetadataPath);
  await mkdir(metadataPath);
  const writeIcon = (service as unknown as { writeIcon(origin: string, icon: CachedIcon, previous: typeof originalMetadata): Promise<void> }).writeIcon.bind(service);
  await assert.rejects(writeIcon(origin, { bytes: otherPng, mediaType: 'image/png' }, originalMetadata));
  await rm(metadataPath, { recursive: true });
  await rename(savedMetadataPath, metadataPath);

  const files = await readdir(originDirectory);
  assert.deepEqual(files.sort(), ['metadata.json', `${originalMetadata.contentHash}.icon`].sort());
  assert.equal((await service.getForBookmark(origin))?.bytes.equals(png), true);
});

test('凭据书签、同 origin 并发发现及调用方取消不会泄露远端请求', async t => {
  const calls: string[] = [];
  let releaseHome!: (value: IconHttpResponse | null) => void;
  let homeSignal: AbortSignal | undefined;
  const shared = new FakeTransport((url, _limit, signal) => {
    calls.push(url.href);
    if (url.pathname === '/') {
      homeSignal = signal;
      return new Promise(resolve => { releaseHome = resolve; });
    }
    return Promise.resolve(image(url));
  });
  const { service } = await serviceFixture(t, shared);
  assert.equal(await service.getForBookmark('https://user:pass@credentials.example.com/private'), null);
  assert.equal(shared.calls.length, 0);

  const firstController = new AbortController();
  const secondController = new AbortController();
  const first = service.getForBookmark('https://example.com/one', firstController.signal);
  await until(() => homeSignal !== undefined);
  const second = service.getForBookmark('https://EXAMPLE.com:443/two', secondController.signal);
  const state = service.workQueue as unknown as { tasks: Map<string, { waiters: number }> };
  await until(() => [...state.tasks.values()][0]?.waiters === 2);
  firstController.abort();
  assert.equal(await first, null);
  assert.equal(homeSignal?.aborted, false);
  releaseHome!(html(new URL('https://example.com/'), ''));
  assert.equal((await second)?.bytes.equals(png), true);
  assert.equal(calls.filter(url => url === 'https://example.com/').length, 1);
});

test('并发同源任务共享、并发 origin 限制为 4、队列限制为 64 且拥塞不写失败缓存', async t => {
  const transports: { url: string; signal: AbortSignal; release: (value: IconHttpResponse | null) => void }[] = [];
  const transport: IconTransport = { fetch(url, _maxBytes, signal) {
    return new Promise(resolve => {
      const call = { url: url.href, signal, release: resolve };
      transports.push(call);
      signal.addEventListener('abort', () => resolve(null), { once: true });
    });
  } };
  const { service, directory } = await serviceFixture(t, transport);
  const state = service.workQueue as unknown as { active: number; queue: unknown[] };
  const activeControllers = Array.from({ length: 4 }, () => new AbortController());
  const activeTasks = activeControllers.map((controller, index) => service.getForBookmark(`https://active-${index}.example.com/`, controller.signal));
  await until(() => transports.length === 4);
  const queuedControllers = Array.from({ length: 64 }, () => new AbortController());
  const queuedTasks = queuedControllers.map((controller, index) => service.getForBookmark(`https://queued-${index}.example.com/`, controller.signal));
  await until(() => state.queue.length === 64);
  assert.equal(state.active, 4);
  const overflow = await Promise.race([
    service.getForBookmark('https://overflow.example.com/'),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('超出排队容量的请求未及时拒绝')), 250)),
  ]);
  assert.equal(overflow, null);
  const overflowHash = createHash('sha256').update('https://overflow.example.com').digest('hex');
  await assert.rejects(readFile(join(directory, overflowHash, 'metadata.json')));

  for (const controller of [...activeControllers, ...queuedControllers]) controller.abort();
  await Promise.all([...activeTasks, ...queuedTasks]);
  await until(() => state.active === 0 && state.queue.length === 0);
});

test('抓取期间变私密或删除时，发送前复核返回空 404', async () => {
  let visible = true, resolveIcon!: (value: CachedIcon | null) => void, calls = 0;
  let iconRequested!: () => void;
  const requested = new Promise<void>(resolve => { iconRequested = resolve; });
  const book = { url: 'https://first.example.com/bookmark' };
  const db = { read: (work: (tx: object) => Promise<unknown>) => work({}) } as unknown as Database;
  const catalog = {
    context: async () => ({ ownerId: null, includePrivate: false }),
    book: async () => { calls++; if (!visible) throw new NotFoundException(); return book; },
  } as unknown as Catalog;
  const icons = { getForBookmark: () => { iconRequested(); return new Promise<CachedIcon | null>(resolve => { resolveIcon = resolve; }); } } as unknown as SiteIconService;
  const controller = new SiteIconsController(db, catalog, icons, { readConfig: async () => null } as unknown as BookmarkIcons);
  const request = new EventEmitter() as unknown as import('express').Request;
  const state = { status: 200, headers: {} as Record<string, string | number> };
  const response = Object.assign(new EventEmitter(), {
    status(status: number) { state.status = status; return this; },
    setHeader(name: string, value: string | number) { state.headers[name.toLowerCase()] = value; return this; },
  }) as unknown as Response;
  const pending = controller.icon({ ownerId: null } as Viewer, 'bookmark-id', request, response);
  await requested;
  visible = false;
  resolveIcon!({ bytes: png, mediaType: 'image/png' });
  assert.equal(await pending, undefined);
  assert.equal(state.status, 404);
  assert.deepEqual(state.headers, {});
  assert.equal(calls, 2);
});

test('抓取期间书签更换 origin 时不返回旧站点图片', async () => {
  let resolveIcon!: (value: CachedIcon | null) => void;
  let calls = 0;
  const book = { url: 'https://first.example.com/bookmark' };
  const db = { read: (work: (tx: object) => Promise<unknown>) => work({}) } as unknown as Database;
  const catalog = {
    context: async () => ({ ownerId: null, includePrivate: false }),
    book: async () => { calls++; return book; },
  } as unknown as Catalog;
  const icons = { getForBookmark: () => new Promise<CachedIcon | null>(resolve => { resolveIcon = resolve; }) } as unknown as SiteIconService;
  const controller = new SiteIconsController(db, catalog, icons, { readConfig: async () => null } as unknown as BookmarkIcons);
  const request = new EventEmitter() as unknown as import('express').Request;
  const state = { status: 200, headers: {} as Record<string, string | number> };
  const response = Object.assign(new EventEmitter(), {
    status(status: number) { state.status = status; return this; },
    setHeader(name: string, value: string | number) { state.headers[name.toLowerCase()] = value; return this; },
  }) as unknown as Response;
  const pending = controller.icon({ ownerId: null } as Viewer, 'bookmark-id', request, response);
  await until(() => resolveIcon !== undefined);
  book.url = 'https://second.example.com/bookmark';
  resolveIcon!({ bytes: png, mediaType: 'image/png' });
  assert.equal(await pending, undefined);
  assert.equal(state.status, 204);
  assert.deepEqual(state.headers, {});
  assert.equal(calls, 2);
});

