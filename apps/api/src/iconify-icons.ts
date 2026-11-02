import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { iconHash, writeIconFile } from './icon-files';
import { IconWorkQueue } from './icon-work';
import { HTML_MAX_BYTES, ICON_MAX_BYTES, SafeIconTransport, validateIcon, type CachedIcon, type IconTransport } from './site-icons';

export const ICONIFY_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*:[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const isIconifyId = (id: string) => id.length <= 160 && ICONIFY_ID_PATTERN.test(id);

export class IconifyIcons {
  private readonly searches = new Map<string, { expires: number; icons: string[] }>();
  constructor(private readonly directory: string, private readonly workQueue: IconWorkQueue,
    private readonly transport: IconTransport = new SafeIconTransport()) {}

  async search(keyword: string, page: number, pageSize: number, signal?: AbortSignal) {
    const query = keyword.trim().toLowerCase();
    if (!query) return { items: [], total: 0, page, pageSize };
    const cached = this.searches.get(query);
    const icons = cached && cached.expires > Date.now() ? cached.icons : await this.workQueue.join(`iconify:search:${query}`, async current => {
      const url = new URL('https://api.iconify.design/search');
      url.searchParams.set('query', query); url.searchParams.set('limit', '999');
      const response = await this.transport.fetch(url, HTML_MAX_BYTES, current);
      if (!response || current.aborted) return null;
      try {
        const result: unknown = JSON.parse(response.body.toString('utf8'));
        if (!result || typeof result !== 'object' || !('icons' in result) || !Array.isArray(result.icons)
          || !result.icons.every(id => typeof id === 'string' && isIconifyId(id))) return null;
        const icons = [...new Set<string>(result.icons)];
        if (this.searches.size >= 64) this.searches.delete(this.searches.keys().next().value!);
        this.searches.set(query, { expires: Date.now() + 5 * 60_000, icons });
        return icons;
      } catch { return null; }
    }, signal);
    if (!icons) return null;
    return { items: icons.slice((page - 1) * pageSize, page * pageSize).map(id => ({ id, name: id.split(':')[1]! })), total: icons.length, page, pageSize };
  }

  async read(id: string | null, signal?: AbortSignal): Promise<CachedIcon | null> {
    if (!id || !isIconifyId(id)) return null;
    const key = iconHash(id), directory = join(this.directory, 'iconify');
    try {
      const bytes = await readFile(join(directory, `${key}.webp`));
      if (bytes.length <= ICON_MAX_BYTES && validateIcon(bytes, 'image/webp')) return { bytes, mediaType: 'image/webp' };
    } catch { /* Missing or corrupt cache is rebuilt from the saved Iconify ID. */ }
    return this.workQueue.join(`iconify:image:${key}`, async current => {
      const [prefix, name] = id.split(':');
      const url = new URL(`https://api.iconify.design/${prefix}/${name}.svg`);
      url.searchParams.set('height', '256');
      const response = await this.transport.fetch(url, ICON_MAX_BYTES, current);
      if (!response || response.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'image/svg+xml' || current.aborted) return null;
      let bytes: Buffer;
      try {
        bytes = await sharp(response.body, { limitInputPixels: 4096 * 4096, failOn: 'warning' })
          .resize({ width: 256, height: 256, fit: 'inside' }).webp().toBuffer();
      } catch { return null; }
      if (bytes.length > ICON_MAX_BYTES || current.aborted) return null;
      await writeIconFile(directory, `${key}.webp`, bytes);
      return { bytes, mediaType: 'image/webp' };
    }, signal);
  }
}
