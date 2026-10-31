import { describe, expect, it } from 'vitest';
import { buildDataGridBackendExportOptions } from '../components/dataGridExportOptions';

const metadata = {
  columnMetaMap: { text: { comment: 'note' } }, columnMetaMapByLowerName: { text: { comment: 'note' } },
  displayOutputColumnNames: ['text'], dbType: 'hive', hasResolvedInsertSQLTarget: true, tableName: 'target',
  insertSQLColumnTypes: { text: 'STRING' }, insertSQLTargetColumns: { text: 'text' },
};

describe('Hive lossless export option propagation', () => {
  it.each(['csv', 'json', 'xlsx', 'sql'])('adds the Hive mode to the shared query/table/snapshot %s options', format => {
    const input = { format, columns: ['text'], useColumnComments: true };
    const options = buildDataGridBackendExportOptions(input, metadata);
    expect(options).toHaveProperty('losslessHive', true);
    expect(options.columns).toEqual(['text']);
    expect(input).not.toHaveProperty('losslessHive');
  });

  it('leaves non-Hive export defaults unchanged and keeps plugin exports isolated', () => {
    const options = buildDataGridBackendExportOptions({ format: 'csv' }, { ...metadata, dbType: 'mysql' });
    expect(options).toEqual({ format: 'csv', csvEncoding: 'utf-8-bom' });
    expect(buildDataGridBackendExportOptions({ format: 'plugin:com.example.exporter:csv' }, metadata)).not.toHaveProperty('losslessHive');
  });
});
