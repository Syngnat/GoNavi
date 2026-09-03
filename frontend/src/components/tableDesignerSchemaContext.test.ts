import { describe, expect, it } from 'vitest';

import {
  qualifyTableDesignerCreateName,
  extractTableDesignerCurrentSchema,
  resolveInitialTableDesignerSchema,
  resolveLoadedTableDesignerSchema,
  resolveTableDesignerEditTarget,
  resolveTableDesignerSchema,
  resolveTableDesignerTableInfo,
} from './tableDesignerSchemaContext';

describe('tableDesignerSchemaContext', () => {
  it.each(['postgres', 'kingbase'])('qualifies bare %s create names with the selected schema', (dbType) => {
    expect(qualifyTableDesignerCreateName('users', 'sales', dbType)).toBe('sales.users');
  });

  it('keeps an explicitly qualified create name instead of replacing its schema', () => {
    expect(qualifyTableDesignerCreateName('archive.users', 'sales', 'postgres')).toBe('archive.users');
  });

  it('uses the selected schema for PostgreSQL table edits instead of the database name', () => {
    expect(resolveTableDesignerTableInfo({
      dbType: 'postgres',
      dbName: 'app_database',
      tableName: 'users',
      selectedSchema: 'sales',
    })).toEqual({
      schema: 'sales',
      table: 'users',
      qualifiedName: 'sales.users',
    });
  });

  it('keeps an explicit edit schema instead of replacing it with the selected schema', () => {
    expect(resolveTableDesignerTableInfo({
      dbType: 'postgres',
      dbName: 'app_database',
      tableName: 'archive.users',
      selectedSchema: 'sales',
    })).toEqual({
      schema: 'archive',
      table: 'users',
      qualifiedName: 'archive.users',
    });
  });

  it('keeps explicit edit targets until the user actively switches schemas', () => {
    expect(resolveTableDesignerEditTarget({
      dbType: 'postgres',
      dbName: 'app_database',
      tableName: 'archive.users',
      selectedSchema: 'sales',
      schemaSelectionOverride: false,
    }).qualifiedName).toBe('archive.users');
    expect(resolveTableDesignerEditTarget({
      dbType: 'postgres',
      dbName: 'app_database',
      tableName: 'archive.users',
      selectedSchema: 'sales',
      schemaSelectionOverride: true,
    }).qualifiedName).toBe('sales.users');
  });

  it('extracts current_schema from the metadata query result', () => {
    expect(extractTableDesignerCurrentSchema([{ schema_name: 'tenant' }])).toBe('tenant');
    expect(extractTableDesignerCurrentSchema([{ current_schema: 'sales' }])).toBe('sales');
    expect(extractTableDesignerCurrentSchema([])).toBe('');
  });

  it('resolves an explicit table schema before the remembered schema', () => {
    expect(resolveTableDesignerSchema('archive.users', 'sales', 'kingbase')).toBe('archive');
  });

  it('does not guess public when a bare table has no selected schema', () => {
    expect(resolveTableDesignerSchema('users', '', 'postgres')).toBe('');
    expect(qualifyTableDesignerCreateName('users', '', 'postgres')).toBe('users');
  });

  it('prefers explicit and valid remembered schemas before the current schema', () => {
    expect(resolveInitialTableDesignerSchema({
      explicitSchema: 'archive',
      rememberedSchema: 'sales',
      currentSchema: 'tenant',
      schemaNames: ['archive', 'sales', 'tenant'],
    })).toBe('archive');
    expect(resolveInitialTableDesignerSchema({
      explicitSchema: '',
      rememberedSchema: 'sales',
      currentSchema: 'tenant',
      schemaNames: ['sales', 'tenant'],
    })).toBe('sales');
  });

  it('falls back to current_schema when the remembered schema no longer exists', () => {
    expect(resolveInitialTableDesignerSchema({
      explicitSchema: '',
      rememberedSchema: 'removed',
      currentSchema: 'tenant',
      schemaNames: ['public', 'tenant'],
    })).toBe('tenant');
    expect(resolveInitialTableDesignerSchema({
      explicitSchema: '',
      rememberedSchema: 'sales',
      currentSchema: '',
      schemaNames: [],
    })).toBe('sales');
  });

  it('ignores stale loads and preserves a selection made while schemas are loading', () => {
    expect(resolveLoadedTableDesignerSchema({
      requestSeq: 1,
      currentRequestSeq: 2,
      latestSelectedSchema: 'sales',
      explicitSchema: '',
      rememberedSchema: '',
      currentSchema: 'tenant',
      schemaNames: ['public', 'sales', 'tenant'],
    })).toBeNull();
    expect(resolveLoadedTableDesignerSchema({
      requestSeq: 2,
      currentRequestSeq: 2,
      latestSelectedSchema: 'sales',
      explicitSchema: '',
      rememberedSchema: '',
      currentSchema: 'tenant',
      schemaNames: ['public', 'tenant'],
    })).toEqual({
      selectedSchema: 'sales',
      schemaNames: ['sales', 'public', 'tenant'],
    });
  });

  it('keeps non PostgreSQL-like table names unchanged', () => {
    expect(qualifyTableDesignerCreateName('users', 'sales', 'mysql')).toBe('users');
    expect(resolveTableDesignerTableInfo({
      dbType: 'mysql',
      dbName: 'app_database',
      tableName: 'users',
      selectedSchema: 'sales',
    })).toEqual({
      schema: 'app_database',
      table: 'users',
      qualifiedName: 'app_database.users',
    });
  });

  it('preserves a quoted dotted SQL Server table when resolving the edit target', () => {
    expect(resolveTableDesignerTableInfo({
      dbType: 'sqlserver',
      dbName: 'BizDB',
      tableName: '[audit].[order.items]',
      selectedSchema: '',
    })).toEqual({
      schema: 'audit',
      table: 'order.items',
      qualifiedName: '[audit].[order.items]',
    });
  });

  it('keeps the quoted table segment when switching PostgreSQL schemas', () => {
    expect(resolveTableDesignerEditTarget({
      dbType: 'postgres',
      dbName: 'app_database',
      tableName: '"archive"."Order.Items"',
      selectedSchema: 'sales',
      schemaSelectionOverride: true,
    })).toEqual({
      schema: 'sales',
      table: 'Order.Items',
      qualifiedName: 'sales."Order.Items"',
    });
  });
});
