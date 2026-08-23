import { describe, expect, it } from 'vitest';

import {
  buildDataSyncPreflightRemediationSQL,
  collectDataSyncPreflightIndexes,
  formatDataSyncPreflightIndexColumns,
} from './dataSyncPreflightIndexes';

describe('data sync preflight indexes', () => {
  it('collects only structured unmigrated index warnings and preserves prefixes', () => {
    const indexes = collectDataSyncPreflightIndexes([
      {
        id: 'unmigrated_index:map-1:0',
        code: 'unmigrated_index',
        severity: 'warning',
        stage: 'mappings',
        mappingId: 'map-1',
        message: 'review',
        detail: {
          unmigratedIndex: {
            name: 'idx_lookup',
            columns: [{ name: 'name', prefixLength: 12 }, { name: 'email' }],
            unique: false,
            indexType: 'BTREE',
            reason: 'review',
            remediationStatements: [],
          },
        },
      },
    ]);

    expect(indexes).toHaveLength(1);
    expect(formatDataSyncPreflightIndexColumns(indexes[0].columns)).toBe('name(12), email');
  });

  it('keeps MongoDB remediation commands as valid JSON', () => {
    const command = '{"createIndexes":"articles","indexes":[{"name":"idx_body","key":{"body":"text"},"unique":false}]}';
    const text = buildDataSyncPreflightRemediationSQL([
      {
        name: 'idx_body',
        columns: [{ name: 'body' }],
        unique: false,
        indexType: 'FULLTEXT',
        reason: 'review text index semantics',
        remediationStatements: [command],
      },
    ]);

    expect(text).toContain(`\n\n${command}`);
    expect(text).not.toContain(`${command};`);
  });

  it('sanitizes multiline metadata before building copyable SQL', () => {
    const sql = buildDataSyncPreflightRemediationSQL([
      {
        name: 'idx\nunsafe',
        columns: [],
        unique: false,
        indexType: 'FULLTEXT',
        reason: 'line one\nline two',
        remediationStatements: ['CREATE INDEX idx ON target (body)'],
      },
    ]);

    expect(sql).toBe('-- idx unsafe: line one line two\n\nCREATE INDEX idx ON target (body);');
    expect(sql).not.toContain('\n--');
  });
});
