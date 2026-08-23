import { describe, expect, it } from 'vitest';

import type { ExternalSQLDirectory, SavedConnection, TabData } from '../../types';
import { buildExternalSQLFileSnapshot } from './aiExternalSqlFileInsights';

const connections: SavedConnection[] = [
  {
    id: 'conn-1',
    name: '本地开发库',
    config: {
      type: 'mysql',
      host: '127.0.0.1',
      port: 3306,
      user: 'root',
    },
  },
  {
    id: 'conn-2',
    name: '报表库',
    config: {
      type: 'sqlserver',
      host: '192.168.1.10',
      port: 1433,
      user: 'reporter',
    },
  },
];

describe('aiExternalSqlFileInsights', () => {
  it('builds a file snapshot with directory metadata, open tab context, and truncated content preview', () => {
    const externalSQLDirectories: ExternalSQLDirectory[] = [
      {
        id: 'dir-1',
        name: '报表脚本',
        path: 'D:/sql/reports',
        connectionId: 'conn-1',
        dbName: 'crm',
        fileBindings: [{
          filePath: 'D:/sql/reports/daily.sql',
          connectionId: 'conn-2',
          dbName: 'reporting',
        }],
        createdAt: 1,
      },
    ];
    const tabs: TabData[] = [
      {
        id: 'tab-1',
        title: 'daily.sql',
        type: 'query',
        connectionId: 'conn-1',
        dbName: 'crm',
        filePath: 'D:/sql/reports/daily.sql',
        query: 'select 1',
      },
    ];

    const snapshot = buildExternalSQLFileSnapshot({
      filePath: 'D:/sql/reports/daily.sql',
      previewCharLimit: 12,
      readResult: {
        content: 'SELECT * FROM orders WHERE status = \'paid\';',
        filePath: 'D:/sql/reports/daily.sql',
        name: 'daily.sql',
      },
      externalSQLDirectories,
      connections,
      tabs,
    });

    expect(snapshot.hasMatchedDirectory).toBe(true);
    expect(snapshot.directory).toMatchObject({
      name: '报表脚本',
      connectionName: '报表库',
      connectionType: 'sqlserver',
      dbName: 'reporting',
      bindingSource: 'file',
    });
    expect(snapshot.hasOpenTab).toBe(true);
    expect(snapshot.openTabCount).toBe(1);
    expect(snapshot.fileName).toBe('daily.sql');
    expect(snapshot.contentPreview).toBe('SELECT * FRO');
    expect(snapshot.truncated).toBe(true);
  });

  it('restores the original directory metadata after a file-specific binding is cleared', () => {
    const snapshot = buildExternalSQLFileSnapshot({
      filePath: 'D:/sql/reports/daily.sql',
      readResult: {
        content: 'SELECT 1;',
        filePath: 'D:/sql/reports/daily.sql',
        name: 'daily.sql',
      },
      externalSQLDirectories: [{
        id: 'dir-1',
        name: '报表脚本',
        path: 'D:/sql/reports',
        connectionId: 'conn-1',
        dbName: 'crm',
        createdAt: 1,
      }],
      connections,
    });

    expect(snapshot.directory).toMatchObject({
      connectionId: 'conn-1',
      connectionName: '本地开发库',
      connectionType: 'mysql',
      dbName: 'crm',
    });
    expect(snapshot.directory).not.toHaveProperty('bindingSource');
  });

  it('does not fill an explicitly unbound file from its directory default database', () => {
    const snapshot = buildExternalSQLFileSnapshot({
      filePath: 'D:/sql/reports/create-database.sql',
      readResult: {
        content: 'CREATE DATABASE reporting;',
        filePath: 'D:/sql/reports/create-database.sql',
        name: 'create-database.sql',
      },
      externalSQLDirectories: [{
        id: 'dir-1',
        name: '报表脚本',
        path: 'D:/sql/reports',
        connectionId: 'conn-1',
        dbName: 'crm',
        fileBindings: [{
          filePath: 'D:/sql/reports/create-database.sql',
          connectionId: 'conn-1',
          dbName: '',
        }],
        createdAt: 1,
      }],
      connections,
    });

    expect(snapshot.directory).toMatchObject({
      connectionId: 'conn-1',
      dbName: '',
      bindingSource: 'file',
    });
  });
});
