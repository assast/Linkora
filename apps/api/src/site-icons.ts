import { createHash, randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
import { isIP, type LookupFunction } from 'node:net';
import * as http from 'node:http';
import * as https from 'node:https';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'parse5';
import { IconWorkQueue } from './icon-work';

export const ICON_MAX_BYTES = 256 * 1024;
export const HTML_MAX_BYTES = 512 * 1024;
export const ICON_SUCCESS_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const ICON_FAILURE_TTL_MS = 24 * 60 * 60 * 1000;
export const ICON_REQUEST_TIMEOUT_MS = 3_000;
export const ICON_DISCOVERY_TIMEOUT_MS = 10_000;

export interface IconHttpResponse {
  status: number;
  headers: Record<string, string | undefined>;
  body: Buffer;
  finalUrl: string;
}

export interface IconTransport {
  fetch(url: URL, maxBytes: number, signal: AbortSignal, onBlocked?: () => void): Promise<IconHttpResponse | null>;
}

export type IconResolver = (hostname: string) => Promise<string[]>;
export type IconRequestOnce = (url: URL, addresses: string[], maxBytes: number, signal: AbortSignal) => Promise<IconHttpResponse>;

const ipv4Blocked = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const;

const localSuffixes = ['.localhost', '.local', '.localdomain', '.internal', '.home.arpa', '.lan', '.test', '.example', '.invalid', '.onion'];

function ipv4Number(address: string) {
  return address.split('.').reduce((value, octet) => (value << 8n) | BigInt(Number(octet)), 0n);
}

function ipv6Number(address: string): bigint | null {
  const clean = address.toLowerCase().split('%')[0];
  if (!clean) return null;
  const halves = clean.split('::');
  if (halves.length > 2) return null;
  const expand = (side: string) => {
    if (!side) return [];
    const groups = side.split(':');
    const result: number[] = [];
    for (const group of groups) {
      if (group.includes('.')) {
        if (isIP(group) !== 4) return null;
        const value = ipv4Number(group);
        result.push(Number((value >> 16n) & 0xffffn), Number(value & 0xffffn));
      } else {
        if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
        result.push(Number.parseInt(group, 16));
      }
    }
    return result;
  };
  const left = expand(halves[0]!);
  const right = expand(halves[1] || '');
  if (!left || !right) return null;
  const missing = 8 - left.length - right.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...left, ...Array(missing).fill(0), ...right];
  if (groups.length !== 8) return null;
  return groups.reduce((value, group) => (value << 16n) | BigInt(group), 0n);
}

function ipv6Cidr(address: bigint, base: bigint, prefix: number) {
  return address >> BigInt(128 - prefix) === base >> BigInt(128 - prefix);
}

function ipv4Cidr(address: bigint, base: string, prefix: number) {
  return address >> BigInt(32 - prefix) === ipv4Number(base) >> BigInt(32 - prefix);
}

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const value = ipv4Number(address);
    return !ipv4Blocked.some(([base, prefix]) => ipv4Cidr(value, base, prefix));
  }
  if (family !== 6) return false;
  const value = ipv6Number(address);
  if (value === null) return false;
  const mappedPrefix = value >> 32n;
  if (mappedPrefix === 0xffffn) {
    const mapped = [24, 16, 8, 0].map(shift => Number((value >> BigInt(shift)) & 255n)).join('.');
    return isPublicAddress(mapped);
  }
  const globalUnicast = ipv6Cidr(value, 0x20000000000000000000000000000000n, 3);
  const protocolAssignments = ipv6Cidr(value, 0x20010000000000000000000000000000n, 23);
  const documentation = ipv6Cidr(value, 0x20010db8000000000000000000000000n, 32)
    || ipv6Cidr(value, 0x3fff0000000000000000000000000000n, 20);
  const sixToFour = ipv6Cidr(value, 0x20020000000000000000000000000000n, 16);
  return globalUnicast && !protocolAssignments && !documentation && !sixToFour;
}

function bareHostname(url: URL) {
  const hostname = url.hostname.toLowerCase();
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname.replace(/\.$/, '');
}

export function isAllowedHttpTarget(url: URL): boolean {
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return false;
  const hostname = bareHostname(url);
  if (!hostname || hostname === 'localhost' || !hostname.includes('.') && isIP(hostname) === 0) return false;
  if (localSuffixes.some(suffix => hostname.endsWith(suffix))) return false;
  return isIP(hostname) ? isPublicAddress(hostname) : true;
}

