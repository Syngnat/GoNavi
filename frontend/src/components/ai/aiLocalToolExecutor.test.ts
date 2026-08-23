import { describe, expect, it, vi } from 'vitest';

import { t as translateCatalog } from '../../i18n/catalog';
import type { AIMCPToolDescriptor, AIToolCall, SavedConnection } from '../../types';
import { buildToolResultMessage, executeLocalAIToolCall } from './aiLocalToolExecutor';

const buildConnection = (): SavedConnection => ({
  id: 'conn-1',
  name: '主库',
  config: {
    type: 'mysql',
    host: '127.0.0.1',
    port: 3306,
    user: 'root',
  },
});

const buildToolCall = (name: string, args: Record<string, unknown>): AIToolCall => ({
  id: `call-${name}`,
  type: 'function',
  function: {
    name,
    arguments: JSON.stringify(args),
  },
});

describe('aiLocalToolExecutor', () => {
  it('caches validated table context after get_tables succeeds', async () => {
    const toolContextMap = new Map();
    const result = await executeLocalAIToolCall({
      toolCall: buildToolCall('get_tables', { connectionId: 'conn-1', dbName: 'crm' }),
      connections: [buildConnection()],
      mcpTools: [],
      toolContextMap,
      runtime: {
        getDatabases: vi.fn(),
        getTables: vi.fn().mockResolvedValue({
          success: true,
          data: [{ Table: 'users' }, { Table: 'orders' }],
        }),
      },
    });

    expect(result.success).toBe(true);
    expect(result.content).toContain('users');
    expect(toolContextMap.get('conn-1:crm')).toEqual({
      connectionId: 'conn-1',
      dbName: 'crm',
      tables: ['users', 'orders'],
    });
  });

  it('returns the current active tab snapshot so the model can inspect the editor draft directly', async () => {
    const result = await executeLocalAIToolCall({
      toolCall: buildToolCall('inspect_active_tab', {
        includeContent: true,
      }),
      connections: [buildConnection()],
      tabs: [{
        id: 'tab-query-1',
        title: '订单查询',
        type: 'query',
        connectionId: 'conn-1',
        dbName: 'crm',
        query: 'SELECT id, status FROM orders WHERE status = \'paid\'',
        filePath: 'D:/sql/orders.sql',
      }],
      activeTabId: 'tab-query-1',
      mcpTools: [],
      toolContextMap: new Map(),
      runtime: {
        getDatabases: vi.fn(),
        getTables: vi.fn(),
      },
    });

    expect(result.success).toBe(true);
    expect(result.content).toContain('"hasActiveTab":true');
    expect(result.content).toContain('"type":"query"');
    expect(result.content).toContain('"connectionName":"主库"');
    expect(result.content).toContain('"contentKind":"sql"');
    expect(result.content).toContain('SELECT id, status FROM orders');
  });

  it('localizes empty active-tab snapshots through the local tool executor', async () => {
    const result = await executeLocalAIToolCall({
      toolCall: buildToolCall('inspect_active_tab', {
        includeContent: true,
      }),
      connections: [buildConnection()],
      tabs: [],
      activeTabId: null,
      mcpTools: [],
      toolContextMap: new Map(),
      translate: (key, params) => translateCatalog('en-US', key, params),
      runtime: {
        getDatabases: vi.fn(),
        getTables: vi.fn(),
      },
    });

    expect(result.success).toBe(true);
    expect(result.content).toContain('"message":"No active tab is currently selected"');
  });

  it('returns a workspace tab overview so the model can inspect which editors are currently open', async () => {
    const result = await executeLocalAIToolCall({
      toolCall: buildToolCall('inspect_workspace_tabs', {
        limit: 2,
        includeContent: true,
      }),
      connections: [buildConnection()],
      tabs: [
        {
          id: 'tab-query-1',
          title: '订单查询',
          type: 'query',
          connectionId: 'conn-1',
          dbName: 'crm',
          query: 'SELECT * FROM orders WHERE status = \'paid\'',
        },
        {
          id: 'tab-table-1',
          title: 'users',
          type: 'table',
          connectionId: 'conn-1',
          dbName: 'crm',
          tableName: 'users',
        },
        {
          id: 'tab-redis-1',
          title: '缓存命令',
          type: 'redis-command',
          connectionId: 'conn-1',
          query: 'GET order:1',
          redisDB: 2,
        },
      ],
      activeTabId: 'tab-query-1',
      mcpTools: [],
      toolContextMap: new Map(),
      runtime: {
        getDatabases: vi.fn(),
        getTables: vi.fn(),
      },
    });

    expect(result.success).toBe(true);
    expect(result.content).toContain('"activeTabId":"tab-query-1"');
    expect(result.content).toContain('"totalTabs":3');
    expect(result.content).toContain('"returnedTabs":2');
    expect(result.content).toContain('"truncated":true');
    expect(result.content).toContain('"isActive":true');
    expect(result.content).toContain('"title":"订单查询"');
    expect(result.content).toContain('SELECT * FROM orders');
  });

  it('returns the current linked AI context so the model can inspect which table schemas are already mounted', async () => {
    const result = await executeLocalAIToolCall({
      toolCall: buildToolCall('inspect_ai_context', {
        includeDDL: true,
        ddlLimit: 80,
      }),
      connections: [buildConnection()],
      activeContext: {
        connectionId: 'conn-1',
        dbName: 'crm',
      },
      aiContexts: {
        'conn-1:crm': [
          {
            dbName: 'crm',
            tableName: 'orders',
            ddl: 'CREATE TABLE orders (id bigint primary key, status varchar(32), amount decimal(10,2));',
          },
        ],
      },
      mcpTools: [],
      toolContextMap: new Map(),
      runtime: {
        getDatabases: vi.fn(),
        getTables: vi.fn(),
      },
    });

    expect(result.success).toBe(true);
    expect(result.content).toContain('"hasActiveContext":true');
    expect(result.content).toContain('"connectionName":"主库"');
    expect(result.content).toContain('"tableName":"orders"');
    expect(result.content).toContain('"includeDDL":true');
    expect(result.content).toContain('CREATE TABLE orders');
  });

  it('localizes AI context snapshot messages while preserving raw table metadata and DDL', async () => {
    const result = await executeLocalAIToolCall({
      toolCall: buildToolCall('inspect_ai_context', {
        includeDDL: true,
        ddlLimit: 120,
      }),
      connections: [buildConnection()],
      activeContext: {
        connectionId: 'conn-1',
        dbName: 'crm',
      },
      aiContexts: {
        'conn-1:crm': [
          {
            dbName: 'crm',
            tableName: 'orders',
            ddl: 'CREATE TABLE orders (id bigint primary key, status varchar(32));',
          },
        ],
      },
      mcpTools: [],
      toolContextMap: new Map(),
      translate: (key, params) => translateCatalog('en-US', key, params),
      runtime: {
        getDatabases: vi.fn(),
        getTables: vi.fn(),
      },
    });

    expect(result.success).toBe(true);
    expect(result.content).toContain('"message":"Currently linked table schema contexts: 1"');
    expect(result.content).toContain('"dbName":"crm"');
    expect(result.content).toContain('"tableName":"orders"');
    expect(result.content).toContain('CREATE TABLE orders');
    expect(result.content).not.toContain('当前已关联');
  });

  it('blocks execute_sql when the AI safety check rejects the statement', async () => {
    const query = vi.fn();
    const result = await executeLocalAIToolCall({
      toolCall: buildToolCall('execute_sql', {
        connectionId: 'conn-1',
        dbName: 'crm',
        sql: 'DELETE FROM users',
      }),
      connections: [buildConnection()],
      mcpTools: [],
      toolContextMap: new Map(),
      runtime: {
        getDatabases: vi.fn(),
        getTables: vi.fn(),
        getColumns: vi.fn(),
        getIndexes: vi.fn(),
        getForeignKeys: vi.fn(),
        getTriggers: vi.fn(),
        showCreateTable: vi.fn(),
        query,
        checkSQL: vi.fn().mockResolvedValue({
          allowed: false,
          operationType: 'DELETE',
        }),
      },
    });

    expect(result.success).toBe(false);
    expect(result.content).toContain('Security policy blocked this request');
    expect(result.content).not.toContain('安全策略拦截');
    expect(query).not.toHaveBeenCalled();
  });

  it('treats OceanBase Oracle SQL execution errors as recoverable and uses Oracle readonly preview SQL', async () => {
    const query = vi.fn().mockResolvedValue({
      success: false,
      message: "oceanbase: error 900 (42000): ORA-00900 near '50 OFFSET 0'",
    });
    const result = await executeLocalAIToolCall({
      toolCall: buildToolCall('execute_sql', {
        connectionId: 'conn-1',
        dbName: 'SYS',
        sql: 'SELECT 1 FROM DUAL',
      }),
      connections: [{
        ...buildConnection(),
        config: {
          type: 'oceanbase',
          host: '127.0.0.1',
          port: 2881,
          user: 'sys',
          driver: 'oceanbase',
          oceanBaseProtocol: 'oracle',
        },
      }],
      mcpTools: [],
      toolContextMap: new Map(),
      runtime: {
        getDatabases: vi.fn(),
        getTables: vi.fn(),
        getColumns: vi.fn(),
        getIndexes: vi.fn(),
        getForeignKeys: vi.fn(),
        getTriggers: vi.fn(),
        showCreateTable: vi.fn(),
        query,
        checkSQL: vi.fn().mockResolvedValue({ allowed: true, operationType: 'query' }),
      },
    });

    expect(result.success).toBe(false);
    expect(result.countsAsProbeFailure).toBe(false);
    expect(query).toHaveBeenCalledWith(
      expect.anything(),
      'SYS',
      'SELECT * FROM (SELECT 1 FROM DUAL) WHERE ROWNUM <= 50',
    );
  });

  it('returns affectedRows for execute_sql write statements instead of pretending rowCount is zero', async () => {
    const query = vi.fn().mockResolvedValue({
      success: true,
      data: {
        affectedRows: 100000,
      },
    });
    const result = await executeLocalAIToolCall({
      toolCall: buildToolCall('execute_sql', {
        connectionId: 'conn-1',
        dbName: 'crm',
        sql: 'INSERT INTO orders_archive SELECT * FROM orders',
      }),
      connections: [buildConnection()],
      mcpTools: [],
      toolContextMap: new Map(),
      runtime: {
        getDatabases: vi.fn(),
        getTables: vi.fn(),
        getColumns: vi.fn(),
        getIndexes: vi.fn(),
        getForeignKeys: vi.fn(),
        getTriggers: vi.fn(),
        showCreateTable: vi.fn(),
        query,
        checkSQL: vi.fn().mockResolvedValue({ allowed: true, operationType: 'INSERT' }),
      },
    });

    expect(result.success).toBe(true);
    expect(query).toHaveBeenCalledWith(expect.anything(), 'crm', 'INSERT INTO orders_archive SELECT * FROM orders');
    expect(JSON.parse(result.content)).toEqual({ affectedRows: 100000 });
  });

  it('returns a cross-table column summary for get_all_columns', async () => {
    const result = await executeLocalAIToolCall({
      toolCall: buildToolCall('get_all_columns', {
        connectionId: 'conn-1',
        dbName: 'crm',
      }),
      connections: [buildConnection()],
      mcpTools: [],
      toolContextMap: new Map(),
      runtime: {
        getDatabases: vi.fn(),
        getTables: vi.fn(),
        getAllColumns: vi.fn().mockResolvedValue({
          success: true,
          data: [
            { TableName: 'users', Name: 'email', Type: 'varchar(255)', Comment: '用户邮箱' },
            { TableName: 'orders', Name: 'user_id', Type: 'bigint', Comment: '关联用户' },
          ],
        }),
      },
    });

    expect(result.success).toBe(true);
    expect(result.content).toContain('"tableCount":2');
    expect(result.content).toContain('"tableName":"users"');
    expect(result.content).toContain('"name":"email"');
  });

  it('marks partial get_all_columns results while preserving returned columns', async () => {
    const result = await executeLocalAIToolCall({
      toolCall: buildToolCall('get_all_columns', {
        connectionId: 'conn-1',
        dbName: 'crm',
      }),
      connections: [buildConnection()],
      mcpTools: [],
      toolContextMap: new Map(),
      runtime: {
        getDatabases: vi.fn(),
        getTables: vi.fn(),
        getAllColumns: vi.fn().mockResolvedValue({
          success: true,
          partial: true,
          warnings: ['Failed to read column metadata for restricted: permission denied'],
          data: [{ TableName: 'healthy', Name: 'id', Type: 'bigint' }],
        }),
      },
    });

    expect(result.success).toBe(true);
    expect(JSON.parse(result.content)).toMatchObject({
      partial: true,
      warnings: ['Failed to read column metadata for restricted: permission denied'],
      columns: [{ tableName: 'healthy', name: 'id' }],
    });
  });

  it('returns index definitions and resolves the tool label for MCP descriptors', async () => {
    const mcpTools: AIMCPToolDescriptor[] = [{
      alias: 'custom_tool',
      originalName: 'custom_tool',
      serverId: 'server-1',
      serverName: 'demo',
      title: '自定义探针',
      description: '',
    }];
    const indexResult = await executeLocalAIToolCall({
      toolCall: buildToolCall('get_indexes', {
        connectionId: 'conn-1',
        dbName: 'crm',
        tableName: 'users',
      }),
      connections: [buildConnection()],
      mcpTools,
      toolContextMap: new Map(),
      runtime: {
        getDatabases: vi.fn(),
        getTables: vi.fn(),
        getColumns: vi.fn(),
        getIndexes: vi.fn().mockResolvedValue({
          success: true,
          data: [{ keyName: 'idx_users_email', nonUnique: 0 }],
        }),
        getForeignKeys: vi.fn(),
        getTriggers: vi.fn(),
        showCreateTable: vi.fn(),
        query: vi.fn(),
      },
    });
    const message = buildToolResultMessage({
      id: 'msg-1',
      timestamp: 1,
      toolCall: buildToolCall('custom_tool', {}),
      execution: {
        content: 'ok',
        success: true,
        toolName: '自定义探针',
      },
    });

    expect(indexResult.success).toBe(true);
    expect(indexResult.content).toContain('idx_users_email');
    expect(message.tool_name).toBe('自定义探针');
  });

  it('localizes local executor tool error wrappers while preserving raw names and details', async () => {
    const translate = vi.fn((key: string, params?: Record<string, unknown>) => {
      if (params?.functionName) return `T:${key} functionName=${params.functionName}`;
      if (params?.detail) return `T:${key} detail=${params.detail}`;
      return `T:${key}`;
    });
    const mcpTools: AIMCPToolDescriptor[] = [{
      alias: 'external_probe',
      originalName: 'raw_external_probe',
      serverId: 'server-1',
      serverName: 'Demo MCP',
      title: 'Demo Probe',
      description: '',
    }];

    const unknownFunction = await executeLocalAIToolCall({
      toolCall: buildToolCall('missing_tool', {}),
      connections: [buildConnection()],
      mcpTools: [],
      toolContextMap: new Map(),
      translate,
      runtime: {
        getDatabases: vi.fn(),
        getTables: vi.fn(),
      },
    });
    const emptyMcpError = await executeLocalAIToolCall({
      toolCall: buildToolCall('external_probe', {}),
      connections: [buildConnection()],
      mcpTools,
      toolContextMap: new Map(),
      translate,
      runtime: {
        getDatabases: vi.fn(),
        getTables: vi.fn(),
        callMCPTool: vi.fn().mockResolvedValue({ isError: true, content: '' }),
      },
    });
    const thrownMcpError = await executeLocalAIToolCall({
      toolCall: buildToolCall('external_probe', {}),
      connections: [buildConnection()],
      mcpTools,
      toolContextMap: new Map(),
      translate,
      runtime: {
        getDatabases: vi.fn(),
        getTables: vi.fn(),
        callMCPTool: vi.fn().mockRejectedValue(new Error('raw upstream 503')),
      },
    });

    expect(unknownFunction.success).toBe(false);
    expect(unknownFunction.content).toBe('T:ai_chat.panel.tool_error.unknown_function functionName=missing_tool');
    expect(emptyMcpError.success).toBe(false);
    expect(emptyMcpError.content).toBe('T:ai_chat.panel.tool_error.mcp_failed');
    expect(thrownMcpError.success).toBe(false);
    expect(thrownMcpError.content).toBe('T:ai_chat.panel.tool_error.mcp_failed_with_detail detail=raw upstream 503');
  });

  it('previews sample rows for a table without forcing the model to handwrite select limit sql', async () => {
    const query = vi.fn().mockResolvedValue({
      success: true,
      data: [
        { id: 1, status: 'paid', amount: 120.5 },
        { id: 2, status: 'pending', amount: null },
      ],
    });
    const result = await executeLocalAIToolCall({
      toolCall: buildToolCall('preview_table_rows', {
        connectionId: 'conn-1',
        dbName: 'crm',
        tableName: 'orders',
        limit: 5,
      }),
      connections: [buildConnection()],
      mcpTools: [],
      toolContextMap: new Map(),
      runtime: {
        getDatabases: vi.fn(),
        getTables: vi.fn(),
        getColumns: vi.fn(),
        getIndexes: vi.fn(),
        getForeignKeys: vi.fn(),
        getTriggers: vi.fn(),
        showCreateTable: vi.fn(),
        query,
      },
    });

    expect(result.success).toBe(true);
    expect(query).toHaveBeenCalledWith(expect.anything(), 'crm', 'SELECT * FROM `orders` LIMIT 5 OFFSET 0');
    expect(result.content).toContain('"tableName":"orders"');
    expect(result.content).toContain('"status":"paid"');
    expect(result.content).toContain('"rowCount":2');
  });

  it('returns a full table snapshot bundle with optional sample rows in one tool call', async () => {
    const result = await executeLocalAIToolCall({
      toolCall: buildToolCall('inspect_table_bundle', {
        connectionId: 'conn-1',
        dbName: 'crm',
        tableName: 'orders',
        includeSampleRows: true,
        sampleLimit: 2,
      }),
      connections: [buildConnection()],
      mcpTools: [],
      toolContextMap: new Map(),
      runtime: {
        getDatabases: vi.fn(),
        getTables: vi.fn(),
        getColumns: vi.fn().mockResolvedValue({
          success: true,
          data: [{ Field: 'id', Type: 'bigint', Null: 'NO', Comment: '主键' }],
        }),
        getIndexes: vi.fn().mockResolvedValue({
          success: true,
          data: [{ keyName: 'PRIMARY', seqInIndex: 1 }],
        }),
        getForeignKeys: vi.fn().mockResolvedValue({
          success: true,
          data: [{ columnName: 'user_id', refTable: 'users' }],
        }),
        getTriggers: vi.fn().mockResolvedValue({
          success: true,
          data: [{ triggerName: 'orders_bi' }],
        }),
        showCreateTable: vi.fn().mockResolvedValue({
          success: true,
          data: [{ ddl: 'CREATE TABLE orders (...)' }],
        }),
        query: vi.fn().mockResolvedValue({
          success: true,
          data: [{ id: 1, status: 'paid' }, { id: 2, status: 'pending' }],
        }),
      },
    });

    expect(result.success).toBe(true);
    expect(result.content).toContain('"tableName":"orders"');
    expect(result.content).toContain('"field":"id"');
    expect(result.content).toContain('"keyName":"PRIMARY"');
    expect(result.content).toContain('"triggerName":"orders_bi"');
    expect(result.content).toContain('"sampleRows"');
    expect(result.content).toContain('"status":"paid"');
  });

  it('returns recent sql logs and supports filtering only failed statements', async () => {
    const result = await executeLocalAIToolCall({
      toolCall: buildToolCall('inspect_recent_sql_logs', {
        limit: 2,
        status: 'error',
      }),
      connections: [buildConnection()],
      mcpTools: [],
      toolContextMap: new Map(),
      sqlLogs: [
        {
          id: 'log-1',
          timestamp: 3,
          sql: 'DELETE FROM users WHERE id = 9',
          status: 'error',
          duration: 120,
          message: 'permission denied',
          dbName: 'crm',
        },
        {
          id: 'log-2',
          timestamp: 2,
          sql: 'SELECT * FROM users LIMIT 10',
          status: 'success',
          duration: 18,
          dbName: 'crm',
          affectedRows: 10,
        },
        {
          id: 'log-3',
          timestamp: 1,
          sql: 'UPDATE orders SET status = \'paid\' WHERE id = 1',
          status: 'error',
          duration: 95,
          message: 'row lock timeout',
          dbName: 'crm',
        },
      ],
      runtime: {
        getDatabases: vi.fn(),
        getTables: vi.fn(),
      },
    });

    expect(result.success).toBe(true);
    expect(result.content).toContain('"status":"error"');
    expect(result.content).toContain('"totalMatched":2');
    expect(result.content).toContain('permission denied');
    expect(result.content).toContain('row lock timeout');
    expect(result.content).not.toContain('SELECT * FROM users LIMIT 10');
  });

  it('returns a recent sql activity summary so the model can quickly spot writes, ddl, and repeated failures', async () => {
    const result = await executeLocalAIToolCall({
      toolCall: buildToolCall('inspect_recent_sql_activity', {
        limit: 3,
        activityKind: 'write',
        dbName: 'crm',
      }),
      connections: [buildConnection()],
      mcpTools: [],
      toolContextMap: new Map(),
      sqlLogs: [
        {
          id: 'log-1',
          timestamp: 4,
          sql: 'DELETE FROM users WHERE id = 9',
          status: 'error',
          duration: 120,
          message: 'permission denied',
          dbName: 'crm',
        },
        {
          id: 'log-2',
          timestamp: 3,
          sql: 'UPDATE orders SET status = \'paid\' WHERE id = 1',
          status: 'error',
          duration: 95,
          message: 'row lock timeout',
          dbName: 'crm',
        },
        {
          id: 'log-3',
          timestamp: 2,
          sql: 'ALTER TABLE orders ADD COLUMN note varchar(32)',
          status: 'success',
          duration: 160,
          dbName: 'crm',
        },
        {
          id: 'log-4',
          timestamp: 1,
          sql: 'SELECT * FROM users LIMIT 10',
          status: 'success',
          duration: 18,
          dbName: 'crm',
          affectedRows: 10,
        },
      ],
      runtime: {
        getDatabases: vi.fn(),
        getTables: vi.fn(),
      },
    });

    expect(result.success).toBe(true);
    expect(result.content).toContain('"activityKind":"write"');
    expect(result.content).toContain('"totalMatched":2');
    expect(result.content).toContain('"writeCount":2');
    expect(result.content).toContain('"statementTypeBreakdown":{"delete":1,"update":1}');
    expect(result.content).toContain('permission denied');
    expect(result.content).toContain('row lock timeout');
    expect(result.content).not.toContain('ALTER TABLE orders');
    expect(result.content).not.toContain('SELECT * FROM users LIMIT 10');
  });

  it('localizes sql editor transaction settings, active dml semantics, and pending transactions', async () => {
    const result = await executeLocalAIToolCall({
      toolCall: buildToolCall('inspect_sql_editor_transaction', {}),
      connections: [buildConnection()],
      tabs: [{
        id: 'tab-query-1',
        title: 'Order update',
        type: 'query',
        connectionId: 'conn-1',
        dbName: 'crm',
        query: 'UPDATE orders SET status = \'paid\' WHERE id = 1',
        resultPanelVisible: true,
      }],
      activeTabId: 'tab-query-1',
      mcpTools: [],
      toolContextMap: new Map(),
      translate: (key, params) => translateCatalog('en-US', key, params),
      sqlLogs: [{
        id: 'log-1',
        timestamp: 10,
        sql: 'UPDATE orders SET status = \'paid\' WHERE id = 1',
        status: 'success',
        duration: 42,
        dbName: 'crm',
        affectedRows: 1,
      }],
      runtime: {
        getDatabases: vi.fn(),
        getTables: vi.fn(),
        getSqlEditorTransactionState: vi.fn().mockResolvedValue({
          commitMode: 'auto',
          autoCommitDelayMs: 3000,
          pendingTransactions: {
            'tab-query-1': {
              id: 'tx-1',
              tabId: 'tab-query-1',
              commitMode: 'auto',
              autoCommitDelayMs: 3000,
              createdAt: 1000,
              autoCommitDueAt: Date.now() + 3000,
            },
          },
        }),
      },
    });

    expect(result.success).toBe(true);
    expect(result.content).toContain('"commitMode":"auto"');
    expect(result.content).toContain('"transactionAlwaysOnForDML":true');
    expect(result.content).toContain('"usesManagedTransaction":true');
    expect(result.content).toContain('"pendingTransactionCount":1');
    expect(result.content).toContain('"activePendingTransaction"');
    expect(result.content).toContain('Auto commit is enabled, but DML still enters a managed transaction');
    expect(result.content).toContain('Ask the user to click \\"Commit\\" or \\"Rollback\\" in the result transaction bar');
    expect(result.content).toContain('DML opens a managed transaction first and auto-commits about 3 seconds after successful execution');
    expect(result.content).toContain('SQL editor runs INSERT/UPDATE/DELETE/MERGE/REPLACE DML inside a managed transaction');
    expect(result.content).toContain('UPDATE orders SET status');
  });

  it('returns a database overview bundle with per-table column previews in one tool call', async () => {
    const result = await executeLocalAIToolCall({
      toolCall: buildToolCall('inspect_database_bundle', {
        connectionId: 'conn-1',
        dbName: 'crm',
        tableLimit: 5,
        perTableColumnLimit: 1,
      }),
      connections: [buildConnection()],
      mcpTools: [],
      toolContextMap: new Map(),
      runtime: {
        getDatabases: vi.fn(),
        getTables: vi.fn().mockResolvedValue({
          success: true,
          data: [{ Table: 'users' }, { Table: 'orders' }],
        }),
        getAllColumns: vi.fn().mockResolvedValue({
          success: true,
          data: [
            { TableName: 'users', Name: 'id', Type: 'bigint', Comment: '主键' },
            { TableName: 'users', Name: 'email', Type: 'varchar(255)', Comment: '邮箱' },
            { TableName: 'orders', Name: 'id', Type: 'bigint', Comment: '主键' },
          ],
        }),
      },
    });

    expect(result.success).toBe(true);
    expect(result.content).toContain('"dbName":"crm"');
    expect(result.content).toContain('"tableCount":2');
    expect(result.content).toContain('"tableName":"users"');
    expect(result.content).toContain('"columnCount":2');
    expect(result.content).toContain('"truncatedColumns":true');
  });
});
