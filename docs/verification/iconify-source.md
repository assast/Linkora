# Iconify 图标来源验证

## 实现范围

书签编辑页的“从图标库选择”新增来源选择，保留 Dashboard Icons，并接入 [Iconify](https://icon-sets.iconify.design/)。切换来源清空选择、关键词和分页；再次打开时带回已保存来源与图标。搜索延迟 300 ms 发出，查询缓存包含来源，迟到的其他来源响应不会覆盖当前列表。

Iconify 搜索和图片下载均由服务端请求官方 API。图片经 sharp 转为静态 WebP，写入现有缓存目录，再由已有同源图标接口返回。来源和 `iconifyId` 持久保存；恢复自动、选择 Dashboard 或上传时清除其他来源字段。未指定来源的原图标库接口继续使用 Dashboard。

## 实际执行结果

环境：Node.js 24.22.2、pnpm 10.20.0；完整回归使用临时本地 PostgreSQL 17 独立测试库，未使用应用数据库。

| 检查 | 结果 |
| --- | --- |
| Web 单元和界面测试 | 52/52 通过 |
| API 单元和 PostgreSQL 集成测试 | 88/88 通过 |
| 图标完整操作 E2E | Chrome、WebKit，各含桌面和手机，4/4 通过 |
| `pnpm typecheck` | API、Web 和浏览器测试通过 |
| `pnpm lint` | 0 错误；保留已有 App.tsx 的 hook 依赖警告 |
| `pnpm build` | API、Web 生产构建通过 |
| `pnpm test:delivery` | 9/9 通过 |
| 空库与旧库升级 | 列定义、约束、索引和枚举一致；旧 AUTO、DASHBOARD、UPLOAD 配置保留 |
| 增量 SQL 单事务执行 | 通过；新增来源允许有效 ID，拒绝非法 ID |
| 真实 Iconify API | `github` 搜索返回 128 个可分页结果；`mdi:github` 的预览、保存和同源书签图片均通过 |
| Hallmark 静态与渲染检查 | 0 FAIL、0 WARN；1 项既有间距规则豁免，涵盖 15 处既有声明 |

真实搜索数量是本次上游返回的结果数量，不代表 Iconify 全站图标总量。搜索接口按上游返回列表在本地分页，连续翻页复用缓存。

Hallmark 渲染使用真实弹窗的 DOM/CSS 快照，预览图片转为内嵌数据以保持同源授权语义，生成 5 张不同视口截图。修复仅限图标选择弹窗的文字、主按钮和输入边界对比度。另在线程内审查了 1440×900 浅色和 390×844 深色的真实页面截图，未使用子代理；组件无需额外素材。

数据库变更为 `202611020002_iconify_source`，已同步 Prisma 迁移、历史 SQL、全量 SQL 与升级说明。部署前先运行 `pnpm db:migrate`，再启动配套 API/Web；本轮未升级应用数据库或发布正式服务。

## 修复影响分析（check-fix）

- 变更摘要：新增一个图标库来源与可空的 `iconify_id`。风险等级中，主要来自数据库升级与在线搜索依赖。
- 直接影响：来源选择器、图标库查询和预览、图标配置 DTO、配置提交和图片读取；均有界面或 API 测试。
- 间接影响：复用原下载队列、网络校验、原子写入和同源权限检查；自动刷新跳过人工来源。缓存可跨实例复用，损坏后重建；图片仍在发送前复核书签可见性与配置版本。
- 数据与兼容性：已有记录的 `iconify_id` 为 NULL；恢复和替换会清除旧来源字段。原 Dashboard 默认接口、上传清理、CRUD 和导出结构保留。新增枚举需配套的新 API 与 Prisma Client。
- 验证覆盖：来源切换、分页复位、迟到响应隔离、保存与恢复、并发版本冲突、下载失败保旧、私密权限、取消任务、损坏资源和缓存跨实例读取均已执行。
- 建议动作：代码与迁移可进入发布流程。Iconify 在线搜索不可用时可重试；已缓存图片继续由本站读取。

## 接口依据

使用 smart-search-cli 获取官方文档：

```sh
smart-search fetch 'https://iconify.design/docs/api/search.html' --format markdown
smart-search fetch 'https://iconify.design/docs/api/svg.html' --format markdown
```

- [搜索接口](https://iconify.design/docs/api/search.html)：关键词、搜索结果列表及分页参数。
- [SVG 接口](https://iconify.design/docs/api/svg.html)：按图标集前缀与图标名称生成 SVG，并指定输出尺寸。