export function bookmarkOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    return url.origin;
  } catch { return null; }
}

async function systemResolve(hostname: string) {
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  return addresses.map(record => record.address);
}

function abortError(signal: AbortSignal) {
  return signal.reason instanceof Error ? signal.reason : new Error('图标请求已取消');
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

function pinnedLookup(addresses: string[]): LookupFunction {
  const callbackLookup = (hostname: string, options: { all?: boolean }, callback: (error: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void) => {
    if (!hostname) return callback(Object.assign(new Error('DNS 主机名为空'), { code: 'ENOTFOUND' }) as NodeJS.ErrnoException, '');
    const records = addresses.map(address => ({ address, family: isIP(address) }));
    if (options.all) callback(null, records);
    else callback(null, records[0]!.address, records[0]!.family);
  };
  return callbackLookup as unknown as LookupFunction;
}

function header(headers: Record<string, string | string[] | undefined>, name: string) {
  const value = headers[name.toLowerCase()];
  return typeof value === 'string' ? value : undefined;
}

export async function requestOnceAtPinnedAddress(url: URL, addresses: string[], maxBytes: number, signal: AbortSignal, timeoutMs = ICON_REQUEST_TIMEOUT_MS): Promise<IconHttpResponse> {
  if (signal.aborted) throw abortError(signal);
  return new Promise((resolve, reject) => {
    const lookupAddress = pinnedLookup(addresses);
    const agent = url.protocol === 'https:'
      ? new https.Agent({ keepAlive: false, maxSockets: 1, lookup: lookupAddress, autoSelectFamily: true })
      : new http.Agent({ keepAlive: false, maxSockets: 1, lookup: lookupAddress, autoSelectFamily: true });
    const hostname = bareHostname(url);
    const options: https.RequestOptions = {
      agent,
      headers: { Host: url.host, 'Accept-Encoding': 'identity', Accept: 'text/html,image/png,image/jpeg,image/webp,image/x-icon,image/vnd.microsoft.icon,*/*;q=0.1', 'User-Agent': 'Linkora Site Icon Fetcher' },
      ...(url.protocol === 'https:' && isIP(hostname) === 0 ? { servername: hostname } : {}),
      signal,
    };
    const request = url.protocol === 'https:' ? https.request(url, options) : http.request(url, options);
    let timer: NodeJS.Timeout | undefined = setTimeout(() => request.destroy(new Error('图标请求超时')), timeoutMs);
    let settled = false;
    const clean = () => {
      if (timer) clearTimeout(timer);
      timer = undefined;
      agent.destroy();
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clean();
      reject(error);
    };
    request.on('error', fail);
    request.on('response', response => {
      const status = response.statusCode || 0;
      const headers = Object.fromEntries(Object.entries(response.headers).map(([name, value]) => [name, Array.isArray(value) ? undefined : value]));
      const encoding = header(response.headers, 'content-encoding');
      if (encoding && encoding.toLowerCase() !== 'identity') {
        response.destroy();
        fail(new Error('图标响应压缩格式不受支持'));
        return;
      }
      if ((status >= 300 && status < 400) || status !== 200) {
        const location = header(response.headers, 'location');
        response.destroy();
        if (settled) return;
        settled = true;
        clean();
        resolve({ status, headers: { ...headers, ...(location ? { location } : {}) }, body: Buffer.alloc(0), finalUrl: url.href });
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      response.on('data', (chunk: Buffer | string) => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += bytes.length;
        if (size > maxBytes && !settled) {
          response.destroy(new Error('图标响应超出大小限制'));
          fail(new Error('图标响应超出大小限制'));
          return;
        }
        chunks.push(bytes);
      });
      response.on('aborted', () => fail(new Error('图标响应中断')));
      response.on('error', fail);
      response.on('end', () => {
        if (settled) return;
        settled = true;
        clean();
        resolve({ status, headers, body: Buffer.concat(chunks, size), finalUrl: url.href });
      });
    });
    request.end();
  });
}

export class SafeIconTransport implements IconTransport {
  constructor(
    private readonly resolveAddresses: IconResolver = systemResolve,
    private readonly requestOnce: IconRequestOnce = requestOnceAtPinnedAddress,
  ) {}

  async fetch(start: URL, maxBytes: number, signal: AbortSignal, onBlocked?: () => void): Promise<IconHttpResponse | null> {
    let url = new URL(start.href);
    for (let redirects = 0; redirects <= 3; redirects++) {
      if (signal.aborted) return null;
      if (!isAllowedHttpTarget(url)) { onBlocked?.(); return null; }
      const hostname = bareHostname(url);
      const requestController = new AbortController();
      const onAbort = () => requestController.abort(signal.reason);
      signal.addEventListener('abort', onAbort, { once: true });
      const timeout = setTimeout(() => requestController.abort('request-timeout'), ICON_REQUEST_TIMEOUT_MS);
      let response: IconHttpResponse;
      try {
        const addresses = isIP(hostname) ? [hostname] : await abortable(this.resolveAddresses(hostname), requestController.signal);
        if (!addresses.length || addresses.some(address => !isPublicAddress(address))) { onBlocked?.(); return null; }
        response = await this.requestOnce(url, addresses, maxBytes, requestController.signal);
      } catch { return null; }
      finally {
        clearTimeout(timeout);
        signal.removeEventListener('abort', onAbort);
      }
      if (requestController.signal.aborted) return null;
      const location = response.headers.location;
      if (response.status >= 300 && response.status < 400 && location) {
        if (redirects === 3) return null;
        try { url = new URL(location, url); } catch { return null; }
        continue;
      }
      if (response.status !== 200 || response.body.byteLength > maxBytes) return null;
      const encoding = response.headers['content-encoding'];
      if (encoding && encoding.toLowerCase() !== 'identity') return null;
      return { ...response, finalUrl: url.href };
    }
    return null;
  }
}

function canonicalMediaType(contentType: string | undefined) {
  const value = contentType?.split(';', 1)[0]?.trim().toLowerCase();
  if (value === 'image/png' || value === 'image/jpeg' || value === 'image/webp') return value;
  if (value === 'image/x-icon' || value === 'image/vnd.microsoft.icon' || value === 'image/ico') return 'image/x-icon';
  return null;
}

export function validateIcon(body: Buffer, contentType: string | undefined): string | null {
  if (!body.length || body.length > ICON_MAX_BYTES) return null;
  const mediaType = canonicalMediaType(contentType);
  if (!mediaType) return null;
  if (mediaType === 'image/png' && body.length >= 8 && body.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return mediaType;
  if (mediaType === 'image/jpeg' && body.length >= 3 && body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff) return mediaType;
  if (mediaType === 'image/webp' && body.length >= 12 && body.toString('ascii', 0, 4) === 'RIFF' && body.toString('ascii', 8, 12) === 'WEBP') return mediaType;
  if (mediaType === 'image/x-icon' && body.length >= 6 && body[0] === 0 && body[1] === 0 && body[2] === 1 && body[3] === 0 && body.readUInt16LE(4) > 0) return mediaType;
  return null;
}

interface CacheMetadata {
  version: 1;
  origin: string;
  checkedAt: number;
  nextCheckAt: number;
  contentHash?: string;
  mediaType?: string;
}

interface CacheValue {
  metadata: CacheMetadata;
  bytes?: Buffer;
}

export interface CachedIcon { bytes: Buffer; mediaType: string }

export interface IconRefreshResult { icon: CachedIcon | null; status: 'success' | 'failed' | 'blocked' | 'busy' }

interface HtmlNode { tagName?: string; attrs?: { name: string; value: string }[]; childNodes?: HtmlNode[] }

function htmlNodes(root: HtmlNode): HtmlNode[] {
  const result: HtmlNode[] = [];
  const stack = [...root.childNodes || []].reverse();
  while (stack.length) {
    const node = stack.pop()!;
    result.push(node);
    stack.push(...[...node.childNodes || []].reverse());
  }
  return result;
}

function attribute(node: HtmlNode, name: string) {
  return node.attrs?.find(attr => attr.name === name)?.value;
}

function iconCandidates(html: string, finalUrl: string): URL[] {
  const nodes = htmlNodes(parse(html) as unknown as HtmlNode);
  let base = new URL(finalUrl);
  for (const node of nodes) {
    if (node.tagName !== 'base') continue;
    const href = attribute(node, 'href')?.trim();
    if (!href) continue;
    try {
      const candidate = new URL(href, finalUrl);
      if (['http:', 'https:'].includes(candidate.protocol) && !candidate.username && !candidate.password) { base = candidate; break; }
    } catch { /* Try the next base element. */ }
  }
  const declared: { priority: number; order: number; url: URL }[] = [];
  nodes.forEach((node, order) => {
    if (node.tagName !== 'link') return;
    const tokens = (attribute(node, 'rel') || '').toLowerCase().split(/[\t\n\f\r ]+/).filter(Boolean);
    const priority = tokens.includes('icon') ? 0 : tokens.includes('apple-touch-icon') ? 1 : -1;
    if (priority < 0) return;
    const href = attribute(node, 'href')?.trim();
    if (!href) return;
    try {
      const url = new URL(href, base);
      if (['http:', 'https:'].includes(url.protocol)) declared.push({ priority, order, url });
    } catch { /* Ignore invalid declarations. */ }
  });
  declared.sort((left, right) => left.priority - right.priority || left.order - right.order);
  const unique = new Set<string>();
  const candidates: URL[] = [];
  for (const item of declared) {
    if (unique.has(item.url.href)) continue;
    unique.add(item.url.href);
    candidates.push(item.url);
    if (candidates.length === 2) break;
  }
  return candidates;
}

function sha256(value: Buffer | string) { return createHash('sha256').update(value).digest('hex'); }

export class SiteIconService {
  constructor(
    private readonly cacheDirectory: string,
    private readonly transport: IconTransport = new SafeIconTransport(),
    private readonly now: () => number = Date.now,
    private readonly discoveryTimeoutMs = ICON_DISCOVERY_TIMEOUT_MS,
    readonly workQueue = new IconWorkQueue(),
  ) {}

  async getForBookmark(bookmarkUrl: string, signal?: AbortSignal): Promise<CachedIcon | null> {
    const origin = bookmarkOrigin(bookmarkUrl);
    if (!origin) return null;
    let parsed: URL;
    try { parsed = new URL(bookmarkUrl); } catch { return null; }
    if (parsed.username || parsed.password || !isAllowedHttpTarget(parsed)) return null;
    const cached = await this.readCache(origin);
    if (cached?.bytes) {
      if (cached.metadata.nextCheckAt > this.now()) return { bytes: cached.bytes, mediaType: cached.metadata.mediaType! };
      void this.joinDiscovery(origin).catch(() => undefined);
      return { bytes: cached.bytes, mediaType: cached.metadata.mediaType! };
    }
    if (cached && cached.metadata.nextCheckAt > this.now()) return null;
    return (await this.joinDiscovery(origin, signal))?.icon || null;
  }

  private async readCache(origin: string): Promise<CacheValue | null> {
    const directory = join(this.cacheDirectory, sha256(origin));
    try {
      const value = JSON.parse(await readFile(join(directory, 'metadata.json'), 'utf8')) as CacheMetadata;
      if (value.version !== 1 || value.origin !== origin || !Number.isFinite(value.checkedAt) || !Number.isFinite(value.nextCheckAt)) return null;
      if (!value.contentHash) return { metadata: value };
      if (!/^[a-f0-9]{64}$/.test(value.contentHash) || typeof value.mediaType !== 'string') return null;
      const bytes = await readFile(join(directory, `${value.contentHash}.icon`));
      if (sha256(bytes) !== value.contentHash || validateIcon(bytes, value.mediaType) !== value.mediaType) return null;
      return { metadata: value, bytes };
    } catch { return null; }
  }

  private async writeFailure(origin: string, previous?: CacheMetadata) {
    const checkedAt = this.now();
    const metadata: CacheMetadata = {
      version: 1, origin, checkedAt, nextCheckAt: checkedAt + ICON_FAILURE_TTL_MS,
      ...(previous?.contentHash && previous.mediaType ? { contentHash: previous.contentHash, mediaType: previous.mediaType } : {}),
    };
    await this.writeMetadata(origin, metadata, previous?.contentHash);
  }

  private async writeIcon(origin: string, icon: CachedIcon, previous?: CacheMetadata) {
    const directory = join(this.cacheDirectory, sha256(origin));
    const contentHash = sha256(icon.bytes);
    const imagePath = join(directory, `${contentHash}.icon`);
    let imageTemp: string | undefined;
    let metadataTemp: string | undefined;
    let imagePublished = false;
    let metadataPublished = false;
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      imageTemp = join(directory, `.${randomUUID()}.tmp`);
      await writeFile(imageTemp, icon.bytes, { flag: 'wx', mode: 0o600 });
      await rename(imageTemp, imagePath);
      imageTemp = undefined;
      imagePublished = true;
      const checkedAt = this.now();
      const metadata: CacheMetadata = { version: 1, origin, checkedAt, nextCheckAt: checkedAt + ICON_SUCCESS_TTL_MS, contentHash, mediaType: icon.mediaType };
      metadataTemp = join(directory, `.${randomUUID()}.tmp`);
      await writeFile(metadataTemp, JSON.stringify(metadata), { flag: 'wx', mode: 0o600 });
      await rename(metadataTemp, join(directory, 'metadata.json'));
      metadataTemp = undefined;
      metadataPublished = true;
      if (previous?.contentHash && previous.contentHash !== contentHash) await rm(join(directory, `${previous.contentHash}.icon`), { force: true });
    } catch (error) {
      if (imagePublished && !metadataPublished && previous?.contentHash !== contentHash) await rm(imagePath, { force: true }).catch(() => undefined);
      throw error;
    } finally {
      if (imageTemp) await rm(imageTemp, { force: true }).catch(() => undefined);
      if (metadataTemp) await rm(metadataTemp, { force: true }).catch(() => undefined);
    }
  }

  private async writeMetadata(origin: string, metadata: CacheMetadata, oldHash?: string) {
    const directory = join(this.cacheDirectory, sha256(origin));
    let temporary: string | undefined;
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      temporary = join(directory, `.${randomUUID()}.tmp`);
      await writeFile(temporary, JSON.stringify(metadata), { flag: 'wx', mode: 0o600 });
      await rename(temporary, join(directory, 'metadata.json'));
      temporary = undefined;
      if (!metadata.contentHash && oldHash) await rm(join(directory, `${oldHash}.icon`), { force: true });
    } finally { if (temporary) await rm(temporary, { force: true }).catch(() => undefined); }
  }

  async refreshForBookmark(bookmarkUrl: string): Promise<IconRefreshResult> {
    let target: URL;
    try { target = new URL(bookmarkUrl); } catch { return { status: 'blocked', icon: null }; }
    if (!isAllowedHttpTarget(target)) return { status: 'blocked', icon: null };
    return await this.joinDiscovery(target.origin) || { status: 'busy', icon: null };
  }

  private joinDiscovery(origin: string, signal?: AbortSignal) {
    return this.workQueue.join<IconRefreshResult>(`auto:${origin}`, current => this.discoverAndStore(origin, current), signal,
      this.discoveryTimeoutMs, { status: 'failed', icon: null });
  }

  private async discoverAndStore(origin: string, signal: AbortSignal): Promise<IconRefreshResult> {
    const previous = await this.readCache(origin);
    const previousMetadata = previous?.metadata;
    let blocked = false;
    const fetch = (url: URL, limit: number) => this.transport.fetch(url, limit, signal, () => { blocked = true; });
    const failure = async (): Promise<IconRefreshResult> => {
      if (!signal.aborted || signal.reason === 'budget') await this.writeFailure(origin, previousMetadata).catch(() => undefined);
      return { status: blocked ? 'blocked' : 'failed',
        icon: previous?.bytes ? { bytes: previous.bytes, mediaType: previous.metadata.mediaType! } : null };
    };
    try {
      const home = await fetch(new URL('/', origin), HTML_MAX_BYTES);
      const declarations = home && ['text/html', 'application/xhtml+xml'].includes((home.headers['content-type'] || '').split(';', 1)[0]!.trim().toLowerCase())
        ? iconCandidates(home.body.toString('utf8'), home.finalUrl) : [];
      for (const target of [...declarations, new URL('/favicon.ico', origin)]) {
        if (signal.aborted) break;
        const response = await fetch(target, ICON_MAX_BYTES);
        const mediaType = response && validateIcon(response.body, response.headers['content-type']);
        if (!response || !mediaType) continue;
        const icon = { bytes: response.body, mediaType };
        if (signal.aborted) return failure();
        try { await this.writeIcon(origin, icon, previousMetadata); }
        catch { return { status: 'failed', icon }; }
        return { status: 'success', icon };
      }
      return failure();
    } catch { return failure(); }
  }
}
