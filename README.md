# crux-docset

Crux 独立 docset 供应仓库。第一阶段已实现 Node.js CLI、Python 官方文档候选构建和验证；尚未启用公开发布。

负责 recipe、构建 adapter、许可证记录、质量测试、上游变更检测、版本锁定与自动发布。

- [Docset 生产可行性](docs/research/DOCSET-FEASIBILITY.zh-CN.md)
- [Recipe 与自动更新设计](docs/design/RECIPE-AUTOMATION.zh-CN.md)
- [调研来源](docs/research/SOURCES.md)
- [第一阶段：运行、验收与尚未完成的边界](docs/PHASE1.md)
- [MDN 三页原生生成实验](docs/experiments/MDN-PHASE1.md)
- [后端服务仓库](../crux-server/README.md)

Git 保存配方与小型元数据；生成的 `.tgz`、SQLite/HTML bundle 发布到 GitHub Releases 或对象存储。Recipe、adapter 与权限策略变更需人工评审，通过既定验证的常规内容更新由机器人发布。

## 开始

依赖 Node.js 24+、npm、uv；测试还需要 `zip`。不需要 Java、Docker、数据库服务或 Dash。uv 使用 `tools/doc2dash/uv.lock`，按需在项目目录创建 Python 3.11 虚拟环境。

```sh
npm ci --ignore-scripts
npm test
npm run docset -- list
npm run docset -- build
```

最后一个命令从 Python 官方站点发现 **3.14 版本线**的稳定版离线 HTML 包，下载并计算散列，不自动跨 minor。成功后输出候选目录，内含 `.tgz`、`manifest.json`、`source-lock.json`、`validation.json` 和可直接检查的 `.docset`。重复运行且输入未变化时跳过构建。所有生成文件位于被忽略的 `.work/`，不会进入 Git。

## 版本线与工作目录

`list` 列出各 family/variant、默认项和 `implemented`/`buildable` 状态；当前正式注册的 adapter 仍只有 Python。新增版本线需要评审 `recipes/<family>/variants/<variantId>.json`，不能仅凭上游出现新版本自动启用。

```sh
node src/cli.js build --id python --variant python-3-14-en
node src/cli.js build --id python --variant python-3-13-en
node src/cli.js matrix --id python
node src/cli.js build --id python --archive /absolute/path/python-docs.zip --work /absolute/path/new-work
node src/cli.js validate --id python --bundle /absolute/path/Python.docset
```

同 family 共用稳定的 bundle identifier（Python 为 `dev.crux.python`），不同 variant 的构建状态独立。默认目录为 `.work/<variantId>`；Python 3.14 保留显式兼容映射 `.work/python`。`--work` 是单一 variant 的状态根，锁内校验 `owner.json`，不能被另一版本线接管；未知的非空目录不会被清理或覆盖。

当前候选矩阵包含 Python 3.14（默认）与 3.13；两者都固定版本线，不跨 minor 发现更新。`matrix` 只输出启用且 adapter 已实现的受评审配置，不下载、构建或发布；精确归档和散列由每个构建任务在锁内解析。`.github/workflows/version-candidates.yml` 仅支持手动触发，最多两个并行任务、每任务 20 分钟、失败互不取消。运行消耗私有仓库 Actions 额度，未新增定时触发。候选成功不代表已经公开可下载或通过 Beta GUI 验收。

Python 官方会在同一版本线调整页面布局。必要正文规则可用 `paths` 列出最多四个已核查的等价路径（与单一路径 `path` 互斥），但仍须在至少一个真实页面中找到相同正文；跳转占位页不能代替正文。当前兼容内置函数文档从 `library/` 到 `builtins/` 的迁移，不修改旧包、不降低数量门槛。

schema-2 状态将版本和指纹放在 `current.json` 的 `release` 中，旧 CLI 会拒绝读写。已验证的 schema-1 Python 3.14 状态迁移前备份为 `legacy-current.v1.json`，不可变旧产物不修改；来源、实际 bundle 或版本线无法核实时需人工核查，或在新目录重建。不要删除 owner/current 来绕过归属校验。Actions 使用新的 v2 cache key，不自动恢复缺少完整 bundle 的旧 v1 缓存。

