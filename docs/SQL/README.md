# 数据库结构与升级 SQL

适用 PostgreSQL 16 及以上。此目录与 `apps/api/prisma/migrations/` 同步维护：

- [init.sql](init.sql)：当前完整业务结构，供空数据库初始化；包含表、枚举、索引、外键与检查约束，按当前最终定义建表。
- [变更记录](变更记录/)：每次结构变更的原始 SQL，文件名与 Prisma 迁移版本一一对应，按名称升序执行。

脚本仅定义结构，账号由应用现有的 `owner:init` 流程初始化。

## 版本顺序

| 版本 | SQL | 内容 |
| --- | --- | --- |
| `202610300001_initial` | [初始结构](变更记录/202610300001_initial.sql) | 用户、会话、分类、书签、标签、关联、偏好与完整约束 |
| `202610310001_permanent_sessions` | [永久会话](变更记录/202610310001_permanent_sessions.sql) | 会话到期时间允许 NULL |
| `202611010001_bookmark_icons` | [书签图标](变更记录/202611010001_bookmark_icons.sql) | 图标来源枚举、按书签保存的图标配置及来源字段约束 |
| `202611020001_secondary_url` | [书签地址2](变更记录/202611020001_secondary_url.sql) | 为书签增加可空的 `url2`，已有原地址保持不变 |
| `202611020002_iconify_source` | [Iconify 图标来源](变更记录/202611020002_iconify_source.sql) | 新增 `ICONIFY` 来源与 `iconify_id`，已有图标配置保持不变 |
| `202611020003_display_preferences` | [显示偏好](变更记录/202611020003_display_preferences.sql) | 书签、分类字号及工作空间导航显示设置，旧用户默认全部显示 |

`init.sql` 已覆盖以上所有版本。初始化后无需再次执行这些增量 SQL。

## 推荐：由 Prisma 执行升级

更新代码并备份应用数据库后，在仓库根目录运行：

```sh
pnpm db:migrate
```

该命令读取 `.env` 中的应用库连接，执行尚未应用的迁移并登记历史。检查生效后再启动或重启应用。容器的 API 启动脚本同样会先执行迁移。

已有 Prisma 管理的数据库，可查询当前版本：

```sql
SELECT migration_name, finished_at
FROM _prisma_migrations
WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
ORDER BY migration_name;
```

## 手工执行 SQL

先配置 `psql` 的数据库连接参数，通过交互密码、`.pgpass` 或受保护的环境提供凭据。

空库执行全量初始化：

```sh
psql -v ON_ERROR_STOP=1 -f docs/SQL/init.sql
```

已有数据库只执行当前版本之后的增量文件。例如已经完成永久会话版本，需要升级书签图标：

```sh
psql -v ON_ERROR_STOP=1 --single-transaction -f docs/SQL/变更记录/202611010001_bookmark_icons.sql
```

增量 SQL 与对应 Prisma 文件内容一致。`--single-transaction` 保证一份升级中的 DDL 一起成功或一起回滚；使用数据库图形工具时，也应在一个事务中执行整份增量文件。执行前核对当前版本，避免重复执行已经应用的文件。

### 同步 Prisma 迁移历史

应用使用 Prisma，因此手工执行 SQL 后还需要登记已执行的版本。使用 Prisma 的 `migrate resolve`，不要手工修改 `_prisma_migrations` 表。

在仓库根目录登记刚刚手工执行的图标升级：

```sh
node --env-file-if-exists=.env apps/api/node_modules/prisma/build/index.js migrate resolve --applied 202611010001_bookmark_icons --schema apps/api/prisma/schema.prisma
```

如果是用 `init.sql` 初始化的新库，依次登记它已经覆盖的六个版本：

```sh
node --env-file-if-exists=.env apps/api/node_modules/prisma/build/index.js migrate resolve --applied 202610300001_initial --schema apps/api/prisma/schema.prisma
node --env-file-if-exists=.env apps/api/node_modules/prisma/build/index.js migrate resolve --applied 202610310001_permanent_sessions --schema apps/api/prisma/schema.prisma
node --env-file-if-exists=.env apps/api/node_modules/prisma/build/index.js migrate resolve --applied 202611010001_bookmark_icons --schema apps/api/prisma/schema.prisma
node --env-file-if-exists=.env apps/api/node_modules/prisma/build/index.js migrate resolve --applied 202611020001_secondary_url --schema apps/api/prisma/schema.prisma
node --env-file-if-exists=.env apps/api/node_modules/prisma/build/index.js migrate resolve --applied 202611020002_iconify_source --schema apps/api/prisma/schema.prisma
node --env-file-if-exists=.env apps/api/node_modules/prisma/build/index.js migrate resolve --applied 202611020003_display_preferences --schema apps/api/prisma/schema.prisma
pnpm db:migrate
```

最后一次迁移检查应提示没有待执行迁移。已经由 Prisma 成功登记的版本无需再次 resolve。

使用 API 镜像时，可通过 `docker compose run --rm --no-deps --entrypoint node api` 调用镜像里的 `node_modules/prisma/build/index.js migrate resolve`，并使用 `--schema prisma/schema.prisma`；连接沿用该服务环境配置。

## 维护约定

1. 每次新增 DDL，新增一个 Prisma 迁移，并把同一份 SQL 保存为 `变更记录/<迁移版本>.sql`。
2. 同时更新 `init.sql` 为变更后的完整结构，更新其最新版本标记和本页版本列表。
3. 已发布的历史 SQL 保持原样；后续修正通过新的增量 SQL 提供。
4. 同一次提交包含 Prisma 迁移、增量 SQL、全量 SQL 和必要的升级说明。
5. `pnpm test:delivery` 检查历史 SQL 与实际迁移一致、全量表/枚举覆盖及最新版本标记。DDL 变更还应在隔离空库和旧版本测试库中分别验证初始化、升级和最终结构一致性。
