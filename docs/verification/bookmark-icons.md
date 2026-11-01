# 书签图标管理验证记录

## 实施基线

- 变更：`add-bookmark-icon-management`，以工作区现有自动 Favicon 实现为基础。
- 开始实施时已存在 API/Web、部署和排序相关未提交修改，以及 OpenSpec 目录的索引删除；本轮不撤销这些改动。
- 实施前文件快照：本机 `/private/tmp/linkora-icon-baseline.C967z1`，不含环境凭据、缓存或依赖目录。
- 原 `add-bookmark-favicon-cache` 为 23/25：6.3 容器持久化和 7.2 E2E/镜像验证尚缺执行证据，原任务保持未完成。
- 本机依照既有约定不运行 Docker；容器相关任务须取得隔离运行证据后才能勾选。

## 检查结果

实施与验证过程中补充实际结果，不将静态配置或已生成测试当作执行通过。

- 重构前基线：Node.js 24.22.2 / pnpm 10.20.0，API 52/52、Web 20/20 通过；API 使用独立 NC 测试库，耗时约 462 秒。
- Dashboard Icons 固定提交：`83f32e08257b66fbd971ac8d7645f5b38d52e85d`，本地索引 4,518 项，包含上游许可文本。


## 最终检查结果

| 检查 | 实际结果 |
| --- | --- |
| `pnpm test` | API 74/74、Web 27/27，通过 |
| `pnpm typecheck` | API、Web、浏览器测试全部通过 |
| `pnpm lint` | 0 错误；已有 App.tsx:65 回调保留 1 条 hook 依赖警告 |
| `pnpm build` | Web/API 生产构建通过 |
| `pnpm test:delivery` | 4/4，通过 |
| `pnpm test:skill` | 9/9，通过 |
| `pnpm test:e2e` | Chrome/WebKit，1440×900 与 390×844，40/40，通过 |
| 新版及基线配对 Docker 镜像 | NC Linux 构建通过，本机未运行 Docker |
| 容器运行与恢复 | 重启、重建、失败冷却、上传持久化、只读降级、PG+上传卷恢复、回退及重新升级全部通过 |
| 上游单资源连通性 | 固定提交的 github.webp：HTTP 200、image/webp、14,502 bytes |
| OpenSpec | add-bookmark-icon-management 严格校验通过 |

本机测试使用 Node.js 24.22.2、pnpm 10.20.0 和本轮创建的临时 PostgreSQL 17 实例，测试库为 `linkora_icons_test`。原基线还在 NC PostgreSQL 16 上完成 52 项 API 测试；新增运行时交付检查在隔离 PostgreSQL 16 容器内完成。工作区原有空迁移目录 `202611010001_custom_content_order` 不含 migration.sql，不随 Git 交付；本机迁移验证使用 `.cache/icon-migration-schema` 副本，只复制真实迁移文件，未修改遗留目录。

本轮先用组件测试复现同 ID/URL 图标失败后无法恢复，再接入刷新代次。完整 E2E 进一步复现了原窄屏样式隐藏编辑侧栏的问题，修正为只隐藏原预览卡、保留图标设置后，四组组合全部通过。图片及网络测试使用受控夹具，不依赖公网站点；上游单资源连通性是额外只读 smoke，不作为测试套件前提。

## 隔离容器验收

- 主机：NC；目录 `/tmp/linkora-icons-check.JI0QR8`。
- 临时资源前缀：`linkora-icons-check-ji0qr8`，独立 PostgreSQL、网络与命名卷，无宿主机端口发布。
- NC 默认 Docker 地址池已满；检查全部网络及主机路由后，显式使用未冲突的 `172.16.16.0/28` 内部网络。
- 新 API 镜像：`linkora-icons-check:api-JI0QR8`，镜像 ID `sha256:b582755c3a9470dc0db5be70b0b01848b396d3f5183e4cc0322a1603629ab6a0`。
- 新 Web 镜像：`linkora-icons-check:web-JI0QR8`，镜像 ID `sha256:7149beefd60dd4fe2919070dc439b2352faab51f5ca3ced9869a7852ee73b400`。
- 回退使用实施前快照构建的 `baseline-api-JI0QR8` / `baseline-web-JI0QR8`，未对正式 latest 标签赋值或发布。
- 使用脚本 `scripts/verify-icons-containers.sh` 和 `scripts/verify-icons-runtime.mjs`，分别校验目标平台 sharp、三种图标来源、继承私密、缓存跨实例、Nginx 上传限制、只读卷失败保旧及一致备份恢复。
- 验收退出后临时容器、网络和四个卷均已清理；查询相同前缀无残留。正式 `linkora-api-1` 仍 healthy，Web/API 容器保持原有运行时间。

