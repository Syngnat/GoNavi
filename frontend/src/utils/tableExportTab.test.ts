import { afterEach, describe, expect, it } from 'vitest';

import {
  buildBatchConnectionWorkbenchTab,
  buildBatchDatabaseExportWorkbenchTab,
  buildBatchTableExportWorkbenchTab,
  buildDatabaseExportWorkbenchTab,
  buildExportWorkbenchHistoryKey,
  buildSchemaExportWorkbenchTab,
  buildTableExportHistoryKey,
  buildTableExportTab,
  DEFAULT_TABLE_EXPORT_SCOPE_OPTION,
} from './tableExportTab';
import { setCurrentLanguage } from '../i18n';

describe('tableExportTab', () => {
  afterEach(() => {
    setCurrentLanguage('en-US');
  });

  it('builds a stable history key for persisted export records', () => {
    expect(buildTableExportHistoryKey(' conn-1 ', ' app ', ' public.orders ')).toBe('conn-1::app::public.orders');
  });

  it('builds batch workbench history keys by mode', () => {
    expect(buildExportWorkbenchHistoryKey({
      connectionId: ' conn-1 ',
      dbName: ' app ',
      tableName: 'orders',
      exportWorkbenchMode: 'batch-tables',
    })).toBe('conn-1::app::__batch_tables__');
    expect(buildExportWorkbenchHistoryKey({
      connectionId: ' conn-1 ',
      dbName: ' ignored ',
      exportWorkbenchMode: 'batch-databases',
    })).toBe('conn-1::__batch_databases__');
    expect(buildExportWorkbenchHistoryKey({
      connectionId: ' ignored ',
      exportWorkbenchMode: 'batch-connections',
    })).toBe('__batch_connections__');
    expect(buildExportWorkbenchHistoryKey({
      connectionId: ' conn-1 ',
      dbName: ' app ',
      exportWorkbenchMode: 'database',
    })).toBe('conn-1::app::__database__');
    expect(buildExportWorkbenchHistoryKey({
      connectionId: ' conn-1 ',
      dbName: ' app ',
      schemaName: ' sales ',
      exportWorkbenchMode: 'schema',
    })).toBe('conn-1::app::sales::__schema__');
  });

  it('builds a stable table export tab with normalized defaults', () => {
    setCurrentLanguage('zh-CN');
    const tab = buildTableExportTab({
      connectionId: 'conn-1',
      dbName: 'app',
      tableName: 'public.orders',
    });

    expect(tab.id).toBe('table-export-conn-1-app-public.orders');
    expect(tab.type).toBe('table-export');
    expect(tab.title).toBe('导出 public.orders');
    expect(tab.exportWorkbenchMode).toBe('single');
    expect(tab.tableExportScopeOptions).toEqual([{ ...DEFAULT_TABLE_EXPORT_SCOPE_OPTION }]);
    expect(tab.tableExportInitialScope).toBe('all');
    expect(tab.tableExportQueryByScope).toBeUndefined();
    expect(tab.tableExportRowCountByScope).toBeUndefined();
  });

  it('deduplicates scope options and sanitizes scope payloads', () => {
    const tab = buildTableExportTab({
      connectionId: 'conn-1',
      dbName: 'app',
      tableName: 'orders',
      scopeOptions: [
        { value: 'filteredAll', label: '筛选结果', description: 'desc' },
        { value: 'filteredAll', label: '重复项应移除' },
        { value: 'page', label: '' },
      ],
      initialScope: 'filteredAll',
      queryByScope: {
        filteredAll: ' select * from orders where status = 1 ',
        page: ' ',
      },
      rowCountByScope: {
        filteredAll: 42.8,
        page: -1,
      },
    });

    expect(tab.tableExportScopeOptions).toEqual([
      { value: 'filteredAll', label: '筛选结果', description: 'desc', disabled: false },
      { value: 'page', label: 'page', description: undefined, disabled: false },
    ]);
    expect(tab.tableExportInitialScope).toBe('filteredAll');
    expect(tab.tableExportQueryByScope).toEqual({
      filteredAll: 'select * from orders where status = 1',
    });
    expect(tab.tableExportRowCountByScope).toEqual({
      filteredAll: 42,
    });
  });

  it('builds batch table export workbench tabs with stable ids', () => {
    setCurrentLanguage('zh-CN');
    const tab = buildBatchTableExportWorkbenchTab({
      connectionId: 'conn-1',
      dbName: 'SYS',
    });

    expect(tab.id).toBe('table-export-batch-tables-conn-1-SYS');
    expect(tab.type).toBe('table-export');
    expect(tab.title).toBe('批量导出对象');
    expect(tab.exportWorkbenchMode).toBe('batch-tables');
    expect(tab.dbName).toBe('SYS');
  });

  it('carries selected objects and an auto-start request into the batch table workbench', () => {
    const tab = buildBatchTableExportWorkbenchTab({
      connectionId: 'conn-1',
      dbName: 'SYS',
      initialObjectNames: [' users ', 'orders', 'users'],
      contentMode: 'backup',
      initialFormat: 'xlsx',
      includeDropIfExists: true,
      requestKey: 'batch-tables-1',
    });

    expect(tab).toEqual(expect.objectContaining({
      tableExportInitialObjectNames: ['users', 'orders'],
      tableExportContentMode: 'backup',
      tableExportInitialFormat: 'xlsx',
      tableExportIncludeDropIfExists: true,
      tableExportLaunchKey: 'batch-tables-1',
      tableExportRequestKey: 'batch-tables-1',
    }));
  });

  it('carries launch-only refresh keys without creating auto-start requests', () => {
    const tableTab = buildBatchTableExportWorkbenchTab({
      connectionId: 'conn-1',
      dbName: 'SYS',
      initialObjectNames: [' users '],
      contentMode: 'backup',
      includeDropIfExists: false,
      launchKey: ' table-launch-1 ',
    });
    const databaseTab = buildDatabaseExportWorkbenchTab({
      connectionId: 'conn-1',
      dbName: ' app ',
      contentMode: 'schema',
      launchKey: ' database-launch-1 ',
    });

    expect(tableTab).toEqual(expect.objectContaining({
      tableExportInitialObjectNames: ['users'],
      tableExportContentMode: 'backup',
      tableExportIncludeDropIfExists: false,
      tableExportLaunchKey: 'table-launch-1',
    }));
    expect(databaseTab).toEqual(expect.objectContaining({
      exportWorkbenchMode: 'database',
      dbName: 'app',
      tableExportContentMode: 'schema',
      tableExportLaunchKey: 'database-launch-1',
    }));
    expect(tableTab).toHaveProperty('tableExportRequestKey', undefined);
    expect(databaseTab).toHaveProperty('tableExportRequestKey', undefined);
  });

  it('builds batch database export workbench tabs with stable ids', () => {
    setCurrentLanguage('zh-CN');
    const tab = buildBatchDatabaseExportWorkbenchTab({
      connectionId: 'conn-1',
    });

    expect(tab.id).toBe('table-export-batch-databases-conn-1');
    expect(tab.type).toBe('table-export');
    expect(tab.title).toBe('批量导出库');
    expect(tab.exportWorkbenchMode).toBe('batch-databases');
  });

  it('builds a stable batch connection workbench tab without binding a host', () => {
    setCurrentLanguage('zh-CN');
    const tab = buildBatchConnectionWorkbenchTab({
      initialConnectionIds: [' conn-1 ', 'conn-2', 'conn-1', ''],
    });

    expect(tab.id).toBe('table-export-batch-connections');
    expect(tab.type).toBe('table-export');
    expect(tab.exportWorkbenchMode).toBe('batch-connections');
    expect(tab.connectionId).toBe('');
    expect(tab.tableExportInitialConnectionIds).toEqual(['conn-1', 'conn-2']);
    expect(tab.title).toBe('批量处理连接');
  });

  it('carries selected databases and an auto-start request into the batch database workbench', () => {
    const tab = buildBatchDatabaseExportWorkbenchTab({
      connectionId: 'conn-1',
      initialDatabaseNames: [' app ', 'audit', 'app'],
      contentMode: 'schema',
      includeDropIfExists: true,
      requestKey: 'batch-databases-1',
    });

    expect(tab).toEqual(expect.objectContaining({
      tableExportInitialDatabaseNames: ['app', 'audit'],
      tableExportContentMode: 'schema',
      tableExportIncludeDropIfExists: true,
      tableExportLaunchKey: 'batch-databases-1',
      tableExportRequestKey: 'batch-databases-1',
    }));
  });

  it('builds direct database and schema workbenches with stable targets', () => {
    const databaseTab = buildDatabaseExportWorkbenchTab({
      connectionId: 'conn-1',
      dbName: ' app ',
      contentMode: 'backup',
      requestKey: 'database-1',
    });
    const schemaTab = buildSchemaExportWorkbenchTab({
      connectionId: 'conn-1',
      dbName: 'app',
      schemaName: ' sales ',
      contentMode: 'schema',
      requestKey: 'schema-1',
    });

    expect(databaseTab).toEqual(expect.objectContaining({
      id: 'table-export-database-conn-1-app',
      type: 'table-export',
      exportWorkbenchMode: 'database',
      dbName: 'app',
      tableExportContentMode: 'backup',
      tableExportLaunchKey: 'database-1',
      tableExportRequestKey: 'database-1',
    }));
    expect(schemaTab).toEqual(expect.objectContaining({
      id: 'table-export-schema-conn-1-app-sales',
      type: 'table-export',
      exportWorkbenchMode: 'schema',
      dbName: 'app',
      schemaName: 'sales',
      tableExportContentMode: 'schema',
      tableExportLaunchKey: 'schema-1',
      tableExportRequestKey: 'schema-1',
    }));
  });

  it('uses the current language for batch workbench fallback titles', () => {
    setCurrentLanguage('en-US');

    expect(buildBatchTableExportWorkbenchTab({
      connectionId: 'conn-1',
    }).title).toBe('Batch export objects');
    expect(buildBatchDatabaseExportWorkbenchTab({
      connectionId: 'conn-1',
    }).title).toBe('Batch export databases');
  });
});
