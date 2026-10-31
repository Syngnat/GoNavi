import type { CompareKpi } from './dataSyncCompareSummaryModel';
import { sharePercent } from './dataSyncCompareSummaryModel';
import type { DataSyncWorkbenchTranslate } from './text';

type Props = { kpis: CompareKpi[]; total: number; t: DataSyncWorkbenchTranslate };

const kpiHint = (
  kpi: CompareKpi,
  total: number,
  t: DataSyncWorkbenchTranslate,
): string => {
  if (kpi.hint.kind === 'share') {
    return t('compare.summary.share_of_total', { percent: sharePercent(kpi.value, total) });
  }
  // 英文单复数无法用同一个模板表达，1 张表单独取一条文案。
  return t(
    kpi.hint.count === 1
      ? 'compare.summary.tables_affected_one'
      : 'compare.summary.tables_affected',
    { count: kpi.hint.count },
  );
};

// KPI 数值一律用前景色：数据颜色留给条形图与风险色带，避免整屏花花绿绿。
export function DataSyncCompareKpis({ kpis, total, t }: Props) {
  return (
    <dl className="gn-data-sync-compare-kpis" data-data-sync-compare-kpis="true">
      {kpis.map((kpi) => (
        <div key={kpi.key} data-kpi={kpi.key}>
          <dt>{t(kpi.labelKey)}</dt>
          <dd>
            <strong>{kpi.value.toLocaleString()}</strong>
            <small>{kpiHint(kpi, total, t)}</small>
          </dd>
        </div>
      ))}
    </dl>
  );
}
