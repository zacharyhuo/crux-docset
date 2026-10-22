# crux-docset

[简体中文](README.md) | [English](README.en.md)

Crux 独立 docset 供应仓库。Node.js CLI、Python 官方文档构建、验证和 GitHub Release 发布流程已有实现与 `main` 私有发布记录。公开匿名下载仍待验收，仓库当前仍为 private。

负责 recipe、构建 adapter、许可证记录、质量测试、上游变更检测、版本锁定与自动发布。

- [Crux 消费协议](contracts/crux-consumer.md)：版本化目录、不可变产物、完整性校验与公开验收边界。
- [Python 发布与恢复](publication/README.md)：现有 main 发布流程、权限与中断恢复。
- [Recipe 配置](recipes/python/recipe.json)与[发布政策](publication/python.json)：当前默认 Python 供应线。
- [Spring 构建工具](tools/spring/README.md)：实验性本地构建与资格限制。
- [Crux 客户端](https://github.com/zacharyhuo/Crux)与[后端服务仓库](https://github.com/zacharyhuo/crux-server)。

Git 保存配方与小型元数据；生成的 `.tgz`、SQLite/HTML bundle 发布到 GitHub Releases 或对象存储。Recipe、adapter 与权限策略变更需人工评审，通过既定验证的常规内容更新由机器人发布。

客户端已实现独立来源设置并通过隔离的原生 Beta 验收，默认 Crux 启用、Zeal 禁用。Crux 的
`schemaVersion: 1` 目录与 Zeal 原始 JSON 数组分别使用独立协议；后者通过
`/d/{sourceId}/{name}/latest` 获取压缩包，不能从版本标签推导精确版本供应。
私有仓库需要认证，客户端、目录与 feed 都不能嵌入 token；服务端认证回读或 Beta 的本地 TLS
中继验收不能替代公开匿名 HTTPS 验收。

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

`list` 列出各 family/variant、默认项和 `implemented`/`buildable` 状态；当前启用自动供给的是 Python 默认版本线。Go/Spring 的实验 adapter 和未启用版本线不会进入自动发布。新增版本线需要评审 `recipes/<family>/variants/<variantId>.json`，不能仅凭上游出现新版本自动启用。

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

本地构建只有明确设置 `--base-url https://<configured-artifact-root>` 才会生成候选 feed，布局为 `artifacts/<variantId>/<fingerprint>/<Bundle>.tgz`、`feeds/<variantId>.xml`。它不是 GitHub Release URL 的直接拼接约定，也不是已经上传的证明。GitHub publisher 使用独立上传和回读流程，随后生成真实 Release 下载地址的目录与 feed。

## 精确版本目录与发布状态

`src/release-catalog.js` 提供 `makeReleaseCatalog(records, latestByFamily)` 和严格的 `validateReleaseCatalog(catalog)`。`latestByFamily` 的键为 `sourceId/familyId`，值为经审核的 releaseId；目录只含 `published` 条目，latest 必须指向默认供应线的 `supported` 稳定版本。历史条目可标记 `archived`，仍可显式下载，不自动推荐。候选/撤回条目不会进入可选列表；缺少有效 latest 会拒绝整个更新，不猜测替代版本。

完整字段与选择规则见[消费协议](contracts/crux-consumer.md)。schemaVersion 1
[契约夹具](test/fixtures/version-catalog/v1.json)中的版本和 `example.invalid` 地址仅用于协议测试，
不代表真实供应。[客户端对应文件](https://github.com/zacharyhuo/Crux/blob/develop/v1/Packages/CruxCore/Tests/ContractFixtures/version-catalog-v1.json)
应保持逐字节一致，两份 SHA-256 为 `097af598938773ab257a30b09640ce2d26b6ee0c84530053b24801db7d391586`。

`src/published-store.js` 提供供独立 publisher 组装使用的本地持久状态 API：

- `reserveRevision(directory, identity, { minimumRevision })`：按 variant/version 串行预留 revision；相同 releaseId 幂等，构建缓存丢失不重新分配。
- `recordPublished(directory, record)`：要求既有预约且身份一致，通过 HTTPS 回读已上传文件并验证完整散列/大小，才记录为已发布。不会上传文件，也不替代独立 docset 内容验证。
- `writePublishedCatalog(directory, latestByFamily)`：从持久记录生成目录，先提交意图快照，最后原子替换 `catalog.json`。
- `recoverPublishedCatalog(directory)`：恢复最后一步目录文件写入；`withdrawPublishedRelease(directory, releaseId, latestByFamily)` 要求明确、一致的替代推荐政策，不能复活原 releaseId。

构建加 `--publication-state /absolute/path/durable-publication` 可使用上述预约；该目录必须与 `--work` 分离，不能当作 Actions cache。默认不加参数仍为本地候选模式，不自动建立“已发布”记录。锁只保护同一目录；GitHub publisher 另用独立 `docset-publication` 分支持久化状态，基于原 head 提交并禁止强制更新，拒绝并发覆盖。

## Python GitHub 自动供给

[运行与恢复说明](publication/README.md)。`.github/workflows/python-candidate.yml` 已接入
只读状态恢复 → 默认 Python 候选构建 → 独立压缩包复验 → 独立写权限发布任务。
构建和发布只在 `main` 执行；PR 与 `develop/v1` 不发布。版本候选矩阵仍仅手动构建。

`publication/python.json` 固定有效 recipe 与图标摘要：规则变更需随代码评审更新，
同一版本线的官方补丁/内容更新不需要逐次人工审批。发布器重新解包、验证每个索引目标和
归档内版本/revision，并生成绑定产物、recipe、builder、source-lock 和报告的 `qualification.json`。
它只接受官方 Python 来源；Spring 的未审阅清单不会被此流程自动批准。

包和四份证据文件上传到独立 GitHub Release。已上传资产从不覆盖或删除，上传后流式回读完整
SHA-256/字节数。公开仓库还验证无需凭据的下载地址；私有开发使用服务端 Actions token
回读同一资产，目录中不含 token 或临时签名参数。随后在一个 Git commit 中更新状态、catalog、feed
和验证证据；失败时保留旧目录。无变化且已发布时跳过上传，上传中断可从新 runner 恢复。

2026-10-06 的私有 main 发布验收记录：真实 Actions 发布了 Python 3.14.7 r1 和 3.13.16 r1，
catalog/feed 位于 `docset-publication`；默认推荐仍为 3.14。相同输入重跑跳过 publisher，
发布分支 head 和五个资产的 ID/摘要均未改变。仓库默认分支已设为 `main`，日更只供应默认线，
手动运行可选择已审阅的 3.13/3.14。本机开发分支继续使用 `develop/v1`。

Beta 已从经过 SHA-256/字节数校验的真实 GitHub Release 包完成 HTTPS 安装、版本替换、
固定旧版、损坏包拒绝及恢复验收。由于仓库 private，本次由 GitHub CLI 认证下载后交给本机
TLS 中继；客户端未持有 token。这证明真实发布包可用，不代表公开地址的匿名 CDN 下载已验收。

CLI/验证器使用 JS；doc2dash 是锁定的上游 Python 构建工具。Java + Spring 后端属于
`crux-server` 的规划，尚无服务实现，本阶段不需要常驻服务。本地生成 agent 也仍在客户端路线图中，
现有 CLI builder 不代表 agent 已完成。

## 离线资产许可清单审计（独立检查）

```sh
node src/cli.js audit-assets --documents /absolute/path/Contents/Resources/Documents --manifest /absolute/path/reviewed-assets.json
```

这是只读本地命令，不要求 adapter 已注册，不联网、不安装依赖、不构建或发布。
检查整个 Documents 树（包括 HTML、内嵌脚本所在页面、无后缀文件），逐文件比对 SHA-256；
未知/缺失文件、内容漂移、未审阅组件、缺失或未归属的许可文件、符号链接均返回退出码 1。
成功返回 0。最多报告前 100 个错误，`errorCount` 保留实际检测到的数量；达到资源限制时停止扫描。

清单格式：`schemaVersion: 1`；`components` 中每项包含 `id`、`version`、HTTPS `source`、
`reviewed: true`、`license` 和 `notices`（Documents 内相对路径数组）；`files` 中每项包含
`path`、小写 SHA-256 `sha256`、`components`（可含多个组件 ID）。每个 notice 必须同时是
files 中有正确归属和摘要的非空文件。完整可运行示例在 `test/asset-audit.test.js`。

**信任边界：**清单必须独立审阅，不能从待审包自动生成后直接标记 reviewed。
工具验证的是清单与文件的一致性，不能识别漏报的 bundle 内第三方组件、判断许可兼容性、
核实 URL 所述来源或授予商标权。调用方须保持输入不可变；它不是不可信归档解包沙箱。
Spring 本地 builder 已接入字节完整性检查；生成清单仍为 `reviewed:false`，
独立审计会拒绝其发布资格。尚未接入通用 publisher 的许可审批门禁，不能仅凭
本地构建成功就启用 Spring 发布。页面摘要自动生成，组件审批不能自动生成。

## Recipe 图标资产

每份 recipe 的同级 `assets/` 保存 `icon.png`（16×16）与 `icon@2x.png`（32×32），
以及来源/商标说明。构建离线读取并复制到 docset 根目录，图标内容纳入构建指纹；
替换图标也会触发重建。Python recipe 设置 `validation.requireIcons: true`，
验证缺失、文件类型、大小上限、PNG 解码/CRC 和尺寸；使用锁定的 `pngjs` 解码。
Python 原图及来源见 [assets 说明](recipes/python/assets/README.md)。

Spring Framework 的官方图标与来源记录在 [Spring assets](recipes/spring-framework/assets/README.md)。
7.0 英文 recipe 保持 disabled；实验性 `spring-framework` adapter 已注册，仅接受已审阅的
7.0.9 固定 commit，目前限定 macOS arm64。源码获取、工具准备、Java/Kotlin API 与参考手册
构建、离线导出和组合打包已接线；`tools/spring` 下的输入全部纳入 CLI 指纹。
正式CLI冷构建与同输入重跑已通过：11,475页、42,741符号、零验证错误/警告；
真实包的同版本revision递增与归档内元数据一致性也已验证。
这仅完成固定版本的本地构建阶段，不可据此启用自动供给或发布。
第三方 notice 打包与完整文件树比对已接入，新增真实候选通过打包/解包及篡改反例验收。
完整许可归属审批、发布门禁及其他版本/执行平台仍需单独完成。
已核对的Dokka组件和许可文本保存在 [notice来源数据](recipes/spring-framework/notices/README.md)，
与固定资源清单一起纳入 builder 指纹；本地字节验证通过不等同于完整许可审核。

Actions 的 PR/构建任务保持只读，`main` 上的独立 publisher job 使用 `contents: write`
创建 Release 和提交供应目录；本阶段未增加其他技术栈的定时构建。客户端代码、生成文档、
第三方测试夹具和图标各有自己的权利边界，Crux 的许可证调整不会改变本仓库或上游内容的条款。
