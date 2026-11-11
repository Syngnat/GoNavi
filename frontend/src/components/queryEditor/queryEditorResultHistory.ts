/**
 * 结果页签的内存兜底上限。
 *
 * 这里不是产品层面的「结果数量限制」：用户主动打开的结果就该留着，开多少个、
 * 每个多少行都由用户自己决定。这几个常量只在估算内存真的超过兜底线时才生效，
 * 用来避免把整个应用撑爆——达到阈值后按「最旧、未固定、无未提交修改」的顺序
 * 释放，直到回到阈值内。
 *
 * 阈值取大一些：查询编辑器已不再给 SELECT 注入 LIMIT，一次 `SELECT *` 拿几十万
 * 行是正常结果，若按 5 万行/64 MiB 卡，用户切到「日志」页签、结果失去活跃态保护
 * 的瞬间就会被释放，表现为「点了日志，结果标签消失了」。
 */
export const QUERY_EDITOR_RESULT_HISTORY_MAX_RESULTS = 200;
export const QUERY_EDITOR_RESULT_HISTORY_MAX_ROWS = 5_000_000;
export const QUERY_EDITOR_RESULT_HISTORY_MAX_BYTES = 1024 * 1024 * 1024;
/** 最近一次执行的结果只受字节兜底约束，不设行数与数量上限。 */
export const QUERY_EDITOR_LATEST_RESULT_MAX_BYTES = 512 * 1024 * 1024;
export const QUERY_EDITOR_PINNED_RESULT_MAX_RESULTS = 50;
export const QUERY_EDITOR_PINNED_RESULT_MAX_ROWS = 1_000_000;
export const QUERY_EDITOR_PINNED_RESULT_MAX_BYTES = 256 * 1024 * 1024;

export type QueryEditorResultHistoryEntry = {
  key: string;
  pinned?: boolean;
  rows?: unknown[];
  columns?: string[];
  sql?: string;
  messages?: string[];
  rawResponse?: string;
  hasPendingChanges?: boolean;
  filterConditions?: unknown[];
  quickWhereCondition?: string;
  selectedRowKeys?: unknown[];
  selectedCellKeys?: string[];
  scrollSnapshot?: { top: number; left: number };
};

type QueryEditorResultHistoryUsage = {
  count: number;
  rows: number;
  bytes: number;
};

const QUERY_EDITOR_RESULT_ESTIMATE_MAX_DEPTH = 3;
const QUERY_EDITOR_RESULT_ESTIMATE_SAMPLE_ROWS = 64;
const QUERY_EDITOR_RESULT_ESTIMATE_SAMPLE_ITEMS = 32;
const queryEditorRowsEstimateCache = new WeakMap<unknown[], number>();

const estimateQueryEditorValueBytes = (
  value: unknown,
  depth = 0,
): number => {
  if (value === null || value === undefined) return 4;
  if (typeof value === 'string') return 8 + value.length * 2;
  if (typeof value === 'number' || typeof value === 'bigint') return 8;
  if (typeof value === 'boolean') return 4;
  if (depth >= QUERY_EDITOR_RESULT_ESTIMATE_MAX_DEPTH) return 16;
  if (Array.isArray(value)) {
    if (value.length === 0) return 16;
    const sample = value.slice(0, QUERY_EDITOR_RESULT_ESTIMATE_SAMPLE_ITEMS);
    const sampleBytes = sample.reduce(
      (sum, item) => sum + estimateQueryEditorValueBytes(item, depth + 1),
      0,
    );
    return 16 + Math.ceil((sampleBytes / sample.length) * value.length);
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value);
    const sampleKeys = keys.slice(0, QUERY_EDITOR_RESULT_ESTIMATE_SAMPLE_ITEMS);
    if (sampleKeys.length === 0) return 24;
    const record = value as Record<string, unknown>;
    const sampleBytes = sampleKeys.reduce((sum, key) => (
      sum + key.length * 2 + estimateQueryEditorValueBytes(record[key], depth + 1)
    ), 0);
    return 24 + Math.ceil((sampleBytes / sampleKeys.length) * keys.length);
  }
  return 8;
};

export const estimateQueryEditorResultSetBytes = (
  result: QueryEditorResultHistoryEntry,
): number => {
  const rows = Array.isArray(result.rows) ? result.rows : [];
  let estimatedRows = queryEditorRowsEstimateCache.get(rows);
  if (estimatedRows === undefined) {
    const sampleCount = Math.min(rows.length, QUERY_EDITOR_RESULT_ESTIMATE_SAMPLE_ROWS);
    let rowBytes = 0;
    for (let index = 0; index < sampleCount; index += 1) {
      const rowIndex = Math.min(rows.length - 1, Math.floor((index * rows.length) / sampleCount));
      rowBytes += estimateQueryEditorValueBytes(rows[rowIndex]);
    }
    estimatedRows = sampleCount > 0
      ? Math.ceil((rowBytes / sampleCount) * rows.length)
      : 0;
    queryEditorRowsEstimateCache.set(rows, estimatedRows);
  }
  return estimatedRows
    + estimateQueryEditorValueBytes(result.columns || [])
    + estimateQueryEditorValueBytes(result.messages || [])
    + estimateQueryEditorValueBytes(result.sql || '')
    + estimateQueryEditorValueBytes(result.rawResponse || '')
    + estimateQueryEditorValueBytes(result.filterConditions || [])
    + estimateQueryEditorValueBytes(result.quickWhereCondition || '')
    + estimateQueryEditorValueBytes(result.selectedRowKeys || [])
    + estimateQueryEditorValueBytes(result.selectedCellKeys || [])
    + estimateQueryEditorValueBytes(result.scrollSnapshot || null)
    + 128;
};