只有明确设置 `--base-url https://<configured-artifact-root>` 才会生成候选 feed，布局为 `artifacts/<variantId>/<fingerprint>/<Bundle>.tgz`、`feeds/<variantId>.xml`。它不是 GitHub Release URL 的直接拼接约定，也不是已经上传的证明；publisher 必须另行配置和验证。当前 CI 仅输出候选，不生成猜测的下载地址。

## 精确版本目录与发布状态

`src/release-catalog.js` 提供 `makeReleaseCatalog(records, latestByFamily)` 和严格的 `validateReleaseCatalog(catalog)`。`latestByFamily` 的键为 `sourceId/familyId`，值为经审核的 releaseId；目录只含 `published` 条目，latest 必须指向默认供应线的 `supported` 稳定版本。历史条目可标记 `archived`，仍可显式下载，不自动推荐。候选/撤回条目不会进入可选列表；缺少有效 latest 会拒绝整个更新，不猜测替代版本。

schemaVersion 1 契约夹具：`test/fixtures/version-catalog/v1.json`。其中版本和 `example.invalid` 地址仅用于协议测试，**不代表真实供应**。客户端对应文件为 `Crux/Packages/CruxCore/Tests/ContractFixtures/version-catalog-v1.json`；两份 SHA-256 均为 `097af598938773ab257a30b09640ce2d26b6ee0c84530053b24801db7d391586`。

`src/published-store.js` 提供供独立 publisher 组装使用的本地持久状态 API：

- `reserveRevision(directory, identity, { minimumRevision })`：按 variant/version 串行预留 revision；相同 releaseId 幂等，构建缓存丢失不重新分配。
- `recordPublished(directory, record)`：要求既有预约且身份一致，通过 HTTPS 回读已上传文件并验证完整散列/大小，才记录为已发布。不会上传文件，也不替代独立 docset 内容验证。
- `writePublishedCatalog(directory, latestByFamily)`：从持久记录生成目录，先提交意图快照，最后原子替换 `catalog.json`。
- `recoverPublishedCatalog(directory)`：恢复最后一步目录文件写入；`withdrawPublishedRelease(directory, releaseId, latestByFamily)` 要求明确、一致的替代推荐政策，不能复活原 releaseId。

构建加 `--publication-state /absolute/path/durable-publication` 可使用上述预约；该目录必须与 `--work` 分离、备份并由唯一 publisher 持有，不能当作 Actions cache。默认不加参数仍为本地候选模式，不自动建立“已发布”记录。锁只保护同一持久目录，不是多个 runner 独立副本之间的分布式锁；远端状态保存、独立复验、不可变上传及部署仍待 publisher 交付。本轮未创建 Release、上传 docset 或提交在线 catalog。

CLI/验证器使用 JS；doc2dash 仍是锁定的上游 Python 构建工具，不是自编 Python CLI。Java + Spring 后端保留在 `crux-server`，本阶段不需要常驻服务。

## Recipe 图标

每份 recipe 的同级 `assets/` 保存 `icon.png`（16×16）与 `icon@2x.png`（32×32），
以及来源/商标说明。构建离线读取并复制到 docset 根目录，图标内容纳入构建指纹；
替换图标也会触发重建。Python recipe 设置 `validation.requireIcons: true`，
验证缺失、文件类型、大小上限、PNG 解码/CRC 和尺寸；使用锁定的 `pngjs` 解码。
Python 原图及来源见 [assets 说明](recipes/python/assets/README.md)。

Actions 工作流提供 PR 测试、main 候选构建和每日检测，只有 `contents: read` 权限。它**不会创建 Release 或提交目录元数据**；此阶段未增加新版本线的定时构建。跨仓库相对链接以三个仓库在同一父目录检出为前提。
