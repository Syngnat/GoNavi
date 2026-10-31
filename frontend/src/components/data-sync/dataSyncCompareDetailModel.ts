import { describeCompareRow } from './dataSyncCompareRowModel';
import { tableRiskLevel } from './dataSyncCompareSummaryModel';
import type {
  DataSyncCompareMode,
  DataSyncCompareResult,
  DataSyncTableDiffSummary,
} from './model';
import type { DataSyncWorkbenchTextKey } from './text';

/** 变更条目：一条可独立执行/核对的结构变化。 */
export type CompareDetailRow = {
  /** 稳定键：同一张表内同一类差异唯一。 */
  id: string;
  table: string;
  /** diff 维度；table 表示整表级（目标缺表）。 */
  dimension: 'table' | 'column' | 'index';
  kind: DataSyncWorkbenchTextKey;
  /** 变更类型在分组视图里的排序键。 */
  groupKey: CompareDetailGroupKey;
  /** 该条变更作用的对象名（列名 / 索引名 / 表名）。 */
  subject: string;
  /** 目标端现状：删/改的“之前”。 */
  targetSide: string;
  /** 源端最新：增/改的“之后”。 */
  sourceSide: string;
  risk: 'blocking' | 'attention' | 'compatible' | null;
};

export type CompareDetailGroupKey =
  | 'table_added'
  | 'table_removed'
  | 'table_renamed'
  | 'column_added'
  | 'column_removed'
  | 'column_changed'
  | 'column_renamed'
  | 'index_added'
  | 'index_removed'
  | 'index_changed'
  | 'index_renamed';

// 按类型分组的固定顺序，对应规格里的展示顺序。
export const DETAIL_GROUP_ORDER: CompareDetailGroupKey[] = [
  'table_added',
  'table_removed',
  'table_renamed',
  'column_added',
  'column_removed',
  'column_changed',
  'column_renamed',
  'index_renamed',
  'index_added',
  'index_removed',
  'index_changed',
];

export const DETAIL_GROUP_LABEL: Record<CompareDetailGroupKey, DataSyncWorkbenchTextKey> = {
  table_added: 'compare.detail_group.table_added',
  table_removed: 'compare.detail_group.table_removed',
  table_renamed: 'compare.detail_group.table_renamed',
  column_added: 'compare.detail_group.column_added',
  column_removed: 'compare.detail_group.column_removed',
  column_changed: 'compare.detail_group.column_changed',
  column_renamed: 'compare.detail_group.column_renamed',
  index_added: 'compare.detail_group.index_added',
  index_removed: 'compare.detail_group.index_removed',
  index_changed: 'compare.detail_group.index_changed',
  index_renamed: 'compare.detail_group.index_renamed',
};

const COLUMN_KIND_GROUP: Record<string, CompareDetailGroupKey> = {
  missing_in_target: 'column_added',
  extra_in_target: 'column_removed',
  type: 'column_changed',
  nullable: 'column_changed',
  renamed: 'column_renamed',
  // 容量降级是字段变更的一种，归到同组；它单独成一种 kind 只是为了风险与
  // 顶部提示区能区分，不另开分组，否则同一行会出现两个标签。
  capacity_degraded: 'column_changed',
};

const INDEX_KIND_GROUP: Record<string, CompareDetailGroupKey> = {
  missing_in_target: 'index_added',
  extra_in_target: 'index_removed',
  changed: 'index_changed',
  renamed: 'index_renamed',
};

const COLUMN_KIND_LABEL: Record<string, DataSyncWorkbenchTextKey> = {
  missing_in_target: 'compare.diff_kind.missing_in_target',
  extra_in_target: 'compare.diff_kind.extra_in_target',
  type: 'compare.diff_kind.type',
  nullable: 'compare.diff_kind.nullable',
  renamed: 'compare.diff_kind.renamed',
  capacity_degraded: 'compare.diff_kind.capacity_degraded',
};

