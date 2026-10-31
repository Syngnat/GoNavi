import { describe, expect, it } from 'vitest';
import TestRenderer from 'react-test-renderer';

import { DataSyncCompareAppendixTable } from './DataSyncCompareAppendixTable';
import { DataSyncCompareTextShrink } from './DataSyncCompareTextShrink';
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
  targetTableExists: true,
  columnDiffs: [],
  ...overrides,
});

const result = (tables: DataSyncTableDiffSummary[]): DataSyncCompareResult => ({
  success: true,
  message: '',
  content: 'schema',
  tables,
});

describe('TEXT capacity reduction notice', () => {
  it('groups reductions by direction and lists the affected tables', () => {
    const renderer = TestRenderer.create(
      <DataSyncCompareTextShrink
        result={result([
          table({
            table: 'orders',
            columnDiffs: [
              { column: 'a', kind: 'capacity_degraded', source: 'longtext', target: 'mediumtext' },
              { column: 'b', kind: 'capacity_degraded', source: 'longtext', target: 'mediumtext' },
            ],
          }),
          table({
            table: 'customers',
            columnDiffs: [
              { column: 'c', kind: 'capacity_degraded', source: 'mediumtext', target: 'text' },
            ],
          }),
        ])}
        t={t}
      />,
    );

    expect(
      renderer.root.findAllByProps({ 'data-data-sync-compare-text-shrink': 'true' }),
    ).toHaveLength(1);
    expect(renderer.root.findAllByProps({ children: 'TEXT 容量降级提示' })).toHaveLength(1);
    // 方向按「源端 → 目标端」写。
    expect(
      renderer.root.findAllByProps({ children: 'longtext → mediumtext' }).length,
    ).toBeGreaterThan(0);
    expect(renderer.root.findAllByProps({ children: 2 }).length).toBeGreaterThan(0);
    expect(
      renderer.root.findAllByProps({ children: '涉及 2 张表：orders(2)、customers(1)' }),
    ).toHaveLength(1);
  });

  it('hides the whole block when nothing is reduced', () => {
    const renderer = TestRenderer.create(
      <DataSyncCompareTextShrink
        result={result([table({
          columnDiffs: [{ column: 'a', kind: 'type', source: 'int', target: 'bigint' }],
        })])}
        t={t}
      />,
    );

    expect(
      renderer.root.findAllByProps({ 'data-data-sync-compare-text-shrink': 'true' }),
    ).toHaveLength(0);
  });
});

describe('compare appendix table', () => {
  it('renders default and comment drift with the shared kind tag', () => {
    const renderer = TestRenderer.create(
      <DataSyncCompareAppendixTable
        result={result([table({
          attributeDiffs: [
            { column: 'created_at', kind: 'default', source: 'CURRENT_TIMESTAMP', target: '' },
            { column: 'note', kind: 'comment', source: '备注', target: '' },
          ],
        })])}
        t={t}
      />,
    );

    expect(
      renderer.root.findAllByProps({ 'data-data-sync-compare-appendix': 'true' }),
    ).toHaveLength(1);
    expect(renderer.root.findAllByProps({ children: '仅默认值' })).toHaveLength(1);
    expect(renderer.root.findAllByProps({ children: '仅字段注释' })).toHaveLength(1);
    // 「没有 DEFAULT 子句」必须显式写成「默认 无」，不能留空。
    expect(renderer.root.findAllByProps({ children: '默认 无' })).toHaveLength(1);
    expect(
      renderer.root.findAllByProps({ children: '默认 CURRENT_TIMESTAMP' }),
    ).toHaveLength(1);
    // 标签复用主表同一套 class。
    expect(
      renderer.root.findAllByProps({ className: 'gn-data-sync-compare-detail__kind' }).length,
    ).toBeGreaterThan(0);
  });

  it('renders nothing when there is no attribute drift', () => {
    const renderer = TestRenderer.create(
      <DataSyncCompareAppendixTable result={result([table({})])} t={t} />,
    );
    expect(
      renderer.root.findAllByProps({ 'data-data-sync-compare-appendix': 'true' }),
    ).toHaveLength(0);
  });
});
