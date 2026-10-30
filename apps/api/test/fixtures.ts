import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { initializeOwner } from '../src/owner-init';

export const TEST_EMAIL = 'owner@example.test';
export const TEST_PASSWORD = 'Test-only-password-2026!';

export async function seedFixtures(db: PrismaClient) {
  if (process.env.NODE_ENV !== 'test' || !new URL(process.env.DATABASE_URL || '').pathname.endsWith('_test')) throw new Error('测试夹具只能写入独立测试库');
  await db.$executeRaw`TRUNCATE TABLE users CASCADE`;
  const owner = await initializeOwner(db, TEST_EMAIL, TEST_PASSWORD);
  const ids = Object.fromEntries(['root', 'front', 'back', 'node', 'nest', 'private', 'privateChild', 'empty', 'github', 'react', 'secret', 'inherited', 'unclassified', 'deep', 'codeTag', 'privateTag', 'backendTag', 'typescriptTag'].map(name => [name, randomUUID()])) as Record<string, string>;
  await db.category.createMany({ data: [
    { id: ids.root, name: '开发工具', parentId: null },
    { id: ids.front, name: '前端开发', parentId: ids.root },
    { id: ids.back, name: '后端开发', parentId: ids.root },
    { id: ids.node, name: 'Node.js', parentId: ids.back },
    { id: ids.nest, name: 'NestJS', parentId: ids.node },
    { id: ids.private, name: '个人收藏', parentId: null, isPrivate: true },
    { id: ids.privateChild, name: '私人资料', parentId: ids.private },
    { id: ids.empty, name: '待整理', parentId: null },
  ].map(category => ({ ...category, ownerId: owner.id })) });
  await db.bookmark.createMany({ data: [
    { id: ids.github, title: 'GitHub', url: 'https://github.com/', description: '代码托管与开源项目', categoryId: ids.root, isFavorite: true, visitCount: 12 },
    { id: ids.react, title: 'React', url: 'https://react.dev/', description: '构建用户界面的组件库', categoryId: ids.front, isFavorite: true, visitCount: 8 },
    { id: ids.secret, title: '显式私密网址', url: 'https://example.test/secret-marker', categoryId: ids.root, isPrivate: true },
    { id: ids.inherited, title: '继承私密笔记', url: 'https://example.test/inherited-marker', categoryId: ids.privateChild },
    { id: ids.unclassified, title: '内部工作台', url: 'http://localhost:8080/', categoryId: null, notes: '工作100% 中文备注' },
    { id: ids.deep, title: 'NestJS 文档', url: 'https://docs.nestjs.com/', description: '高效的 Node.js 服务端框架', categoryId: ids.nest },
  ].map((book, index) => ({ ...book, ownerId: owner.id, createdAt: new Date(Date.now() - index * 86400000) })) });
  await db.tag.createMany({ data: [
    { id: ids.codeTag, name: '代码', normalizedName: '代码' },
    { id: ids.privateTag, name: '独有私密标签', normalizedName: '独有私密标签' },
    { id: ids.backendTag, name: '后端', normalizedName: '后端' },
    { id: ids.typescriptTag, name: 'TypeScript', normalizedName: 'typescript' },
  ].map(tag => ({ ...tag, ownerId: owner.id })) });
  await db.bookmarkTag.createMany({ data: [
    [ids.github, ids.codeTag], [ids.inherited, ids.privateTag], [ids.secret, ids.privateTag],
    [ids.deep, ids.backendTag], [ids.deep, ids.typescriptTag],
  ].map(([bookmarkId, tagId]) => ({ ownerId: owner.id, bookmarkId, tagId })) });
  return { ownerId: owner.id, ids };
}
