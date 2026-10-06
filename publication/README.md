# Python 自动供给运行说明

本阶段实现代码位于 `src/publication/`，首次供给固定在 Python 3.14 英文版本线。
3.13 支持手动供给，但不会因每日任务自动扩展构建矩阵。默认版本线或规则变更通过代码评审调整；
官方同线补丁与内容更新根据源码归档摘要自动识别。

## 工作流

`Python docset supply` 在 PR 上执行测试，在 `main` 的 push、手动运行、定时运行中构建并发布。
定时表达式对应 04:23 UTC / 12:23 上海时间；GitHub 可能延迟执行。
[GitHub schedule 文档](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)
要求工作流在默认分支执行，所以启用日更时默认分支须为 `main`。
仓库默认分支已设为 `main`；手动运行的 `variant` 可选 3.14/3.13，其他事件固定选 3.14。
缓存按 variant 隔离，两条线共享发布 ledger，但旧线供给不会修改默认线的 latest 指针。

构建 job 只有 `contents: read`。它恢复发布分支的状态，在独立 `.publisher/` 工作副本中预留
revision，构建 Python，并重新解包验证归档。Actions 缓存只保留构建结果；未在远端预留的
缓存候选会移到旁边的临时目录，不用于决定发布 revision。

发布 job 独享 `contents: write`，不在 PR 或开发分支运行。它再次复验 archive，校验源码
commit 属于 `main`，先持久化 revision 预留，再创建 draft Release、上传并回读全部文件，
最后公布 Release，提交供给目录。认证仅由该 job 注入 `GITHUB_TOKEN`，无额外长期服务或数据库。

