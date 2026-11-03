# Git 镜像交付与 NC 验证

当前执行顺序是先本地直启验证，后由 Git 平台打包镜像，再到 NC 验证容器。以下是后续发布步骤；配置文件已准备，不代表镜像已经构建、推送或在 NC 运行。

## 发布输入

- 代码仓库为 <https://github.com/assast/Linkora>，本地 `origin` 使用该地址。工作流使用 GitHub Actions + GHCR；首次发布前确认 Actions 权限及镜像可见性。
- 配对发布 `ghcr.io/assast/linkora-web` 与 `ghcr.io/assast/linkora-api`，部署配置使用 `IMAGE_REPOSITORY=ghcr.io/assast/linkora`。`main` 检查成功后发布 `sha-<完整提交>` 和 `latest`；稳定版本标签发布 `vX.Y.Z` 和 `latest`。NC 使用 `APP_VERSION=latest`，需要固定提交时可改用同一个 SHA 标签。
- Web 直接通过 `http://10.144.144.10:8080` 提供访问，并加入现有 `proxy_network`，由 Traefik 按 `nav.icio.eu.org` 路由。应用隔离网络使用 `172.16.15.0/24`，避免与 NC 已分配的 Docker 子网冲突。主站登录源使用 `https://nav.icio.eu.org`，内网登录源通过 `ALLOWED_ORIGINS` 显式添加；域名的 Cloudflare Tunnel 公开主机名需指向现有 Traefik HTTP 入口。
- `main` 和有效稳定版本标签都会更新配对镜像的 `latest`；版本标签的提交必须在允许的发布分支中。
- NC 复用已有 PostgreSQL 16，应用库/角色为 `linkora`，隔离测试库/角色为 `linkora_test`。不停止或重建共享 PG 服务。

## 部署到 NC

1. 在 NC 的 Dockge stacks 下为本项目创建独立目录，放置 `deploy/compose.yaml` 和私有环境配置；当前 NC stacks 位于 `/docker/dockge/stacks/`。
2. 按 `deploy/.env.example` 配置镜像前缀、配对版本、数据库连接和 `https://nav.icio.eu.org` 站点地址。私有镜像使用仅有拉取权限的凭据登录镜像仓库。
3. 确认 `10.144.144.10:8080` 未占用及 `172.16.15.0/24` 无冲突；Web 同时加入 `proxy_network`。Cloudflare Tunnel 的 `nav.icio.eu.org` 公开主机名指向 Traefik HTTP 入口。浏览器登录来源必须与 `SITE_URL` 或 `ALLOWED_ORIGINS` 中的一个来源相同；生产启用 HTTP 来源时须设置 `ALLOW_INSECURE_HTTP=true`。
4. 执行 Compose 拉取和启动。API 先部署迁移，成功后启动；Web 等待 API 健康检查通过。
5. 用 `deploy/init-owner.sh` 初始化唯一所有者；已有账号时命令拒绝覆盖。正式账号和数据不加载测试夹具。
6. 以访客和所有者分别验证首页、列表、搜索、分类统计、私密直达请求和批量操作，再核对镜像源码提交标签。

## 域名与内网 IP 同时登录

部署环境文件使用以下配置；`SITE_URL` 自动加入白名单，`ALLOWED_ORIGINS` 只需填写额外来源，多个来源用逗号分隔：

```env
SITE_URL=https://nav.icio.eu.org
ALLOWED_ORIGINS=http://10.144.144.10:8080
ALLOW_INSECURE_HTTP=true
```

来源包含协议、主机和端口，不填写路径、查询、凭据或通配符。未设置 `ALLOWED_ORIGINS` 时保持原有单来源行为。`ALLOW_INSECURE_HTTP=true` 只允许启用已明确配置的 HTTP 登录入口，不会自动放行其他内网地址，也不会取消域名入口 Cookie 的 Secure 属性。HTTP 入口的凭据和会话没有传输加密，应仅通过可信私网访问。

