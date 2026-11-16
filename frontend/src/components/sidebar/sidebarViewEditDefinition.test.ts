import { beforeEach, describe, expect, it, vi } from 'vitest';

const backend = vi.hoisted(() => ({
  DBQuery: vi.fn(),
  DBShowCreateTable: vi.fn(),
}));

vi.mock('../../../wailsjs/go/app/App', () => backend);

import {
  loadSidebarViewDefinitionForEditing,
  looksLikeViewDefinition,
  normalizeSidebarViewDefinitionForEditing,
} from './sidebarViewEditDefinition';

const baseInput = {
  connectionConfig: { type: 'oracle', host: '127.0.0.1', port: 1521 },
  dbName: 'PAIFILE',
  viewName: 'PAIFILE.V_FILES',
  schemaName: 'PAIFILE',
  dialect: 'oracle',
} as const;

describe('sidebar view edit definition', () => {
  beforeEach(() => {
    backend.DBQuery.mockReset();
    backend.DBShowCreateTable.mockReset();
  });

  it.each([
    ['mysql', 'mysql', 'CREATE ALGORITHM=UNDEFINED DEFINER=`u`@`%` SQL SECURITY DEFINER VIEW `PAIFILE`.`V_FILES` AS SELECT id FROM files'],
    ['starrocks', 'starrocks', 'CREATE VIEW `PAIFILE`.`V_FILES` AS SELECT id FROM files'],
    ['postgres', 'postgres', 'SELECT id FROM files'],
    ['kingbase', 'kingbase', 'SELECT id FROM files'],
    ['sqlserver', 'sqlserver', 'CREATE VIEW [PAIFILE].[V_FILES] AS SELECT id FROM files'],
    ['oracle', 'oracle', 'CREATE OR REPLACE FORCE VIEW PAIFILE.V_FILES AS SELECT id FROM files'],
    ['dameng', 'dm', 'CREATE OR REPLACE VIEW PAIFILE.V_FILES AS SELECT id FROM files'],
    ['sqlite', 'sqlite', 'CREATE VIEW PAIFILE.V_FILES AS SELECT id FROM files'],
    ['duckdb', 'duckdb', 'SELECT id FROM files'],
    ['clickhouse', 'clickhouse', 'CREATE VIEW PAIFILE.V_FILES AS SELECT id FROM files'],
    ['firebird', 'firebird', 'CREATE VIEW PAIFILE.V_FILES AS SELECT id FROM files'],
    ['gbase8s', 'gbase8s', 'CREATE VIEW PAIFILE.V_FILES AS SELECT id FROM files'],
    ['yashandb', 'yashandb', 'CREATE OR REPLACE VIEW PAIFILE.V_FILES AS SELECT id FROM files'],
    ['questdb', 'questdb', 'CREATE VIEW PAIFILE.V_FILES AS SELECT id FROM files'],
    ['greptimedb', 'greptimedb', 'CREATE VIEW PAIFILE.V_FILES AS SELECT id FROM files'],
    ['timescaledb', 'postgres', 'SELECT id FROM files'],
    ['cockroachdb', 'postgres', 'CREATE VIEW PAIFILE.V_FILES AS SELECT id FROM files'],
  ])('uses driver DDL for %s instead of the placeholder', async (configType, dialect, driverDdl) => {
    backend.DBShowCreateTable.mockResolvedValueOnce({ success: true, data: driverDdl });

    const result = await loadSidebarViewDefinitionForEditing({
      ...baseInput,
      connectionConfig: { ...baseInput.connectionConfig, type: configType },
      dialect,
    });

    expect(result.source).toBe('driver');
    expect(result.definition).toContain('SELECT id FROM files');
    expect(result.definition).not.toContain('your_table');
    expect(looksLikeViewDefinition(result.definition)).toBe(true);
    expect(backend.DBQuery).not.toHaveBeenCalled();
  });

  it.each([
    ['mysql', 'mysql', 'SHOW CREATE VIEW'],
    ['postgres', 'postgres', 'pg_get_viewdef'],
    ['sqlserver', 'sqlserver', 'sys.all_sql_modules'],
    ['oracle', 'oracle', 'ALL_VIEWS'],
    ['dameng', 'dm', 'ALL_VIEWS'],
    ['sqlite', 'sqlite', 'sqlite_master'],
    ['duckdb', 'duckdb', 'information_schema.views'],
    ['clickhouse', 'clickhouse', 'SHOW CREATE TABLE'],
    ['yashandb', 'yashandb', 'ALL_VIEWS'],
  ])('falls back to the dialect query for %s when driver DDL is unavailable', async (configType, dialect, expectedQueryFragment) => {
    backend.DBShowCreateTable.mockResolvedValueOnce({ success: false, message: 'not supported' });
    backend.DBQuery.mockResolvedValueOnce({
      success: true,
      data: [{ view_definition: 'SELECT id FROM files' }],
    });

    const result = await loadSidebarViewDefinitionForEditing({
      ...baseInput,
      connectionConfig: { ...baseInput.connectionConfig, type: configType },
      dialect,
    });

    expect(result.source).toBe('query');
    expect(result.definition).toContain('SELECT id FROM files');
    expect(result.definition).not.toContain('your_table');
    expect(backend.DBQuery).toHaveBeenCalled();
    expect(String(backend.DBQuery.mock.calls[0][2])).toContain(expectedQueryFragment);
  });

  it('rejects table DDL returned by a mistaken metadata path', () => {
    expect(normalizeSidebarViewDefinitionForEditing(
      'oracle',
      'PAIFILE.V_FILES',
      'CREATE TABLE PAIFILE.V_FILES (id NUMBER)',
    )).toBe('');
  });

  it('quotes MySQL schema and view as separate identifiers in the fallback query', async () => {
    backend.DBShowCreateTable.mockResolvedValueOnce({ success: false });
    backend.DBQuery.mockResolvedValueOnce({
      success: true,
      data: [{ 'Create View': 'CREATE VIEW `PAIFILE`.`V_FILES` AS SELECT id FROM files' }],
    });

    await loadSidebarViewDefinitionForEditing({
      ...baseInput,
      connectionConfig: { ...baseInput.connectionConfig, type: 'mysql' },
      dialect: 'mysql',
    });

    expect(backend.DBQuery.mock.calls[0][2]).toBe('SHOW CREATE VIEW `PAIFILE`.`V_FILES`');
  });

  it('ignores table DDL and still tries the dialect view query', async () => {
    backend.DBShowCreateTable.mockResolvedValueOnce({
      success: true,
      data: 'CREATE TABLE PAIFILE.V_FILES (id NUMBER)',
    });
    backend.DBQuery.mockResolvedValueOnce({
      success: true,
      data: [{ view_definition: 'SELECT id FROM files' }],
    });

    const result = await loadSidebarViewDefinitionForEditing(baseInput);

    expect(result.source).toBe('query');
    expect(result.definition).toContain('SELECT id FROM files');
    expect(result.definition).not.toContain('CREATE TABLE');
  });

  it('returns none when neither driver DDL nor dialect queries produce a definition', async () => {
    backend.DBShowCreateTable.mockResolvedValueOnce({ success: false });
    backend.DBQuery.mockResolvedValue({ success: false, message: 'not supported' });

    const result = await loadSidebarViewDefinitionForEditing({
      ...baseInput,
      connectionConfig: { ...baseInput.connectionConfig, type: 'custom', driver: 'unknown' },
      dialect: 'unknown',
    });

    expect(result).toEqual({ definition: '', source: 'none' });
  });
});
