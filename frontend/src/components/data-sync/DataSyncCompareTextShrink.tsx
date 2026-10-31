import type { DataSyncCompareResult } from './model';
import type { DataSyncWorkbenchTranslate } from './text';

type Props = {
  result: DataSyncCompareResult | null;
  t: DataSyncWorkbenchTranslate;
};

type ShrinkBucket = {
  direction: string;
  columns: number;
  tables: Map<string, number>;
};

// TEXT 容量降级：目标容量小于源端。这类差异不会让建表失败，但存量数据超长
// 会被静默截断，所以要单独提示，而不是混在「字段变更」里。
export function DataSyncCompareTextShrink({ result, t }: Props) {
  const buckets = new Map<string, ShrinkBucket>();
  (result?.tables || []).forEach((summary) => {
    (summary.columnDiffs || []).forEach((diff) => {
      if (diff.kind !== 'capacity_degraded') return;
      // 方向统一按「目标现状 → 源端最新」写，与明细表两列一致。
      const direction = `${diff.source || '—'} → ${diff.target || '—'}`;
      const bucket = buckets.get(direction) ?? { direction, columns: 0, tables: new Map() };
      bucket.columns += 1;
      bucket.tables.set(summary.table, (bucket.tables.get(summary.table) ?? 0) + 1);
      buckets.set(direction, bucket);
    });
  });
  // 没有降级时整块隐藏。
  if (buckets.size === 0) return null;

  const rows = [...buckets.values()].sort((left, right) => right.columns - left.columns);
  const max = rows.reduce((peak, row) => Math.max(peak, row.columns), 0);
  const allTables = new Map<string, number>();
  rows.forEach((row) => row.tables.forEach((count, table) => {
    allTables.set(table, (allTables.get(table) ?? 0) + count);
  }));
  const tableSummary = [...allTables.entries()]
    .sort((left, right) => right[1] - left[1])
    .map(([table, count]) => `${table}(${count})`)
    .join('、');

  return (
    <section
      className="gn-data-sync-compare-text-shrink"
      data-data-sync-compare-text-shrink="true"
    >
      <h3>{t('compare.text_shrink.title')}</h3>
      <p className="gn-data-sync-compare-text-shrink__note">
        {t('compare.text_shrink.note')}
      </p>
      <ul className="gn-data-sync-compare-bars">
        {rows.map((row) => (
          <li key={row.direction} data-tone="warn" data-direction={row.direction}>
            <span className="gn-data-sync-compare-bars__label" title={row.direction}>
              {row.direction}
            </span>
            <span className="gn-data-sync-compare-bars__track">
              <span
                className="gn-data-sync-compare-bars__fill"
                style={{ width: `${max > 0 ? (row.columns / max) * 100 : 0}%` }}
              />
            </span>
            <span className="gn-data-sync-compare-bars__value">{row.columns}</span>
          </li>
        ))}
      </ul>
      <p className="gn-data-sync-compare-text-shrink__tables">
        {t('compare.text_shrink.tables', {
          count: allTables.size,
          tables: tableSummary,
        })}
      </p>
    </section>
  );
}