const INDEX_KIND_LABEL: Record<string, DataSyncWorkbenchTextKey> = {
  missing_in_target: 'compare.index_kind.missing_in_target',
  extra_in_target: 'compare.index_kind.extra_in_target',
  changed: 'compare.index_kind.changed',
  renamed: 'compare.index_kind.renamed',
};

// 「目标端现状 / 源端最新」两列的方向约定：目标多出的记为删除（目标有、源端无），
// 目标缺失的记为新增（源端有、目标无），其余按 from → to。
const columnSides = (
  diff: { kind: string; column: string; source?: string; target?: string },
): { targetSide: string; sourceSide: string } => {
  switch (diff.kind) {
    case 'missing_in_target':
      return { targetSide: '—', sourceSide: diff.source || diff.column };
    case 'extra_in_target':
      return { targetSide: diff.target || diff.column, sourceSide: '—' };
    case 'renamed':
      return { targetSide: diff.source || diff.column, sourceSide: diff.target || '—' };
    default:
      return { targetSide: diff.target || '—', sourceSide: diff.source || '—' };
  }
};

const indexSides = (
  diff: { kind: string; name: string; source?: string; target?: string },
): { targetSide: string; sourceSide: string } => {
  switch (diff.kind) {
    case 'missing_in_target':
      return { targetSide: '—', sourceSide: diff.source || diff.name };
    case 'extra_in_target':
      return { targetSide: diff.target || diff.name, sourceSide: '—' };
    case 'renamed':
      return { targetSide: diff.source || diff.name, sourceSide: diff.target || '—' };
    default:
      return { targetSide: diff.target || '—', sourceSide: diff.source || '—' };
  }
};

// 风险按原始 kind 判定，不按分组：可空性变更和类型变更同属「字段变更」组，
// 但前者只是需关注、后者阻断同步，用组名判定会把两者抹平。
const COLUMN_KIND_RISK: Record<string, CompareDetailRow['risk']> = {
  missing_in_target: 'blocking',
  type: 'blocking',
  nullable: 'attention',
  extra_in_target: 'compatible',
  renamed: 'attention',
  // TEXT 族内部降级不会让建表失败，只是存量数据可能被截断。
  capacity_degraded: 'compatible',
};

const INDEX_KIND_RISK: Record<string, CompareDetailRow['risk']> = {
  missing_in_target: 'blocking',
  changed: 'blocking',
  extra_in_target: 'compatible',
  renamed: 'attention',
};

/**
 * 把「每表一行」的对比结果摊平成「每条变更一行」。
 *
 * 只有摊平之后才谈得上「变更类型」这一列与按类型分组；表格仍然按表聚合
 * 展示（分组视图里插表头行），两边共用同一份投影。
 */
export const projectCompareDetailRows = (
  result: DataSyncCompareResult | null,
  mode?: DataSyncCompareMode,
): CompareDetailRow[] => {
  const effectiveMode = result?.content || mode;
  const rows: CompareDetailRow[] = [];
  (result?.tables || []).forEach((summary) => {
    const row = describeCompareRow(summary, effectiveMode);
    // 无法比较的表没有可信差异，摊平只会造出假条目。
    if (row.status === 'unknown') return;
    const risk = tableRiskLevel(summary);

    // 整表级：目标缺表 / 目标多表都只有一条，不再展开成 N 条列差异。
    if (summary.diffStats?.targetTableMissing || summary.targetTableExists === false) {
      rows.push({
        id: `${summary.table}:table`,
        table: summary.table,
        dimension: 'table',
        kind: 'compare.detail_kind.table',
        groupKey: 'table_removed',
        subject: summary.table,
        targetSide: '—',
        sourceSide: summary.sourceObject || summary.table,
        risk: 'blocking',
      });
      return;
    }

    (summary.columnDiffs || []).forEach((diff, index) => {
      const groupKey = COLUMN_KIND_GROUP[diff.kind] ?? 'column_changed';
      const sides = columnSides(diff);
      rows.push({
        id: `${summary.table}:column:${diff.kind}:${diff.column}:${index}`,
        table: summary.table,
        dimension: 'column',
        kind: COLUMN_KIND_LABEL[diff.kind] ?? 'compare.diff_kind.type',
        groupKey,
        subject: diff.column,
        targetSide: sides.targetSide,
        sourceSide: sides.sourceSide,
        risk: COLUMN_KIND_RISK[diff.kind] ?? null,
      });
    });

    (summary.indexDiffs || []).forEach((diff, index) => {
      const groupKey = INDEX_KIND_GROUP[diff.kind] ?? 'index_changed';
      const sides = indexSides(diff);
      rows.push({
        id: `${summary.table}:index:${diff.kind}:${diff.name}:${index}`,
        table: summary.table,
        dimension: 'index',
        kind: INDEX_KIND_LABEL[diff.kind] ?? 'compare.index_kind.changed',
        groupKey,
        subject: diff.name,
        targetSide: sides.targetSide,
        sourceSide: sides.sourceSide,
        risk: INDEX_KIND_RISK[diff.kind] ?? null,
      });
    });
  });
  return rows;
};

