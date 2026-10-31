import { describe, expect, it } from 'vitest';
import TestRenderer from 'react-test-renderer';

import { DataSyncCompareRowSchema } from './DataSyncCompareRowSchema';
import type { DataSyncTableDiffSummary } from './model';
import { createDataSyncWorkbenchTranslate } from './text';

const baseSummary: DataSyncTableDiffSummary = {
  table: 'kf_question_flow_node_bak_copy1',
  targetObject: 'kf_question_flow_node_bak_copy1',
  canSync: true,
  inserts: 0,
  updates: 0,
  deletes: 0,
  same: 0,
  hasSchema: true,
  schemaDiffCount: 6,
  columnDiffs: [
    { column: 'id', kind: 'missing_in_target', source: 'varchar(32) NOT NULL' },
  ],
  message: '目标库没有这张表；对比结果会把整表标记为缺表',
};

const renderSummary = (summary: DataSyncTableDiffSummary) =>
  TestRenderer.create(
    <DataSyncCompareRowSchema
      summary={summary}
      compareMode="schema"
      t={createDataSyncWorkbenchTranslate('zh-CN')}
    />,
  );

describe('compare row structure section', () => {
  // 目标整表缺失时，逐列差异没有信息量（列全缺），只说清「表缺失」。
  it('hides column detail when the target table is missing', () => {
    const renderer = renderSummary({ ...baseSummary, targetTableExists: false });

    expect(
      renderer.root.findAllByProps({ 'data-data-sync-column-diffs': 'true' }),
    ).toHaveLength(0);
    expect(
      renderer.root.findAllByProps({
        className: 'gn-data-sync-compare-row__schema-counts',
      }),
    ).toHaveLength(0);
  });

  // 表存在时的结构差异仍要逐列展示：类型漂移是真实差异。
  it('keeps column detail when the target table exists', () => {
    const renderer = renderSummary({
      ...baseSummary,
      targetTableExists: true,
      columnDiffs: [{ column: 'content', kind: 'type', source: 'mediumtext', target: 'longtext' }],
      schemaDiffCount: 1,
    });

    expect(
      renderer.root.findAllByProps({ 'data-data-sync-column-diffs': 'true' }),
    ).toHaveLength(1);
  });
});
