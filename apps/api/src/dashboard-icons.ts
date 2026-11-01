import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import catalogue from './resources/dashboard-icons.json';
import { IconWorkQueue } from './icon-work';
import { iconHash, writeIconFile } from './icon-files';
import { ICON_MAX_BYTES, SafeIconTransport, validateIcon, type CachedIcon, type IconTransport } from './site-icons';

export interface DashboardEntry { id: string; name: string; formats: string[] }
export interface DashboardCatalogue { repository: string; commit: string; icons: DashboardEntry[] }
export interface DashboardReference { dashboardId: string | null; dashboardCommit: string | null; dashboardFormat: string | null }

export class DashboardIcons {
  private readonly entries: Map<string, DashboardEntry>;
  constructor(private readonly directory: string, readonly workQueue: IconWorkQueue,
    private readonly transport: IconTransport = new SafeIconTransport(), readonly index: DashboardCatalogue = catalogue) {
    this.entries = new Map(index.icons.map(entry => [entry.id, entry]));
  }

  search(keyword: string, page: number, pageSize: number) {
    const words = keyword.trim().toLowerCase().split(/\s+/);
    const matches = this.index.icons.filter(entry => words.every(word => `${entry.id} ${entry.name}`.toLowerCase().includes(word)));
    return { items: matches.slice((page - 1) * pageSize, page * pageSize).map(({ id, name }) => ({ id, name })), total: matches.length, page, pageSize };
  }

  entry(id: string) { return this.entries.get(id); }

  async select(id: string, signal?: AbortSignal) {
    const entry = this.entry(id);
    if (!entry) return null;
    for (const format of ['webp', 'png']) {
      if (!entry.formats.includes(format)) continue;
      const reference = { dashboardId: id, dashboardCommit: this.index.commit, dashboardFormat: format };
      const icon = await this.read(reference, signal);
      if (icon) return { reference, icon };
    }
    return null;
  }

  async read(reference: DashboardReference, signal?: AbortSignal): Promise<CachedIcon | null> {
    const { dashboardId: id, dashboardCommit: commit, dashboardFormat: format } = reference;
    if (!id || !/^[a-z0-9][a-z0-9-]{0,119}$/.test(id) || !commit || !/^[a-f0-9]{40}$/.test(commit) || !format || !['png', 'webp'].includes(format)) return null;
    const key = iconHash(`${commit}/${id}.${format}`);
    const directory = join(this.directory, 'dashboard');
    try {
      const cached = JSON.parse(await readFile(join(directory, `${key}.json`), 'utf8')) as { bytes: string; hash: string };
      const bytes = Buffer.from(cached.bytes, 'base64');
      if (iconHash(bytes) === cached.hash && validateIcon(bytes, `image/${format}`)) return { bytes, mediaType: `image/${format}` };
    } catch { /* Missing or corrupt cache is rebuilt from its pinned reference. */ }
    return this.workQueue.join(`dashboard:${key}`, async current => {
      const url = new URL(`https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons@${commit}/${format}/${id}.${format}`);
      const response = await this.transport.fetch(url, ICON_MAX_BYTES, current);
      const mediaType = response && validateIcon(response.body, response.headers['content-type']);
      if (!response || mediaType !== `image/${format}` || current.aborted) return null;
      const icon = { bytes: response.body, mediaType };
      await writeIconFile(directory, `${key}.json`, JSON.stringify({ hash: iconHash(icon.bytes), bytes: icon.bytes.toString('base64') }));
      return icon;
    }, signal);
  }
}
