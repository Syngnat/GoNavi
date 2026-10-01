# 需求进度追踪 - KingBase 上 SQL 诊断报「未返回 EXPLAIN 结果集」

## 1. 需求摘要
- 需求名称：修复 SQL 分析工作台「SQL 诊断」在 KingBase 上必然失败
- 发现日期：2026-10-01（README 截图时在本机 KingBase 实验库复现）
- 现象：任意 SELECT 点「运行诊断」，页面提示「诊断失败：执行 EXPLAIN 失败：未返回 EXPLAIN 结果集」
- 目标：KingBase（及其他走可选驱动代理的方言）能正常拿到执行计划。
- 非目标：不改驱动代理本身，不改 EXPLAIN 语句的构造与解析。

## 2. 根因（已在真实环境验证）
- KingBase 由可选驱动代理承载（`OptionalDriverAgentDB`）。代理不支持原生多结果集时，`QueryMultiContextWithMessages` 约定返回 `nil, nil, nil` 表示「不支持」，由调用方退回单结果查询（`DBQueryMulti` 已按此约定处理）。
- `executeExplainStatementsWithText` 命中多结果集接口后直接把空结果交给 `collectExplainRaw`，`len(results)==0` 触发 `explain_result_missing`，没有退回单结果查询。
- 同一约定下受影响的是所有「实现了多结果集接口但代理返回 nil」的方言，KingBase 是本机实测到的一个。

## 3. 修复
- `internal/app/methods_explain.go`：多结果集调用收敛为 `queryExplainMulti`（保持原有 context 优先顺序与取消语义）；返回空且无错误、且没有后置查询时，退回单结果查询。
- 有后置查询的方言（Oracle 的 `DBMS_XPLAN.DISPLAY`）单结果无法还原，保持原报错，避免悄悄返回残缺计划（Oracle / SQL Server 实际走固定会话路径，不经过这里，此处仅作防御）。
- 新增 `internal/app/methods_explain_multi_fallback_test.go`：复现用例（修复前红、修复后绿）与后置查询保护用例。

## 4. 验证记录
- 修复前：新增复现用例失败，报错与页面一致「未返回 EXPLAIN 结果集」。
- 修复后：`TestExecuteExplainStatements*` 4 个用例全部通过（含既有的取消 / 上下文边界用例）；`-run 'Explain|Diagnose'` 全部通过。
- 真实环境：重建后端后，在 KingBase `gonavi_kingbase_lab` 上对客户 / 订单联表聚合 SQL 运行诊断，得到 7 节点执行计划、执行统计与索引建议。
- 全包 `go test ./internal/app/`：仅剩既有的 9 个失败（驱动安装 / 驱动包导出 / Windows 快捷方式），在干净 HEAD 上同样失败，与本次无关。

## 5. 风险与回滚
- 风险：仅影响「多结果集接口返回空且无错误」这一原先必然报错的分支，其余路径行为不变。
- 回滚：还原 `methods_explain.go` 中 `queryExplainMulti` 的引入即可。
