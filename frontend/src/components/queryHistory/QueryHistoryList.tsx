import { useMemo, type KeyboardEvent } from 'react';
import { Button, Empty, Pagination, Spin, Typography } from 'antd';
import { useI18n } from '../../i18n/provider';
import type { SQLAuditEvent } from '../audit/sqlAuditModel';
import { formatQueryHistoryDayLabel, type QueryHistoryFormatters } from './queryHistoryFormat';
import { groupQueryHistoryByDay } from './queryHistoryModel';
import QueryHistoryRow, { getQueryHistoryRowDomId } from './QueryHistoryRow';

const { Text } = Typography;

interface QueryHistoryListProps {
  items: SQLAuditEvent[];
  total: number;
  page: number;
  pageSize: number;
  loading: boolean;
  hasActiveFilters: boolean;
  selectedId: string;
  connectionNameById: Map<string, string>;
  formatters: QueryHistoryFormatters;
  onSelect: (eventId: string) => void;
  onRestore: (event: SQLAuditEvent) => void;
  onCopySql: (event: SQLAuditEvent) => void;
  onPaginationChange: (page: number, pageSize: number) => void;
  onResetFilters: () => void;
}

const PAGE_SIZE_OPTIONS = [25, 50, 100];

export default function QueryHistoryList({
  items,
  total,
  page,
  pageSize,
  loading,
  hasActiveFilters,
  selectedId,
  connectionNameById,
  formatters,
  onSelect,
  onRestore,
  onCopySql,
  onPaginationChange,
  onResetFilters,
}: QueryHistoryListProps) {
  const { t } = useI18n();
  const groups = useMemo(() => groupQueryHistoryByDay(items), [items]);
  const selectedEvent = items.find((item) => item.id === selectedId);

  const handleKeyDown = (keyboardEvent: KeyboardEvent<HTMLDivElement>) => {
    if (items.length === 0) return;
    const currentIndex = Math.max(0, items.findIndex((item) => item.id === selectedId));
    if (keyboardEvent.key === 'ArrowDown' || keyboardEvent.key === 'ArrowUp') {
      keyboardEvent.preventDefault();
      const delta = keyboardEvent.key === 'ArrowDown' ? 1 : -1;
      const next = items[Math.min(items.length - 1, Math.max(0, currentIndex + delta))];
      onSelect(next.id);
      document.getElementById(getQueryHistoryRowDomId(next.id))?.scrollIntoView({ block: 'nearest' });
    } else if (keyboardEvent.key === 'Enter') {
      keyboardEvent.preventDefault();
      onRestore(items[currentIndex]);
    }
  };

  return (
    <section className="gn-qh-list-panel" aria-label={t('query_history.table.aria_label')} aria-busy={loading}>
      <Spin spinning={loading} wrapperClassName="gn-qh-list-spin">
        {items.length > 0 ? (
          <div
            className="gn-qh-list"
            role="listbox"
            tabIndex={0}
            aria-label={t('query_history.table.aria_label')}
            aria-activedescendant={selectedEvent ? getQueryHistoryRowDomId(selectedEvent.id) : undefined}
            onKeyDown={handleKeyDown}
          >
            {groups.map((group) => (
              <div key={group.dayKey} role="group" aria-label={formatQueryHistoryDayLabel(group.dayStart, formatters)}>
                <div className="gn-qh-day">
                  <span>{formatQueryHistoryDayLabel(group.dayStart, formatters)}</span>
                  <em>{formatters.number.format(group.items.length)}</em>
                </div>
                {group.items.map((event) => (
                  <QueryHistoryRow
                    key={event.id}
                    event={event}
                    selected={event.id === selectedId}
                    connectionName={connectionNameById.get(event.connectionId) || event.connectionId}
                    formatters={formatters}
                    onSelect={onSelect}
                    onRestore={onRestore}
                    onCopySql={onCopySql}
                  />
                ))}
              </div>
            ))}
          </div>
        ) : (
          <Empty
            className="gn-qh-empty"
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={t(hasActiveFilters ? 'query_history.empty.no_matches' : 'query_history.empty.no_records')}
          >
            {hasActiveFilters ? <Button onClick={onResetFilters}>{t('sql_audit.action.reset_filters')}</Button> : null}
          </Empty>
        )}
      </Spin>
      <footer className="gn-qh-pagination">
        <Text type="secondary">{t('sql_audit.pagination.total', { count: formatters.number.format(total) })}</Text>
        <Pagination
          size="small"
          current={page}
          pageSize={pageSize}
          total={total}
          showSizeChanger
          pageSizeOptions={PAGE_SIZE_OPTIONS}
          onChange={onPaginationChange}
          aria-label={t('sql_audit.pagination.aria_label')}
        />
      </footer>
    </section>
  );
}
