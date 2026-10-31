import type {
  CompareRiskBucket,
  CompareSummary,
  CompareTableFilter,
} from './dataSyncCompareSummaryModel';
import { compareFilterCounts } from './dataSyncCompareSummaryModel';
import type { DataSyncWorkbenchTextKey } from './text';
import type { DataSyncWorkbenchTranslate } from './text';

export type CompareGroupBy = 'table' | 'kind';

type Props = {
  summary: CompareSummary;
  filter: CompareTableFilter;
  query: string;
  riskFilter: CompareRiskBucket[];
  visibleCount: number;
  groupBy: CompareGroupBy;
  onFilterChange: (filter: CompareTableFilter) => void;
  onQueryChange: (query: string) => void;
  onRiskFilterChange: (risk: CompareRiskBucket[]) => void;
  onGroupByChange: (groupBy: CompareGroupBy) => void;
  t: DataSyncWorkbenchTranslate;
};

const FILTERS: { key: CompareTableFilter; labelKey: DataSyncWorkbenchTextKey }[] = [
  { key: 'all', labelKey: 'compare.filters.all' },
  { key: 'diff', labelKey: 'compare.status_diff' },
  { key: 'same', labelKey: 'compare.status_same' },
  { key: 'unknown', labelKey: 'compare.status_blocked' },
];

const RISK_CHIPS: { key: CompareRiskBucket; labelKey: DataSyncWorkbenchTextKey }[] = [
  { key: 'blocking', labelKey: 'compare.risk.filter_high' },
  { key: 'attention', labelKey: 'compare.risk.filter_mid' },
  { key: 'compatible', labelKey: 'compare.risk.filter_low' },
];

// 受控筛选条：标签页切状态，风险 chip 多选，搜索可叠加。
// 风险 chip 必须带 data-risk：分组类按钮不能共用同一选择器，否则点击会把
// 非风险值塞进风险集合导致列表全空。
export function DataSyncCompareFilters({
  summary,
  filter,
  query,
  riskFilter,
  visibleCount,
  groupBy,
  onFilterChange,
  onQueryChange,
  onRiskFilterChange,
  onGroupByChange,
  t,
}: Props) {
  const counts = compareFilterCounts(summary);
  const toggleRisk = (risk: CompareRiskBucket) => {
    onRiskFilterChange(
      riskFilter.includes(risk)
        ? riskFilter.filter((value) => value !== risk)
        : [...riskFilter, risk],
    );
  };
  return (
    <div className="gn-data-sync-compare-filters" data-data-sync-compare-filters="true">
      <div className="gn-data-sync-compare-filters__tabs" role="tablist">
        {FILTERS.map((item) => (
          <button
            key={item.key}
            type="button"
            role="tab"
            aria-selected={filter === item.key}
            data-compare-filter={item.key}
            data-active={filter === item.key ? 'true' : 'false'}
            onClick={() => onFilterChange(item.key)}
          >
            <span>{t(item.labelKey)}</span>
            <small>{counts[item.key].toLocaleString()}</small>
          </button>
        ))}
      </div>
      <div className="gn-data-sync-compare-filters__chips" data-compare-risk-group="true">
        {RISK_CHIPS.map((chip) => (
          <button
            key={chip.key}
            type="button"
            className="gn-data-sync-compare-chip"
            data-risk={chip.key}
            aria-pressed={riskFilter.includes(chip.key)}
            onClick={() => toggleRisk(chip.key)}
          >
            {t(chip.labelKey)}
          </button>
        ))}
      </div>
      <div className="gn-data-sync-compare-filters__chips" data-compare-group-by="true">
        <span className="gn-data-sync-compare-filters__sep">
          {t('compare.detail.group')}
        </span>
        {(['table', 'kind'] as CompareGroupBy[]).map((key) => (
          <button
            key={key}
            type="button"
            className="gn-data-sync-compare-chip"
            data-group-by={key}
            aria-pressed={groupBy === key}
            onClick={() => onGroupByChange(key)}
          >
            {t(key === 'table' ? 'compare.report.group_by_table' : 'compare.report.group_by_kind')}
          </button>
        ))}
      </div>
      <div className="gn-data-sync-compare-filters__search">
        <input
          type="search"
          className="gn-data-sync-control"
          value={query}
          placeholder={t('compare.filters.search_placeholder')}
          aria-label={t('compare.filters.search_placeholder')}
          data-data-sync-compare-search="true"
          onChange={(event) => onQueryChange(event.target.value)}
        />
        <span className="gn-data-sync-compare-filters__count" data-compare-visible-count={visibleCount}>
          {t('compare.filters.visible_count', { count: visibleCount })}
        </span>
      </div>
    </div>
  );
}
