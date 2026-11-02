# Linkora

参考 MarkSpace V3 的前后端分离书签系统。React + TypeScript + Vite 前端、NestJS 后端，连接 NC 的 PostgreSQL 16；单所有者管理，访客只读普通内容。

源码仓库：<https://github.com/assast/Linkora>，界面右上角的“项目源码”按钮也可直接打开仓库。

## 本地运行

使用 `.nvmrc` 指定的 Node.js 24.22.2 与 pnpm 10.20.0（可通过 Corepack 准备包管理器），复制 `.env.example` 为 `.env` 并配置独立的应用、测试数据库连接。测试库名必须以 `_test` 结尾，实际配置不要提交 Git。

```sh
pnpm install --frozen-lockfile
pnpm db:generate
pnpm db:migrate
pnpm dev
```

前端：<http://127.0.0.1:5173>。后端：<http://127.0.0.1:3000/api/v1/health>。API 文档：<http://127.0.0.1:5173/api/docs>，通过前端代理访问时与站点保持同源。

`scripts/local-service.sh` 支持 `start`、`restart`、`stop`、`status` 来管理后台开发服务。运行日志写入被 Git 忽略的 `.cache/local-service/linkora.log`。

更新包含数据库变更的代码后，先运行 `pnpm db:migrate`，再启动或重启本地服务。迁移命令会保留并忽略遗留空目录；非空目录缺少 `migration.sql` 时仍会报错。

完整建库 SQL 位于 [`docs/SQL/init.sql`](docs/SQL/init.sql)，每次 DDL 位于 [`docs/SQL/变更记录/`](docs/SQL/变更记录/)。手工初始化、按版本升级和 Prisma 迁移历史登记见 [SQL 维护说明](docs/SQL/README.md)。

应用默认没有演示账号和书签。首次设置账号时，在本地 `.env` 临时添加 `OWNER_EMAIL` 和 `OWNER_PASSWORD`（至少 8 位），执行 `pnpm owner:init`，然后移除初始密码配置。账号存在后初始化命令不会覆盖它。

## 隔离验证环境

```sh
pnpm db:migrate:test
pnpm test
pnpm dev:verify
```

`dev:verify` 使用 `TEST_DATABASE_URL` 直接启动本地前后端，不启动 Docker，也不写入应用数据库。API 测试只在独立测试库建立演示数据：测试邮箱 `owner@example.test`，测试密码 `Test-only-password-2026!`。这些是公开的测试夹具凭据，不能用作正式账号。

重新运行 API 测试会重建测试库夹具；验证模式中的收藏只用于测试。正式使用应初始化应用库账号后运行 `pnpm dev`。

