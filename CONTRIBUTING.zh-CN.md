# 贡献指南

感谢你对本项目的贡献。

本项目当前采用“`dev` 作为默认集成分支，`main` 作为稳定发布分支，`release/*` 负责发版准备”的协作模型。为减少分支漂移与 PR 处理成本，请在提交贡献前先阅读本指南。

---

## 分支模型

- `dev`：默认分支，也是日常开发集成分支
- `main`：稳定发布分支
- `release/*`：发布准备分支，主要供维护者使用
- 外部贡献者建议使用以下分支命名：
  - `fix/*`：问题修复
  - `feature/*`：功能新增或增强

维护者发布流转如下：

```text
feature/* / fix/* -> dev -> release/* -> main -> tag(vX.Y.Z)
```

---

## 外部贡献者如何提 Pull Request

无论是 `fix/*` 还是 `feature/*`，**外部贡献者统一直接向 `dev` 发起 Pull Request**。

这样做的原因：

- `dev` 是当前日常集成分支，评审与合入路径和维护者开发流程一致
- 外部贡献会直接进入触发日常校验和 dev 构建的分支
- 维护者可以直接从 `dev` 切 `release/*`，减少额外同步步骤

建议流程：

1. Fork 本仓库
2. 先同步你 fork 中的 `dev`，再从 `dev` 创建分支（建议命名为 `fix/*` 或 `feature/*`）
3. 完成代码修改，并进行必要自检
4. 推送到你的远程分支
5. 向本仓库的 `dev` 分支发起 Pull Request

---

## Pull Request 要求

请尽量保证 PR 单一、清晰、可审核。

建议遵循以下要求：

- 一个 PR 只解决一类问题，避免混入无关改动
- 标题清晰说明改动目的
- 描述中说明：
  - 背景与问题
  - 变更点
  - 影响范围
  - 验证方式
- 如涉及 UI 调整，建议附截图或录屏
- 如涉及兼容性、数据变更或构建链路调整，请明确说明风险和回滚方式
- Bug 修复请附上“base 提交上失败、PR head 上通过”的命令和关键输出
- 请运行与改动相关的检查；没有运行的检查逐条说明原因

`CI Gate` 是合并必过检查；它失败、被取消或未出现时，PR 不能合并。

---

## PR 合并策略（维护者）

`dev` 分支上的 PR 使用 **Merge commit**（仓库当前未启用 squash/rebase merge）。

原因：

- 保留被评审的 PR head 和合并记录
- 保留 PR 的独立提交，便于审计与回滚
- 与分支规则集允许的合并方式一致

---

## 维护者同步规则

由于外部 PR 会直接合入 `dev`，维护者应将 `dev` 作为日常协作与发版准备的主线分支。

### 1. 发版前从 dev 切 release/*

发布前由维护者基于 `dev` 创建发布分支，例如：

```bash
git checkout dev
git pull
git checkout -b release/v0.6.0
git push -u origin release/v0.6.0
```

### 2. release/* → main 发版

发布准备完成后，将 `release/*` 合并回 `main`，并打标签发布：

```bash
git checkout main
git pull
git merge release/v0.6.0
git push
git tag v0.6.0
git push origin v0.6.0
```

### 3. main 回流到 dev（发版后必做）

发布完成后，需要将 `main` 回流到 `dev`，确保下一轮开发从已发布代码线继续推进：

```bash
git checkout dev
git pull
git merge main
git push
```

---

## 提交建议

建议保持提交信息简洁、明确，便于维护者审查与后续追踪。

推荐格式：

```text
emoji type(scope): 中文描述
```

示例：

```text
🔧 fix(ci): 修复 Windows AMD64 下 DuckDB 驱动构建工具链
✨ feat(redis): 新增 Stream 类型数据浏览支持
♻️ refactor(datagrid): 优化大表横向滚动与渲染结构
```

---

## 其他说明

- 文档、构建链路、驱动兼容性相关改动，请尽量附带验证结果
- 若改动较大，建议先提 Issue 或 Draft PR，先对齐方案再实施
- 如提交内容与项目当前架构方向冲突，维护者可能要求收敛范围后再合并

感谢你的贡献。
