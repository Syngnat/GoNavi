import type {
  CompareDetailGroup,
  CompareDetailRow,
} from './dataSyncCompareDetailModel';
import type { DataSyncWorkbenchTranslate } from './text';

type Props = {
  rows: CompareDetailRow[];
  groups: CompareDetailGroup[] | null;
  groupBy: 'table' | 'kind';
  t: DataSyncWorkbenchTranslate;
};

const RISK_CLASS: Record<NonNullable<CompareDetailRow['risk']>, string> = {
  blocking: 't-high',
  attention: 't-mid',
  compatible: 't-low',
};

const riskLabelKey = (risk: NonNullable<CompareDetailRow['risk']>) =>
  risk === 'blocking'
    ? 'compare.risk.filter_high' as const
    : risk === 'attention'
      ? 'compare.risk.filter_mid' as const
      : 'compare.risk.filter_low' as const;

// 三类行视觉区分：整表行加粗底纹、索引行淡紫底、字段行无底色。
const rowClass = (row: CompareDetailRow): string => {
  if (row.dimension === 'table') return 'gn-data-sync-compare-detail__row table-row';
  if (row.dimension === 'index') return 'gn-data-sync-compare-detail__row idx-row';
  return 'gn-data-sync-compare-detail__row';
};

// 每列宽度百分比。固定列宽是必需的：不定宽时内容一长就把「风险」列挤出视野，
// 于是最关键的一列反而看不到。
const COLUMN_WIDTHS = ['24%', '4%', '8%', '20%', '15%', '15%', '6%'];

type CellProps = { value: string; className?: string };

// 固定列宽必然截断内容，所以每个单元格都把完整文本放进 title，悬停可见。
const Cell = ({ value, className }: CellProps) => (
  <td className={className} title={value}>{value}</td>
);

/**
 * 变更明细：每行一条结构变更，7 列。
 *
 * 数据先按 groupBy 排好（按表 / 按类型），按类型视图插入分组标题行。
 * 表头 sticky，长列表滚动时列名不丢。
 */
export function DataSyncCompareDetailTable({ rows, groups, groupBy, t }: Props) {
  // 「张数」= 该表共产生多少条变更；按表视图里同表多行共用这一个数。
  const tableCounts = new Map<string, number>();
  rows.forEach((row) => tableCounts.set(row.table, (tableCounts.get(row.table) ?? 0) + 1));

  const renderRow = (row: CompareDetailRow) => {
    const count = String(tableCounts.get(row.table) ?? 1);
    const kind = t(row.kind);
    const riskLabel = row.risk ? t(riskLabelKey(row.risk)) : '—';
    return (
      <tr key={row.id} className={rowClass(row)} data-kind-group={row.groupKey}>
        <Cell value={row.table} className="mono" />
        <Cell value={count} className="num" />
        <td title={kind}>
          <span className="gn-data-sync-compare-detail__kind" data-kind={row.groupKey}>
            {kind}
          </span>
        </td>
        <Cell value={row.subject} className="mono" />
        <Cell value={row.targetSide} className="mono" />
        <Cell value={row.sourceSide} className="mono" />
        <td title={riskLabel}>
          {row.risk ? (
            <span className={`gn-data-sync-compare-detail__risk ${RISK_CLASS[row.risk]}`}>
              <span className="gn-data-sync-compare-detail__dot" />
              {riskLabel}
            </span>
          ) : (
            '—'
          )}
        </td>
      </tr>
    );
  };

  const body = groups
    ? groups.flatMap((group) => [
      <tr
        key={`group:${group.key}`}
        className="gn-data-sync-compare-detail__group-head"
        data-group-head={group.key}
      >
        <td colSpan={7}>
          {t('compare.detail.group_count', {
            name: t(group.labelKey),
            count: group.rows.length,
          })}
        </td>
      </tr>,
      ...group.rows.map(renderRow),
    ])
    : rows.map(renderRow);

  return (
    <div
      className="gn-data-sync-compare-detail"
      data-data-sync-compare-detail="true"
      data-group-by={groupBy}
    >
      <div className="gn-data-sync-compare-detail__scroll">
        <table className="gn-data-sync-compare-detail__table">
          <colgroup>
            {COLUMN_WIDTHS.map((width) => <col key={width} style={{ width }} />)}
          </colgroup>
          <thead>
            <tr>
              <th>{t('compare.detail.column_table')}</th>
              <th className="num">{t('compare.detail.column_count')}</th>
              <th>{t('compare.detail.column_kind')}</th>
              <th>{t('compare.detail.column_subject')}</th>
              <th>{t('compare.detail.column_target')}</th>
              <th>{t('compare.detail.column_source')}</th>
              <th>{t('compare.report.risk')}</th>
            </tr>
          </thead>
          <tbody>{body}</tbody>
        </table>
      </div>
    </div>
  );
}
