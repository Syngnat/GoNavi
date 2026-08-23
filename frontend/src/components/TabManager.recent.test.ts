import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import {
  buildPinnedTableShortcuts,
  buildRecentConnectionShortcuts,
  buildRecentSQLFileShortcuts,
  dispatchRecentConnectionShortcut,
  RecentConnectionShortcutItem,
} from './TabManager';
import type { ExternalSQLDirectory, SavedConnection } from '../types';

const connection = (id: string, type: string): SavedConnection => ({
  id,
  name: id,
  config: {
    id,
    type,
    host: 'localhost',
    port: type === 'redis' ? 6379 : 3306,
    user: 'tester',
  },
});

describe('recent workbench shortcuts', () => {
  it('renders recent connections with the same database identity as the sidebar tree', () => {
    const mysqlConnection = connection('mysql-1', 'mysql');
    const customizedConnection: SavedConnection = {
      ...connection('customized-1', 'mysql'),
      iconType: 'postgres',
      iconColor: '#2f855a',
    };
    const [mysqlShortcut, customizedShortcut] = buildRecentConnectionShortcuts([
      mysqlConnection,
      customizedConnection,
    ], [
      { connectionId: 'mysql-1', dbName: 'orders', openedAt: 2 },
      { connectionId: 'customized-1', dbName: 'reporting', openedAt: 1 },
    ]);

    const mysqlMarkup = renderToStaticMarkup(React.createElement(RecentConnectionShortcutItem, {
      shortcut: mysqlShortcut,
      onOpen: () => undefined,
    }));
    const customizedMarkup = renderToStaticMarkup(React.createElement(RecentConnectionShortcutItem, {
      shortcut: customizedShortcut,
      onOpen: () => undefined,
    }));

    expect(mysqlMarkup).toContain('data-db-icon-frame="true"');
    expect(mysqlMarkup).toContain('/db-icons/mysql.svg');
    expect(customizedMarkup).toContain('/db-icons/postgres.svg');
    expect(customizedMarkup).toContain('#2f855a');
    expect(mysqlMarkup).not.toContain('anticon-database');
    expect(customizedMarkup).not.toContain('anticon-database');
  });

  it('keeps recent connections even when they do not support the SQL query editor', () => {
    const shortcuts = buildRecentConnectionShortcuts([
      connection('redis-1', 'redis'),
      connection('mysql-1', 'mysql'),
    ], [
      { connectionId: 'redis-1', dbName: '0', openedAt: 2 },
      { connectionId: 'mysql-1', dbName: 'orders', openedAt: 1 },
    ]);

    expect(shortcuts).toEqual([
      expect.objectContaining({
        connection: expect.objectContaining({ id: 'redis-1' }),
        dbName: '0',
      }),
      expect.objectContaining({
        connection: expect.objectContaining({ id: 'mysql-1' }),
        dbName: 'orders',
      }),
    ]);
  });

  it('dispatches a sidebar navigation request instead of creating a query tab', () => {
    const eventTarget = { dispatchEvent: vi.fn() };
    const mysqlConnection = connection('mysql-1', 'mysql');

    expect(dispatchRecentConnectionShortcut({
      connection: mysqlConnection,
      dbName: 'orders',
    }, eventTarget)).toBe(true);

    const event = eventTarget.dispatchEvent.mock.calls[0]?.[0] as CustomEvent;
    expect(event.type).toBe('gonavi:locate-sidebar-connection');
    expect(event.detail).toEqual({ connectionId: 'mysql-1', dbName: 'orders' });
  });

  it('only exposes valid pinned tables whose connection still exists', () => {
    const shortcuts = buildPinnedTableShortcuts([
      connection('mysql-1', 'mysql'),
    ], [
      JSON.stringify(['mysql-1', 'orders', 'public', 'line_items']),
      JSON.stringify(['missing-1', 'orders', '', 'orphaned_table']),
      '{bad json',
      JSON.stringify(['mysql-1', '', '', 'missing_database']),
      JSON.stringify(['mysql-1', 'orders', 'public', 'line_items']),
    ]);

    expect(shortcuts).toEqual([
      expect.objectContaining({
        connection: expect.objectContaining({ id: 'mysql-1' }),
        dbName: 'orders',
        schemaName: 'public',
        tableName: 'line_items',
      }),
    ]);
  });

  it('uses the latest persisted file binding for recent SQL file shortcuts', () => {
    const connections = [
      connection('mysql-1', 'mysql'),
      connection('mysql-2', 'mysql'),
    ];
    const directories: ExternalSQLDirectory[] = [{
      id: 'dir-1',
      name: 'scripts',
      path: 'D:/sql/scripts',
      connectionId: 'mysql-1',
      dbName: 'legacy',
      fileBindings: [{
        filePath: 'D:/sql/scripts/report.sql',
        connectionId: 'mysql-2',
        dbName: 'reporting',
      }],
      createdAt: 1,
    }];

    expect(buildRecentSQLFileShortcuts(connections, directories, [{
      filePath: 'D:/sql/scripts/report.sql',
      fileName: 'report.sql',
      connectionId: 'mysql-1',
      dbName: 'legacy',
      openedAt: 1,
    }])).toEqual([
      expect.objectContaining({
        connectionId: 'mysql-2',
        dbName: 'reporting',
      }),
    ]);
  });

  it('shows a bound SQL file only once after its execution database changes', () => {
    const connections = [
      connection('mysql-1', 'mysql'),
      connection('mysql-2', 'mysql'),
    ];
    const directories: ExternalSQLDirectory[] = [{
      id: 'dir-1',
      name: 'scripts',
      path: 'D:/sql/scripts',
      connectionId: 'mysql-1',
      dbName: 'crawler',
      fileBindings: [{
        filePath: 'D:/sql/scripts/hancheng.sql',
        connectionId: 'mysql-2',
        dbName: '12315_dev',
      }],
      createdAt: 1,
    }];

    expect(buildRecentSQLFileShortcuts(connections, directories, [
      {
        filePath: 'D:/sql/scripts/hancheng.sql',
        fileName: 'hancheng.sql',
        connectionId: 'mysql-2',
        dbName: '12315_dev',
        openedAt: 2,
      },
      {
        filePath: 'D:\\sql\\scripts\\hancheng.sql',
        fileName: 'hancheng.sql',
        connectionId: 'mysql-1',
        dbName: 'crawler',
        openedAt: 1,
      },
    ])).toEqual([
      expect.objectContaining({
        filePath: 'D:/sql/scripts/hancheng.sql',
        connectionId: 'mysql-2',
        dbName: '12315_dev',
      }),
    ]);
  });

  it('preserves the recent context when the same directory path has multiple database bindings', () => {
    const connections = [
      connection('mysql-1', 'mysql'),
      connection('mysql-2', 'mysql'),
    ];
    const directories: ExternalSQLDirectory[] = [
      {
        id: 'dir-1',
        name: 'scripts',
        path: 'D:/sql/shared',
        connectionId: 'mysql-1',
        dbName: 'orders',
        createdAt: 1,
      },
      {
        id: 'dir-2',
        name: 'scripts',
        path: 'D:/sql/shared',
        connectionId: 'mysql-2',
        dbName: 'reporting',
        createdAt: 2,
      },
    ];

    expect(buildRecentSQLFileShortcuts(connections, directories, [{
      filePath: 'D:/sql/shared/report.sql',
      fileName: 'report.sql',
      connectionId: 'mysql-2',
      dbName: 'reporting',
      openedAt: 1,
    }])).toEqual([
      expect.objectContaining({
        connectionId: 'mysql-2',
        dbName: 'reporting',
      }),
    ]);
  });

  it('restores the original recent-file context after a file-specific binding is cleared', () => {
    const connections = [
      connection('mysql-1', 'mysql'),
      connection('mysql-2', 'mysql'),
    ];
    const directories: ExternalSQLDirectory[] = [{
      id: 'dir-1',
      name: 'scripts',
      path: 'D:/sql/shared',
      connectionId: 'mysql-1',
      dbName: 'orders',
      createdAt: 1,
    }];

    expect(buildRecentSQLFileShortcuts(connections, directories, [{
      filePath: 'D:/sql/shared/report.sql',
      fileName: 'report.sql',
      connectionId: 'mysql-2',
      dbName: 'reporting',
      openedAt: 1,
    }])).toEqual([
      expect.objectContaining({
        connectionId: 'mysql-2',
        dbName: 'reporting',
      }),
    ]);
  });
});
