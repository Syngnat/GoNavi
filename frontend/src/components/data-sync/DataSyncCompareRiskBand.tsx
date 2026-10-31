import type { CompareRisk } from './dataSyncCompareSummaryModel';
import type { DataSyncWorkbenchTranslate } from './text';

type Props = { risk: CompareRisk; t: DataSyncWorkbenchTranslate };

const BUCKETS = [
  { key: 'blocking' as const, tone: 'danger', labelKey: 'compare.risk.blocking' as const },
  { key: 'attention' as const, tone: 'warn', labelKey: 'compare.risk.attention' as const },
  { key: 'compatible' as const, tone: 'ok', labelKey: 'compare.risk.compatible' as const },
];

// 26px 堆叠条：红阻断 / 黄关注 / 绿兼容。分档按列级差异类型计数。
//
// 段宽用 flex-grow 按数量分配，而不是写 width 百分比：色带有 2px 段间距，
// 百分比总和 100% 再加间距必然溢出，最窄的一段会被挤成 0 宽而消失。
export function DataSyncCompareRiskBand({ risk, t }: Props) {
  const total = BUCKETS.reduce((sum, bucket) => sum + risk[bucket.key], 0);
  return (
    <section className="gn-data-sync-compare-risk" data-data-sync-compare-risk="true">
      <div className="gn-data-sync-compare-risk__head">
        <h3>{t('compare.risk.title')}</h3>
        <span>{t('compare.risk.total', { count: total.toLocaleString() })}</span>
      </div>
      <div
        className="gn-data-sync-compare-risk__band"
        role="img"
        aria-label={t('compare.risk.title')}
        data-empty={total === 0 ? 'true' : 'false'}
      >
        {total === 0 ? null : (
          BUCKETS.filter((bucket) => risk[bucket.key] > 0).map((bucket) => (
            <span
              key={bucket.key}
              data-tone={bucket.tone}
              data-bucket={bucket.key}
              style={{ flex: `${risk[bucket.key]} 1 0` }}
            >
              {risk[bucket.key].toLocaleString()}
            </span>
          ))
        )}
      </div>
      <ul className="gn-data-sync-compare-risk__legend">
        {BUCKETS.map((bucket) => (
          <li key={bucket.key} data-tone={bucket.tone} data-bucket={bucket.key}>
            <span className="gn-data-sync-compare-risk__dot" aria-hidden="true" />
            <span>{t(bucket.labelKey)}</span>
            <strong>{risk[bucket.key].toLocaleString()}</strong>
          </li>
        ))}
      </ul>
    </section>
  );
}