公开仓库会再以不带认证的请求验证浏览器下载 URL；私有仓库通过资产 API 验证同一上传内容。
认证头仅发送给 GitHub API/上传域名，绝不转发给签名 CDN URL。
[GitHub 资产 API](https://docs.github.com/en/rest/releases/assets) 的下载重定向通过 HTTPS 域名白名单处理。

## 产物与地址

每次发布的 tag 含 variant、version、revision 与完整 releaseId。Release 保存：

- `Python.tgz`
- `manifest.json`（移除不影响内容的构建时刻，允许冷重建恢复）
- `validation.json`
- `source-lock.json`
- `qualification.json`（独立验证结果与精确摘要绑定）

writer 不覆盖任何已上传资产。同名冲突、摘要不一致和缺失资产会中止，避免用不同内容替换
已有下载地址。客户端仍以 catalog 中的 SHA-256 和字节数检查下载内容。

`docset-publication` 是只包含供应数据的独立分支，不修改 `main` 或 `develop/v1` 源码。
`state.json` 包含持久预留与发布记录；`catalog.json`、`feeds/python.xml`、
`feeds/python-3-14-en.xml`、`qualifications/<releaseId>.json` 在一个 commit 内激活。
[GitHub ref 更新](https://docs.github.com/en/rest/git/refs#update-a-reference) 使用 `force:false`；
如果原 head 已变化，发布器中止，下一次任务从新快照重跑。

首次成功发布后，公开仓库的目录地址为：
`https://raw.githubusercontent.com/zacharyhuo/crux-docset/docset-publication/catalog.json`。
feed 地址为同一根目录下的 `feeds/python.xml`。文件已提交到真实发布分支；当前 private 仓库
需要 GitHub 权限访问，仓库公开后的匿名地址可用性留待公开发布验收。
下载包使用 Release 的固定 tag URL，不使用全仓库 `latest` 路由。

## 本地校验与策略变更

```sh
node src/cli.js build --id python --work /absolute/path/new-build --publication-state /absolute/path/separate-publication
node src/publication/cli.js qualify --id python --candidate /absolute/path/candidate
node --test test/publication.test.js test/publication-security.test.js test/workflow.test.js
```

常规 `build` 不会上传或写 GitHub。`qualify` 是本地只读复验：重新提取压缩包，校验版本、
身份、revision、图标、保留的版权/许可页面、全部索引目标和真实计数，并核对 build/报告摘要。
使用 `--archive` 构建的 `local-archive` 候选不能由官方来源 publisher 发布。

recipe、source 规则、验证门槛或图标发生变化时，`publication/python.json` 的 pin 必须随评审更新。
pin 计算为 `policyDigest(effectiveRecipe, loadRecipeIcons(recipeDirectory))`，不是为每份产物写一次审批。
整个 `publication/python.json` 也属于 Python adapter 的构建输入，切换默认供应线会改变
builder/release 指纹，不会被旧的“已发布”候选跳过。
构建输入变化通过 builder digest 自动触发新 releaseId。政策固定已有来源规则和归属信息，
不宣称自动散列检查能替代对新技术栈的许可判断。

## 中断与恢复

任务总是从远端状态恢复新的工作副本，不上传 `.publisher/` 到 Actions cache。
首次预留只提交 state，旧 catalog/feed 保持原样。上传部分文件失败后保留 draft 和预留记录；
同输入重跑会回读并复用已经存在且摘要一致的资产，只补缺失文件。
GitHub 502 上传失败可能留下 `state: starter` 的零字节占位项；只在匹配的 draft 中删除
这个空占位并重试，不删除已上传资产。单独重跑 publish job 时，旧 promotion 快照也可恢复：
仅当远端已有与候选身份/revision 完全一致的预留，才采用新状态，最终目录更新仍受非强制 CAS 保护。

Release 完成但目录提交失败时，该 Release 暂不进入客户端目录。新 runner 从预留记录重建、
复验已有资产，再重试目录提交。已经发布的相同输入不重复上传、不移动 latest 指针。
缓存丢失时使用远端历史继续分配 revision；降级、计数下降超过 recipe 门槛或并发状态变更均拒绝。

被撤回的 releaseId 不能重新发布。失败候选的 draft/预留先保留用于恢复；本阶段不自动删除
历史资产，不提供在线撤回命令。历史清理和撤回需要维护者明确选择替代 latest 后操作。

## Beta 的 TLS 验收

`experiments/publication/serve.mjs` 下载、构建真实官方 Python 3.14/3.13 包，并让真实发布器对
可控的 GitHub HTTP fixture 完成上传/回读/目录更新。然后用临时证书启动实际 loopback HTTPS
服务，通过 302 HTTPS 重定向提供这两份经过校验的包。

```sh
node experiments/publication/serve.mjs --work /absolute/path/disposable-experiment-parent
```

输出 `READY .../PythonSupplyAcceptance.json` 后，将该小型配置暂放到客户端
`CruxTests/PythonSupplyAcceptance.json`，运行 `Crux Beta` 的
`PythonSupplyHTTPSAcceptanceTests`。证书只在测试 URLSession 内作为受限 anchor 使用，
不写入 Keychain、不关闭系统 TLS 校验。没有配置时测试跳过，跳过不能算验收通过。
服务只绑定 `127.0.0.1`，20 分钟后自动停止，也可向本次进程发送 SIGINT；请求记录留在实验目录。

该验收覆盖真实 TLS 下载、同一安装位置更新、固定旧版、损坏内容拒绝、失败后重试、
catalog 缓存回退、图标和离线阅读。GitHub HTTP fixture 仍不是线上 GitHub 部署验收；
真实 Actions 和已发布资产的验收见下一节，公开 HTTPS 地址仍需在仓库公开后实际验证。

## 已发布资产的 Beta 验收

```sh
node experiments/publication/live-serve.mjs --repository zacharyhuo/crux-docset --work /absolute/path/disposable-experiment-parent
```

此工具读取实际 `docset-publication` 的固定 commit catalog，并用标准 `gh release download`
下载其中的真实 Release 包。每个包与 catalog 的 SHA-256/字节数一致才启动 loopback TLS。
认证只留在 GitHub CLI 的正常认证流程中，不读取或输出 token，不给客户端写私有凭据。
使用同一 Beta opt-in 测试配置；GitHub 来源证明保存为 `github-catalog.json` 和
`github-receipts.json`，TLS 请求留在 `https-requests.json`。

2026-10-06 的首轮 3.14/手动 3.13 发布和默认线无变化重跑均成功，真实 Release 包的 Beta
验收通过。后者使用本机 TLS 中继，不能当作公开 CDN 匿名下载证明。
