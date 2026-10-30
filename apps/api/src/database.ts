import { ConflictException, Global, Injectable, Module, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';

export type Transaction = Prisma.TransactionClient;

@Injectable()
export class Database extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  async onModuleInit() { await this.$connect(); }
  async onModuleDestroy() { await this.$disconnect(); }

  read<T>(work: (tx: Transaction) => Promise<T>) {
    return this.$transaction(work, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 15000 });
  }

  write<T>(ownerId: string, work: (tx: Transaction, revision: number) => Promise<T>) {
    return this.$transaction(async tx => {
      const [owner] = await tx.$queryRaw<{ contentRevision: number }[]>`
        SELECT content_revision AS "contentRevision" FROM users WHERE id = ${ownerId}::uuid FOR UPDATE`;
      if (!owner) throw new ConflictException('所有者不存在');
      const result = await work(tx, owner.contentRevision);
      await tx.user.update({ where: { id: ownerId }, data: { contentRevision: { increment: 1 } } });
      return result;
    }, { timeout: 15000 });
  }
}

@Global()
@Module({ providers: [Database], exports: [Database] })
export class DatabaseModule {}
