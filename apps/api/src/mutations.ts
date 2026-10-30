import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { Category } from '@prisma/client';
import { Database, Transaction } from './database';
import { Catalog } from './catalog';
import { BatchDto, BookmarkDto, BookmarkPatchDto, CategoryDto, CategoryPatchDto, ConfirmationDto, normalizeTags } from './dto';

type BookState = { id: string; title: string; categoryId: string | null; isPrivate: boolean };
type Change = { kind: 'category'; id: string; data: CategoryPatchDto }
  | { kind: 'bookmark'; id: string; data: BookmarkPatchDto }
  | { kind: 'batch'; data: BatchDto };
const BOOK_FIELDS = ['title', 'url', 'categoryId', 'description', 'notes', 'isPrivate', 'isFavorite'] as const;
const CATEGORY_FIELDS = ['name', 'parentId', 'isPrivate', 'sortOrder'] as const;
const defined = <T, K extends keyof T>(input: T, keys: readonly K[]): Pick<T, K> =>
  Object.fromEntries(keys.filter(key => input[key] !== undefined).map(key => [key, input[key]])) as Pick<T, K>;

function descendants(categories: Category[], root: string) {
  const result = new Set([root]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const category of categories) if (category.parentId && result.has(category.parentId) && !result.has(category.id)) {
      result.add(category.id); changed = true;
    }
  }
  return result;
}

function privacy(categories: Category[]) {
  const lookup = new Map(categories.map(category => [category.id, category]));
  const cache = new Map<string, boolean>();
  const get = (id: string | null): boolean => {
    if (!id) return false;
    if (cache.has(id)) return cache.get(id)!;
    const category = lookup.get(id);
    if (!category) throw new NotFoundException('分类不存在');
    const result = category.isPrivate || get(category.parentId);
    cache.set(id, result);
    return result;
  };
  return get;
}

function tagResult(current: string[], incoming: string[], mode: 'ADD_TAGS' | 'REMOVE_TAGS' | 'REPLACE_TAGS') {
  const remove = new Set(incoming.map(tag => tag.toLocaleLowerCase()));
  const names = mode === 'ADD_TAGS' ? [...current, ...incoming] : mode === 'REMOVE_TAGS'
    ? current.filter(tag => !remove.has(tag.toLocaleLowerCase())) : incoming;
  const result = normalizeTags(names) as string[];
  if (result.length > 20) throw new BadRequestException('每条书签最多 20 个标签');
  return result;
}

export interface Impact {
  revision: number; affectedBookmarks: number; affectedCategories: number; privateBookmarks: number;
  becomingPublicBookmarks: number; becomingPublicCategories: number; stillInheritedPrivate: number;
  summary: { id: string; title: string; isPrivate: boolean; willBePrivate: boolean }[];
}

@Injectable()
export class ContentMutations {
  constructor(private readonly db: Database, private readonly catalog: Catalog) {}

  private async impact(tx: Transaction, ownerId: string, revision: number, change: Change): Promise<Impact> {
    const categories = await tx.category.findMany({ where: { ownerId } });
    const books = await tx.bookmark.findMany({ where: { ownerId }, select: { id: true, title: true, categoryId: true, isPrivate: true } });
    const nextCategories = categories.map(category => ({ ...category }));
    const nextBooks = books.map(book => ({ ...book }));
    let affected: BookState[] = [];
    let affectedCategories = 0;
    const assertCategory = (id: string | null | undefined) => {
      if (id && !categories.some(category => category.id === id)) throw new NotFoundException('分类不存在');
    };
    if (change.kind === 'category') {
      const target = nextCategories.find(category => category.id === change.id);
      if (!target) throw new NotFoundException('分类不存在');
      const subtree = descendants(categories, change.id);
      if (change.data.parentId !== undefined) {
        assertCategory(change.data.parentId);
        if (change.data.parentId && subtree.has(change.data.parentId)) throw new BadRequestException('不能移动到自身或后代分类');
      }
      Object.assign(target, defined(change.data, CATEGORY_FIELDS));
      if (nextCategories.some(category => category.id !== target.id && category.parentId === target.parentId && category.name === target.name)) {
        throw new ConflictException('同级分类名称已存在');
      }
      affectedCategories = subtree.size;
      affected = books.filter(book => book.categoryId && subtree.has(book.categoryId));
    } else {
      const ids = new Set(change.kind === 'bookmark' ? [change.id] : change.data.bookmarkIds);
      affected = books.filter(book => ids.has(book.id));
      if (affected.length !== ids.size) throw new NotFoundException('部分书签不存在');
      if (change.kind === 'bookmark') {
        assertCategory(change.data.categoryId);
        Object.assign(nextBooks.find(book => book.id === change.id)!, defined(change.data, ['categoryId', 'isPrivate']));
      } else {
        const request = change.data;
        if (request.operation === 'MOVE_CATEGORY') {
          if (request.payload.categoryId === undefined) throw new BadRequestException('请选择目标分类或未分类');
          assertCategory(request.payload.categoryId);
          for (const book of nextBooks) if (ids.has(book.id)) book.categoryId = request.payload.categoryId;
        }
        if (['SET_FAVORITE', 'SET_PRIVACY'].includes(request.operation) && request.payload.value === undefined) throw new BadRequestException('缺少设置值');
        if (request.operation === 'SET_PRIVACY') for (const book of nextBooks) if (ids.has(book.id)) book.isPrivate = request.payload.value!;
        if (['ADD_TAGS', 'REMOVE_TAGS', 'REPLACE_TAGS'].includes(request.operation)) {
          if (!request.payload.tags) throw new BadRequestException('缺少标签集合');
          const existing = await tx.bookmarkTag.findMany({ where: { ownerId, bookmarkId: { in: [...ids] } }, include: { tag: true } });
          for (const id of ids) tagResult(existing.filter(link => link.bookmarkId === id).map(link => link.tag.name), request.payload.tags, request.operation as 'ADD_TAGS' | 'REMOVE_TAGS' | 'REPLACE_TAGS');
        }
      }
    }
    const before = privacy(categories), after = privacy(nextCategories);
    const nextLookup = new Map(nextBooks.map(book => [book.id, book]));
    const selected = new Set(affected.map(book => book.id));
    const will = new Map(nextBooks.filter(book => selected.has(book.id)).map(book => [book.id, book.isPrivate || after(book.categoryId)]));
    return {
      revision, affectedBookmarks: affected.length, affectedCategories,
      privateBookmarks: affected.filter(book => book.isPrivate || before(book.categoryId)).length,
      becomingPublicBookmarks: change.kind === 'batch' && change.data.operation === 'DELETE' ? 0
        : books.filter(book => (book.isPrivate || before(book.categoryId)) && !(nextLookup.get(book.id)!.isPrivate || after(nextLookup.get(book.id)!.categoryId))).length,
      becomingPublicCategories: categories.filter(category => before(category.id) && !after(category.id)).length,
      stillInheritedPrivate: nextBooks.filter(book => selected.has(book.id) && after(book.categoryId)).length,
      summary: affected.slice(0, 10).map(book => ({ id: book.id, title: book.title, isPrivate: book.isPrivate || before(book.categoryId), willBePrivate: will.get(book.id)! })),
    };
  }

