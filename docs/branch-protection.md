# 分支保护规则

Agent 工作流依赖两个规则集：

- `dev-protection`：要求 PR、可 merge commit、`CI Gate` 成功、禁止强推/删除；
- `main-protection`：保留现有 PR 规则，追加 `CI Gate` 成功、禁止强推/删除。

## 先 dry-run

```bash
REPO=Syngnat/GoNavi bash tools/apply-branch-protection.sh
```

脚本会打印当前规则集合并追加的 `required_status_checks`，不会修改 GitHub。

## 确认后应用

```bash
REPO=Syngnat/GoNavi bash tools/apply-branch-protection.sh --apply
```

应用后：

- `dev` 不能再直接 push，必须走 PR；
- PR 合并前必须有成功的 `CI Gate`；
- `main` 仍走 PR，并增加 `CI Gate`。

## 注意事项

- 规则集有管理员 bypass；确认你仍能在紧急情况下用管理员身份合并。
- 如果 `dev` 原本没有 bypass actor，脚本会补一个仓库管理员紧急 bypass（role id 5）；
  这样才能在 CI 故障时人工放行，而不是把自己锁死。
- `require_code_owner_review` 默认关闭。若要启用，维护者自己开的 PR 需要另一个账号批准，
  否则会被 `.github/CODEOWNERS` 卡住。
- `strict_required_status_checks_policy` 默认关闭，避免每次 main 更新都强制 rebase；
  需要“必须基于最新 main”时再改成 `true`。
- 如果 `CI Gate` 改名，先改 `.github/workflows/backend-tests.yml` 的 job `name`，
  再同步本脚本、`.github/CODEOWNERS` 说明和 `tools/pr-review/gate.go`。