const measureQueryEditorResult = (
  result: QueryEditorResultHistoryEntry,
): QueryEditorResultHistoryUsage => ({
  count: 1,
  rows: Array.isArray(result.rows) ? result.rows.length : 0,
  bytes: estimateQueryEditorResultSetBytes(result),
});

const addQueryEditorResultHistoryUsage = (
  left: QueryEditorResultHistoryUsage,
  right: QueryEditorResultHistoryUsage,
): QueryEditorResultHistoryUsage => ({
  count: left.count + right.count,
  rows: left.rows + right.rows,
  bytes: left.bytes + right.bytes,
});

const measureQueryEditorResultHistory = (
  resultSets: QueryEditorResultHistoryEntry[],
): QueryEditorResultHistoryUsage => resultSets.reduce<QueryEditorResultHistoryUsage>(
  (usage, result) => addQueryEditorResultHistoryUsage(usage, measureQueryEditorResult(result)),
  { count: 0, rows: 0, bytes: 0 },
);

const fitsQueryEditorResultHistoryBudget = (
  usage: QueryEditorResultHistoryUsage,
  resultUsage: QueryEditorResultHistoryUsage,
): boolean => (
  usage.count + resultUsage.count <= QUERY_EDITOR_RESULT_HISTORY_MAX_RESULTS
  && usage.rows + resultUsage.rows <= QUERY_EDITOR_RESULT_HISTORY_MAX_ROWS
  && usage.bytes + resultUsage.bytes <= QUERY_EDITOR_RESULT_HISTORY_MAX_BYTES
);

/** 最近一次结果只受字节上限约束，行数不设限（见 QUERY_EDITOR_RESULT_HISTORY_MAX_ROWS）。 */
const fitsLatestQueryEditorResultBudget = (
  resultUsage: QueryEditorResultHistoryUsage,
): boolean => (
  resultUsage.count <= 1
  && resultUsage.bytes <= QUERY_EDITOR_LATEST_RESULT_MAX_BYTES
);

export const applyQueryEditorResultHistoryBudget = <T extends QueryEditorResultHistoryEntry>(
  resultSets: T[],
  protectedKeys: Iterable<string> = [],
): { resultSets: T[]; evictedKeys: string[] } => {
  const requiredKeys = new Set(protectedKeys);
  resultSets.forEach((result) => {
    if (result.pinned || result.hasPendingChanges) requiredKeys.add(result.key);
  });
  const measuredResults = resultSets.map((result) => ({
    result,
    usage: measureQueryEditorResult(result),
  }));

  // 最近一次执行的结果（最后一个真实数据结果）不受 5 万行预算约束：查询已不再
  // 注入 LIMIT，几十万行是正常结果，不该因为用户切到「日志」页签失去活跃态保护
  // 就被立刻释放。
  const latestIndex = measuredResults.length - 1;

  const selectedKeys = new Set<string>();
  let usage = { count: 0, rows: 0, bytes: 0 };
  measuredResults.forEach(({ result, usage: resultUsage }) => {
    if (!requiredKeys.has(result.key)) return;
    selectedKeys.add(result.key);
    usage = addQueryEditorResultHistoryUsage(usage, resultUsage);
  });

  for (let index = measuredResults.length - 1; index >= 0; index -= 1) {
    const { result, usage: resultUsage } = measuredResults[index];
    if (selectedKeys.has(result.key)) continue;
    const fits = index === latestIndex
      ? fitsLatestQueryEditorResultBudget(resultUsage)
      : fitsQueryEditorResultHistoryBudget(usage, resultUsage);
    if (!fits) continue;
    selectedKeys.add(result.key);
    usage = addQueryEditorResultHistoryUsage(usage, resultUsage);
  }

  return {
    resultSets: resultSets.filter((result) => selectedKeys.has(result.key)),
    evictedKeys: resultSets.filter((result) => !selectedKeys.has(result.key)).map((result) => result.key),
  };
};

export const canPinQueryEditorResult = <T extends QueryEditorResultHistoryEntry>(
  resultSets: T[],
  targetKey: string,
): boolean => {
  const target = resultSets.find((result) => result.key === targetKey);
  if (!target) return false;
  if (target.pinned) return true;
  const pinnedResults = resultSets.filter((result) => result.pinned || result.key === targetKey);
  const usage = measureQueryEditorResultHistory(pinnedResults);
  return usage.count <= QUERY_EDITOR_PINNED_RESULT_MAX_RESULTS
    && usage.rows <= QUERY_EDITOR_PINNED_RESULT_MAX_ROWS
    && usage.bytes <= QUERY_EDITOR_PINNED_RESULT_MAX_BYTES;
};