/** 按表分组：表名字母序，整表行排在同表最前。 */
export const groupByTable = (rows: CompareDetailRow[]): CompareDetailRow[] => {
  const dimensionWeight = (dimension: CompareDetailRow['dimension']): number =>
    dimension === 'table' ? 0 : dimension === 'column' ? 1 : 2;
  return [...rows].sort((left, right) => {
    if (left.table !== right.table) return left.table.localeCompare(right.table);
    if (left.dimension !== right.dimension) {
      return dimensionWeight(left.dimension) - dimensionWeight(right.dimension);
    }
    return left.subject.localeCompare(right.subject);
  });
};

/** 按类型分组：固定顺序，组内按表名排序。 */
export const groupByKind = (rows: CompareDetailRow[]): CompareDetailRow[] => {
  const order = new Map(DETAIL_GROUP_ORDER.map((key, index) => [key, index] as const));
  return [...rows].sort((left, right) => {
    const leftOrder = order.get(left.groupKey) ?? DETAIL_GROUP_ORDER.length;
    const rightOrder = order.get(right.groupKey) ?? DETAIL_GROUP_ORDER.length;
    if (leftOrder !== rightOrder) return leftOrder - rightOrder;
    if (left.table !== right.table) return left.table.localeCompare(right.table);
    return left.subject.localeCompare(right.subject);
  });
};

export type CompareDetailGroup = {
  key: CompareDetailGroupKey;
  labelKey: DataSyncWorkbenchTextKey;
  rows: CompareDetailRow[];
};

/** 按类型视图需要插入的分组标题（含「类型名 · N 条」）。 */
export const splitByDetailGroup = (rows: CompareDetailRow[]): CompareDetailGroup[] =>
  DETAIL_GROUP_ORDER.flatMap((key) => {
    const groupRows = rows.filter((row) => row.groupKey === key);
    return groupRows.length === 0
      ? []
      : [{ key, labelKey: DETAIL_GROUP_LABEL[key], rows: groupRows }];
  });

/** 明细搜索：表名、对象名、两侧内容与变更类型标签都参与。 */
export const filterDetailRows = (
  rows: CompareDetailRow[],
  query: string,
  t: (key: DataSyncWorkbenchTextKey) => string,
): CompareDetailRow[] => {
  const keyword = query.trim().toLowerCase();
  if (!keyword) return rows;
  return rows.filter((row) =>
    [row.table, row.subject, row.targetSide, row.sourceSide, t(row.kind)]
      .some((value) => value.toLowerCase().includes(keyword)),
  );
};

/** 风险 chip 过滤；空集合表示不筛。 */
export const filterDetailRowsByRisk = (
  rows: CompareDetailRow[],
  risks: CompareDetailRow['risk'][],
): CompareDetailRow[] => {
  const wanted = new Set(risks);
  if (wanted.size === 0) return rows;
  return rows.filter((row) => row.risk !== null && wanted.has(row.risk));
};
