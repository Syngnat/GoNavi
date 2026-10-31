import { describeCompareRow } from './dataSyncCompareRowModel';
import type {
  DataSyncColumnStructureDiff,
  DataSyncCompareMode,
  DataSyncCompareResult,
  DataSyncIndexStructureDiff,
  DataSyncTableDiffSummary,
} from './model';
import type { DataSyncWorkbenchTextKey } from './text';
import type { DataSyncWorkbenchTranslate } from './text';

export type CompareTableStatus = 'diff' | 'same' | 'unknown';
export type CompareTableFilter = 'all' | CompareTableStatus;
export type CompareTone = 'danger' | 'warn' | 'ok' | 'muted';
export type CompareRiskBucket = 'blocking' | 'attention' | 'compatible';

export type CompareBarItem = {
  key: string;
  labelKey: DataSyncWorkbenchTextKey;
  value: number;
  tone: CompareTone;
};

export type CompareKpi = {
  key: string;
  labelKey: DataSyncWorkbenchTextKey;
  value: number;
  // 表数类指标显示占比，行数类指标显示涉及表数。
  hint:
    | { kind: 'share'; percent: number }
    | { kind: 'tables'; count: number };
};

export type CompareRisk = Record<CompareRiskBucket, number>;

// 每类差异各自涉及的表数，用于 KPI 卡片下方的补充说明。
export type CompareAffectedTables = {
  inserts: number;
  updates: number;
  deletes: number;
  schema: number;
};

export type CompareSummary = {
  total: number;
  diff: number;
  same: number;
  unknown: number;
  inserts: number;
  updates: number;
  deletes: number;
  schemaDiffs: number;
  showData: boolean;
  showSchema: boolean;
  affectedRows: CompareAffectedTables;
  kpis: CompareKpi[];
  statusBars: CompareBarItem[];
  diffKindBars: CompareBarItem[];
  risk: CompareRisk;
  composition: CompareDiffComposition;
  /** 含阻断级差异（缺字段、类型漂移、索引缺失/变更）的表数。 */
  highRiskTables: number;
  /** 后端是否采集到了索引差异；读不到时仪表盘不该展示索引维度。 */
  hasIndexDiffs: boolean;
};

const STATUS_LABEL_KEYS: Record<CompareTableStatus, DataSyncWorkbenchTextKey> = {
  diff: 'compare.status_diff',
  same: 'compare.status_same',
  unknown: 'compare.status_blocked',
};

const STATUS_TONES: Record<CompareTableStatus, CompareTone> = {
  diff: 'warn',
  same: 'ok',
  unknown: 'muted',
};

const DIFF_KINDS: DataSyncColumnStructureDiff['kind'][] = [
  'missing_in_target',
  'extra_in_target',
  'type',
  'nullable',
  'renamed',
  'capacity_degraded',
];

const DIFF_KIND_RISK: Record<DataSyncColumnStructureDiff['kind'], CompareRiskBucket> = {
  missing_in_target: 'blocking',
  type: 'blocking',
  nullable: 'attention',
  extra_in_target: 'compatible',
  // 重命名是推断结果：可能是改名，也可能是一删一增，按需关注处理。
  renamed: 'attention',
  // TEXT 族内部降级不会让建表失败，只是存量数据可能被截断。
  capacity_degraded: 'compatible',
};

// 索引风险口径与列不同：多出的索引不影响同步，定义变更会让后续写入走错索引，
// 与缺索引同属阻断级。
const INDEX_DIFF_RISK: Record<DataSyncIndexStructureDiff['kind'], CompareRiskBucket> = {
  missing_in_target: 'blocking',
  changed: 'blocking',
  extra_in_target: 'compatible',
  renamed: 'attention',
};

const DIFF_KIND_TONES: Record<DataSyncColumnStructureDiff['kind'], CompareTone> = {
  missing_in_target: 'danger',
  type: 'danger',
  nullable: 'warn',
  extra_in_target: 'ok',
  renamed: 'warn',
  capacity_degraded: 'warn',
};

const emptyRisk = (): CompareRisk => ({ blocking: 0, attention: 0, compatible: 0 });

const toTableStatus = (value: string): CompareTableStatus =>
  value === 'diff' || value === 'same' ? value : 'unknown';

export const sharePercent = (value: number, total: number): number =>
  total > 0 ? Math.round((value / total) * 100) : 0;

