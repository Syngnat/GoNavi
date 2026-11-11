export const QUERY_EDITOR_UNLIMITED_SAFE_MAX_ROWS = 50_000;
export const QUERY_EDITOR_SAFE_MAX_RESULT_BYTES = 24 * 1024 * 1024;
export const QUERY_EDITOR_SAFE_MAX_FIELD_BYTES = 1024 * 1024;

/**
 * 「显式不限」的线上哨兵值，必须与 Go 侧
 * `internal/app/query_result_budget.go` 的 `queryResultBudgetUnlimited` 保持一致。
 *
 * 不能用 0：后端四个字段都带 `omitempty`，0 与「调用方根本没传这一维」在
 * JSON 上不可区分，把 0 当不限会让所有漏传字段的外部调用方静默变成无上限。
 */
export const QUERY_EDITOR_BUDGET_UNLIMITED = -1;

export type QueryEditorResultBudgetOptions = {
  maxRowsPerResult: number;
  maxTotalRows: number;
  maxTotalBytes: number;
  maxFieldBytes: number;
};

/**
 * 把工具栏的行数选择映射成后端扫描预算。
 *
 * `0` 是工具栏「不限」的哨兵值：取消自动 LIMIT，并让行数与总字节都不再设上限。
 * 正数仍夹紧到安全上限（与 store 的 sanitizeQueryOptions 一致）。
 *
 * 单字段上限始终保留：它只约束一格内存，代价极低，而放开它会让 Oracle 文本
 * 大对象退化成 4KiB 兜底预览，也会让扫描预算整体变成「无预算」。
 */
export const buildQueryEditorResultBudgetOptions = (
  configuredMaxRows: number | null | undefined,
): QueryEditorResultBudgetOptions => {
  const parsed = Math.trunc(Number(configuredMaxRows) || 0);
  if (parsed <= 0) {
    return {
      maxRowsPerResult: QUERY_EDITOR_BUDGET_UNLIMITED,
      maxTotalRows: QUERY_EDITOR_BUDGET_UNLIMITED,
      maxTotalBytes: QUERY_EDITOR_BUDGET_UNLIMITED,
      maxFieldBytes: QUERY_EDITOR_SAFE_MAX_FIELD_BYTES,
    };
  }
  const maxRows = Math.min(parsed, QUERY_EDITOR_UNLIMITED_SAFE_MAX_ROWS);
  return {
    maxRowsPerResult: maxRows,
    maxTotalRows: maxRows,
    maxTotalBytes: QUERY_EDITOR_SAFE_MAX_RESULT_BYTES,
    maxFieldBytes: QUERY_EDITOR_SAFE_MAX_FIELD_BYTES,
  };
};

/**
 * 翻页请求的扫描预算：必须放得下 lookahead 那一行。
 *
 * 翻页 SQL 自带 `LIMIT pageSize+1 OFFSET ...`，多取的一行只用于判断"还有没有下
 * 一页"。若沿用工具栏的 `maxRows` 预算（例如用户把最大行数设为 100），后端会在第
 * pageSize 行处截断，第 pageSize+1 行永远取不到，于是每页都被判成最后一页：
 * 下一页按钮禁用，页数停在「当前页 / 当前页」，总数被算成 (current+1)*pageSize。
 * 结果就是几千条数据只能翻两页，点「统计总数」才恢复正常。
 *
 * 页大小为 0 表示用户在结果分页栏里选了「不限」：此时翻页 SQL 不带 LIMIT，
 * 需要一次取全部行，沿用调用方的常规预算（不在这里放开，避免无上限扫描）。
 */
export const buildQueryEditorPagedResultBudgetOptions = (
  pageSize: number,
): QueryEditorResultBudgetOptions | undefined => {
  const parsed = Math.trunc(Number(pageSize) || 0);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  const lookaheadRows = parsed + 1;
  // 页大小已经逼近安全上限时，多出的那一行会撞上夹紧逻辑而丢掉 lookahead。
  if (lookaheadRows > QUERY_EDITOR_UNLIMITED_SAFE_MAX_ROWS) return undefined;
  return {
    maxRowsPerResult: lookaheadRows,
    maxTotalRows: lookaheadRows,
    maxTotalBytes: QUERY_EDITOR_SAFE_MAX_RESULT_BYTES,
    maxFieldBytes: QUERY_EDITOR_SAFE_MAX_FIELD_BYTES,
  };
};
