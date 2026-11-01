# 2026-11-02：图标配置接口与 SQL 维护

## 实例故障修复

- 用户请求 `/api/v1/bookmarks/fe6e82c1-6bff-47a3-84ef-0fa12f61b5e7/icon-config`，修复前以独立临时会话实际复现 HTTP 500。
- 本地新版 API 连接 NC 的 `linkora` 应用库。数据库当时仅有初始和永久会话两次迁移，缺少 `public.bookmark_icons`，Prisma 返回 P2021。
- 修复前保存应用库备份：`.cache/migrations/linkora-before-icon-config-2026-11-01T161807962Z.dump`，94455 bytes、权限 0600，使用 pg_restore 列表检查验证可读；文件位于 Git 忽略的受保护目录。
- 执行 `pnpm db:migrate`，只补应用 `202611010001_bookmark_icons`。新表和枚举已生效，迁移成功登记；未重启本地 API，也未发布 Web/API 镜像。
- 修复后实际读回：icon-config 200、图标 200、图标库 200；书签/分类/标签数量及内容修订号与修复前一致。
- 诊断登录使用受保护配置中的现有凭据，创建独立会话并在检查后注销，没有输出 Cookie、CSRF 或密码。

## 迁移命令回归

原命令会把遗留空目录 `202611010001_custom_content_order` 传给 Prisma，导致 P3015。先新增命令级回归测试，复现空目录缺少 migration.sql 的失败，再修复迁移文件准备逻辑。

当前仅忽略真正的空目录，在临时 schema 副本中保留完整 SQL 和锁文件，不删除或修改源目录。非空目录缺少 migration.sql 继续报错；`--test` 的独立数据库选择保持原样。

## SQL 维护产物

- `docs/SQL/init.sql`：当前完整业务结构，最新版本 `202611010001_bookmark_icons`，仅用于空库，不包含账号或演示数据。
- `docs/SQL/变更记录/`：三份历史 SQL，与实际 Prisma 迁移逐字一致。
- `docs/SQL/README.md`：新装、升级顺序、事务执行、Prisma 官方 migrate resolve 登记及维护约定。
- `tests/sql-docs.test.mjs`：CI 检查迁移与历史 SQL 一一对应、内容一致、全量表和枚举覆盖、最新版本标记。

## 验证结果

| 检查 | 结果 |
| --- | --- |
| `pnpm test:delivery` | 9/9 通过，包含 3 项迁移命令和 2 项 SQL 文档检查 |
| `pnpm lint` | 0 错误，保留原 App.tsx:65 的 1 条 hook 警告 |
| `git diff --check` | 通过 |
| PostgreSQL 16 全量/逐次升级对比 | 8 张业务表的列、类型、NULL、默认值、约束、索引、枚举完全一致 |
| Prisma 手工初始化衔接 | 三个版本 resolve 后 migrate deploy 无待执行迁移 |

PostgreSQL 校验在 NC 的新隔离容器执行，目录 `/tmp/linkora-sql-check.pHDR9Q`，容器使用 network none、不发布端口；校验后容器及匿名数据卷随 --rm 清理。未操作共享 PG 服务或其他业务库。

实际校验输出：

```text
PASS PostgreSQL 16: init.sql 与三份历史 SQL 的列、类型、默认值、NULL、约束、索引、枚举完全一致（8 张业务表）
Prisma schema loaded from prisma/schema.prisma
Datasource "db": PostgreSQL database "init_test", schema "public" at "127.0.0.1:5432"

Migration 202610300001_initial marked as applied.

Prisma schema loaded from prisma/schema.prisma
Datasource "db": PostgreSQL database "init_test", schema "public" at "127.0.0.1:5432"

Migration 202610310001_permanent_sessions marked as applied.

Prisma schema loaded from prisma/schema.prisma
Datasource "db": PostgreSQL database "init_test", schema "public" at "127.0.0.1:5432"

Migration 202611010001_bookmark_icons marked as applied.

Prisma schema loaded from prisma/schema.prisma
Datasource "db": PostgreSQL database "init_test", schema "public" at "127.0.0.1:5432"

3 migrations found in prisma/migrations


No pending migrations to apply.
PASS Prisma: 手工全量初始化后按文档登记三个版本，再次 migrate deploy 无待执行迁移
```

## check-fix 影响分析

📝 变更摘要：修复迁移运行器的空目录处理，补齐 SQL 交付文件，并补执行当前实例缺失的图标结构迁移；风险等级中，实际应用库执行前已有备份。

🎯 直接影响：pnpm db:migrate、db:migrate:test、SQL 初始化和手工升级流程；图标业务接口代码无需修改。

🔗 间接影响：迁移工具输入保留全部真实迁移及校验和，测试库隔离不变，源空目录保留，缺失真实 SQL 仍然失败。

🧱 数据与兼容性：应用库仅新增图标表和枚举及一条迁移记录，业务记录数量与修订号保持一致；手工 SQL 后的 Prisma 历史登记已按文档实测。

🧪 测试与验证：先得到原接口 500 与空目录回归失败，再得到原接口 200、9 项检查通过和真实 PostgreSQL 16 结构一致性证据。

✅ 建议动作：当前实例已恢复，更新代码后的本地启动按 README 先执行迁移；后续每次 DDL 同步更新全量与增量 SQL。