  private confirm(impact: Impact, dto: ConfirmationDto, required = false) {
    const publicChange = impact.becomingPublicBookmarks > 0 || impact.becomingPublicCategories > 0;
    if ((required || publicChange || dto.expectedRevision !== undefined) && dto.expectedRevision !== impact.revision) {
      throw new ConflictException({ statusCode: 409, code: 'PREVIEW_EXPIRED', message: '内容已变化或尚未预览，请重新确认', preview: impact });
    }
    if (publicChange && !dto.confirmedPublic) throw new ConflictException({ statusCode: 409, code: 'PUBLIC_CONFIRMATION_REQUIRED', message: '此操作会公开内容，请确认影响范围', preview: impact });
  }

  preview(ownerId: string, change: Change) {
    return this.db.read(async tx => {
      const owner = await tx.user.findUniqueOrThrow({ where: { id: ownerId }, select: { contentRevision: true } });
      return this.impact(tx, ownerId, owner.contentRevision, change);
    });
  }

  createCategory(ownerId: string, dto: CategoryDto) {
    return this.db.write(ownerId, async tx => {
      if (dto.parentId && !await tx.category.findUnique({ where: { ownerId_id: { ownerId, id: dto.parentId } } })) throw new NotFoundException('父分类不存在');
      return tx.category.create({ data: { ownerId, ...defined(dto, CATEGORY_FIELDS) } });
    });
  }

  updateCategory(ownerId: string, id: string, dto: CategoryPatchDto) {
    return this.db.write(ownerId, async (tx, revision) => {
      this.confirm(await this.impact(tx, ownerId, revision, { kind: 'category', id, data: dto }), dto);
      return tx.category.update({ where: { ownerId_id: { ownerId, id } }, data: defined(dto, CATEGORY_FIELDS) });
    });
  }

  deleteCategory(ownerId: string, id: string) {
    return this.db.write(ownerId, async tx => {
      const category = await tx.category.findUnique({ where: { ownerId_id: { ownerId, id } } });
      if (!category) throw new NotFoundException('分类不存在');
      if (await tx.category.count({ where: { ownerId, parentId: id } }) || await tx.bookmark.count({ where: { ownerId, categoryId: id } })) {
        throw new ConflictException('请先移动分类内的书签和子分类');
      }
      await tx.category.delete({ where: { ownerId_id: { ownerId, id } } });
      return { deleted: true };
    });
  }

