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
npm run docset -- build
```

最后一个命令从 Python 官方站点发现稳定版离线 HTML 包，下载并计算散列。成功后输出候选目录，内含 `.tgz`、`manifest.json`、`validation.json` 和可直接检查的 `.docset`。重复运行且输入未变化时跳过构建。所有生成文件位于被忽略的 `.work/`，不会进入 Git。

CLI/验证器使用 JS；doc2dash 仍是锁定的上游 Python 构建工具，不是自编 Python CLI。Java + Spring 后端保留在 `crux-server`，本阶段不需要常驻服务。

## Recipe 图标

每份 recipe 的同级 `assets/` 保存 `icon.png`（16×16）与 `icon@2x.png`（32×32），
以及来源/商标说明。构建离线读取并复制到 docset 根目录，图标内容纳入构建指纹；
替换图标也会触发重建。Python recipe 设置 `validation.requireIcons: true`，
验证缺失、文件类型、大小上限、PNG 解码/CRC 和尺寸；使用锁定的 `pngjs` 解码。
Python 原图及来源见 [assets 说明](recipes/python/assets/README.md)。

Actions 工作流提供 PR 测试、main 候选构建和每日检测，只有 `contents: read` 权限。它**不会创建 Release 或提交目录元数据**；生成的 feed 在远端产物发布前不可用。跨仓库相对链接以三个仓库在同一父目录检出为前提。
