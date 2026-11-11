/**
 * 「显式不限」的线上哨兵值，必须与 Go 侧
 * `internal/app/query_result_budget.go` 的 `queryResultBudgetUnlimited` 保持一致。
 *
 * 不能用 0：后端四个字段都带 `omitempty`，0 与「调用方根本没传这一维」在
 * JSON 上不可区分，把 0 当不限会让所有漏传字段的外部调用方静默变成无上限。
 */
export const QUERY_EDITOR_BUDGET_UNLIMITED = -1;

/**
 * 单字段预览上限：只约束一格内存，代价极低。
 *
 * 放开它会带来两个副作用：Oracle 文本大对象退化成 4KiB 兜底预览；扫描预算
 * 整体变成 nil，丢掉 Truncated 标记。
 */
export const QUERY_EDITOR_SAFE_MAX_FIELD_BYTES = 8 * 1024 * 1024;

/** 查询结果的默认页大小。用户可在结果分页栏里改。 */
export const QUERY_EDITOR_DEFAULT_PAGE_SIZE = 100;

export type QueryEditorResultBudgetOptions = {
  maxRowsPerResult: number;
  maxTotalRows: number;
  maxTotalBytes: number;
  maxFieldBytes: number;
};

/**
 * 查询结果的扫描预算。
 *
 * 行数不设上限：工具栏的「最大返回行数」选项已移除，用户跑 `SELECT *` 就该拿到
 * 全量结果，不由应用替他把行数截断。仍保留单字段预览上限。
 *
 * 三个行数/字节维度都传 `-1`（显式不限）而不是 0：后端四个字段都带 `omitempty`，
 * 0 会被省略成「调用方没传这一维」，语义上退化为缺省值而非不限。该哨兵值必须与
 * Go 侧 `internal/app/query_result_budget.go` 的 `queryResultBudgetUnlimited` 一致。
 */
export const buildQueryEditorResultBudgetOptions = (): QueryEditorResultBudgetOptions => ({
  maxRowsPerResult: QUERY_EDITOR_BUDGET_UNLIMITED,
  maxTotalRows: QUERY_EDITOR_BUDGET_UNLIMITED,
  maxTotalBytes: QUERY_EDITOR_BUDGET_UNLIMITED,
  maxFieldBytes: QUERY_EDITOR_SAFE_MAX_FIELD_BYTES,
});

/**
 * 翻页请求的扫描预算：必须放得下 lookahead 那一行。
 *
 * 翻页 SQL 自带 `LIMIT pageSize+1 OFFSET ...`，多取的一行只用于判断"还有没有下
 * 一页"。若这里给出比页大小还窄的行数上限，后端会在第 pageSize 行处截断，第
 * pageSize+1 行永远取不到，于是每页都被判成最后一页：下一页按钮禁用、页数停在
 * 「当前页 / 当前页」、总数被算成 (current+1)*pageSize。
 *
 * 行数本就无上限，这里只需保留单字段上限，不必再传行数维度。
 */
export const buildQueryEditorPagedResultBudgetOptions = (): QueryEditorResultBudgetOptions => ({
  maxRowsPerResult: QUERY_EDITOR_BUDGET_UNLIMITED,
  maxTotalRows: QUERY_EDITOR_BUDGET_UNLIMITED,
  maxTotalBytes: QUERY_EDITOR_BUDGET_UNLIMITED,
  maxFieldBytes: QUERY_EDITOR_SAFE_MAX_FIELD_BYTES,
});
