import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n/provider';
import { normalizeSQLAuditEvent } from '../audit/sqlAuditModel';
import { createQueryHistoryFormatters } from './queryHistoryFormat';
import QueryHistoryList from './QueryHistoryList';

const timestamp = new Date(2026, 8, 28, 21, 52, 29).getTime();

const items = [
  normalizeSQLAuditEvent({
    id: 'evt-error',
    timestamp,
    status: 'error',
    connectionId: 'conn-1',
    database: 'analytics',
    dbType: 'kingbase',
    sqlText: '  SELECT *\n    FROM t\n  LIMIT ?',
    sqlRedacted: true,
    durationMs: 2_975,
    error: 'relation "t" does not exist',
  }),
  normalizeSQLAuditEvent({
    id: 'evt-ok',
    timestamp: timestamp - 60_000,
    status: 'success',
    connectionId: 'conn-1',
    database: 'analytics',
    transactionId: 'tx-1',
    statementIndex: 2,
    statementCount: 3,
    sqlText: 'SELECT 1',
    durationMs: 12,
    rowsReturned: 1,
  }),
];

const renderList = (overrides: Partial<React.ComponentProps<typeof QueryHistoryList>> = {}) => renderToStaticMarkup(
  <I18nProvider preference="zh-CN" systemLanguages={['zh-CN']} onPreferenceChange={vi.fn()}>
    <QueryHistoryList
      items={items}
      total={items.length}
      page={1}
      pageSize={50}
      loading={false}
      hasActiveFilters={false}
      selectedId="evt-error"
      connectionNameById={new Map([['conn-1', 'orders-prod']])}
      formatters={createQueryHistoryFormatters('zh-CN')}
      onSelect={vi.fn()}
      onRestore={vi.fn()}
      onCopySql={vi.fn()}
      onPaginationChange={vi.fn()}
      onResetFilters={vi.fn()}
      {...overrides}
    />
  </I18nProvider>,
);

describe('QueryHistoryList', () => {
  it('shows connection, SQL preview, error text and timing for every row', () => {
    const markup = renderList();

    expect(markup).toContain('orders-prod / analytics');
    expect(markup).toContain('SELECT *\n  FROM t\nLIMIT ?');
    expect(markup).toContain('relation &quot;t&quot; does not exist');
    expect(markup).toContain('2.98 s');
    expect(markup).toContain('12 ms');
    expect(markup).toContain('kingbase');
    expect(markup).toContain('第 2/3 条语句');
    expect(markup).toContain('脱敏文本');
  });

  it('marks only the selected row and groups rows under one day header', () => {
    const markup = renderList();

    expect(markup.match(/aria-selected="true"/g)).toHaveLength(1);
    expect(markup.match(/class="gn-qh-day"/g)).toHaveLength(1);
    expect(markup).toContain('共 2 条');
  });

  it('offers a filter reset when a filtered query has no rows', () => {
    const markup = renderList({ items: [], total: 0, hasActiveFilters: true });

    expect(markup).toContain('没有符合当前筛选条件的 SQL 执行记录');
    expect(markup).toContain('重置筛选');
  });
});