// 表缺失时逐列差异全是「目标缺失」，但列表里不展开，统计里仍按缺失列数计入
// 阻断分档：整表不存在才是最强阻断项。
const columnDiffEntries = (
  summary: DataSyncTableDiffSummary,
): DataSyncColumnStructureDiff[] => {
  const columnDiffs = summary.columnDiffs || [];
  if (columnDiffs.length > 0) return columnDiffs;
  return (summary.missingColumns || []).map((column) => ({
    column,
    kind: 'missing_in_target' as const,
  }));
};

// 差异条目按「维度 × 方向」聚合，对应仪表盘的「差异条目构成」条形图。
// 维度只有表/字段/索引三种，方向只有 增/删/改 三种，缺的一律记 0。
export type CompareDiffComposition = {
  table: { added: number; removed: number; changed: number };
  column: { added: number; removed: number; changed: number };
  index: { added: number; removed: number; changed: number };
};

export type CompareDiffDimension = keyof CompareDiffComposition;
export type CompareDiffDirection = 'added' | 'removed' | 'changed';

type Aggregated = {
  counts: Record<CompareTableStatus, number>;
  inserts: number;
  updates: number;
  deletes: number;
  affected: { inserts: number; updates: number; deletes: number; schema: number };
  schemaDiffs: number;
  diffKinds: Record<string, number>;
  risk: CompareRisk;
  composition: CompareDiffComposition;
  highRiskTables: number;
};

const emptyComposition = (): CompareDiffComposition => ({
  table: { added: 0, removed: 0, changed: 0 },
  column: { added: 0, removed: 0, changed: 0 },
  index: { added: 0, removed: 0, changed: 0 },
});

// 列差异方向：目标缺失 = 需要新增，目标多出 = 需要删除，类型/可空性 = 变更。
const COLUMN_DIFF_DIRECTION: Record<DataSyncColumnStructureDiff['kind'], CompareDiffDirection> = {
  missing_in_target: 'added',
  extra_in_target: 'removed',
  type: 'changed',
  nullable: 'changed',
  renamed: 'changed',
  capacity_degraded: 'changed',
};

const INDEX_DIFF_DIRECTION: Record<DataSyncIndexStructureDiff['kind'], CompareDiffDirection> = {
  missing_in_target: 'added',
  extra_in_target: 'removed',
  changed: 'changed',
  renamed: 'changed',
};

type AggregateOptions = {
  mode?: DataSyncCompareMode;
  showData: boolean;
  showSchema: boolean;
};

const aggregateTables = (
  tables: DataSyncTableDiffSummary[],
  { mode, showData, showSchema }: AggregateOptions,
): Aggregated => {
  const counts: Record<CompareTableStatus, number> = { diff: 0, same: 0, unknown: 0 };
  const affected = { inserts: 0, updates: 0, deletes: 0, schema: 0 };
  const diffKinds: Record<string, number> = {};
  const risk = emptyRisk();
  const composition = emptyComposition();
  let highRiskTables = 0;
  let inserts = 0;
  let updates = 0;
  let deletes = 0;
  let schemaDiffs = 0;

  tables.forEach((summary) => {
    const row = describeCompareRow(summary, mode);
    // describeCompareRow 返回对象的 status 被拓宽成 string，这里收敛回三种状态。
    counts[toTableStatus(row.status)] += 1;
    if (showData) {
      inserts += summary.inserts;
      updates += summary.updates;
      deletes += summary.deletes;
      if (summary.inserts > 0) affected.inserts += 1;
      if (summary.updates > 0) affected.updates += 1;
      if (summary.deletes > 0) affected.deletes += 1;
    }
    if (!showSchema) return;
    const entries = columnDiffEntries(summary);
    const schemaCount = summary.schemaDiffCount ?? entries.length;
    if (schemaCount > 0) affected.schema += 1;
    schemaDiffs += schemaCount;
    // 无法比较（canSync=false：读失败/未真正比对）的表不参与构成与风险分档：
    // 它的计数全是占位 0，把它算成「差异」会凭空造出一条差异。
    if (toTableStatus(row.status) === 'unknown') return;

    // 整表缺失是最强阻断项：只记一条「整表缺失」，不再把它的 N 条列差异
    // 也算成 N 条字段差异，否则一张缺表就把图表拉满。
    if (summary.diffStats?.targetTableMissing || summary.targetTableExists === false) {
      composition.table.removed += 1;
      highRiskTables += 1;
      return;
    }
    entries.forEach((entry) => {
      diffKinds[entry.kind] = (diffKinds[entry.kind] || 0) + 1;
      risk[DIFF_KIND_RISK[entry.kind]] += 1;
      composition.column[COLUMN_DIFF_DIRECTION[entry.kind]] += 1;
    });
    (summary.indexDiffs || []).forEach((entry) => {
      risk[INDEX_DIFF_RISK[entry.kind]] += 1;
      composition.index[INDEX_DIFF_DIRECTION[entry.kind]] += 1;
    });
    // 高风险表：含阻断级差异（目标缺失字段、类型漂移、索引缺失/变更）的表。
    if (entries.some((entry) => DIFF_KIND_RISK[entry.kind] === 'blocking') ||
      (summary.indexDiffs || []).some((entry) =>
        entry.kind === 'missing_in_target' || entry.kind === 'changed')) {
      highRiskTables += 1;
    }
  });

  return {
    counts, inserts, updates, deletes, affected, schemaDiffs, diffKinds, risk,
    composition, highRiskTables,
  };
};

