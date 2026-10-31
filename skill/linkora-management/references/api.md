# Linkora API

所有接口前缀为 `/api/v1`，客户端命令中的路径省略此前缀。运行中的契约可从站点 `/api/docs` 或 `/api/docs-json` 核对；源码为仓库 `apps/api/src/controllers.ts` 与 `dto.ts`。

## 认证与错误

- `POST /auth/login`：`{email,password}`；`Origin` 必须等于服务端 `SITE_URL` 的源。
- `GET /auth/me`：返回 `authenticated`、所有者身份与 `csrfToken`。
- `POST /auth/logout`：注销当前会话。
- 会话 Cookie 为 `linkora_session`，HttpOnly，作用路径 `/api`，默认 7 天。所有者的非 GET 请求同时携带 Cookie、`Origin`、`X-CSRF-Token`；登录只要求可信来源。
- 无注册、改密或导入接口。首次账号由部署端 `owner:init` 初始化，已有账号时拒绝覆盖。
- 400：字段或操作参数错误；401：需要登录；403：来源/CSRF 错误；404：访客不可见或 ID 不存在；409：过期修订、重名或仍被引用；429：登录限流；503：数据库未就绪。
- 不反复尝试密码。先核对来源、凭据来源和登录限流，不能通过更换 IP 或关闭校验绕过。

客户端不会跟随 HTTP 重定向。站点入口返回 301/302 时，核对并直接配置最终 HTTPS 源；不要向跳转目的地转发会话。客户端只接受当前站点的 API 路径，不接受外部 URL。

## 读取

| 方法与路径 | 用途 |
|---|---|
| `GET /health` | 应用及数据库就绪；验证环境额外含 `verification:true` |
| `GET /home` | 星标常用、最近收藏、授权统计 |
| `GET /categories/tree` | 分类树、路径、计数与继承私密状态 |
| `GET /bookmarks` | 分页组合查询 |
| `GET /bookmarks/:id` | 单条详情 |
| `GET /tags` | 当前身份可见标签 |
| `GET /preferences` | 所有者偏好 |

列表参数：`categoryId`、`includeDescendants=true`、`keyword`（最多 500 字符）、`tagIds`（逗号分隔 UUID）、`favorite=true|false`、`privacy=all|private|public`、`sort=newest|oldest|title|frequent`、`page=1`、`pageSize=50`（最多 100）。多标签全部匹配。响应为 `{items,total,page,pageSize}`，遍历时按页读取，不把第一页当全库。

查询词需要 URL 编码，可通过 Python `urllib.parse.urlencode` 构造路径，避免把中文、`&` 等直接拼进查询参数。访客返回的数量、标签和搜索结果都已授权过滤；私密 ID 与未知 ID 都返回 404。

## 单项管理

| 方法与路径 | 请求要点 |
|---|---|
| `POST /categories` | `{name,parentId,isPrivate,sortOrder}` |
| `POST /categories/:id/preview` | 与 PATCH 相同的变更字段，只读预览 |
| `PATCH /categories/:id` | 只传需变更字段；公开变化带修订号和确认 |
| `DELETE /categories/:id` | 只能删除空分类；无请求体 |
| `POST /bookmarks` | `{title,url,categoryId,description,notes,tags,isPrivate,isFavorite}` |
| `POST /bookmarks/:id/preview` | 与 PATCH 相同的变更字段，只读预览 |
| `PATCH /bookmarks/:id` | 只传需变更字段；公开变化带修订号和确认 |
| `DELETE /bookmarks/:id` | 永久删除，无请求体；事先核对用户授权 |
| `POST /bookmarks/:id/visits` | 增加所有者访问次数，无请求体；查询不调用 |
| `PATCH /preferences` | `theme=light|dark`、`defaultEngine=google|bing|baidu|duck|github`、`defaultView=list|grid`、`expandedCategories`（UUID 数组） |

`parentId:null` 表示根分类，`categoryId:null` 表示未分类。分类名最多 40、标题 200、URL 4096、简介 1000、备注 10000 字符。URL 必须为绝对 HTTP/HTTPS，可保存内网地址；服务端不抓取网页。标签为字符串数组，最多 20 个，每个 40 字符；去首尾空格、去空、忽略大小写去重。

请求 JSON 写入临时文件，通过 `--body-file` 传入，不在 shell 中拼接：

```sh
python3 scripts/linkora.py request POST /bookmarks --body-file /tmp/linkora-create.json --apply
python3 scripts/linkora.py request POST /bookmarks/BOOKMARK_UUID/preview --body-file /tmp/linkora-edit.json
python3 scripts/linkora.py request PATCH /bookmarks/BOOKMARK_UUID --body-file /tmp/linkora-edit-confirmed.json --apply
```

将占位 ID 换成实际 UUID。私密内容的请求文件及导出使用 `umask 077`，仅保存在用户指定的本地位置。客户端不会生成或自动补齐业务确认字段。

## 批量与导出

1. `POST /bookmarks/batch/preview`：只读。
2. `POST /bookmarks/batch`：提交更新或删除。
3. `POST /bookmarks/export`：提交 `EXPORT`，返回 JSON 文件内容。

预览请求示例：

```json
{
  "operation": "MOVE_CATEGORY",
  "bookmarkIds": ["实际书签 UUID"],
  "payload": {"categoryId": "实际目标分类 UUID"}
}
```

| operation | payload |
|---|---|
| `MOVE_CATEGORY` | `{categoryId:UUID|null}` |
| `ADD_TAGS` / `REMOVE_TAGS` / `REPLACE_TAGS` | `{tags:["标签"]}`；REPLACE 可用空数组清空 |
| `SET_FAVORITE` / `SET_PRIVACY` | `{value:true|false}`；私密设置只改自身标志 |
| `DELETE` / `EXPORT` | `{}` 或省略 |

每批 1–100 个去重 ID，明确列出所选记录。预览响应包含 `revision`、`affectedBookmarks`、`affectedCategories`、`privateBookmarks`、`becomingPublicBookmarks`、`becomingPublicCategories`、`stillInheritedPrivate` 和最多 10 条 `summary`。

提交保留相同操作/ID/payload，加上 `expectedRevision:预览的revision`；删除加 `confirmedDelete:true`；变公开加 `confirmedPublic:true`；含私密的导出加 `confirmedPrivateExport:true`。这些字段必须来自实际预览与用户授权，不能把示例中的布尔值当作默认同意。

```sh
python3 scripts/linkora.py request POST /bookmarks/batch/preview --body-file /tmp/linkora-batch.json
python3 scripts/linkora.py request POST /bookmarks/batch --body-file /tmp/linkora-batch-confirmed.json --apply
umask 077
python3 scripts/linkora.py request POST /bookmarks/export --body-file /tmp/linkora-export-confirmed.json --apply > /tmp/linkora-export.json
```

批量修改在一个 PG 事务中全成或全败，无部分成功。导出包含格式版本、时间、选中书签、标签与必要分类祖先，保留原始私密标志；不含账号凭据。JSON 导出只备份选中内容，完整服务恢复仍需 PG 原生备份。
