import { describe, expect, it } from 'vitest';

import { buildAlterTablePreviewSql } from './tableDesignerSchemaSqlAlter';
import { resolveTableDesignerTableInfo } from './tableDesignerSchemaContext';
import { supportsTableClearAction, supportsTableTruncateAction } from './tableDataDangerActions';
import { supportsDatabaseSequences } from './sidebar/sidebarMetadataBasics';
import { usesDriverObjectDefinition } from './definitionViewerDialect';

const column = (overrides: Record<string, unknown>) => ({
  _key: String(overrides.name),
  name: '',
  type: 'integer',
  nullable: 'YES',
  key: '',
  extra: '',
  comment: '',
  default: undefined,
  ...overrides,
}) as Record<string, unknown>;

describe('GBase 8s (Informix) table designer SQL', () => {
  it('uses ADD / MODIFY / DROP with parentheses and a separate RENAME COLUMN', () => {
    const originalColumns = [
      column({ name: 'id', type: 'serial', nullable: 'NO', key: 'PRI' }),
      column({ name: 'note', type: 'varchar(20)' }),
      column({ name: 'legacy', type: 'integer' }),
    ];
    const columns = [
      column({ name: 'id', type: 'serial', nullable: 'NO', key: 'PRI' }),
      { ...column({ name: 'memo', type: 'varchar(40)', nullable: 'NO' }), _key: 'note' },
      column({ name: 'level', type: 'varchar(255)' }),
    ];
    const sql = buildAlterTablePreviewSql({ dbType: 'gbase8s', tableName: 'customers', originalColumns, columns } as never);
    expect(sql).toBe([
      'ALTER TABLE customers\nDROP (legacy);',
      'RENAME COLUMN customers.note TO memo;',
      'ALTER TABLE customers\nMODIFY (memo varchar(40) NOT NULL);',
      'ALTER TABLE customers\nADD (level varchar(255));',
    ].join('\n'));
  });

  it('adds a primary key with ADD CONSTRAINT and leaves dropping the old one to the user', () => {
    const originalColumns = [column({ name: 'id' })];
    const columns = [column({ name: 'id', key: 'PRI', nullable: 'NO' })];
    const sql = buildAlterTablePreviewSql({ dbType: 'gbase8s', tableName: 'orders', originalColumns, columns } as never);
    expect(sql).toContain('ADD CONSTRAINT PRIMARY KEY (id);');
    const dropped = buildAlterTablePreviewSql({ dbType: 'gbase8s', tableName: 'orders', originalColumns: columns, columns: originalColumns } as never);
    expect(dropped.split('\n').some((line) => line.startsWith('-- '))).toBe(true);
  });

  it('does not qualify tables with the database name (owner.table in Informix)', () => {
    const info = resolveTableDesignerTableInfo({ dbType: 'gbase8s', dbName: 'gonavi_lab', tableName: 'customers', selectedSchema: '' } as never);
    expect(info.qualifiedName).toBe('customers');
    expect(resolveTableDesignerTableInfo({ dbType: 'mysql', dbName: 'shop', tableName: 'customers', selectedSchema: '' } as never).qualifiedName).toBe('shop.customers');
  });

  it('offers truncate / clear, sequences and driver-provided routine definitions from the registry', () => {
    expect(supportsTableTruncateAction('gbase8s')).toBe(true);
    expect(supportsTableClearAction('gbase8s')).toBe(true);
    expect(supportsDatabaseSequences({ config: { type: 'gbase8s' } } as never)).toBe(true);
    expect(supportsDatabaseSequences({ config: { type: 'influxdb' } } as never)).toBe(false);
    expect(usesDriverObjectDefinition({ config: { type: 'gbase8s' } })).toBe(true);
    expect(usesDriverObjectDefinition({ config: { type: 'tidb' } })).toBe(false);
    expect(usesDriverObjectDefinition({ config: { type: 'mysql' } })).toBe(false);
  });
});