## 检查

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm test:delivery
pnpm test:skill
pnpm build
```

浏览器验证在已启动的 `dev:verify` 环境运行，使用单工作进程，避免多个批量预览相互改变内容修订：

```sh
pnpm exec playwright install webkit
pnpm test:e2e
pnpm test:benchmark
```

本机 Chromium 项目使用已安装的 Google Chrome；CI 使用 Playwright 配套 Chromium。WebKit 覆盖桌面和移动尺寸。压力验证在测试库事务中临时建立 5,000 条书签，校验后回滚，不保留这些记录。

API 测试连接真实 PG，覆盖身份、继承私密、授权搜索/统计/标签、多级分类、并发防环、分页、预览修订与批量原子性。前端测试覆盖搜索编码、身份切换后的旧响应、请求错误与可访问弹层。

## 容器交付

Docker 镜像由 GitHub Actions 构建并发布到 GHCR，再部署到 NC；发布规则和验收记录见 [Git 镜像交付与 NC 验证](docs/deployment.md)。

- PR：检查、测试、生产构建与 Docker 构建检查，不发布镜像。
- `main`：检查成功后发布前后端 `sha-<完整提交>` 与 `latest` 镜像。
- `vX.Y.Z`：校验源码位于允许的发布分支，发布配对版本并更新 `latest`。
- 镜像名：`ghcr.io/assast/linkora-web` 与 `ghcr.io/assast/linkora-api`。
- Compose 仅运行 Web/API，复用 NC 的现有 PG；API 容器启动时先执行数据库迁移，失败则不启动服务。

将 `deploy/.env.example` 复制为 `deploy/.env`，填入镜像前缀、同一版本、NC 专用数据库和 HTTPS 站点地址，然后在目标服务器执行：

```sh
docker compose --env-file deploy/.env -f deploy/compose.yaml pull
docker compose --env-file deploy/.env -f deploy/compose.yaml up -d
sh deploy/init-owner.sh
```

`init-owner.sh` 交互读取初始邮箱与密码，不把密码写到命令行或 Git。Web 端口默认只绑定本机，生产 HTTPS 由现有入口代理提供；NC 上需要私网访问时，将绑定地址设为 NC 的私有地址。仅本机容器验证可以显式启用 `ALLOW_INSECURE_HTTP=true`。

### 书签图标

已保存书签通过同源 API 按需加载图标。API 从网站首页抓取，只接受通过校验的 PNG、JPEG、WebP 和 ICO 文件；成功结果缓存 30 天，抓取失败或目标被禁止时冷却 24 小时。抓取有资源限制，只连接公网目标。图片加载失败时保留首字母兜底，不会拖慢书签保存和列表读取。

已保存书签的编辑页可搜索选择 Dashboard Icons、上传图片或恢复自动。人工来源按书签保存，同站点书签可以设置不同图标；人工资源不可用时显示自动图标或首字母。上传接受不超过 2 MiB、最大边 4096 像素的 PNG/JPEG/WebP 静态图片，归一化为最长边 256 像素的 WebP。新增书签及已修改但未保存的网址需先保存，再设置图标。

书签库支持刷新选中或全库的自动图标，编辑页也可单条刷新。刷新按站点去重、共享最多 4 个执行槽，展示成功/失败/跳过结果，保留人工选择及刷新失败前的旧图。同站点的其他自动书签也会同步更新。任务在页面导航时继续，API 重启后需重新发起；完成结果保留 30 分钟。

`ICON_CACHE_DIR=.cache/site-icons` 保存可重建的自动/图标库缓存；`ICON_UPLOAD_DIR=.data/icon-uploads` 保存必须备份的上传图片，两者不可相同或嵌套。生产使用独立的 `site_icons`、`icon_uploads` 卷。本版增加图标配置表迁移，完整备份须同时保存 PostgreSQL 与上传卷；JSON 书签导出格式保持原样。清理缓存和恢复步骤见 [部署说明](docs/deployment.md)。

Dashboard Icons 的 4,518 项本地目录固定到上游提交 `83f32e08257b66fbd971ac8d7645f5b38d52e85d`，图片按需经服务端缓存。更新目录运行 `node scripts/update-dashboard-icons.mjs <完整上游提交>`，审阅生成的索引及许可后随应用交付；启动与普通镜像构建不依赖实时同步上游。

## 数据与权限

有效私密状态由书签自身、所属分类及所有祖先共同决定。搜索、分页总数、分类计数、标签和首页先做服务端授权。可能公开现有内容的修改必须先预览，内容修订变化会返回 409 要求重新确认。

默认每页 50、最多 100 条；多选只作用于当前页。批量更新全部成功或全部回滚，支持标签添加/移除/替换、设置/取消星标、移动、私密、删除和 JSON 导出。删除为确认后永久删除；回收站和浏览器/V3 导入不在本期范围。

书签默认使用卡片视图，视图选择保存在当前浏览器，刷新页面或登录、退出后继续沿用。分类页面可打开该分类及子分类中的全部可见书签，不受当前分页或搜索筛选限制；批量打开需要浏览器允许本站弹出窗口。

新增和编辑书签可填写可选的“地址2”，原地址仍必填。书签列表工具栏中的“访问地址”可统一选择“地址”或“地址2”；未配置地址2的书签始终使用原地址。该选择默认使用原地址，只在当前浏览器记忆，首页常用与最近收藏、编辑页访问及分类批量打开均遵循同一选择。两个地址共用书签的可见性设置，JSON 导出始终保留两个原始地址。

上线前保存 PG 原生备份，并验证恢复到独立空库后，分类引用、标签、私密规则及登录保持一致。应用回退使用已验证兼容当前数据库的前一配对镜像；如数据结构不兼容，需停止写入并恢复数据库备份，切换镜像不会自动回滚数据库。

具体步骤见 [Git 镜像交付与 NC 验证](docs/deployment.md)。

## Agent 管理技能

项目内提供 [linkora-management](skill/linkora-management/SKILL.md)，用于通过 API 管理分类、书签、标签、批量操作和导出，以及检查部署状态、备份和配对镜像版本。技能附带仅依赖 Python 3 标准库的客户端，处理会话 Cookie 与 CSRF；服务地址和凭据由运行环境提供。

让 agent 读取该 `SKILL.md`，或将 `skill/linkora-management` 安装到 agent 的技能目录后使用 `$linkora-management`。技能不包含正式凭据，也不会因读取而自动发布或部署。
