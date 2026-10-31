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

按当前实施顺序先完成本地服务验证。Docker 镜像由 GitHub Actions 构建并发布到 GHCR 后，再到 NC 验证运行。项目远端为 `https://github.com/assast/Linkora`；实际推送、首次发布及 NC 容器验收尚未执行。

- PR：检查、测试、生产构建与 Docker 构建检查，不发布镜像。
- `main`：检查成功后发布前后端 `sha-<完整提交>` 镜像。
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

## 数据与权限

有效私密状态由书签自身、所属分类及所有祖先共同决定。搜索、分页总数、分类计数、标签和首页先做服务端授权。可能公开现有内容的修改必须先预览，内容修订变化会返回 409 要求重新确认。

默认每页 50、最多 100 条；多选只作用于当前页。批量更新全部成功或全部回滚，支持标签添加/移除/替换、设置/取消星标、移动、私密、删除和 JSON 导出。删除为确认后永久删除；回收站和浏览器/V3 导入不在本期范围。

书签默认使用卡片视图，视图选择保存在当前浏览器，刷新页面或登录、退出后继续沿用。分类页面可打开该分类及子分类中的全部可见书签，不受当前分页或搜索筛选限制；批量打开需要浏览器允许本站弹出窗口。

上线前保存 PG 原生备份，并验证恢复到独立空库后，分类引用、标签、私密规则及登录保持一致。应用回退使用已验证兼容当前数据库的前一配对镜像；如数据结构不兼容，需停止写入并恢复数据库备份，切换镜像不会自动回滚数据库。

具体步骤见 [Git 镜像交付与 NC 验证](docs/deployment.md)。

## Agent 管理技能

项目内提供 [linkora-management](skill/linkora-management/SKILL.md)，用于通过 API 管理分类、书签、标签、批量操作和导出，以及检查部署状态、备份和配对镜像版本。技能附带仅依赖 Python 3 标准库的客户端，处理会话 Cookie 与 CSRF；服务地址和凭据由运行环境提供。

让 agent 读取该 `SKILL.md`，或将 `skill/linkora-management` 安装到 agent 的技能目录后使用 `$linkora-management`。技能不包含正式凭据，也不会因读取而自动发布或部署。