  private async setTags(tx: Transaction, ownerId: string, ids: string[], incoming: string[], mode: 'ADD_TAGS' | 'REMOVE_TAGS' | 'REPLACE_TAGS' = 'REPLACE_TAGS') {
    const current = await tx.bookmarkTag.findMany({ where: { ownerId, bookmarkId: { in: ids } }, include: { tag: true } });
    const target = new Map(ids.map(id => [id, tagResult(current.filter(link => link.bookmarkId === id).map(link => link.tag.name), incoming, mode)]));
    const names = new Map([...target.values()].flat().map(name => [name.toLocaleLowerCase(), name]));
    if (names.size) await tx.tag.createMany({ data: [...names].map(([normalizedName, name]) => ({ ownerId, normalizedName, name })), skipDuplicates: true });
    const tags = names.size ? await tx.tag.findMany({ where: { ownerId, normalizedName: { in: [...names.keys()] } } }) : [];
    const lookup = new Map(tags.map(tag => [tag.normalizedName, tag.id]));
    await tx.bookmarkTag.deleteMany({ where: { ownerId, bookmarkId: { in: ids } } });
    const links = [...target].flatMap(([bookmarkId, values]) => values.map(name => ({ ownerId, bookmarkId, tagId: lookup.get(name.toLocaleLowerCase())! })));
    if (links.length) await tx.bookmarkTag.createMany({ data: links, skipDuplicates: true });
  }

  createBookmark(ownerId: string, dto: BookmarkDto) {
    return this.db.write(ownerId, async tx => {
      if (dto.categoryId && !await tx.category.findUnique({ where: { ownerId_id: { ownerId, id: dto.categoryId } } })) throw new NotFoundException('分类不存在');
      const book = await tx.bookmark.create({ data: { ownerId, ...defined(dto, BOOK_FIELDS) } });
      if (dto.tags?.length) await this.setTags(tx, ownerId, [book.id], dto.tags);
      return this.catalog.book(tx, { ownerId, includePrivate: true }, book.id);
    });
  }

  updateBookmark(ownerId: string, id: string, dto: BookmarkPatchDto) {
    return this.db.write(ownerId, async (tx, revision) => {
      this.confirm(await this.impact(tx, ownerId, revision, { kind: 'bookmark', id, data: dto }), dto);
      await tx.bookmark.update({ where: { ownerId_id: { ownerId, id } }, data: defined(dto, BOOK_FIELDS) });
      if (dto.tags !== undefined) await this.setTags(tx, ownerId, [id], dto.tags);
      return this.catalog.book(tx, { ownerId, includePrivate: true }, id);
    });
  }

  deleteBookmark(ownerId: string, id: string) {
    return this.db.write(ownerId, async tx => {
      await tx.bookmark.delete({ where: { ownerId_id: { ownerId, id } } });
      return { deleted: true };
    });
  }

  applyBatch(ownerId: string, dto: BatchDto) {
    if (dto.operation === 'EXPORT') throw new BadRequestException('请使用导出接口');
    return this.db.write(ownerId, async (tx, revision) => {
      const impact = await this.impact(tx, ownerId, revision, { kind: 'batch', data: dto });
      this.confirm(impact, dto, true);
      const where = { ownerId, id: { in: dto.bookmarkIds } };
      switch (dto.operation) {
        case 'MOVE_CATEGORY': await tx.bookmark.updateMany({ where, data: { categoryId: dto.payload.categoryId } }); break;
        case 'SET_PRIVACY': await tx.bookmark.updateMany({ where, data: { isPrivate: dto.payload.value } }); break;
        case 'SET_FAVORITE': await tx.bookmark.updateMany({ where, data: { isFavorite: dto.payload.value } }); break;
        case 'ADD_TAGS': case 'REMOVE_TAGS': case 'REPLACE_TAGS': await this.setTags(tx, ownerId, dto.bookmarkIds, dto.payload.tags!, dto.operation); break;
        case 'DELETE':
          if (!dto.confirmedDelete) throw new BadRequestException('请确认永久删除');
          await tx.bookmark.deleteMany({ where }); break;
      }
      return { count: dto.bookmarkIds.length, revision: revision + 1 };
    });
  }

  export(ownerId: string, dto: BatchDto) {
    if (dto.operation !== 'EXPORT') throw new BadRequestException('导出操作类型不正确');
    return this.db.read(async tx => {
      const owner = await tx.user.findUniqueOrThrow({ where: { id: ownerId }, select: { contentRevision: true } });
      const impact = await this.impact(tx, ownerId, owner.contentRevision, { kind: 'batch', data: dto });
      this.confirm(impact, dto, true);
      if (impact.privateBookmarks && !dto.confirmedPrivateExport) throw new ConflictException({ statusCode: 409, code: 'PRIVATE_EXPORT_CONFIRMATION_REQUIRED', message: '导出包含私密内容，请确认', preview: impact });
      const books = await this.catalog.books(tx, { ownerId, includePrivate: true }, dto.bookmarkIds);
      const allCategories = await tx.category.findMany({ where: { ownerId } });
      const needed = new Set<string>();
      const lookup = new Map(allCategories.map(category => [category.id, category]));
      for (const book of books) {
        let id = book.categoryId;
        while (id && !needed.has(id)) { needed.add(id); id = lookup.get(id)!.parentId; }
      }
      return { formatVersion: 1, exportedAt: new Date().toISOString(), bookmarks: books,
        categories: allCategories.filter(category => needed.has(category.id)).map(category => defined(category, ['id', ...CATEGORY_FIELDS])) };
    });
  }
}
