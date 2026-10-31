import { describe, expect, it } from 'vitest';

import {
  buildCompareHtmlReport,
  buildCompareReportFileName,
} from './dataSyncCompareHtmlReport';
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

const meta = {
  taskName: '订单比对',
  sourceLabel: 'MySQL 生产库',
  targetLabel: 'PostgreSQL 数仓',
  generatedAt: '2026-10-30T06:00:00.000Z',
};

const result = (
  tables: DataSyncTableDiffSummary[],
  content: DataSyncCompareResult['content'],
): DataSyncCompareResult => ({ success: true, message: '', content, tables });

describe('compare html report', () => {
  it('renders a standalone document with the hero, KPI and detail rows', () => {
    const html = buildCompareHtmlReport(
      result([
        table({
          inserts: 12,
          schemaDiffCount: 1,
          columnDiffs: [{ column: 'code', kind: 'missing_in_target', source: 'text' }],
          message: '目标表缺失 1 个字段',
        }),
        table({ table: 'customers', same: 90 }),
      ], 'both'),
      { meta, t },
    );

    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<style>');
    expect(html).toContain('订单比对');
    expect(html).toContain('MySQL 生产库');
    expect(html).toContain('PostgreSQL 数仓');
    expect(html).toContain('有差异 1 张、相同 1 张、无法比较 0 张');
    expect(html).toContain('data-tone="danger"');
    expect(html).toContain('orders');
    expect(html).toContain('data-kind-group=');
    // 完全相同的表不产生变更条目：明细只含 orders 的字段行。
    expect(html).toContain('data-kind-group="column_added"');
    expect(html).not.toContain('customers');
    // 报告不依赖应用内主题变量，导出的文件必须能独立打开。
    expect(html).not.toContain('var(--gn-');
    expect(html).not.toContain('--gn-bg-panel');
  });

  it('escapes table metadata so a hostile name cannot break the document', () => {
    const html = buildCompareHtmlReport(
      result([
        table({
          table: 'a<script>alert(1)</script>',
          message: '<img src=x onerror="alert(2)">',
          columnDiffs: [{ column: 'b"onmouseover="alert(3)', kind: 'type', source: 'int', target: 'text' }],
        }),
      ], 'both'),
      { meta: { ...meta, taskName: 'x</title><script>alert(4)</script>' }, t },
    );

    expect(html).not.toContain('<script>');
    expect(html).not.toContain('onerror="alert(2)"');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&quot;');
  });

  it('omits schema blocks for a data-only compare and row counts for schema-only', () => {
    const dataOnly = buildCompareHtmlReport(
      result([table({ inserts: 3, hasSchema: false, schemaDiffCount: 4 })], 'data'),
      { meta, t },
    );
    expect(dataOnly).not.toContain('结构差异风险分档');
    expect(dataOnly).not.toContain('结构差异类型分布');
    expect(dataOnly).toContain('新增');

    const schemaOnly = buildCompareHtmlReport(
      result([table({ schemaDiffCount: 2 })], 'schema'),
      { meta, t },
    );
    expect(schemaOnly).toContain('结构差异风险分档');
    expect(schemaOnly).not.toContain('更新');
  });

  it('uses the schema-diff counter when no column detail is present', () => {
    const html = buildCompareHtmlReport(
      result([table({ schemaDiffCount: 3 })], 'schema'),
      { meta, t },
    );

    expect(html).toContain('>3<');
    expect(html).not.toContain('gn-diffs');
  });

  it('renders an empty detail table when nothing changed', () => {
    // 相同的表没有变更条目：明细表体为空，而不是补一行占位的破折号。
    const html = buildCompareHtmlReport(result([table({ same: 10 })], 'both'), { meta, t });
    expect(html).toContain('<tbody></tbody>');
  });

  it('builds a sanitized file name that survives odd task names', () => {
    expect(buildCompareReportFileName('订单/比对', '2026-10-30T06:00:00.000Z'))
      .toBe('订单_比对-compare-2026-10-30-06-00-00');
    expect(buildCompareReportFileName('  ', '2026-10-30T06:00:00.000Z'))
      .toBe('compare-compare-2026-10-30-06-00-00');
  });
});
