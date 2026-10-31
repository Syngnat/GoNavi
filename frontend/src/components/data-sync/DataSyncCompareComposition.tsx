import type {
  CompareBarItem,
  CompareDiffComposition,
  CompareDiffDimension,
  CompareTone,
} from './dataSyncCompareSummaryModel';
import { compositionBars } from './dataSyncCompareSummaryModel';
import type { DataSyncWorkbenchTranslate } from './text';

type Props = {
  composition: CompareDiffComposition;
  hasIndexDiffs: boolean;
  t: DataSyncWorkbenchTranslate;
};

const DIRECTIONS = [
  { key: 'added' as const, labelKey: 'compare.diff_kind.added' as const, tone: 'ok' as CompareTone },
  { key: 'removed' as const, labelKey: 'compare.diff_kind.removed' as const, tone: 'danger' as CompareTone },
  { key: 'changed' as const, labelKey: 'compare.diff_kind.changed' as const, tone: 'warn' as CompareTone },
];

// 差异条目构成：整表 / 字段 / 索引 三个维度，每个维度内按增删改细分。
// 单系列条形图，高度 12px，圆角只在数据端。
export function DataSyncCompareComposition({ composition, hasIndexDiffs, t }: Props) {
  const rows: CompareBarItem[] = compositionBars(composition, hasIndexDiffs);
  const max = rows.reduce((peak, row) => Math.max(peak, row.value), 0);
  const dimensions: CompareDiffDimension[] = hasIndexDiffs
    ? ['table', 'column', 'index']
    : ['table', 'column'];
  // 标签键显式列出，不用模板拼接：拼出来的 key 不在词典里，界面会漏出原始
  // i18n key。
  const dimensionLabel: Record<CompareDiffDimension, 'compare.composition.tables'
    | 'compare.composition.columns' | 'compare.composition.indexes'> = {
    table: 'compare.composition.tables',
    column: 'compare.composition.columns',
    index: 'compare.composition.indexes',
  };
  return (
    <section
      className="gn-data-sync-compare-bars gn-data-sync-compare-bars--composition"
      data-data-sync-compare-bars="compare.composition.title"
    >
      <h3>{t('compare.composition.title')}</h3>
      {max === 0 ? (
        <p className="gn-data-sync-compare-bars__empty">
          {t('compare.summary.no_diff_kinds')}
        </p>
      ) : (
        <ul>
          {dimensions.map((dimension) => (
            <li key={dimension} data-bar-key={dimension}>
              <span className="gn-data-sync-compare-bars__label">
                {t(dimensionLabel[dimension])}
              </span>
              <span className="gn-data-sync-compare-bars__stack">
                {DIRECTIONS.map((direction) => {
                  const value = composition[dimension][direction.key];
                  if (value === 0) return null;
                  return (
                    <span
                      key={direction.key}
                      className="gn-data-sync-compare-bars__fill"
                      data-tone={direction.tone}
                      data-direction={direction.key}
                      title={t(direction.labelKey)}
                      style={{ width: `${max > 0 ? (value / max) * 100 : 0}%` }}
                    />
                  );
                })}
              </span>
              <span className="gn-data-sync-compare-bars__value">
                {composition[dimension].added
                  + composition[dimension].removed
                  + composition[dimension].changed}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