API 根据白名单和请求 Host 为登录、永久会话续期及退出选择 Cookie 属性；反向代理必须保留浏览器访问时的 Host（含非默认端口），现有 Nginx 已通过 `proxy_set_header Host $http_host` 保留。域名入口保持 Secure，内网 HTTP 入口使用不含 Secure 的 Cookie，两者均保留 HttpOnly、SameSite=Lax 和 `/api` 路径。两个入口分别登录、分别退出，写操作继续要求可信 Origin 和正确的 CSRF。

更新到包含此功能的镜像，并同步更新 `compose.yaml` 中的 `ALLOWED_ORIGINS` 环境变量传递后，重新创建 API 容器使配置生效：

```sh
docker compose --env-file deploy/.env -f deploy/compose.yaml up -d api
```

如只使用 HTTPS 域名，清空 `ALLOWED_ORIGINS` 并将 `ALLOW_INSECURE_HTTP` 设为 `false`。

## 图标数据与缓存

API 镜像为运行用户 `node` 创建两个独立可写目录：`ICON_CACHE_DIR=/app/data/site-icons` 对应 `site_icons` 缓存卷，`ICON_UPLOAD_DIR=/app/data/icon-uploads` 对应 `icon_uploads` 用户上传卷。目录不可相同或嵌套，均不作为静态资源公开。自动抓取的 PNG/JPEG/WebP/ICO 成功缓存 30 天，失败或禁止结果冷却 24 小时；Dashboard PNG/WebP 依据固定上游提交按需缓存。

上传入口接受最多 2 MiB 的静态 PNG/JPEG/WebP，最大边 4096 像素，服务端归一化为最长边 256 像素的 WebP。Nginx 允许 3 MiB 完整请求以容纳 multipart 开销，API 独立限制文件大小。镜像内需交付固定图标库索引和 sharp 原生依赖；目标平台必须实际运行一次图片解码验证。

如需重建这份可丢弃的缓存，先停止并移除 API 容器，再删除该卷，然后重新启动 API。已保存书签会在后续展示时按需重建图标：

```sh
docker compose --env-file deploy/.env -f deploy/compose.yaml stop api
docker compose --env-file deploy/.env -f deploy/compose.yaml rm -f api
docker volume rm linkora_site_icons
docker compose --env-file deploy/.env -f deploy/compose.yaml up -d api
```

如果 Compose 项目名称改变，先检查 `docker compose ... config --volumes`，再删除对应项目的 `site_icons` 卷。这里只能删除可重建缓存，必须保留 `icon_uploads`。本版新增 `bookmark_icons` 表和来源约束迁移，旧书签无需回填、默认自动。回退时使用上一版配对 Web/API，保留新增表与上传卷；旧版本暂时只显示自动图标，重新升级后恢复人工选择。

图标刷新任务只作用于自动来源，按 origin 共享结果、限制并发，失败保留旧图。全库范围包含私密书签且不受当前页面筛选限制。任务不跨 API 重启续跑，进度丢失时重新发起；已完成的缓存仍在。Dashboard 索引随应用交付，更新命令为 `node scripts/update-dashboard-icons.mjs <40 位上游提交>`；已有人工选择保留原提交。

## PG 原生备份与独立恢复演练

以下命令在 NC 终端执行。完整备份必须将 PG dump 和上传卷归入同一备份集，并在暂停本项目 API 写入期间取得；缓存卷无需备份。文件权限通过 `umask` 限制，数据库管理员身份从现有容器环境读取，不在命令中填写密码。

```sh
umask 077
mkdir -p /root/linkora-backups
LINKORA_BACKUP_FILE="/root/linkora-backups/linkora-$(date -u +%Y%m%dT%H%M%SZ).dump"
docker compose --env-file deploy/.env -f deploy/compose.yaml stop api
docker exec ai-postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d linkora -Fc' > "$LINKORA_BACKUP_FILE"
docker compose --env-file deploy/.env -f deploy/compose.yaml run --rm --no-deps --entrypoint sh api -c 'tar -czf - -C "$ICON_UPLOAD_DIR" .' > "${LINKORA_BACKUP_FILE%.dump}.uploads.tar.gz"
docker compose --env-file deploy/.env -f deploy/compose.yaml start api
```

