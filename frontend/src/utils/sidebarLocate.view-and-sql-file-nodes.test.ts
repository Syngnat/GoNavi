import { describe, expect, it } from 'vitest';
import { findSidebarNodePathForLocate, resolveSidebarLocateTarget } from './sidebarLocate';

describe('sidebarLocate', () => {
  it('finds a unique bare view node when metadata supplies schema separately', () => {
    const target = resolveSidebarLocateTarget({
      tabId: 'stale-view-tab-id',
      connectionId: 'conn-1',
      dbName: 'SYSDBA',
      tableName: 'V_ACCOUNT',
      schemaName: 'SYSDBA',
      objectGroup: 'views',
    }, { groupBySchema: false });

    const tree = [
      {
        key: 'conn-1',
        children: [
          {
            key: 'conn-1-SYSDBA',
            dataRef: { id: 'conn-1', dbName: 'SYSDBA' },
            children: [
              {
                key: 'conn-1-SYSDBA-views',
                children: [
                  {
                    key: 'conn-1-SYSDBA-view-V_ACCOUNT',
                    type: 'view',
                    dataRef: {
                      id: 'conn-1',
                      dbName: 'SYSDBA',
                      viewName: 'V_ACCOUNT',
                    },
                  },
                ],
              },
            ],
          },
        ],
      },
    ];

    expect(findSidebarNodePathForLocate(tree, target)).toEqual([
      'conn-1',
      'conn-1-SYSDBA',
      'conn-1-SYSDBA-views',
      'conn-1-SYSDBA-view-V_ACCOUNT',
    ]);
  });

  it('finds a bare mysql-compatible view node when the locate request keeps a different schema name', () => {
    const target = resolveSidebarLocateTarget({
      tabId: 'stale-view-tab-id',
      connectionId: 'conn-1',
      dbName: 'GDB_APP',
      tableName: 'V_ACCOUNT',
      schemaName: 'SYSDBA',
      objectGroup: 'views',
    }, { groupBySchema: false });

    const tree = [
      {
        key: 'conn-1',
        children: [
          {
            key: 'conn-1-GDB_APP',
            dataRef: { id: 'conn-1', dbName: 'GDB_APP' },
            children: [
              {
                key: 'conn-1-GDB_APP-views',
                children: [
                  {
                    key: 'conn-1-GDB_APP-view-V_ACCOUNT',
                    type: 'view',
                    dataRef: {
                      id: 'conn-1',
                      dbName: 'GDB_APP',
                      viewName: 'V_ACCOUNT',
                    },
                  },
                ],
              },
            ],
          },
        ],
      },
    ];

    expect(findSidebarNodePathForLocate(tree, target)).toEqual([
      'conn-1',
      'conn-1-GDB_APP',
      'conn-1-GDB_APP-views',
      'conn-1-GDB_APP-view-V_ACCOUNT',
    ]);
  });

  it('finds a mysql-compatible view node when objectType carries the view identity', () => {
    const target = resolveSidebarLocateTarget({
      tabId: 'stale-view-tab-id',
      connectionId: 'conn-1',
      dbName: 'GDB_APP',
      tableName: 'V_ACCOUNT',
      schemaName: 'SYSDBA',
      objectGroup: 'views',
    }, { groupBySchema: false });

    const tree = [
      {
        key: 'conn-1',
        children: [
          {
            key: 'conn-1-GDB_APP',
            dataRef: { id: 'conn-1', dbName: 'GDB_APP' },
            children: [
              {
                key: 'conn-1-GDB_APP-views',
                children: [
                  {
                    key: 'opaque-view-node',
                    type: 'database-object',
                    dataRef: {
                      id: 'conn-1',
                      dbName: 'GDB_APP',
                      tableName: 'V_ACCOUNT',
                      objectType: 'view',
                    },
                  },
                ],
              },
            ],
          },
        ],
      },
    ];

    expect(findSidebarNodePathForLocate(tree, target)).toEqual([
      'conn-1',
      'conn-1-GDB_APP',
      'conn-1-GDB_APP-views',
      'opaque-view-node',
    ]);
  });

  it('falls back to a table-like node when a view is only present in the tables branch', () => {
    const target = resolveSidebarLocateTarget({
      tabId: 'stale-view-tab-id',
      connectionId: 'conn-1',
      dbName: 'SYSDBA',
      tableName: 'V_ACCOUNT',
      objectGroup: 'views',
    }, { groupBySchema: false });

    const tree = [
      {
        key: 'conn-1',
        children: [
          {
            key: 'conn-1-SYSDBA',
            dataRef: { id: 'conn-1', dbName: 'SYSDBA' },
            children: [
              {
                key: 'conn-1-SYSDBA-tables',
                children: [
                  {
                    key: 'conn-1-SYSDBA-V_ACCOUNT',
                    type: 'table',
                    dataRef: {
                      id: 'conn-1',
                      dbName: 'SYSDBA',
                      tableName: 'V_ACCOUNT',
                    },
                  },
                ],
              },
            ],
          },
        ],
      },
    ];

    expect(findSidebarNodePathForLocate(tree, target)).toEqual([
      'conn-1',
      'conn-1-SYSDBA',
      'conn-1-SYSDBA-tables',
      'conn-1-SYSDBA-V_ACCOUNT',
    ]);
  });

  it('falls back to a visual table-like node when view metadata is not present on the node', () => {
    const target = resolveSidebarLocateTarget({
      tabId: 'stale-view-tab-id',
      connectionId: 'conn-1',
      dbName: 'SYSDBA',
      tableName: 'V_ACCOUNT',
      objectGroup: 'views',
    }, { groupBySchema: false });

    const tree = [
      {
        key: 'conn-1',
        children: [
          {
            key: 'conn-1-SYSDBA',
            dataRef: { id: 'conn-1', dbName: 'SYSDBA' },
            children: [
              {
                key: 'conn-1-SYSDBA-tables',
                children: [
                  {
                    key: 'conn-1-SYSDBA-V_ACCOUNT',
                    title: 'V_ACCOUNT',
                    type: 'table',
                    dataRef: {},
                  },
                ],
              },
            ],
          },
        ],
      },
    ];

    expect(findSidebarNodePathForLocate(tree, target)).toEqual([
      'conn-1',
      'conn-1-SYSDBA',
      'conn-1-SYSDBA-tables',
      'conn-1-SYSDBA-V_ACCOUNT',
    ]);
  });

  it('falls back to a visual table-like node with a table-prefixed key for a view request', () => {
    const target = resolveSidebarLocateTarget({
      tabId: 'stale-view-tab-id',
      connectionId: 'conn-1',
      dbName: 'SYSDBA',
      tableName: 'V_ACCOUNT',
      objectGroup: 'views',
    }, { groupBySchema: false });

    const tree = [
      {
        key: 'conn-1',
        children: [
          {
            key: 'conn-1-SYSDBA',
            dataRef: { id: 'conn-1', dbName: 'SYSDBA' },
            children: [
              {
                key: 'conn-1-SYSDBA-tables',
                children: [
                  {
                    key: 'conn-1-SYSDBA-table-V_ACCOUNT',
                    type: 'table',
                    dataRef: {},
                  },
                ],
              },
            ],
          },
        ],
      },
    ];

    expect(findSidebarNodePathForLocate(tree, target)).toEqual([
      'conn-1',
      'conn-1-SYSDBA',
      'conn-1-SYSDBA-tables',
      'conn-1-SYSDBA-table-V_ACCOUNT',
    ]);
  });

  it('decodes schema-aware table keys during visual locate fallback', () => {
    const schemaAwareIdentity = `reporting${String.fromCharCode(0)}orders`;
    const nodeKey = `conn-1-main-table-${encodeURIComponent(schemaAwareIdentity)}`;
    const target = resolveSidebarLocateTarget({
      tabId: 'stale-table-tab-id',
      connectionId: 'conn-1',
      dbName: 'main',
      tableName: 'reporting.orders',
      schemaName: 'reporting',
      objectGroup: 'tables',
    }, { groupBySchema: false });

    const tree = [
      {
        key: 'conn-1',
        children: [
          {
            key: 'conn-1-main',
            dataRef: { id: 'conn-1', dbName: 'main' },
            children: [
              {
                key: 'conn-1-main-tables',
                children: [
                  {
                    key: nodeKey,
                    type: 'table',
                    dataRef: {},
                  },
                ],
              },
            ],
          },
        ],
      },
    ];

    expect(findSidebarNodePathForLocate(tree, target)).toEqual([
      'conn-1',
      'conn-1-main',
      'conn-1-main-tables',
      nodeKey,
    ]);
  });

  it('finds a view node by title when the tree node is missing object metadata', () => {
    const target = resolveSidebarLocateTarget({
      tabId: 'stale-view-tab-id',
      connectionId: 'conn-1',
      dbName: 'SYSDBA',
      tableName: 'V_ACCOUNT',
      objectGroup: 'views',
    }, { groupBySchema: false });

    const tree = [
      {
        key: 'conn-1',
        children: [
          {
            key: 'conn-1-SYSDBA',
            dataRef: { id: 'conn-1', dbName: 'SYSDBA' },
            children: [
              {
                key: 'conn-1-SYSDBA-views',
                children: [
                  {
                    key: 'conn-1-SYSDBA-view-generated-key',
                    title: 'V_ACCOUNT',
                    type: 'view',
                    dataRef: {
                      id: 'conn-1',
                      dbName: 'SYSDBA',
                    },
                  },
                ],
              },
            ],
          },
        ],
      },
    ];

    expect(findSidebarNodePathForLocate(tree, target)).toEqual([
      'conn-1',
      'conn-1-SYSDBA',
      'conn-1-SYSDBA-views',
      'conn-1-SYSDBA-view-generated-key',
    ]);
  });

  it('finds a view node by title under the views group when node type metadata is missing', () => {
    const target = resolveSidebarLocateTarget({
      tabId: 'stale-view-tab-id',
      connectionId: 'conn-1',
      dbName: 'GDB_APP',
      tableName: 'V_ACCOUNT',
      schemaName: 'SYSDBA',
      objectGroup: 'views',
    }, { groupBySchema: false });

    const tree = [
      {
        key: 'conn-1',
        children: [
          {
            key: 'conn-1-GDB_APP',
            dataRef: { id: 'conn-1', dbName: 'GDB_APP' },
            children: [
              {
                key: 'conn-1-GDB_APP-views',
                children: [
                  {
                    key: 'conn-1-GDB_APP-view-generated-key',
                    title: 'V_ACCOUNT',
                    dataRef: {},
                  },
                ],
              },
            ],
          },
        ],
      },
    ];

    expect(findSidebarNodePathForLocate(tree, target)).toEqual([
      'conn-1',
      'conn-1-GDB_APP',
      'conn-1-GDB_APP-views',
      'conn-1-GDB_APP-view-generated-key',
    ]);
  });

  it('finds a schema-qualified view request by visual title when the node has no schema metadata', () => {
    const target = resolveSidebarLocateTarget({
      tabId: 'stale-view-tab-id',
      connectionId: 'conn-1',
      dbName: 'GDB_APP',
      tableName: 'SYSDBA.V_ACCOUNT',
      schemaName: 'SYSDBA',
      objectGroup: 'views',
    }, { groupBySchema: false });

    const tree = [
      {
        key: 'conn-1',
        children: [
          {
            key: 'conn-1-GDB_APP',
            dataRef: { id: 'conn-1', dbName: 'GDB_APP' },
            children: [
              {
                key: 'conn-1-GDB_APP-views',
                children: [
                  {
                    key: 'conn-1-GDB_APP-view-generated-key',
                    title: 'V_ACCOUNT',
                    type: 'view',
                    dataRef: {
                      id: 'conn-1',
                      dbName: 'GDB_APP',
                    },
                  },
                ],
              },
            ],
          },
        ],
      },
    ];

    expect(findSidebarNodePathForLocate(tree, target)).toEqual([
      'conn-1',
      'conn-1-GDB_APP',
      'conn-1-GDB_APP-views',
      'conn-1-GDB_APP-view-generated-key',
    ]);
  });

  it('falls back from a schema-qualified view request to a bare table-like node in the same database', () => {
    const target = resolveSidebarLocateTarget({
      tabId: 'stale-view-tab-id',
      connectionId: 'conn-1',
      dbName: 'SYSDBA',
      tableName: 'SYSDBA.V_ACCOUNT',
      schemaName: 'SYSDBA',
      objectGroup: 'views',
    }, { groupBySchema: false });

    const tree = [
      {
        key: 'conn-1',
        children: [
          {
            key: 'conn-1-SYSDBA',
            dataRef: { id: 'conn-1', dbName: 'SYSDBA' },
            children: [
              {
                key: 'conn-1-SYSDBA-tables',
                children: [
                  {
                    key: 'conn-1-SYSDBA-V_ACCOUNT',
                    type: 'table',
                    dataRef: {
                      id: 'conn-1',
                      dbName: 'SYSDBA',
                      tableName: 'V_ACCOUNT',
                    },
                  },
                ],
              },
            ],
          },
        ],
      },
    ];

    expect(findSidebarNodePathForLocate(tree, target)).toEqual([
      'conn-1',
      'conn-1-SYSDBA',
      'conn-1-SYSDBA-tables',
      'conn-1-SYSDBA-V_ACCOUNT',
    ]);
  });

  it('falls back to a unique schema-qualified table-like node for an unqualified view request', () => {
    const target = resolveSidebarLocateTarget({
      tabId: 'stale-view-tab-id',
      connectionId: 'conn-1',
      dbName: 'SYSDBA',
      tableName: 'V_ACCOUNT',
      objectGroup: 'views',
    }, { groupBySchema: true });

    const tree = [
      {
        key: 'conn-1',
        children: [
          {
            key: 'conn-1-SYSDBA',
            dataRef: { id: 'conn-1', dbName: 'SYSDBA' },
            children: [
              {
                key: 'conn-1-SYSDBA-schema-SYSDBA',
                children: [
                  {
                    key: 'conn-1-SYSDBA-schema-SYSDBA-tables',
                    children: [
                      {
                        key: 'conn-1-SYSDBA-SYSDBA.V_ACCOUNT',
                        type: 'table',
                        dataRef: {
                          id: 'conn-1',
                          dbName: 'SYSDBA',
                          tableName: 'SYSDBA.V_ACCOUNT',
                          schemaName: 'SYSDBA',
                        },
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    ];

    expect(findSidebarNodePathForLocate(tree, target)).toEqual([
      'conn-1',
      'conn-1-SYSDBA',
      'conn-1-SYSDBA-schema-SYSDBA',
      'conn-1-SYSDBA-schema-SYSDBA-tables',
      'conn-1-SYSDBA-SYSDBA.V_ACCOUNT',
    ]);
  });

  it('prefers the current database schema when an unqualified view request matches multiple schemas', () => {
    const target = resolveSidebarLocateTarget({
      tabId: 'conn-1-SYSDBA-view-V_ACCOUNT',
      connectionId: 'conn-1',
      dbName: 'SYSDBA',
      tableName: 'V_ACCOUNT',
      objectGroup: 'views',
    }, { groupBySchema: true });

    const tree = [
      {
        key: 'conn-1',
        children: [
          {
            key: 'conn-1-SYSDBA',
            dataRef: { id: 'conn-1', dbName: 'SYSDBA' },
            children: [
              {
                key: 'conn-1-SYSDBA-schema-SYSDBA',
                children: [
                  {
                    key: 'conn-1-SYSDBA-schema-SYSDBA-views',
                    children: [
                      {
                        key: 'conn-1-SYSDBA-view-SYSDBA.V_ACCOUNT',
                        type: 'view',
                        dataRef: { id: 'conn-1', dbName: 'SYSDBA', viewName: 'SYSDBA.V_ACCOUNT', schemaName: 'SYSDBA' },
                      },
                    ],
                  },
                ],
              },
              {
                key: 'conn-1-SYSDBA-schema-REPORT',
                children: [
                  {
                    key: 'conn-1-SYSDBA-schema-REPORT-views',
                    children: [
                      {
                        key: 'conn-1-SYSDBA-view-REPORT.V_ACCOUNT',
                        type: 'view',
                        dataRef: { id: 'conn-1', dbName: 'SYSDBA', viewName: 'REPORT.V_ACCOUNT', schemaName: 'REPORT' },
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    ];

    expect(findSidebarNodePathForLocate(tree, target)).toEqual([
      'conn-1',
      'conn-1-SYSDBA',
      'conn-1-SYSDBA-schema-SYSDBA',
      'conn-1-SYSDBA-schema-SYSDBA-views',
      'conn-1-SYSDBA-view-SYSDBA.V_ACCOUNT',
    ]);
  });

  it('prefers the current database schema when bare view nodes keep schema metadata separately', () => {
    const target = resolveSidebarLocateTarget({
      tabId: 'conn-1-SYSDBA-view-V_ACCOUNT',
      connectionId: 'conn-1',
      dbName: 'SYSDBA',
      tableName: 'V_ACCOUNT',
      objectGroup: 'views',
    }, { groupBySchema: true });

    const tree = [
      {
        key: 'conn-1',
        children: [
          {
            key: 'conn-1-SYSDBA',
            dataRef: { id: 'conn-1', dbName: 'SYSDBA' },
            children: [
              {
                key: 'conn-1-SYSDBA-schema-REPORT',
                children: [
                  {
                    key: 'conn-1-SYSDBA-schema-REPORT-views',
                    children: [
                      {
                        key: 'conn-1-SYSDBA-view-REPORT.V_ACCOUNT',
                        title: 'V_ACCOUNT',
                        type: 'view',
                        dataRef: { id: 'conn-1', dbName: 'SYSDBA', viewName: 'V_ACCOUNT', schemaName: 'REPORT' },
                      },
                    ],
                  },
                ],
              },
              {
                key: 'conn-1-SYSDBA-schema-SYSDBA',
                children: [
                  {
                    key: 'conn-1-SYSDBA-schema-SYSDBA-views',
                    children: [
                      {
                        key: 'conn-1-SYSDBA-view-SYSDBA.V_ACCOUNT',
                        title: 'V_ACCOUNT',
                        type: 'view',
                        dataRef: { id: 'conn-1', dbName: 'SYSDBA', viewName: 'V_ACCOUNT', schemaName: 'SYSDBA' },
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    ];

    expect(findSidebarNodePathForLocate(tree, target)).toEqual([
      'conn-1',
      'conn-1-SYSDBA',
      'conn-1-SYSDBA-schema-SYSDBA',
      'conn-1-SYSDBA-schema-SYSDBA-views',
      'conn-1-SYSDBA-view-SYSDBA.V_ACCOUNT',
    ]);
  });

  it('does not guess a schema-qualified view when no current-schema preference resolves ambiguity', () => {
    const target = resolveSidebarLocateTarget({
      tabId: 'conn-1-SYSDBA-view-V_ACCOUNT',
      connectionId: 'conn-1',
      dbName: 'SYSDBA',
      tableName: 'V_ACCOUNT',
      objectGroup: 'views',
    }, { groupBySchema: true });

    const tree = [
      {
        key: 'conn-1',
        children: [
          {
            key: 'conn-1-SYSDBA',
            dataRef: { id: 'conn-1', dbName: 'SYSDBA' },
            children: [
              {
                key: 'conn-1-SYSDBA-schema-APP',
                children: [
                  {
                    key: 'conn-1-SYSDBA-schema-APP-views',
                    children: [
                      {
                        key: 'conn-1-SYSDBA-view-APP.V_ACCOUNT',
                        type: 'view',
                        dataRef: { id: 'conn-1', dbName: 'SYSDBA', viewName: 'APP.V_ACCOUNT', schemaName: 'APP' },
                      },
                    ],
                  },
                ],
              },
              {
                key: 'conn-1-SYSDBA-schema-REPORT',
                children: [
                  {
                    key: 'conn-1-SYSDBA-schema-REPORT-views',
                    children: [
                      {
                        key: 'conn-1-SYSDBA-view-REPORT.V_ACCOUNT',
                        type: 'view',
                        dataRef: { id: 'conn-1', dbName: 'SYSDBA', viewName: 'REPORT.V_ACCOUNT', schemaName: 'REPORT' },
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    ];

    expect(findSidebarNodePathForLocate(tree, target)).toBeNull();
  });

  it('finds external SQL file paths from loaded tree data', () => {
    const target = resolveSidebarLocateTarget({
      filePath: 'C:\\Users\\me\\sql\\report.sql',
      objectGroup: 'externalSqlFiles',
    }, { groupBySchema: false });

    const tree = [
      {
        key: 'external-sql-root',
        type: 'external-sql-root',
        children: [
          {
            key: 'external-sql-directory:C:/Users/me/sql',
            type: 'external-sql-directory',
            dataRef: { path: 'C:/Users/me/sql' },
            children: [
              {
                key: 'external-sql-file:C:/Users/me/sql/report.sql',
                type: 'external-sql-file',
                dataRef: { path: 'C:/Users/me/sql/report.sql' },
              },
            ],
          },
        ],
      },
    ];

    expect(findSidebarNodePathForLocate(tree, target)).toEqual([
      'external-sql-root',
      'external-sql-directory:C:/Users/me/sql',
      'external-sql-file:C:/Users/me/sql/report.sql',
    ]);
  });
});
