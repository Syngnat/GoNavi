import { describe, expect, it, vi } from 'vitest';
import {
  dispatchSidebarLocateConnection,
  findSidebarNodePathByKey,
  findSidebarNodePathForLocate,
  normalizeSidebarLocateConnectionRequest,
  normalizeSidebarLocateObjectRequest,
  normalizeSidebarLocateObjectRequestFromTab,
  resolveSidebarLocateTarget,
} from './sidebarLocate';

describe('sidebarLocate', () => {
  it('normalizes and dispatches a connection navigation request', () => {
    expect(normalizeSidebarLocateConnectionRequest({
      connectionId: '  conn-1 ',
      dbName: ' orders ',
    })).toEqual({ connectionId: 'conn-1', dbName: 'orders' });
    expect(normalizeSidebarLocateConnectionRequest({ connectionId: ' ' })).toBeNull();

    const eventTarget = { dispatchEvent: vi.fn() };
    expect(dispatchSidebarLocateConnection({
      connectionId: 'conn-1',
      dbName: 'orders',
    }, eventTarget)).toBe(true);
    const event = eventTarget.dispatchEvent.mock.calls[0]?.[0] as CustomEvent;
    expect(event.type).toBe('gonavi:locate-sidebar-connection');
    expect(event.detail).toEqual({ connectionId: 'conn-1', dbName: 'orders' });
  });

  it('normalizes a table locate request and builds the direct tree path', () => {
    const request = normalizeSidebarLocateObjectRequest({
      tabId: 'conn-1-main-users',
      connectionId: 'conn-1',
      dbName: 'main',
      tableName: 'users',
    });

    expect(request).toMatchObject({
      tabId: 'conn-1-main-users',
      connectionId: 'conn-1',
      dbName: 'main',
      tableName: 'users',
      schemaName: '',
      objectGroup: 'tables',
    });

    expect(resolveSidebarLocateTarget(request!, { groupBySchema: false })).toMatchObject({
      targetKey: 'conn-1-main-users',
      expectedAncestorKeys: ['conn-1', 'conn-1-main', 'conn-1-main-tables'],
    });
  });

  it('keeps view tabs on the views branch and includes schema ancestors', () => {
    const request = normalizeSidebarLocateObjectRequest({
      tabId: 'conn-1-main-view-public.orders_view',
      connectionId: 'conn-1',
      dbName: 'main',
      tableName: 'public.orders_view',
    });

    expect(request).toMatchObject({
      objectGroup: 'views',
      schemaName: 'public',
    });

    expect(resolveSidebarLocateTarget(request!, { groupBySchema: true })).toMatchObject({
      targetKey: 'conn-1-main-view-public.orders_view',
      schemaKey: 'conn-1-main-schema-6%3Apublic',
      objectGroupKey: 'conn-1-main-schema-6%3Apublic-views',
      expectedAncestorKeys: [
        'conn-1',
        'conn-1-main',
        'conn-1-main-schema-6%3Apublic',
        'conn-1-main-schema-6%3Apublic-views',
      ],
    });
  });

  it('keeps an empty schema key distinct from a schema literally named default', () => {
    const emptySchemaTarget = resolveSidebarLocateTarget({
      connectionId: 'conn-1',
      dbName: 'main',
      tableName: 'orders',
      schemaName: '',
      objectGroup: 'tables',
    }, { groupBySchema: true });
    const namedDefaultSchemaTarget = resolveSidebarLocateTarget({
      connectionId: 'conn-1',
      dbName: 'main',
      tableName: 'default.orders',
      schemaName: 'default',
      objectGroup: 'tables',
    }, { groupBySchema: true });

    expect(emptySchemaTarget.schemaKey).toBe('conn-1-main-schema-0%3A');
    expect(namedDefaultSchemaTarget.schemaKey).toBe('conn-1-main-schema-7%3Adefault');
    expect(emptySchemaTarget.schemaKey).not.toBe(namedDefaultSchemaTarget.schemaKey);
  });

  it('builds a locate request from the active table tab', () => {
    expect(normalizeSidebarLocateObjectRequestFromTab({
      id: 'conn-1-main-public.users',
      type: 'table',
      connectionId: 'conn-1',
      dbName: 'main',
      tableName: 'public.users',
    })).toMatchObject({
      tabId: 'conn-1-main-public.users',
      connectionId: 'conn-1',
      dbName: 'main',
      tableName: 'public.users',
      schemaName: 'public',
      objectGroup: 'tables',
    });
  });

  it('builds a view locate request from view tabs and rejects non-object tabs', () => {
    expect(normalizeSidebarLocateObjectRequestFromTab({
      id: 'view-def-conn-1-main-public.orders_view',
      type: 'view-def',
      connectionId: 'conn-1',
      dbName: 'main',
      viewName: 'public.orders_view',
    })).toMatchObject({
      tableName: 'public.orders_view',
      schemaName: 'public',
      objectGroup: 'views',
    });

    expect(normalizeSidebarLocateObjectRequestFromTab({
      id: 'query-1',
      type: 'query',
      connectionId: 'conn-1',
      dbName: 'main',
    })).toBeNull();
  });

  it('builds locate requests from object-edit SQL editor tabs', () => {
    expect(normalizeSidebarLocateObjectRequestFromTab({
      id: 'query-edit-routine-123',
      type: 'query',
      queryMode: 'object-edit',
      connectionId: 'conn-1',
      dbName: 'example',
      routineName: 'main.func_name',
      schemaName: 'main',
      sidebarLocateKey: 'conn-1-example-routine-func-main.func_name',
    })).toMatchObject({
      tabId: 'conn-1-example-routine-func-main.func_name',
      tableName: 'main.func_name',
      schemaName: 'main',
      objectGroup: 'routines',
    });

    expect(normalizeSidebarLocateObjectRequestFromTab({
      id: 'query-edit-view-123',
      type: 'query',
      queryMode: 'object-edit',
      connectionId: 'conn-1',
      dbName: 'main',
      viewName: 'public.orders_view',
    })).toMatchObject({
      tableName: 'public.orders_view',
      schemaName: 'public',
      objectGroup: 'views',
    });

    expect(normalizeSidebarLocateObjectRequestFromTab({
      id: 'query-edit-trigger-123',
      type: 'query',
      queryMode: 'object-edit',
      connectionId: 'conn-1',
      dbName: 'main',
      triggerName: 'audit.users_bi',
    })).toMatchObject({
      objectGroup: 'triggers',
      tableName: 'audit.users_bi',
    });

    expect(normalizeSidebarLocateObjectRequestFromTab({
      id: 'query-edit-event-123',
      type: 'query',
      queryMode: 'object-edit',
      connectionId: 'conn-1',
      dbName: 'main',
      eventName: 'nightly_cleanup',
      schemaName: 'main',
    })).toMatchObject({
      objectGroup: 'events',
      tableName: 'nightly_cleanup',
      schemaName: 'main',
    });

    expect(normalizeSidebarLocateObjectRequestFromTab({
      id: 'event-def-conn-1-main-nightly_cleanup',
      type: 'event-def',
      connectionId: 'conn-1',
      dbName: 'main',
      eventName: 'nightly_cleanup',
    })).toMatchObject({
      objectGroup: 'events',
      tableName: 'nightly_cleanup',
    });

    expect(normalizeSidebarLocateObjectRequestFromTab({
      id: 'database-link-def-conn-ora-H2-H2-ORCL.WORLD',
      type: 'database-link-def',
      connectionId: 'conn-ora',
      dbName: 'H2',
      schemaName: 'H2',
      databaseLinkName: 'ORCL.WORLD',
      sidebarLocateKey: 'conn-ora-H2-schema-x-databaseLinks-database-link-ORCL.WORLD',
    })).toMatchObject({
      objectGroup: 'databaseLinks',
      tableName: 'ORCL.WORLD',
      schemaName: 'H2',
      tabId: 'conn-ora-H2-schema-x-databaseLinks-database-link-ORCL.WORLD',
    });

    expect(normalizeSidebarLocateObjectRequestFromTab({
      id: 'query-1',
      type: 'query',
      queryMode: 'object-edit',
      connectionId: 'conn-1',
      dbName: 'main',
    })).toBeNull();
  });

  it('builds saved-query locate requests from plain query tabs', () => {
    expect(normalizeSidebarLocateObjectRequestFromTab({
      id: 'query-saved-1',
      title: '123456',
      type: 'query',
      connectionId: 'conn-1',
      dbName: 'missav_bot',
      savedQueryId: 'sq-123',
    })).toMatchObject({
      connectionId: 'conn-1',
      dbName: 'missav_bot',
      savedQueryId: 'sq-123',
      savedQueryName: '123456',
      objectGroup: 'savedQueries',
    });

    expect(normalizeSidebarLocateObjectRequestFromTab({
      id: 'query-2',
      type: 'query',
      connectionId: 'conn-1',
      dbName: 'main',
    })).toBeNull();
  });

  it('prefers object-edit identity over the saved query binding', () => {
    expect(normalizeSidebarLocateObjectRequestFromTab({
      id: 'query-edit-routine-123',
      type: 'query',
      queryMode: 'object-edit',
      connectionId: 'conn-1',
      dbName: 'example',
      routineName: 'main.func_name',
      savedQueryId: 'sq-123',
    })).toMatchObject({
      objectGroup: 'routines',
      tableName: 'main.func_name',
    });
  });

  it('locates a saved query node under the all-saved-queries root', () => {
    const request = normalizeSidebarLocateObjectRequestFromTab({
      id: 'query-saved-1',
      title: '123456',
      type: 'query',
      connectionId: 'conn-1',
      dbName: 'missav_bot',
      savedQueryId: 'sq-123',
    });
    expect(request).not.toBeNull();

    const target = resolveSidebarLocateTarget(request!, { groupBySchema: false });
    expect(target).toMatchObject({
      targetKey: 'all-saved-query-sq-123',
      objectGroupKey: 'all-saved-queries',
      expectedAncestorKeys: ['all-saved-queries'],
    });

    const tree = [
      {
        key: 'all-saved-queries',
        type: 'all-saved-queries',
        children: [
          {
            key: 'all-saved-queries-connection-conn-1',
            type: 'saved-query-group',
            children: [
              {
                key: 'all-saved-queries-connection-conn-1-db-missav_bot',
                type: 'saved-query-group',
                children: [
                  {
                    key: 'all-saved-query-sq-123',
                    type: 'saved-query',
                    dataRef: { id: 'sq-123', name: '123456', connectionId: 'conn-1', dbName: 'missav_bot' },
                  },
                  {
                    key: 'all-saved-query-sq-456',
                    type: 'saved-query',
                    dataRef: { id: 'sq-456', name: '其他查询', connectionId: 'conn-1', dbName: 'missav_bot' },
                  },
                ],
              },
            ],
          },
        ],
      },
    ];

    expect(findSidebarNodePathForLocate(tree, target)).toEqual([
      'all-saved-queries',
      'all-saved-queries-connection-conn-1',
      'all-saved-queries-connection-conn-1-db-missav_bot',
      'all-saved-query-sq-123',
    ]);
  });

  it('keeps table-style view tabs on the views branch', () => {
    expect(normalizeSidebarLocateObjectRequestFromTab({
      id: 'legacy-view-tab-id',
      type: 'table',
      connectionId: 'conn-1',
      dbName: 'GDB_APP',
      tableName: 'V_ACCOUNT',
      objectType: 'view',
    })).toMatchObject({
      tabId: 'legacy-view-tab-id',
      tableName: 'V_ACCOUNT',
      objectGroup: 'views',
    });
  });

  it('builds locate requests from trigger and routine tabs', () => {
    expect(normalizeSidebarLocateObjectRequestFromTab({
      id: 'trigger-conn-1-main-audit.users_bi',
      type: 'trigger',
      connectionId: 'conn-1',
      dbName: 'main',
      triggerName: 'audit.users_bi',
    })).toMatchObject({
      tableName: 'audit.users_bi',
      schemaName: 'audit',
      objectGroup: 'triggers',
    });

    expect(normalizeSidebarLocateObjectRequestFromTab({
      id: 'routine-def-conn-1-main-reporting.refresh_stats',
      type: 'routine-def',
      connectionId: 'conn-1',
      dbName: 'main',
      routineName: 'reporting.refresh_stats',
    })).toMatchObject({
      tableName: 'reporting.refresh_stats',
      schemaName: 'reporting',
      objectGroup: 'routines',
    });
  });

  it('builds and resolves locate requests from external SQL file query tabs', () => {
    const request = normalizeSidebarLocateObjectRequestFromTab({
      id: 'external-sql-tab:conn-1:main:/Users/me/sql/report.sql',
      type: 'query',
      connectionId: 'conn-1',
      dbName: 'main',
      filePath: '/Users/me/sql/report.sql',
    });

    expect(request).toMatchObject({
      connectionId: 'conn-1',
      dbName: 'main',
      filePath: '/Users/me/sql/report.sql',
      objectGroup: 'externalSqlFiles',
    });

    expect(resolveSidebarLocateTarget(request!, { groupBySchema: false })).toMatchObject({
      objectGroupKey: 'external-sql-root',
      expectedAncestorKeys: ['external-sql-root'],
      filePath: '/Users/me/sql/report.sql',
    });
  });

  it('keeps StarRocks materialized view tabs on the materialized views branch', () => {
    const request = normalizeSidebarLocateObjectRequestFromTab({
      id: 'view-def-conn-1-main-sales.mv_daily',
      type: 'view-def',
      connectionId: 'conn-1',
      dbName: 'main',
      viewName: 'sales.mv_daily',
      viewKind: 'materialized',
    });

    expect(request).toMatchObject({
      tableName: 'sales.mv_daily',
      schemaName: 'sales',
      objectGroup: 'materializedViews',
    });

    expect(resolveSidebarLocateTarget(request!, { groupBySchema: true })).toMatchObject({
      targetKey: 'view-def-conn-1-main-sales.mv_daily',
      objectGroupKey: 'conn-1-main-schema-5%3Asales-materializedViews',
    });
  });

  it('finds a locate path from loaded tree data even when the target key is absent', () => {
    const target = resolveSidebarLocateTarget(
      {
        tabId: 'stale-tab-id',
        connectionId: 'conn-1',
        dbName: 'main',
        tableName: 'public.users',
        schemaName: 'public',
        objectGroup: 'tables',
      },
      { groupBySchema: true },
    );

    const tree = [
      {
        key: 'conn-1',
        children: [
          {
            key: 'conn-1-main',
            dataRef: { id: 'conn-1', dbName: 'main' },
            children: [
              {
                key: 'conn-1-main-schema-public',
                dataRef: { id: 'conn-1', dbName: 'main', schemaName: 'public' },
                children: [
                  {
                    key: 'conn-1-main-schema-public-tables',
                    dataRef: { id: 'conn-1', dbName: 'main', groupKey: 'tables', schemaName: 'public' },
                    children: [
                      {
                        key: 'conn-1-main-public.users',
                        type: 'table',
                        dataRef: {
                          id: 'conn-1',
                          dbName: 'main',
                          tableName: 'public.users',
                          schemaName: 'public',
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

    expect(findSidebarNodePathByKey(tree, 'conn-1-main-public.users')).toEqual([
      'conn-1',
      'conn-1-main',
      'conn-1-main-schema-public',
      'conn-1-main-schema-public-tables',
      'conn-1-main-public.users',
    ]);
    expect(findSidebarNodePathForLocate(tree, target)).toEqual([
      'conn-1',
      'conn-1-main',
      'conn-1-main-schema-public',
      'conn-1-main-schema-public-tables',
      'conn-1-main-public.users',
    ]);
  });

  it('finds trigger and routine paths from loaded tree data', () => {
    const triggerTarget = resolveSidebarLocateTarget({
      connectionId: 'conn-1',
      dbName: 'main',
      tableName: 'audit.users_bi',
      schemaName: 'audit',
      objectGroup: 'triggers',
    }, { groupBySchema: true });

    const routineTarget = resolveSidebarLocateTarget({
      connectionId: 'conn-1',
      dbName: 'main',
      tableName: 'reporting.refresh_stats',
      schemaName: 'reporting',
      objectGroup: 'routines',
    }, { groupBySchema: true });

    const tree = [
      {
        key: 'conn-1',
        children: [
          {
            key: 'conn-1-main',
            dataRef: { id: 'conn-1', dbName: 'main' },
            children: [
              {
                key: 'conn-1-main-schema-audit',
                children: [
                  {
                    key: 'conn-1-main-schema-audit-triggers',
                    children: [
                      {
                        key: 'conn-1-main-trigger-audit.users_bi-audit.users',
                        type: 'db-trigger',
                        dataRef: { id: 'conn-1', dbName: 'main', triggerName: 'audit.users_bi', schemaName: 'audit' },
                      },
                    ],
                  },
                ],
              },
              {
                key: 'conn-1-main-schema-reporting',
                children: [
                  {
                    key: 'conn-1-main-schema-reporting-routines',
                    children: [
                      {
                        key: 'conn-1-main-routine-reporting.refresh_stats',
                        type: 'routine',
                        dataRef: { id: 'conn-1', dbName: 'main', routineName: 'reporting.refresh_stats', schemaName: 'reporting' },
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

    expect(findSidebarNodePathForLocate(tree, triggerTarget)).toEqual([
      'conn-1',
      'conn-1-main',
      'conn-1-main-schema-audit',
      'conn-1-main-schema-audit-triggers',
      'conn-1-main-trigger-audit.users_bi-audit.users',
    ]);
    expect(findSidebarNodePathForLocate(tree, routineTarget)).toEqual([
      'conn-1',
      'conn-1-main',
      'conn-1-main-schema-reporting',
      'conn-1-main-schema-reporting-routines',
      'conn-1-main-routine-reporting.refresh_stats',
    ]);
  });

  it('locates a DuckDB macro from an object-edit SQL editor tab', () => {
    const request = normalizeSidebarLocateObjectRequestFromTab({
      id: 'query-edit-routine-123',
      type: 'query',
      queryMode: 'object-edit',
      connectionId: 'conn-1',
      dbName: 'example',
      routineName: 'main.func_name',
      schemaName: 'main',
      sidebarLocateKey: 'conn-1-example-routine-func-main.func_name',
    });
    expect(request).not.toBeNull();

    const target = resolveSidebarLocateTarget(request!, { groupBySchema: false });
    const tree = [
      {
        key: 'conn-1',
        children: [
          {
            key: 'conn-1-example',
            dataRef: { id: 'conn-1', dbName: 'example' },
            children: [
              {
                key: 'conn-1-example-routines',
                children: [
                  {
                    key: 'conn-1-example-routine-func-main.func_name',
                    type: 'routine',
                    dataRef: {
                      id: 'conn-1',
                      dbName: 'example',
                      routineName: 'main.func_name',
                      routineType: 'FUNCTION',
                      schemaName: 'main',
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
      'conn-1-example',
      'conn-1-example-routines',
      'conn-1-example-routine-func-main.func_name',
    ]);
  });

  it('locates a MySQL event from an object-edit SQL editor tab', () => {
    const request = normalizeSidebarLocateObjectRequestFromTab({
      id: 'query-edit-event-123',
      type: 'query',
      queryMode: 'object-edit',
      connectionId: 'conn-1',
      dbName: 'main',
      eventName: 'nightly_cleanup',
      schemaName: 'main',
    });
    expect(request).not.toBeNull();

    const target = resolveSidebarLocateTarget(request!, { groupBySchema: false });
    const tree = [
      {
        key: 'conn-1',
        children: [
          {
            key: 'conn-1-main',
            dataRef: { id: 'conn-1', dbName: 'main' },
            children: [
              {
                key: 'conn-1-main-events',
                children: [
                  {
                    key: 'conn-1-main-event-main-nightly_cleanup',
                    type: 'db-event',
                    dataRef: {
                      id: 'conn-1',
                      dbName: 'main',
                      eventName: 'nightly_cleanup',
                      schemaName: 'main',
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
      'conn-1-main',
      'conn-1-main-events',
      'conn-1-main-event-main-nightly_cleanup',
    ]);
  });

  it('finds schema objects when tree nodes use unqualified names or different case', () => {
    const viewTarget = resolveSidebarLocateTarget({
      tabId: 'conn-1-main-view-reporting.active_users',
      connectionId: 'conn-1',
      dbName: 'main',
      tableName: 'reporting.active_users',
      schemaName: 'reporting',
      objectGroup: 'views',
    }, { groupBySchema: true });

    const routineTarget = resolveSidebarLocateTarget({
      tabId: 'conn-1-main-routine-reporting.refresh_stats',
      connectionId: 'conn-1',
      dbName: 'main',
      tableName: 'reporting.refresh_stats',
      schemaName: 'reporting',
      objectGroup: 'routines',
    }, { groupBySchema: true });

    const triggerTarget = resolveSidebarLocateTarget({
      tabId: 'conn-1-main-trigger-audit.users_bi-audit.users',
      connectionId: 'conn-1',
      dbName: 'main',
      tableName: 'audit.users_bi',
      schemaName: 'audit',
      objectGroup: 'triggers',
    }, { groupBySchema: true });

    const tree = [
      {
        key: 'conn-1',
        children: [
          {
            key: 'conn-1-main',
            dataRef: { id: 'conn-1', dbName: 'main' },
            children: [
              {
                key: 'conn-1-main-schema-REPORTING',
                children: [
                  {
                    key: 'conn-1-main-schema-REPORTING-views',
                    children: [
                      {
                        key: 'conn-1-main-view-ACTIVE_USERS',
                        type: 'view',
                        dataRef: { id: 'conn-1', dbName: 'main', viewName: 'ACTIVE_USERS', schemaName: 'REPORTING' },
                      },
                    ],
                  },
                  {
                    key: 'conn-1-main-schema-REPORTING-routines',
                    children: [
                      {
                        key: 'conn-1-main-routine-REFRESH_STATS',
                        type: 'routine',
                        dataRef: { id: 'conn-1', dbName: 'main', routineName: 'REFRESH_STATS', schemaName: 'REPORTING' },
                      },
                    ],
                  },
                ],
              },
              {
                key: 'conn-1-main-schema-AUDIT',
                children: [
                  {
                    key: 'conn-1-main-schema-AUDIT-triggers',
                    children: [
                      {
                        key: 'conn-1-main-trigger-USERS_BI-AUDIT.USERS',
                        type: 'db-trigger',
                        dataRef: { id: 'conn-1', dbName: 'main', triggerName: 'USERS_BI', tableName: 'AUDIT.USERS', schemaName: 'AUDIT' },
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

    expect(findSidebarNodePathForLocate(tree, viewTarget)).toEqual([
      'conn-1',
      'conn-1-main',
      'conn-1-main-schema-REPORTING',
      'conn-1-main-schema-REPORTING-views',
      'conn-1-main-view-ACTIVE_USERS',
    ]);
    expect(findSidebarNodePathForLocate(tree, routineTarget)).toEqual([
      'conn-1',
      'conn-1-main',
      'conn-1-main-schema-REPORTING',
      'conn-1-main-schema-REPORTING-routines',
      'conn-1-main-routine-REFRESH_STATS',
    ]);
    expect(findSidebarNodePathForLocate(tree, triggerTarget)).toEqual([
      'conn-1',
      'conn-1-main',
      'conn-1-main-schema-AUDIT',
      'conn-1-main-schema-AUDIT-triggers',
      'conn-1-main-trigger-USERS_BI-AUDIT.USERS',
    ]);
  });

  it('finds a unique schema-qualified view when the locate request only has the view name', () => {
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
                        dataRef: {
                          id: 'conn-1',
                          dbName: 'SYSDBA',
                          viewName: 'SYSDBA.V_ACCOUNT',
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
      'conn-1-SYSDBA-schema-SYSDBA-views',
      'conn-1-SYSDBA-view-SYSDBA.V_ACCOUNT',
    ]);
  });
});
