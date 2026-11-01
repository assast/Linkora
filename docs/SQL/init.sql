-- Linkora 全量初始化 SQL（PostgreSQL 16+）
-- 最新迁移：202611010001_bookmark_icons
-- 仅用于空数据库；包含当前全部业务表、枚举、索引及约束。
-- 不插入账号或演示数据；Prisma 迁移登记步骤见本目录 README.md。

BEGIN;

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "singleton" BOOLEAN NOT NULL DEFAULT true,
    "email" VARCHAR(254) NOT NULL,
    "password_hash" TEXT NOT NULL,
    "content_revision" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "token_hash" CHAR(64) NOT NULL,
    "user_id" UUID NOT NULL,
    "csrf_token" CHAR(64) NOT NULL,
    "expires_at" TIMESTAMPTZ,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("token_hash")
);

-- CreateTable
CREATE TABLE "categories" (
    "id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "parent_id" UUID,
    "name" VARCHAR(40) NOT NULL,
    "is_private" BOOLEAN NOT NULL DEFAULT false,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bookmarks" (
    "id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "category_id" UUID,
    "title" VARCHAR(200) NOT NULL,
    "url" VARCHAR(4096) NOT NULL,
    "description" VARCHAR(1000) NOT NULL DEFAULT '',
    "notes" TEXT NOT NULL DEFAULT '',
    "is_private" BOOLEAN NOT NULL DEFAULT false,
    "is_favorite" BOOLEAN NOT NULL DEFAULT false,
    "visit_count" INTEGER NOT NULL DEFAULT 0,
    "last_visited_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "bookmarks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tags" (
    "id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "name" VARCHAR(40) NOT NULL,
    "normalized_name" VARCHAR(40) NOT NULL,

    CONSTRAINT "tags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bookmark_tags" (
    "owner_id" UUID NOT NULL,
    "bookmark_id" UUID NOT NULL,
    "tag_id" UUID NOT NULL,

    CONSTRAINT "bookmark_tags_pkey" PRIMARY KEY ("bookmark_id","tag_id")
);

-- CreateTable
CREATE TABLE "user_preferences" (
    "user_id" UUID NOT NULL,
    "theme" TEXT NOT NULL DEFAULT 'light',
    "default_engine" TEXT NOT NULL DEFAULT 'google',
    "default_view" TEXT NOT NULL DEFAULT 'list',
    "expanded_categories" UUID[] DEFAULT ARRAY[]::UUID[],

    CONSTRAINT "user_preferences_pkey" PRIMARY KEY ("user_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_singleton_key" ON "users"("singleton");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "sessions_expires_at_idx" ON "sessions"("expires_at");

-- CreateIndex
CREATE INDEX "categories_owner_id_parent_id_idx" ON "categories"("owner_id", "parent_id");

-- CreateIndex
CREATE UNIQUE INDEX "categories_owner_id_id_key" ON "categories"("owner_id", "id");

-- CreateIndex
CREATE INDEX "bookmarks_owner_id_category_id_created_at_idx" ON "bookmarks"("owner_id", "category_id", "created_at");

-- CreateIndex
CREATE INDEX "bookmarks_owner_id_is_favorite_idx" ON "bookmarks"("owner_id", "is_favorite");

-- CreateIndex
CREATE UNIQUE INDEX "bookmarks_owner_id_id_key" ON "bookmarks"("owner_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "tags_owner_id_id_key" ON "tags"("owner_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "tags_owner_id_normalized_name_key" ON "tags"("owner_id", "normalized_name");

-- CreateIndex
CREATE INDEX "bookmark_tags_tag_id_idx" ON "bookmark_tags"("tag_id");

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "categories" ADD CONSTRAINT "categories_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "categories" ADD CONSTRAINT "categories_owner_id_parent_id_fkey" FOREIGN KEY ("owner_id", "parent_id") REFERENCES "categories"("owner_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "bookmarks" ADD CONSTRAINT "bookmarks_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookmarks" ADD CONSTRAINT "bookmarks_owner_id_category_id_fkey" FOREIGN KEY ("owner_id", "category_id") REFERENCES "categories"("owner_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "tags" ADD CONSTRAINT "tags_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookmark_tags" ADD CONSTRAINT "bookmark_tags_owner_id_bookmark_id_fkey" FOREIGN KEY ("owner_id", "bookmark_id") REFERENCES "bookmarks"("owner_id", "id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "bookmark_tags" ADD CONSTRAINT "bookmark_tags_owner_id_tag_id_fkey" FOREIGN KEY ("owner_id", "tag_id") REFERENCES "tags"("owner_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "user_preferences" ADD CONSTRAINT "user_preferences_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- PostgreSQL 16 constraints not expressible in the Prisma schema.
ALTER TABLE "users" ADD CONSTRAINT "users_singleton_true" CHECK ("singleton" = true);
ALTER TABLE "categories" ADD CONSTRAINT "categories_sibling_name_key" UNIQUE NULLS NOT DISTINCT ("owner_id", "parent_id", "name");
ALTER TABLE "categories" ADD CONSTRAINT "categories_not_self_parent" CHECK ("parent_id" IS NULL OR "parent_id" <> "id");
ALTER TABLE "bookmarks" ADD CONSTRAINT "bookmarks_visit_count_nonnegative" CHECK ("visit_count" >= 0);

-- 书签人工图标配置
CREATE TYPE "IconSource" AS ENUM ('AUTO', 'DASHBOARD', 'UPLOAD');

CREATE TABLE bookmark_icons (
  bookmark_id UUID PRIMARY KEY REFERENCES bookmarks(id) ON DELETE CASCADE,
  source "IconSource" NOT NULL,
  version UUID NOT NULL,
  dashboard_id VARCHAR(120),
  dashboard_commit CHAR(40),
  dashboard_format VARCHAR(4),
  upload_key UUID,
  CONSTRAINT bookmark_icon_source_fields CHECK (
    (source = 'AUTO' AND dashboard_id IS NULL AND dashboard_commit IS NULL AND dashboard_format IS NULL AND upload_key IS NULL)
    OR (source = 'DASHBOARD' AND dashboard_id IS NOT NULL AND dashboard_id ~ '^[a-z0-9][a-z0-9-]{0,119}$'
      AND dashboard_commit IS NOT NULL AND dashboard_commit ~ '^[a-f0-9]{40}$'
      AND dashboard_format IS NOT NULL AND dashboard_format IN ('png', 'webp') AND upload_key IS NULL)
    OR (source = 'UPLOAD' AND upload_key IS NOT NULL AND dashboard_id IS NULL AND dashboard_commit IS NULL AND dashboard_format IS NULL)
  )
);

COMMIT;
