import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { BookmarkIcon } from '@prisma/client';
import { Database } from './database';
import { bookmarkOrigin, isAllowedHttpTarget, SiteIconService } from './site-icons';
import type { IconRefreshDto } from './icon-dto';

interface Candidate { id: string; title: string; url: string; icon: BookmarkIcon | null }
type Status = 'success' | 'failed' | 'skipped';
interface Result { id: string; title: string; status: Status; reason: 'success' | 'failed' | 'manual' | 'blocked' | 'changed' }
interface Job {
  id: string; ownerId: string; state: 'queued' | 'running' | 'completed'; total: number; processed: number;
  success: number; failed: number; skipped: number; totalOrigins: number; processedOrigins: number;
  results: Result[]; completedAt: number | null;
}

@Injectable()
export class IconRefreshJobs {
  private readonly owners = new Map<string, { active?: Job; completed?: Job }>();
  constructor(private readonly db: Database, private readonly icons: SiteIconService) {}

  private owner(ownerId: string) {
    let state = this.owners.get(ownerId);
    if (!state) { state = {}; this.owners.set(ownerId, state); }
    if (state.completed?.completedAt && state.completed.completedAt + 30 * 60_000 <= Date.now()) state.completed = undefined;
    return state;
  }

  private view(job: Job, page = 1, pageSize = 24) {
    const { ownerId: _ownerId, results, completedAt: _completedAt, ...summary } = job;
    return { ...summary, results: results.slice((page - 1) * pageSize, page * pageSize), page, pageSize };
  }

  get(ownerId: string, id: string, page: number, pageSize: number) {
    const state = this.owner(ownerId);
    const job = [state.active, state.completed].find(item => item?.id === id);
    if (!job) throw new NotFoundException('刷新任务已中断或过期，请重新发起');
    return this.view(job, page, pageSize);
  }

  async create(ownerId: string, dto: IconRefreshDto) {
    if (dto.scope === 'all' && dto.bookmarkIds !== undefined) throw new BadRequestException('全库范围不能同时指定书签');
    const active = () => {
      const current = this.owner(ownerId).active;
      if (current) throw new ConflictException({ message: '已有图标刷新任务正在进行', jobId: current.id });
    };
    active();
    const candidates = await this.db.bookmark.findMany({ where: { ownerId, ...(dto.scope === 'selected' ? { id: { in: dto.bookmarkIds } } : {}) },
      select: { id: true, title: true, url: true, icon: true }, orderBy: { id: 'asc' } });
    if (dto.scope === 'selected' && candidates.length !== dto.bookmarkIds?.length) throw new NotFoundException('部分书签不存在');
    active();
    const job: Job = { id: randomUUID(), ownerId, state: 'queued', total: candidates.length, processed: 0, success: 0, failed: 0, skipped: 0,
      totalOrigins: 0, processedOrigins: 0, results: [], completedAt: null };
    this.owner(ownerId).active = job;
    void this.run(job, candidates);
    return this.view(job);
  }

  private async run(job: Job, candidates: Candidate[]) {
    const recorded = new Set<string>();
    const record = (book: Candidate, status: Status, reason: Result['reason']) => {
      if (recorded.has(book.id)) return;
      recorded.add(book.id); job.results.push({ id: book.id, title: book.title, status, reason }); job[status]++; job.processed++;
    };
    try {
      job.state = 'running';
      const groups = new Map<string, Candidate[]>();
      for (const book of candidates) {
        if (book.icon && book.icon.source !== 'AUTO') { record(book, 'skipped', 'manual'); continue; }
        const origin = bookmarkOrigin(book.url);
        if (!origin || !isAllowedHttpTarget(new URL(book.url))) { record(book, 'skipped', 'blocked'); continue; }
        const group = groups.get(origin) || []; group.push(book); groups.set(origin, group);
      }
      const pending = [...groups.values()];
      job.totalOrigins = pending.length;
      const current = async (group: Candidate[]) => {
        const books = await this.db.bookmark.findMany({ where: { ownerId: job.ownerId, id: { in: group.map(book => book.id) } }, select: { id: true, url: true, icon: true } });
        return group.filter(book => {
          const next = books.find(item => item.id === book.id);
          const valid = next && next.url === book.url && (next.icon?.version || null) === (book.icon?.version || null) && (!next.icon || next.icon.source === 'AUTO');
          if (!valid) record(book, 'skipped', 'changed');
          return !!valid;
        });
      };
      const worker = async () => {
        for (;;) {
          const group = pending.shift(); if (!group) return;
          let eligible = group;
          try {
            for (;;) {
              await this.icons.workQueue.waitForSlot();
              eligible = await current(eligible);
              if (!eligible.length) break;
              const result = await this.icons.refreshForBookmark(eligible[0].url);
              if (result.status === 'busy') continue;
              for (const book of await current(eligible)) record(book, result.status === 'blocked' ? 'skipped' : result.status, result.status);
              break;
            }
          } catch { for (const book of eligible) record(book, 'failed', 'failed'); }
          job.processedOrigins++;
        }
      };
      await Promise.all(Array.from({ length: 4 }, () => worker()));
    } catch { for (const book of candidates) record(book, 'failed', 'failed'); }
    finally {
      job.state = 'completed'; job.completedAt = Date.now();
      const state = this.owner(job.ownerId); state.active = undefined; state.completed = job;
    }
  }
}
