import { DataSyncCompareBars } from './DataSyncCompareBars';
import { DataSyncCompareComposition } from './DataSyncCompareComposition';
import { DataSyncCompareKpis } from './DataSyncCompareKpis';
import { DataSyncCompareRiskBand } from './DataSyncCompareRiskBand';
import { DataSyncCompareTextShrink } from './DataSyncCompareTextShrink';
import type { CompareSummary } from './dataSyncCompareSummaryModel';
import type { DataSyncCompareResult } from './model';
import type { DataSyncWorkbenchTranslate } from './text';

type Props = {
  summary: CompareSummary;
  result: DataSyncCompareResult | null;
  t: DataSyncWorkbenchTranslate;
};

// 对比结果仪表盘顶部：Hero 总数 + KPI + 构成/分布 + 风险色带。
export function DataSyncCompareSummary({ summary, result, t }: Props) {
  if (summary.total === 0) return null;
  return (
    <section className="gn-data-sync-compare-summary" data-data-sync-compare-summary="true">
      <div className="gn-data-sync-compare-hero">
        <p className="gn-data-sync-compare-hero__label">
          {t('compare.summary.tables_total')}
        </p>
        <strong className="gn-data-sync-compare-hero__value">
          {summary.total.toLocaleString()}
        </strong>
        <p className="gn-data-sync-compare-hero__note">
          {t('compare.summary.hero_caption', {
            diff: summary.diff,
            same: summary.same,
            unknown: summary.unknown,
          })}
        </p>
      </div>

      <DataSyncCompareKpis kpis={summary.kpis} total={summary.total} t={t} />

      <div className="gn-data-sync-compare-dashboard">
        <DataSyncCompareBars
          titleKey="compare.summary.status_distribution"
          bars={summary.statusBars}
          emptyKey="compare.summary.no_diff_kinds"
          t={t}
        />
        {summary.showSchema ? (
          <DataSyncCompareBars
            titleKey="compare.summary.diff_kind_distribution"
            bars={summary.diffKindBars}
            emptyKey="compare.summary.no_diff_kinds"
            t={t}
          />
        ) : null}
        {summary.showSchema ? (
          <DataSyncCompareComposition
            composition={summary.composition}
            hasIndexDiffs={summary.hasIndexDiffs}
            t={t}
          />
        ) : null}
        {summary.showSchema ? (
          <DataSyncCompareTextShrink result={result} t={t} />
        ) : null}
        {summary.showSchema ? (
          <DataSyncCompareRiskBand risk={summary.risk} t={t} />
        ) : null}
      </div>
    </section>
  );
}
