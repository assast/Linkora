import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Transaction } from './database';
import type { Viewer } from './auth';
import { BookmarkQueryDto } from './dto';

export interface Scope { ownerId: string | null; includePrivate: boolean }
export interface CategoryView {
  id: string; parentId: string | null; name: string; isPrivate: boolean; effectivePrivate: boolean;
  inheritedPrivate: boolean; sortOrder: number; path: string; count: number; children: CategoryView[];
}
export interface BookmarkView {
  id: string; categoryId: string | null; title: string; url: string; description: string; notes: string;
  isPrivate: boolean; isFavorite: boolean; effectivePrivate: boolean; inheritedPrivate: boolean;
  visitCount: number; createdAt: Date; updatedAt: Date; lastVisitedAt: Date | null; categoryPath: string; tags: string[];
}

const BOOKMARK_FIELDS = Prisma.sql`
  b.id, b.title, b.url, b.description, b.notes, b.category_id AS "categoryId",
  b.is_private AS "isPrivate", b.is_favorite AS "isFavorite", b.effective_private AS "effectivePrivate",
  b.inherited_private AS "inheritedPrivate", b.visit_count AS "visitCount", b.created_at AS "createdAt",
  b.updated_at AS "updatedAt", b.last_visited_at AS "lastVisitedAt", b.category_path AS "categoryPath",
  COALESCE((SELECT array_agg(t.name::text ORDER BY t.normalized_name) FROM bookmark_tags bt
    JOIN tags t ON t.id = bt.tag_id AND t.owner_id = bt.owner_id WHERE bt.bookmark_id = b.id), ARRAY[]::text[]) AS tags`;

const SORT = {
  newest: Prisma.sql`b.created_at DESC, b.id ASC`, oldest: Prisma.sql`b.created_at ASC, b.id ASC`,
  title: Prisma.sql`b.title ASC, b.id ASC`, frequent: Prisma.sql`b.visit_count DESC, b.created_at DESC, b.id ASC`,
};

@Injectable()
export class Catalog {
  async context(tx: Transaction, viewer: Viewer): Promise<Scope> {
    const owner = await tx.user.findUnique({ where: { singleton: true }, select: { id: true } });
    return { ownerId: owner?.id || null, includePrivate: !!owner && viewer.ownerId === owner.id };
  }

  scopes(scope: Scope): Prisma.Sql {
    return Prisma.sql`WITH RECURSIVE category_scope AS (
      SELECT c.*, c.is_private AS effective_private, false AS inherited_private,
        c.name::text AS category_path, ARRAY[c.id] AS category_ids
      FROM categories c WHERE c.owner_id = ${scope.ownerId}::uuid AND c.parent_id IS NULL
      UNION ALL
      SELECT c.*, c.is_private OR p.effective_private, p.effective_private,
        (p.category_path || ' / ' || c.name)::text, p.category_ids || c.id
      FROM categories c JOIN category_scope p ON c.parent_id = p.id AND c.owner_id = p.owner_id
    ), bookmark_scope AS (
      SELECT b.*, b.is_private OR COALESCE(c.effective_private, false) AS effective_private,
        COALESCE(c.effective_private, false) AS inherited_private,
        COALESCE(c.category_path, '未分类') AS category_path,
        COALESCE(c.category_ids, ARRAY[]::uuid[]) AS category_ids
      FROM bookmarks b LEFT JOIN category_scope c ON b.category_id = c.id AND b.owner_id = c.owner_id
      WHERE b.owner_id = ${scope.ownerId}::uuid
    )`;
  }

