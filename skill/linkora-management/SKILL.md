---
name: linkora-management
description: 管理已运行的 Linkora 单所有者书签服务：通过 API 查询和整理书签、分类、标签、星标与私密内容，执行批量预览及导出，检查部署状态、备份和配对镜像版本。适用于日常内容管理和服务运维。
---

# Linkora 服务管理

源码：<https://github.com/assast/Linkora>。这是 React + NestJS + PostgreSQL 的单所有者服务，访客只能读取公开内容。

## 选择操作方式

- 整理收藏、调整分类、批量修改、导出：使用 API，先读 [references/api.md](references/api.md)。附带的 [scripts/linkora.py](scripts/linkora.py) 仅依赖 Python 3 标准库，处理 Cookie、Origin 和 CSRF。
- 排查健康、日志、版本，发布、备份或恢复：先读 [references/operations.md](references/operations.md)，定位用户指定的主机和部署目录。不要把本地验证地址当成生产地址，也不要假定服务已经部署。

## 连接与会话

从现有私有配置获取 `LINKORA_BASE_URL`（站点根地址，必须与服务端 `SITE_URL` 同源）、`LINKORA_EMAIL` 和 `LINKORA_PASSWORD`。密码通过受保护的环境注入或交互输入，不放在命令行、文档、Git 或回复里。缺少服务地址时先定位现有部署配置；只有无法确定时才询问用户。

以下命令从技能目录运行；在仓库根目录运行时加上 `skill/linkora-management/` 前缀：

```sh
python3 scripts/linkora.py --anonymous request GET /health
python3 scripts/linkora.py login
python3 scripts/linkora.py request GET '/bookmarks?page=1&pageSize=50'
python3 scripts/linkora.py request GET /categories/tree
```

`login` 可交互输入邮箱和密码；已有环境凭据时无需交互。默认请求使用所有者会话，过期时仅在已配置环境凭据的情况下重新登录一次；缺少凭据则明确失败。访客检查必须加 `--anonymous`，它不会读取所有者 Cookie。客户端按站点隔离缓存会话，目录默认 `~/.cache/linkora`，可用 `LINKORA_SESSION_DIR` 指定；目录权限为 0700，Cookie 文件为 0600。`logout` 撤销当前会话并清理缓存。

## 修改规则

1. 先读取实际 ID、所属分类和原始 `isPrivate`，再构造操作。业务整理通过 API，不直接改 PG 表。
2. 单项移动分类、调整私密及批量操作先调用对应的 `POST .../preview`。检查总影响数量、公开变化与 `revision`，不能只看最多 10 条的摘要。
3. 在用户已授权的范围内提交相同操作，带上最新 `expectedRevision` 和相应确认字段。实际写入及导出需要客户端 `--apply`；该参数表示执行意图，无须在已有授权下重复向用户索要批准。
4. 删除是永久删除。未明确授权删除、公开私密内容或导出私密数据时，先给出具体对象、数量与影响供用户确认；不能自动补齐这些确认来扩大范围。
5. 遇到 409 重新预览。如果影响仍在已授权范围内，可使用新修订再提交一次；范围扩大或连续冲突时停止并说明。网络超时后先读回核对，不能盲目重放写请求。
6. 写入后读回记录/数量；涉及可见性变化时，再用 `--anonymous` 检查访客结果。报告实际完成项和未完成项，不输出凭据、Cookie、CSRF 或未请求的私密内容。

`isPrivate` 是自身标志，`effectivePrivate` 包含祖先继承。取消自身私密不一定公开；移出私密祖先可能公开整棵后代树。保留这一区别，不能把派生状态写回自身标志。
