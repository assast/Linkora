# Linkora 运维

## 定位服务

- 仓库：<https://github.com/assast/Linkora>；发布说明：<https://github.com/assast/Linkora/blob/main/docs/deployment.md>。
- Web/API 镜像：`ghcr.io/assast/linkora-web`、`ghcr.io/assast/linkora-api`，使用同一 `sha-完整提交` 或 `vX.Y.Z`。
- 部署环境前缀：`IMAGE_REPOSITORY=ghcr.io/assast/linkora`；`APP_VERSION` 同时控制两个镜像。
- NC 复用 PostgreSQL 16，既有容器名为 `ai-postgres`，应用库/角色 `linkora`，隔离测试库/角色 `linkora_test`。操作前检查实际环境是否仍一致。
- NC 原有 Dockge stacks 根目录 `/docker/dockge/stacks/`；Linkora 的具体 stack 目录、SSH 主机别名、生产域名需从现有配置或用户处确定，不能凭此推定已部署。
- 本地开发默认站点 `http://127.0.0.1:5173`、API `http://127.0.0.1:3000`。仓库 `pnpm dev` 使用应用库，`pnpm dev:verify` 使用隔离测试库。本机直接启动验证；Docker 镜像经 Git 打包后到 NC 验证。

## 健康与故障定位

先用客户端匿名检查 `/health`，再检查首页/列表。503 通常表示数据库未就绪；403 优先核对 `LINKORA_BASE_URL` 是否与 `SITE_URL` 同源、反代是否保留 Cookie。生产使用 HTTPS，Cookie Secure 不能通过 HTTP 正常工作。

以下只在已确认的部署主机执行。设置 `LINKORA_STACK_DIR` 为实际包含 `.env` 与 `compose.yaml` 的目录；在仓库目录执行时改用 `deploy/.env`、`deploy/compose.yaml`：

```sh
linkora_compose() {
  docker compose --project-directory "$LINKORA_STACK_DIR" --env-file "$LINKORA_STACK_DIR/.env" -f "$LINKORA_STACK_DIR/compose.yaml" "$@"
}
linkora_compose ps
linkora_compose config --images
linkora_compose logs --tail 100 api web
```

仅摘取相关日志并脱敏，不输出完整环境文件、`docker inspect` 环境或未经筛选的 `compose config`，这些会包含数据库凭据。API 容器启动前运行 Prisma 迁移；迁移失败时解决错误，不用重置数据库绕过。

没有账号时，在用户授权的首次初始化范围内运行仓库提供的 `deploy/init-owner.sh`；先核对脚本的 Compose 路径。镜像内的实际入口为 `node dist/owner-init.js`，通过受保护环境传入 `OWNER_EMAIL` 和 `OWNER_PASSWORD`，运行镜像不依赖 pnpm。已有所有者不能通过此命令覆盖，不直接编辑密码哈希。

## 发布与回退

仅在用户要求发布/升级时执行。先核对 Git 提交、CI 状态、镜像平台、配对标签/摘要、现有版本和数据库备份。私有 GHCR 镜像使用仅有拉取权限的凭据。主分支发布提交标签，稳定 `vX.Y.Z` 才更新 `latest`；生产优先固定已验证标签。

修改部署配置中的配对版本后：

```sh
linkora_compose pull
linkora_compose up -d
linkora_compose ps
```

核对健康、Web 页面、所有者登录与访客私密边界。服务重启后检查记录仍在，不把仅有健康响应视为完整验收。记录实际提交、镜像版本和检查结果。

回退也同时切换 Web/API。只有前一版本兼容现有数据库结构时才能直接切镜像；否则停止本项目写入，把备份恢复到新的专用库并验证后再切换连接。镜像回退不会撤销数据库迁移。

## 备份与恢复

完整备份使用 PG 原生 dump。以下在 NC 执行，从容器环境读取管理员身份，不填写明文密码：

```sh
umask 077
mkdir -p /root/linkora-backups
LINKORA_BACKUP_FILE="/root/linkora-backups/linkora-$(date -u +%Y%m%dT%H%M%SZ).dump"
docker exec ai-postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d linkora -Fc' > "$LINKORA_BACKUP_FILE"
```

确认备份命令成功且文件非空。恢复演练选择未存在的独立空库，例如 `linkora_restore_test`；已有同名库时换新名称，不覆盖：

```sh
docker exec ai-postgres sh -c 'createdb -U "$POSTGRES_USER" -O linkora_test linkora_restore_test'
docker exec -i ai-postgres pg_restore -U linkora_test -d linkora_restore_test --no-owner --no-acl --single-transaction --exit-on-error < "$LINKORA_BACKUP_FILE"
```

用同版本应用连接恢复库，绑定独立端口，核对分类引用、标签、所有者登录、显式/继承私密、列表与导出。备份含私密内容及会话数据，不能提交 Git 或随意发送给外部服务。

NC 的 PG 为共享服务：不停止/重建 `ai-postgres`，不执行 Prisma reset，不使用 `compose down -v`，不清理其他 stack 或数据库。测试与演练只使用专用测试/恢复库。
