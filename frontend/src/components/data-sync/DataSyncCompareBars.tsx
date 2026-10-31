import type { CompareBarItem } from './dataSyncCompareSummaryModel';
import type { DataSyncWorkbenchTranslate } from './text';

type Props = {
  titleKey: 'compare.summary.status_distribution' | 'compare.summary.diff_kind_distribution';
  bars: CompareBarItem[];
  t: DataSyncWorkbenchTranslate;
  // 全部为 0 时展示占位说明，避免一屏空条。
  emptyKey: 'compare.summary.no_diff_kinds';
};

// 单系列横向条形图：标签 + 细条 + 数值。条宽按占最大值的比例，避免小数值
// 被压成 0 像素；数值为 0 的行仍列出，让分档口径可见。
export function DataSyncCompareBars({ titleKey, bars, t, emptyKey }: Props) {
  const max = bars.reduce((peak, bar) => Math.max(peak, bar.value), 0);
  return (
    <section className="gn-data-sync-compare-bars" data-data-sync-compare-bars={titleKey}>
      <h3>{t(titleKey)}</h3>
      {max === 0 ? (
        <p className="gn-data-sync-compare-bars__empty">{t(emptyKey)}</p>
      ) : (
        <ul>
          {bars.map((bar) => (
            <li key={bar.key} data-tone={bar.tone} data-bar-key={bar.key}>
              <span className="gn-data-sync-compare-bars__label">{t(bar.labelKey)}</span>
              <span className="gn-data-sync-compare-bars__track">
                <span
                  className="gn-data-sync-compare-bars__fill"
                  style={{ width: `${max > 0 ? (bar.value / max) * 100 : 0}%` }}
                />
              </span>
              <span className="gn-data-sync-compare-bars__value">
                {bar.value.toLocaleString()}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
