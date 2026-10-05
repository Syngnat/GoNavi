import React from 'react';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  V2ConnectionContextMenuView,
  V2DatabaseContextMenuView,
  V2TableContextMenuView,
} from './V2TableContextMenu';
import { t } from '../i18n';
import { registryAllowsImport } from '../utils/dataSourceRegistry';
import { createTableExportFormatOptions } from './tableExport/tableExportWorkbenchOptions';
import { decodeSavedConnectionViews } from './data-sync/wailsDtoMetadata';

const sqlDumpTitle = t('sidebar.v2_table_menu.backup_sql_dump', { keyword: 'SQL Dump' });
const copyInsertTitle = t('sidebar.v2_table_menu.copy_table_as_insert', { keyword: 'INSERT' });
const runSqlFileTitle = t('sidebar.sql_file_exec.title');

describe('transfer entry gating for data sources without SQL round-trips', () => {
  it('hides SQL dump and copy-as-INSERT on tables of non-SQL sources', () => {
    const hidden = renderToStaticMarkup(<V2TableContextMenuView tableName="movies" supportsSqlExport={false} />);
    expect(hidden).not.toContain(sqlDumpTitle);
    expect(hidden).not.toContain(copyInsertTitle);
    expect(hidden).toContain(t('sidebar.v2_table_menu.open_export_workbench'));

    const shown = renderToStaticMarkup(<V2TableContextMenuView tableName="orders" />);
    expect(shown).toContain(sqlDumpTitle);
    expect(shown).toContain(copyInsertTitle);
  });

  it('hides database SQL backups and run-SQL-file when the source cannot take them', () => {
    const markup = renderToStaticMarkup(
      <V2DatabaseContextMenuView dbName="default" supportsBatchWorkbench={false} supportsRunSqlFile={false} />,
    );
    expect(markup).not.toContain(t('sidebar.v2_database_menu.backup_all_tables_sql'));
    expect(markup).not.toContain(t('sidebar.v2_database_menu.export_backup_section'));
    expect(markup).not.toContain(runSqlFileTitle);

    const connection = renderToStaticMarkup(
      <V2ConnectionContextMenuView connectionName="search" driverLabel="meilisearch" supportsRunSqlFile={false} />,
    );
    expect(connection).toContain(t('sidebar.menu.new_query'));
    expect(connection).not.toContain(runSqlFileTitle);
  });

  it('reads import entry points from the data source registry', () => {
    expect(registryAllowsImport('tidb', 'sqlFile')).toBe(true);
    expect(registryAllowsImport('meilisearch', 'sqlFile')).toBe(false);
    expect(registryAllowsImport('meilisearch', 'table')).toBe(true);
    expect(registryAllowsImport('questdb', 'table')).toBe(true);
    expect(registryAllowsImport('opensearch', 'table')).toBe(false);
    expect(registryAllowsImport('presto', 'table')).toBe(false);
    // 历史类型由后端导入能力决定，入口照常显示。
    expect(registryAllowsImport('mysql', 'sqlFile')).toBe(true);
  });

  it('drops the SQL format from the single-table export workbench on request', () => {
    expect(createTableExportFormatOptions().some((option) => option.value === 'sql')).toBe(true);
    expect(createTableExportFormatOptions(false).some((option) => option.value === 'sql')).toBe(false);
  });

  it('offers registry connections to data sync only in the roles their spec declares', () => {
    const views = decodeSavedConnectionViews([
      { id: 'a', name: 'TiDB', config: { type: 'tidb' } },
      { id: 'b', name: 'Presto', config: { type: 'presto' } },
      { id: 'c', name: 'Search', config: { type: 'meilisearch' } },
      { id: 'd', name: 'MySQL', config: { type: 'mysql' } },
    ]);
    const roles = Object.fromEntries(views.map((view) => [view.id, [view.readable, view.writable]]));
    expect(roles).toEqual({ a: [true, true], b: [true, false], c: [false, false], d: [true, true] });
  });
});