  async assertCategory(tx: Transaction, scope: Scope, id: string) {
    const rows = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`${this.scopes(scope)}
      SELECT id FROM category_scope WHERE id = ${id}::uuid AND (${scope.includePrivate} OR NOT effective_private)`);
    if (!rows.length) throw new NotFoundException('分类不存在');
  }

  async categories(tx: Transaction, scope: Scope): Promise<CategoryView[]> {
    const rows = await tx.$queryRaw<Omit<CategoryView, 'children'>[]>(Prisma.sql`${this.scopes(scope)}
      SELECT c.id, c.parent_id AS "parentId", c.name, c.is_private AS "isPrivate", c.sort_order AS "sortOrder",
        c.effective_private AS "effectivePrivate", c.inherited_private AS "inheritedPrivate", c.category_path AS path,
        (SELECT COUNT(*)::int FROM bookmark_scope b WHERE c.id = ANY(b.category_ids)
          AND (${scope.includePrivate} OR NOT b.effective_private)) AS count
      FROM category_scope c WHERE (${scope.includePrivate} OR NOT c.effective_private)
      ORDER BY c.sort_order, c.name, c.id`);
    const nodes = new Map(rows.map(row => [row.id, { ...row, children: [] as CategoryView[] }]));
    const roots: CategoryView[] = [];
    for (const node of nodes.values()) {
      const parent = node.parentId ? nodes.get(node.parentId) : undefined;
      if (parent) parent.children.push(node); else roots.push(node);
    }
    return roots;
  }

  async list(tx: Transaction, scope: Scope, query: BookmarkQueryDto) {
    if (query.categoryId) await this.assertCategory(tx, scope, query.categoryId);
    const conditions: Prisma.Sql[] = [Prisma.sql`(${scope.includePrivate} OR NOT b.effective_private)`];
    if (query.categoryId) conditions.push(query.includeDescendants
      ? Prisma.sql`${query.categoryId}::uuid = ANY(b.category_ids)`
      : Prisma.sql`b.category_id = ${query.categoryId}::uuid`);
    if (query.keyword) {
      const pattern = '%' + query.keyword.replace(/[\\%_]/g, value => '\\' + value) + '%';
      conditions.push(Prisma.sql`concat_ws(' ', b.title, b.url, b.description, b.notes, b.category_path,
        (SELECT string_agg(t.name, ' ') FROM bookmark_tags bt JOIN tags t ON t.id = bt.tag_id AND t.owner_id = bt.owner_id
          WHERE bt.bookmark_id = b.id)) ILIKE ${pattern}`);
    }
    for (const id of query.tagIds) conditions.push(Prisma.sql`EXISTS (SELECT 1 FROM bookmark_tags bt WHERE bt.bookmark_id = b.id AND bt.tag_id = ${id}::uuid)`);
    if (query.favorite !== undefined) conditions.push(Prisma.sql`b.is_favorite = ${query.favorite}`);
    if (query.privacy !== 'all') conditions.push(Prisma.sql`b.effective_private = ${query.privacy === 'private'}`);
    const where = Prisma.join(conditions, ' AND ');
    const [count] = await tx.$queryRaw<{ total: number }[]>(Prisma.sql`${this.scopes(scope)} SELECT COUNT(*)::int AS total FROM bookmark_scope b WHERE ${where}`);
    const items = await tx.$queryRaw<BookmarkView[]>(Prisma.sql`${this.scopes(scope)} SELECT ${BOOKMARK_FIELDS}
      FROM bookmark_scope b WHERE ${where} ORDER BY ${SORT[query.sort]}
      LIMIT ${query.pageSize} OFFSET ${(query.page - 1) * query.pageSize}`);
    return { items, total: count.total, page: query.page, pageSize: query.pageSize };
  }

  async books(tx: Transaction, scope: Scope, ids: string[]) {
    if (!ids.length) return [];
    return tx.$queryRaw<BookmarkView[]>(Prisma.sql`${this.scopes(scope)} SELECT ${BOOKMARK_FIELDS}
      FROM bookmark_scope b WHERE b.id IN (${Prisma.join(ids.map(id => Prisma.sql`${id}::uuid`))})
      AND (${scope.includePrivate} OR NOT b.effective_private) ORDER BY b.id`);
  }

  async book(tx: Transaction, scope: Scope, id: string) {
    const [book] = await this.books(tx, scope, [id]);
    if (!book) throw new NotFoundException('书签不存在');
    return book;
  }

  async tags(tx: Transaction, scope: Scope) {
    return tx.$queryRaw<{ id: string; name: string; count: number }[]>(Prisma.sql`${this.scopes(scope)}
      SELECT t.id, t.name, COUNT(*)::int AS count FROM tags t
      JOIN bookmark_tags bt ON bt.tag_id = t.id AND bt.owner_id = t.owner_id
      JOIN bookmark_scope b ON b.id = bt.bookmark_id
      WHERE (${scope.includePrivate} OR NOT b.effective_private)
      GROUP BY t.id, t.name, t.normalized_name ORDER BY t.normalized_name, t.id`);
  }

  async home(tx: Transaction, scope: Scope) {
    const frequent = Object.assign(new BookmarkQueryDto(), { favorite: true, sort: 'frequent', pageSize: 10 });
    const recent = Object.assign(new BookmarkQueryDto(), { pageSize: 7 });
    const [counts] = await tx.$queryRaw<{ bookmarks: number; favorites: number; private: number; categories: number }[]>(Prisma.sql`${this.scopes(scope)}
      SELECT COUNT(*)::int AS bookmarks, COUNT(*) FILTER (WHERE is_favorite)::int AS favorites,
        COUNT(*) FILTER (WHERE effective_private)::int AS private,
        (SELECT COUNT(*)::int FROM category_scope WHERE (${scope.includePrivate} OR NOT effective_private)) AS categories
      FROM bookmark_scope WHERE (${scope.includePrivate} OR NOT effective_private)`);
    const { private: privateCount, ...publicCounts } = counts;
    return {
      frequent: (await this.list(tx, scope, frequent)).items,
      recent: (await this.list(tx, scope, recent)).items,
      counts: scope.includePrivate ? { ...publicCounts, private: privateCount } : publicCounts,
    };
  }
}
