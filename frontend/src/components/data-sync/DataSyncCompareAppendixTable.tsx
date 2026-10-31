import type { DataSyncCompareResult } from './model';
import type { DataSyncWorkbenchTranslate } from './text';

type Props = {
  result: DataSyncCompareResult | null;
  t: DataSyncWorkbenchTranslate;
};

type AppendixRow = {
  id: string;
  table: string;
  column: string;
  kind: 'default' | 'comment';
  targetSide: string;
  sourceSide: string;
};

const COLUMN_WIDTHS = ['26%', '6%', '18%', '20%', '20%', '10%'];

// 「没有 DEFAULT 子句」必须显式写成「无」：留空会让人以为后端没取到值。
const sideText = (
  value: string | undefined,
  kind: 'default' | 'comment',
  t: DataSyncWorkbenchTranslate,
): string => {
  const trimmed = (value || '').trim();
  if (kind === 'comment') return trimmed || '—';
  return trimmed ? `${t('compare.appendix.default_prefix')}${trimmed}` : t('compare.appendix.default_none');
};

const Cell = ({ value, className }: { value: string; className?: string }) => (
  <td className={className} title={value}>{value}</td>
);

/**
 * 附表：只含默认值与注释的差异。
 *
 * 这类差异不影响建表，但会让两端行为不同，所以单独一张表；标签与主表
 * 复用同一套 class，避免两处样式漂移。
 */
export function DataSyncCompareAppendixTable({ result, t }: Props) {
  const rows: AppendixRow[] = [];
  (result?.tables || []).forEach((summary) => {
    const diffs = summary.attributeDiffs || [];
    if (diffs.length === 0) return;
    diffs.forEach((diff, index) => {
      rows.push({
        id: `${summary.table}:attr:${diff.kind}:${diff.column}:${index}`,
        table: summary.table,
        column: diff.column,
        kind: diff.kind,
        targetSide: sideText(diff.target, diff.kind, t),
        sourceSide: sideText(diff.source, diff.kind, t),
      });
    });
  });
  if (rows.length === 0) return null;

  const tableCounts = new Map<string, number>();
  rows.forEach((row) => tableCounts.set(row.table, (tableCounts.get(row.table) ?? 0) + 1));

  return (
    <section
      className="gn-data-sync-compare-appendix"
      data-data-sync-compare-appendix="true"
    >
      <h3>{t('compare.appendix.title')}</h3>
      <div className="gn-data-sync-compare-detail__scroll">
        <table className="gn-data-sync-compare-detail__table">
          <colgroup>
            {COLUMN_WIDTHS.map((width) => <col key={width} style={{ width }} />)}
          </colgroup>
          <thead>
            <tr>
              <th>{t('compare.detail.column_table')}</th>
              <th className="num">{t('compare.detail.column_count')}</th>
              <th>{t('compare.detail.column_subject')}</th>
              <th>{t('compare.detail.column_target')}</th>
              <th>{t('compare.detail.column_source')}</th>
              <th>{t('compare.detail.column_kind')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const kindLabel = t(
                row.kind === 'default'
                  ? 'compare.attr_kind.default'
                  : 'compare.attr_kind.comment',
              );
              return (
                <tr key={row.id}>
                  <Cell value={row.table} className="mono" />
                  <Cell value={String(tableCounts.get(row.table) ?? 1)} className="num" />
                  <Cell value={row.column} className="mono" />
                  <Cell value={row.targetSide} className="mono" />
                  <Cell value={row.sourceSide} className="mono" />
                  <td title={kindLabel}>
                    <span
                      className="gn-data-sync-compare-detail__kind"
                      data-kind={row.kind === 'default' ? 'attr_default' : 'attr_comment'}
                    >
                      {kindLabel}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