恢复演练使用新的空测试库。将 `LINKORA_BACKUP_FILE` 设为需要恢复的备份路径；若示例库名已存在，先选择另一个独立测试库名，不覆盖现有库：

```sh
docker exec ai-postgres sh -c 'createdb -U "$POSTGRES_USER" -O linkora_test linkora_restore_test'
docker exec -i ai-postgres pg_restore -U linkora_test -d linkora_restore_test --no-owner --no-acl --single-transaction --exit-on-error < "$LINKORA_BACKUP_FILE"
docker exec ai-postgres psql -U linkora_test -d linkora_restore_test -c 'SELECT count(*) AS bookmarks FROM bookmarks; SELECT count(*) AS categories FROM categories; SELECT count(*) AS tags FROM tags;'
```

同时将对应的 `.uploads.tar.gz` 恢复到新的专用上传卷，保持运行用户 `node` 可读写；不要覆盖正在使用的上传卷。用同版本应用镜像连接恢复库及新上传卷，并以未占用的独立端口运行验证实例。检查所有者登录、分类层级、标签关联、显式/继承私密、列表/统计、导出、图标配置及实际上传图片。不能只按行数相等判断恢复成功。

恢复上传卷可用目标 API 镜像中的 tar，将归档只读挂载到临时容器、将新空上传卷挂载到 `/restore`，解包后将该目录归属设为 `node:node`。记录配对镜像版本、备份时间和两个备份文件的校验和。PG 与上传文件必须来自同一备份集；仅有 PG dump 或 JSON 导出无法完整恢复自定义图片。

## 应用回退与数据库回退

每次发布前记录当前 Web/API 镜像标签、迁移状态并保存数据库备份。新迁移优先保持对前一应用版本兼容。

如果前一应用版本兼容当前数据结构，在本项目的部署环境文件中同时修改两个应用版本，拉取并更新服务即可；不要单独回退其中一个应用。

若数据结构不兼容，先停止本项目 API 写入，把备份恢复到新的专用数据库并完成验证，再将配对应用与连接一起切回。切换旧镜像不会自动撤销数据库迁移；不对 NC 其他数据库或共享 PG 服务执行重置。

## NC 首轮部署记录

首轮 NC 部署已完成，记录如下：

- Git 提交：`236b43590f5137290964c38efbb4a5ebe5c56630`；[GitHub Actions](https://github.com/assast/Linkora/actions/runs/41169878479) 的检查、两个 Docker 构建与两个 GHCR 发布 job 全部通过。
- 配对镜像：`ghcr.io/assast/linkora-web:sha-236b43590f5137290964c38efbb4a5ebe5c56630` 与 `ghcr.io/assast/linkora-api:sha-236b43590f5137290964c38efbb4a5ebe5c56630`。
- NC stack：`/docker/dockge/stacks/linkora`；私有环境文件权限为 `0600`；部署前 PostgreSQL 备份为 `/root/linkora-backups/linkora-before-40a36a0.dump`（93,761 bytes，权限 `0600`）。
- Web/API 容器正常运行，API health 为 `ok`；私网入口 `http://10.144.144.10:8080` 返回 HTTP 200，`https://nav.icio.eu.org` 返回 Linkora 页面且 API health 为 `ok`。
- 域名所有者登录通过：57 个分类、784 个书签、702 次历史点击、20 个星标；访客看到 300 个公开书签，私密书签直达为 404。管理技能客户端通过域名登录并安全退出。

NC 空库备份恢复演练，以及兼容数据库的配对镜像回退尚未执行；见 OpenSpec 任务 9.4 和 9.7。
