# Git 镜像交付与 NC 验证

当前执行顺序是先本地直启验证，后由 Git 平台打包镜像，再到 NC 验证容器。以下是后续发布步骤；配置文件已准备，不代表镜像已经构建、推送或在 NC 运行。

## 发布输入

- 代码仓库为 <https://github.com/assast/Linkora>，本地 `origin` 使用该地址。工作流使用 GitHub Actions + GHCR；首次发布前确认 Actions 权限及镜像可见性。
- 配对发布 `ghcr.io/assast/linkora-web` 与 `ghcr.io/assast/linkora-api`，部署配置使用 `IMAGE_REPOSITORY=ghcr.io/assast/linkora`，两个镜像使用同一个 `sha-<完整提交>` 或 `vX.Y.Z` 标签。
- Web 直接通过 `http://10.144.144.10:8080` 提供访问，并加入现有 `proxy_network`，由 Traefik 按 `nav.icio.eu.org` 路由。正式登录源使用 `https://nav.icio.eu.org`；域名的 Cloudflare Tunnel 公开主机名需指向现有 Traefik HTTP 入口。
- `main` 发布提交标签，稳定版本发布才更新 `latest`；版本标签的提交必须在允许的发布分支中。
- NC 复用已有 PostgreSQL 16，应用库/角色为 `linkora`，隔离测试库/角色为 `linkora_test`。不停止或重建共享 PG 服务。

## 部署到 NC

1. 在 NC 的 Dockge stacks 下为本项目创建独立目录，放置 `deploy/compose.yaml` 和私有环境配置；当前 NC stacks 位于 `/docker/dockge/stacks/`。
2. 按 `deploy/.env.example` 配置镜像前缀、配对版本、数据库连接和 `https://nav.icio.eu.org` 站点地址。私有镜像使用仅有拉取权限的凭据登录镜像仓库。
3. 确认 `10.144.144.10:8080` 未占用；Web 同时加入 `proxy_network`。Cloudflare Tunnel 的 `nav.icio.eu.org` 公开主机名指向 Traefik HTTP 入口，`SITE_URL` 必须与浏览器访问源相同。
4. 执行 Compose 拉取和启动。API 先部署迁移，成功后启动；Web 等待 API 健康检查通过。
5. 用 `deploy/init-owner.sh` 初始化唯一所有者；已有账号时命令拒绝覆盖。正式账号和数据不加载测试夹具。
6. 以访客和所有者分别验证首页、列表、搜索、分类统计、私密直达请求和批量操作，再核对镜像源码提交标签。

## PG 原生备份与独立恢复演练

以下命令在 NC 终端执行。文件权限通过 `umask` 限制，数据库管理员身份从现有容器环境读取，不在命令中填写密码。

```sh
umask 077
mkdir -p /root/linkora-backups
LINKORA_BACKUP_FILE="/root/linkora-backups/linkora-$(date -u +%Y%m%dT%H%M%SZ).dump"
docker exec ai-postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d linkora -Fc' > "$LINKORA_BACKUP_FILE"
```

恢复演练使用新的空测试库。将 `LINKORA_BACKUP_FILE` 设为需要恢复的备份路径；若示例库名已存在，先选择另一个独立测试库名，不覆盖现有库：

```sh
docker exec ai-postgres sh -c 'createdb -U "$POSTGRES_USER" -O linkora_test linkora_restore_test'
docker exec -i ai-postgres pg_restore -U linkora_test -d linkora_restore_test --no-owner --no-acl --single-transaction --exit-on-error < "$LINKORA_BACKUP_FILE"
docker exec ai-postgres psql -U linkora_test -d linkora_restore_test -c 'SELECT count(*) AS bookmarks FROM bookmarks; SELECT count(*) AS categories FROM categories; SELECT count(*) AS tags FROM tags;'
```

用同版本应用镜像连接恢复库，并以未占用的独立端口运行验证实例。检查所有者登录、分类层级、标签关联、显式/继承私密、列表/统计及导出。不能只按行数相等判断恢复成功。

## 应用回退与数据库回退

每次发布前记录当前 Web/API 镜像标签、迁移状态并保存数据库备份。新迁移优先保持对前一应用版本兼容。

如果前一应用版本兼容当前数据结构，在本项目的部署环境文件中同时修改两个应用版本，拉取并更新服务即可；不要单独回退其中一个应用。

若数据结构不兼容，先停止本项目 API 写入，把备份恢复到新的专用数据库并完成验证，再将配对应用与连接一起切回。切换旧镜像不会自动撤销数据库迁移；不对 NC 其他数据库或共享 PG 服务执行重置。

## 待实机记录

代码仓库已确定为 <https://github.com/assast/Linkora>。首次 CI 运行、镜像可见性与标签/摘要、NC 容器健康状态、恢复核对和回退演练结果，在 Git 打包后的 NC 验证阶段补入。当前不能提前填写为通过。
