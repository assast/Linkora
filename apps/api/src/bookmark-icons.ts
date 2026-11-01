import { BadRequestException, ConflictException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import type { BookmarkIcon, Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { Database } from './database';
import { DashboardIcons } from './dashboard-icons';
import { IconUploads, type IconUpload } from './icon-uploads';
import type { IconConfigDto } from './icon-dto';

export const iconConfigView = (config: BookmarkIcon | null) => ({ source: config?.source.toLowerCase() || 'auto', version: config?.version || null,
  dashboardId: config?.dashboardId || null, uploaded: config?.source === 'UPLOAD' });

@Injectable()
export class BookmarkIcons {
  constructor(private readonly db: Database, private readonly library: DashboardIcons, private readonly uploads: IconUploads) {}

  readConfig(bookmarkId: string) { return this.db.bookmarkIcon.findUnique({ where: { bookmarkId } }); }

  private async own(ownerId: string, id: string) {
    if (!await this.db.bookmark.findUnique({ where: { ownerId_id: { ownerId, id } }, select: { id: true } })) throw new NotFoundException('书签不存在');
  }

  async config(ownerId: string, id: string) { await this.own(ownerId, id); return iconConfigView(await this.readConfig(id)); }

  private async commit(ownerId: string, id: string, expectedVersion: string | null, data: Pick<Prisma.BookmarkIconUncheckedCreateInput, 'source'> & Partial<Pick<Prisma.BookmarkIconUncheckedCreateInput, 'dashboardId' | 'dashboardCommit' | 'dashboardFormat' | 'uploadKey'>>) {
    const { config, old } = await this.db.write(ownerId, async tx => {
      if (!await tx.bookmark.findUnique({ where: { ownerId_id: { ownerId, id } } })) throw new NotFoundException('书签不存在');
      const old = await tx.bookmarkIcon.findUnique({ where: { bookmarkId: id } });
      if ((old?.version || null) !== expectedVersion) throw new ConflictException({ code: 'ICON_CONFIG_CHANGED', message: '图标已在其他页面修改，请重新加载后重试' });
      const next = { dashboardId: null, dashboardCommit: null, dashboardFormat: null, uploadKey: null, ...data, version: randomUUID() };
      const config = await tx.bookmarkIcon.upsert({ where: { bookmarkId: id }, create: { bookmarkId: id, ...next }, update: next });
      await tx.bookmark.update({ where: { id }, data: { updatedAt: new Date() } });
      return { config, old };
    });
    if (old?.uploadKey) await this.uploads.removeMany([old]);
    return iconConfigView(config);
  }

  async select(ownerId: string, id: string, dto: IconConfigDto) {
    await this.own(ownerId, id);
    if (dto.source === 'auto') {
      if (dto.dashboardId !== undefined) throw new BadRequestException('自动来源不接受图标库条目');
      return this.commit(ownerId, id, dto.expectedVersion, { source: 'AUTO' });
    }
    if (!dto.dashboardId || !this.library.entry(dto.dashboardId)) throw new BadRequestException('图标库条目不存在');
    const selected = await this.library.select(dto.dashboardId, AbortSignal.timeout(10_000));
    if (!selected) throw new ServiceUnavailableException('暂时无法下载此图标，请选择其他图标或稍后重试');
    return this.commit(ownerId, id, dto.expectedVersion, { source: 'DASHBOARD', ...selected.reference });
  }

  async upload(ownerId: string, id: string, expectedVersion: string | null, file: IconUpload) {
    await this.own(ownerId, id);
    const uploadKey = await this.uploads.prepare(id, file);
    try { return await this.commit(ownerId, id, expectedVersion, { source: 'UPLOAD', uploadKey }); }
    catch (error) { await this.uploads.removeMany([{ bookmarkId: id, uploadKey }]); throw error; }
  }

  image(config: BookmarkIcon, signal: AbortSignal) {
    if (config.source === 'UPLOAD') return this.uploads.read(config.bookmarkId, config.uploadKey);
    if (config.source === 'DASHBOARD') return this.library.read(config, signal);
    return Promise.resolve(null);
  }
}
