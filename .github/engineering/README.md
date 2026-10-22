# Engineering Standards · 工程化规范

此目录是从维护者的工程规范仓库同步的**项目内规范快照**；用于本仓库独立审阅和验证，不代替实际代码、项目 AGENTS 或 CI。

## 内容导航

- [ENGINEERING_STANDARD.md](ENGINEERING_STANDARD.md)：公开仓库内容准入、文档归属、版本发行与 Agent 约束。
- [ADOPTION.md](ADOPTION.md)：现有项目接入、验证与后续同步检查。
- [templates/AGENTS.md](templates/AGENTS.md)：仅英文的可移植 Agent 规则模板；必须按项目真实边界调整。
- [templates/CLAUDE.md](templates/CLAUDE.md)：Claude 兼容入口。
- [templates/CHANGELOG.md](templates/CHANGELOG.md)：按「新增 / 改进 / 修复」的中英双语 Changelog 样例。
- [templates/RELEASE.md](templates/RELEASE.md)：通用发行及回滚操作说明。
- [scripts/release-notes.mjs](scripts/release-notes.mjs)：从目标版本 Changelog 提取发行说明的无依赖脚本。
- [tests/](tests/)：脚本自动化测试。

## 权责划分

1. **维护者的工程规范仓库**维护通用原则与模板；本目录是独立可读的项目副本，调整后需经过项目审核。
2. **项目仓库**的 `AGENTS.md`、CHANGELOG、CI 和发行手册必须在本仓库内可独立阅读和执行；项目实现与经验证的现实情况优先于泛用样例。
3. **变更传播是显式的。** 修改本目录不自动改变产品仓库；同步后各项目独立审查、测试和提交。严禁直接修改历史 Tag 或二进制发行资产。