const buildKpis = (summary: Omit<CompareSummary, 'kpis'>): CompareKpi[] => {
  const total = summary.total || 0;
  const kpis: CompareKpi[] = [
    { key: 'diff', labelKey: 'compare.summary.diff_tables', value: summary.diff, hint: { kind: 'share', percent: sharePercent(summary.diff, total) } },
    { key: 'same', labelKey: 'compare.summary.same_tables', value: summary.same, hint: { kind: 'share', percent: sharePercent(summary.same, total) } },
    { key: 'unknown', labelKey: 'compare.summary.unknown_tables', value: summary.unknown, hint: { kind: 'share', percent: sharePercent(summary.unknown, total) } },
  ];
  if (summary.showData) {
    kpis.push(
      { key: 'inserts', labelKey: 'compare.summary.inserts_total', value: summary.inserts, hint: { kind: 'tables', count: summary.affectedRows.inserts } },
      { key: 'updates', labelKey: 'compare.summary.updates_total', value: summary.updates, hint: { kind: 'tables', count: summary.affectedRows.updates } },
      { key: 'deletes', labelKey: 'compare.summary.deletes_total', value: summary.deletes, hint: { kind: 'tables', count: summary.affectedRows.deletes } },
    );
  }
  if (summary.showSchema) {
    kpis.push({
      key: 'schema',
      labelKey: 'compare.summary.schema_total',
      value: summary.schemaDiffs,
      hint: { kind: 'tables', count: summary.affectedRows.schema },
    });
    kpis.push({
      key: 'high_risk',
      labelKey: 'compare.summary.high_risk_tables',
      value: summary.highRiskTables,
      hint: { kind: 'share', percent: sharePercent(summary.highRiskTables, total) },
    });
  }
  return kpis;
};

export const buildCompareSummary = (
  result: DataSyncCompareResult | null,
  mode?: DataSyncCompareMode,
): CompareSummary => {
  const tables = result?.tables || [];
  const effectiveMode = result?.content || mode;
  const showData = !effectiveMode || effectiveMode === 'data' || effectiveMode === 'both';
  const showSchema =
    effectiveMode === 'schema' ||
    effectiveMode === 'both' ||
    tables.some((summary) => summary.hasSchema === true);
  const aggregated = aggregateTables(tables, { mode: effectiveMode, showData, showSchema });

  const base = {
    total: tables.length,
    diff: aggregated.counts.diff,
    same: aggregated.counts.same,
    unknown: aggregated.counts.unknown,
    inserts: aggregated.inserts,
    updates: aggregated.updates,
    deletes: aggregated.deletes,
    schemaDiffs: aggregated.schemaDiffs,
    showData,
    showSchema,
    affectedRows: aggregated.affected,
    statusBars: (['diff', 'same', 'unknown'] as CompareTableStatus[]).map((status) => ({
      key: status,
      labelKey: STATUS_LABEL_KEYS[status],
      value: aggregated.counts[status],
      tone: STATUS_TONES[status],
    })),
    diffKindBars: showSchema
      ? DIFF_KINDS.map((kind) => ({
          key: kind,
          labelKey: `compare.diff_kind.${kind}` as DataSyncWorkbenchTextKey,
          value: aggregated.diffKinds[kind] || 0,
          tone: DIFF_KIND_TONES[kind],
        }))
      : [],
    risk: aggregated.risk,
    composition: aggregated.composition,
    highRiskTables: aggregated.highRiskTables,
    // 索引维度只在后端确实读过索引时展示：读失败与「无索引」不可区分，
    // 空着说「0 条索引差异」会误导用户以为索引已核对过。
    hasIndexDiffs: showSchema && tables.some((summary) => (summary.indexDiffs || []).length > 0),
  };
  return { ...base, kpis: buildKpis(base) };
};