复现命令（先构建四个配对测试镜像，并将运行时脚本放到隔离验证目录；子网必须按目标主机重新检查）：

```sh
bash scripts/verify-icons-containers.sh /tmp/linkora-icons-check.JI0QR8 linkora-icons-check-ji0qr8 linkora-icons-check:api-JI0QR8 linkora-icons-check:web-JI0QR8 linkora-icons-check:baseline-api-JI0QR8 linkora-icons-check:baseline-web-JI0QR8 172.16.16.0/28
```

实际运行输出：

```text
PASS seed: 真实 Linux sharp、三种来源、继承私密、成功缓存及失败冷却
PASS seed: 上传及配置持久化、图片可读、私密授权、缓存降级
PASS proxy: 配对 Web/API、同源图片、代理上传上限及失败保旧
PASS check: 上传及配置持久化、图片可读、私密授权、缓存降级
PASS check: 上传及配置持久化、图片可读、私密授权、缓存降级
PASS restored: 上传及配置持久化、图片可读、私密授权、缓存降级
请求处理失败 Error
PASS readonly: 上传及配置持久化、图片可读、私密授权、缓存降级
PASS legacy: 旧 API 仍可读自动缓存，人工配置与上传资源保留
PASS check: 上传及配置持久化、图片可读、私密授权、缓存降级
PASS proxy: 配对 Web/API、同源图片、代理上传上限及失败保旧
PASS containers: 重启、重建、独立恢复、只读降级及配对镜像回退/重新升级
```

## 修复影响分析（check-fix）

📝 变更摘要：新增图标配置表、独立上传目录及三类管理接口，扩展原有同源图标读取；风险等级中，主要来自迁移和新增用户文件备份。

🎯 直接影响：编辑页、书签库刷新入口、统一 SiteIcon、JSON/FormData 请求封装、图标下载调度、删除后的资源清理及容器目录权限；均有对应 API、组件或 E2E 覆盖。

🔗 间接影响：同 origin 的未选中自动书签会共享新缓存；人工来源单独保存，刷新跳过。人工配置提交推进内容修订，自动读取/刷新不推进，已有内容预览的行为已经验证。

🧱 数据与兼容性：旧书签默认 AUTO；既有 CRUD 与 JSON 导出字段保留；原缓存格式保留。PG 与上传卷必须成套恢复；旧镜像显示自动图标，重新升级恢复人工配置，已在隔离环境验证。

🧪 测试与验证：101 项单元/集成、40 项 E2E、4 项交付、9 项管理客户端检查通过；运行时脚本验证了真正的 Linux 图片解码和 PostgreSQL 16 数据恢复。无本变更范围内未验证的交付任务。

✅ 建议动作：实现与验收完成，可进入 OpenSpec 归档；正式发布仍按配对镜像、数据库迁移和上传卷挂载流程执行，本轮未更新正式部署。

本轮临时 PostgreSQL 实例已停止，15439 测试端口已关闭；临时浏览器验证服务随测试退出。当前变更 38/38 完成，原自动 Favicon 变更 25/25 完成，两者均通过严格规范校验，尚未归档或更新正式部署。

2026-11-02 后续：当前本地实例的缺失迁移已补应用，并新增全量/增量 SQL 维护及校验；具体记录见 [接口修复与 SQL 维护](20261102-icon-config-and-sql.md)。
