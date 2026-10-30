import 'reflect-metadata';
import { PrismaClient } from '@prisma/client';
import * as argon2 from 'argon2';
import { isEmail } from 'class-validator';

export async function initializeOwner(db: PrismaClient, email: string, password: string) {
  const normalized = email.trim().toLowerCase();
  if (!isEmail(normalized) || password.length < 8 || password.length > 1024) throw new Error('需要有效 OWNER_EMAIL 和 8 至 1024 位 OWNER_PASSWORD');
  if (await db.user.findFirst()) throw new Error('所有者已存在，拒绝覆盖账号');
  const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
  return db.user.create({ data: { email: normalized, passwordHash, preferences: { create: {} } }, select: { id: true, email: true } });
}

if (require.main === module) {
  const db = new PrismaClient();
  initializeOwner(db, process.env.OWNER_EMAIL || '', process.env.OWNER_PASSWORD || '')
    .then(() => { console.log('所有者初始化成功'); })
    .catch((error: unknown) => { console.error(error instanceof Error && !('code' in error) ? error.message : '所有者初始化失败'); process.exitCode = 1; })
    .finally(() => db.$disconnect());
}
