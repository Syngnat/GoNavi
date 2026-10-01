import { useMemo } from 'react';
import { Button, DatePicker, Input, Segmented, Select } from 'antd';
import type { RangePickerProps } from 'antd/es/date-picker';
import dayjs, { type Dayjs } from 'dayjs';
import { SearchOutlined } from '@ant-design/icons';
import { useI18n } from '../../i18n/provider';
import type { SavedConnection } from '../../types';
import type { SQLAuditFilter } from '../audit/sqlAuditModel';
import {
  isQueryHistoryStatus,
  QUERY_HISTORY_STATUS_FILTERS,
  type QueryHistoryStatusCounts,
} from './queryHistoryModel';

const { RangePicker } = DatePicker;

interface QueryHistoryToolbarProps {
  filter: SQLAuditFilter;
  counts: QueryHistoryStatusCounts;
  connections: SavedConnection[];
  hasActiveFilters: boolean;
  onFieldChange: <K extends keyof SQLAuditFilter>(key: K, value: SQLAuditFilter[K]) => void;
  onReset: () => void;
}

const buildTimePresets = (labels: Record<'lastHour' | 'today' | 'last24h' | 'last7d' | 'last30d', string>): RangePickerProps['presets'] => [
  { label: labels.lastHour, value: () => [dayjs().subtract(1, 'hour'), dayjs()] },
  { label: labels.today, value: () => [dayjs().startOf('day'), dayjs()] },
  { label: labels.last24h, value: () => [dayjs().subtract(24, 'hour'), dayjs()] },
  { label: labels.last7d, value: () => [dayjs().subtract(7, 'day'), dayjs()] },
  { label: labels.last30d, value: () => [dayjs().subtract(30, 'day'), dayjs()] },
];

export default function QueryHistoryToolbar({
  filter,
  counts,
  connections,
  hasActiveFilters,
  onFieldChange,
  onReset,
}: QueryHistoryToolbarProps) {
  const { t, language } = useI18n();
  const numberFormatter = useMemo(() => new Intl.NumberFormat(language), [language]);

  const statusOptions = useMemo(() => [
    { value: '', label: t('query_history.status.all'), count: counts.all },
    ...QUERY_HISTORY_STATUS_FILTERS.map((status) => ({
      value: status,
      label: t(`sql_audit.status.${status}` as const),
      count: counts[status],
    })),
  ].map((option) => ({
    value: option.value,
    label: (
      <span className="gn-qh-status-option">
        {option.label}
        <em>{numberFormatter.format(option.count)}</em>
      </span>
    ),
  })), [counts, numberFormatter, t]);

  const timePresets = useMemo(() => buildTimePresets({
    lastHour: t('query_history.filter.preset.last_hour'),
    today: t('query_history.filter.preset.today'),
    last24h: t('query_history.filter.preset.last_24h'),
    last7d: t('query_history.filter.preset.last_7d'),
    last30d: t('query_history.filter.preset.last_30d'),
  }), [t]);

  const rangeValue: [Dayjs | null, Dayjs | null] = [
    filter.fromTimestamp ? dayjs(filter.fromTimestamp) : null,
    filter.toTimestamp ? dayjs(filter.toTimestamp) : null,
  ];

  const handleRangeChange = (range: [Dayjs | null, Dayjs | null] | null) => {
    onFieldChange('fromTimestamp', range?.[0]?.valueOf());
    onFieldChange('toTimestamp', range?.[1]?.valueOf());
  };

  return (
    <section className="gn-qh-toolbar" aria-label={t('query_history.filter.aria_label')}>
      <Input
        className="gn-qh-filter-search"
        value={filter.search}
        onChange={(event) => onFieldChange('search', event.target.value)}
        prefix={<SearchOutlined aria-hidden="true" />}
        placeholder={t('query_history.filter.search_placeholder')}
        aria-label={t('query_history.filter.search_aria_label')}
        name="query-history-search"
        autoComplete="off"
        allowClear
      />
      <Segmented
        className="gn-qh-status-filter"
        aria-label={t('query_history.filter.status_aria_label')}
        value={filter.status}
        options={statusOptions}
        onChange={(value) => {
          const next = String(value);
          onFieldChange('status', next === '' || isQueryHistoryStatus(next) ? next : '');
        }}
      />
      <Select
        className="gn-qh-filter-connection"
        value={filter.connectionId || undefined}
        onChange={(value) => onFieldChange('connectionId', value || '')}
        placeholder={t('sql_audit.filter.connection')}
        aria-label={t('sql_audit.filter.connection')}
        allowClear
        showSearch
        optionFilterProp="label"
        options={connections.map((connection) => ({ value: connection.id, label: connection.name }))}
      />
      <Input
        className="gn-qh-filter-database"
        value={filter.database}
        onChange={(event) => onFieldChange('database', event.target.value)}
        placeholder={t('sql_audit.filter.database')}
        aria-label={t('sql_audit.filter.database')}
        name="query-history-database"
        autoComplete="off"
        allowClear
      />
      <RangePicker
        className="gn-qh-filter-time"
        showTime={{ format: 'HH:mm' }}
        format="MM-DD HH:mm"
        presets={timePresets}
        value={rangeValue}
        onChange={handleRangeChange}
        placeholder={[t('query_history.filter.time_start'), t('query_history.filter.time_end')]}
        aria-label={t('sql_audit.filter.time_range')}
        allowClear
      />
      <Button className="gn-qh-filter-reset" type="text" disabled={!hasActiveFilters} onClick={onReset}>
        {t('sql_audit.action.reset_filters')}
      </Button>
    </section>
  );
}
