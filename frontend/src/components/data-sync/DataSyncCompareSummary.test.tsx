import { describe, expect, it } from 'vitest';
import TestRenderer, { act } from 'react-test-renderer';

import { DataSyncCompareSummary } from './DataSyncCompareSummary';
import { buildCompareSummary } from './dataSyncCompareSummaryModel';
import type { DataSyncCompareResult, DataSyncTableDiffSummary } from './model';
import { createDataSyncWorkbenchTranslate } from './text';

const t = createDataSyncWorkbenchTranslate('zh-CN');

const table = (overrides: Partial<DataSyncTableDiffSummary>): DataSyncTableDiffSummary => ({
  table: 'orders',
  canSync: true,
  inserts: 0,
  updates: 0,
  deletes: 0,
  same: 0,
  hasSchema: true,
  schemaDiffCount: 0,
  columnDiffs: [],
  ...overrides,
});

const result = (
  tables: DataSyncTableDiffSummary[],
  content: DataSyncCompareResult['content'],
): DataSyncCompareResult => ({ success: true, message: '', content, tables });

const diffOnly = result(
  [
    table({
      inserts: 5,
      schemaDiffCount: 1,
      columnDiffs: [{ column: 'code', kind: 'missing_in_target', source: 'text' }],
    }),
    table({ table: 'customers', same: 90 }),
    table({ table: 'audit_log', canSync: false }),
  ],
  'both',
);

const render = (tables: DataSyncCompareResult) =>
  TestRenderer.create(
    <DataSyncCompareSummary
      summary={buildCompareSummary(tables, tables.content)}
      result={tables}
      t={t}
    />,
  );

describe('compare summary dashboard', () => {
  it('renders the hero total with the per-status caption', () => {
    const renderer = render(diffOnly);
    const summary = renderer.root.findAllByProps({
      'data-data-sync-compare-summary': 'true',
    });

    expect(summary).toHaveLength(1);
    expect(renderer.root.findAllByProps({ children: '3' }).length).toBeGreaterThan(0);
    expect(
      renderer.root.findAllByProps({ children: '张表参与本次对比' }),
    ).toHaveLength(1);
    expect(
      renderer.root.findAllByProps({
        children: '有差异 1 张、相同 1 张、无法比较 1 张',
      }),
    ).toHaveLength(1);
  });

  it('renders one KPI card per metric with its share or table hint', () => {
    const renderer = render(diffOnly);
    const cards = renderer.root.findAll(
      (node) =>
        typeof node.type === 'string' &&
        node.type === 'div' &&
        typeof node.props['data-kpi'] === 'string',
    );

    expect(cards.map((card) => card.props['data-kpi'])).toEqual([
      'diff',
      'same',
      'unknown',
      'inserts',
      'updates',
      'deletes',
      'schema',
      'high_risk',
    ]);
    expect(renderer.root.findAllByProps({ children: '占 33%' }).length).toBe(4);
    expect(renderer.root.findAllByProps({ children: '1 张表涉及' }).length).toBe(2);
    expect(renderer.root.findAllByProps({ children: '0 张表涉及' }).length).toBe(2);
  });

  it('renders the status bars scaled against the largest value', () => {
    const renderer = render(diffOnly);
    const statusSection = renderer.root.findAllByProps({
      'data-data-sync-compare-bars': 'compare.summary.status_distribution',
    })[0]!;
    const rows = statusSection.findAll(
      (node) => typeof node.type === 'string' && node.type === 'li',
    );

    expect(rows.map((row) => row.props['data-bar-key'])).toEqual(['diff', 'same', 'unknown']);
    rows.forEach((row) => {
      const fill = row.findAllByProps({ className: 'gn-data-sync-compare-bars__fill' })[0]!;
      expect(fill.props.style.width).toBe('100%');
    });
  });

  it('renders the risk band and legend for schema comparisons', () => {
    const renderer = render(diffOnly);

    expect(
      renderer.root.findAllByProps({ 'data-data-sync-compare-risk': 'true' }),
    ).toHaveLength(1);
    expect(renderer.root.findAllByProps({ 'data-bucket': 'blocking' }).length).toBeGreaterThan(0);
    expect(renderer.root.findAllByProps({ children: '共 1 处列级差异' })).toHaveLength(1);
    expect(renderer.root.findAllByProps({ children: '阻断同步' })).toHaveLength(1);
  });

  it('hides schema blocks in data-only mode', () => {
    const renderer = render(
      result([table({ inserts: 2, schemaDiffCount: 4, hasSchema: false })], 'data'),
    );

    expect(
      renderer.root.findAllByProps({ 'data-data-sync-compare-risk': 'true' }),
    ).toHaveLength(0);
    expect(
      renderer.root.findAllByProps({
        'data-data-sync-compare-bars': 'compare.summary.diff_kind_distribution',
      }),
    ).toHaveLength(0);
    expect(renderer.root.findAllByProps({ 'data-kpi': 'schema' })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ 'data-kpi': 'inserts' })).toHaveLength(1);
  });

  it('renders nothing when the result has no tables', () => {
    const renderer = render(result([], 'both'));
    expect(
      renderer.root.findAllByProps({ 'data-data-sync-compare-summary': 'true' }),
    ).toHaveLength(0);
  });
});

describe('compare summary filters', () => {
  it('keeps the active tab and query controlled through props', async () => {
    const { DataSyncCompareFilters } = await import('./DataSyncCompareFilters');
    const summary = buildCompareSummary(diffOnly, 'both');
    const changes: string[] = [];
    const renderer = TestRenderer.create(
      <DataSyncCompareFilters
        summary={summary}
        filter="diff"
        query="ord"
        riskFilter={[]}
        visibleCount={1}
        groupBy="table"
        onFilterChange={(next) => changes.push(`filter:${next}`)}
        onQueryChange={(next) => changes.push(`query:${next}`)}
        onRiskFilterChange={(next) => changes.push(`risk:${next.join(',')}`)}
        onGroupByChange={(next) => changes.push(`group:${next}`)}
        t={t}
      />,
    );

    expect(renderer.root.findAllByProps({ 'data-compare-visible-count': 1 })).toHaveLength(1);
    expect(renderer.root.findAllByProps({ children: '显示 1 张表' })).toHaveLength(1);

    const active = renderer.root.findAll(
      (node) => typeof node.type === 'string' && node.type === 'button' && node.props['role'] === 'tab',
    );
    expect(active.map((node) => node.props['data-active'])).toEqual([
      'false',
      'true',
      'false',
      'false',
    ]);

    act(() => {
      active[1]!.props.onClick();
    });
    const search = renderer.root.findAllByProps({ 'data-data-sync-compare-search': 'true' })[0]!;
    act(() => {
      search.props.onChange({ target: { value: 'orders' } });
    });

    // 风险 chip 必须带 data-risk，且只有它们响应该组事件。
    const riskChips = renderer.root.findAll(
      (node) => typeof node.type === 'string' && node.props['data-risk'] !== undefined,
    );
    expect(riskChips.map((chip) => chip.props['data-risk'])).toEqual([
      'blocking',
      'attention',
      'compatible',
    ]);
    expect(riskChips.map((chip) => chip.props['aria-pressed'])).toEqual([
      false,
      false,
      false,
    ]);
    act(() => {
      riskChips[0]!.props.onClick();
    });

    expect(changes).toEqual(['filter:diff', 'query:orders', 'risk:blocking']);
  });
});