// 差异条目构成条形图：三个维度各一行，取该维度的增/删/改合计。
export const compositionBars = (
  composition: CompareDiffComposition,
  hasIndexDiffs: boolean,
): CompareBarItem[] => {
  const rows: { key: CompareDiffDimension; labelKey: DataSyncWorkbenchTextKey; tone: CompareTone }[] = [
    { key: 'table', labelKey: 'compare.composition.tables', tone: 'muted' },
    { key: 'column', labelKey: 'compare.composition.columns', tone: 'warn' },
    { key: 'index', labelKey: 'compare.composition.indexes', tone: 'ok' },
  ];
  return rows
    .filter((row) => row.key !== 'index' || hasIndexDiffs)
    .map((row) => ({
      key: row.key,
      labelKey: row.labelKey,
      value: composition[row.key].added + composition[row.key].removed + composition[row.key].changed,
      tone: row.tone,
    }));
};

/** 某张表的阻断级差异标签；用于明细与筛选。 */
export const tableRiskLevel = (
  summary: DataSyncTableDiffSummary,
): CompareRiskBucket | null => {
  const columnDiffs = columnDiffEntries(summary);
  const indexDiffs = summary.indexDiffs || [];
  if (
    columnDiffs.some((diff) => DIFF_KIND_RISK[diff.kind] === 'blocking') ||
    indexDiffs.some((diff) => INDEX_DIFF_RISK[diff.kind] === 'blocking')
  ) {
    return 'blocking';
  }
  if (columnDiffs.some((diff) => DIFF_KIND_RISK[diff.kind] === 'attention')) {
    return 'attention';
  }
  if (columnDiffs.some((diff) => DIFF_KIND_RISK[diff.kind] === 'compatible')) {
    return 'compatible';
  }
  return null;
};

export const filterCompareTables = (
  tables: DataSyncTableDiffSummary[],
  mode: DataSyncCompareMode | undefined,
  filter: CompareTableFilter,
  query: string,
  riskFilter: CompareRiskBucket[] = [],
  t?: DataSyncWorkbenchTranslate,
): DataSyncTableDiffSummary[] => {
  const keyword = query.trim().toLowerCase();
  const riskSet = new Set(riskFilter);
  return tables.filter((summary) => {
    if (filter !== 'all' && toTableStatus(describeCompareRow(summary, mode).status) !== filter) {
      return false;
    }
    // 风险 chip 是多选：空集合表示不筛。
    if (riskSet.size > 0) {
      const level = tableRiskLevel(summary);
      if (!level || !riskSet.has(level)) return false;
    }
    if (!keyword) return true;
    return searchableText(summary, t).some((value) =>
      value.toLowerCase().includes(keyword));
  });
};

// 搜索覆盖表名、两端对象名、列/索引差异的两侧内容与变更类型标签。
// 变更类型必须用翻译后的标签：把 i18n 键塞进来会命中 "missing" 这类
// 键片段，让所有缺字段的表都被搜出来。
const searchableText = (
  summary: DataSyncTableDiffSummary,
  t?: DataSyncWorkbenchTranslate,
): string[] => {
  const values: (string | undefined)[] = [
    summary.table,
    summary.sourceObject,
    summary.targetObject,
  ];
  (summary.columnDiffs || []).forEach((diff) => {
    values.push(diff.column, diff.source, diff.target);
    if (t) values.push(t(`compare.diff_kind.${diff.kind}`));
  });
  (summary.indexDiffs || []).forEach((diff) => {
    values.push(diff.name, diff.source, diff.target);
    if (t) values.push(t(`compare.index_kind.${diff.kind}`));
  });
  return values.filter((value): value is string => Boolean(value));
};

export const compareFilterCounts = (
  summary: CompareSummary,
): Record<CompareTableFilter, number> => ({
  all: summary.total,
  diff: summary.diff,
  same: summary.same,
  unknown: summary.unknown,
});
