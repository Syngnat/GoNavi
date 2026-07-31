import { describe, expect, it, vi } from 'vitest';

import type { AIToolCall, SavedConnection } from '../../types';
import { executeLocalAIToolCall } from './aiLocalToolExecutor';

const buildConnection = (): SavedConnection => ({
  id: 'conn-1',
  name: 'Primary',
  config: {
    type: 'oracle',
    host: '127.0.0.1',
    port: 1521,
    user: 'system',
  },
});

const buildSqlExecutionConnection = (): SavedConnection => ({
  id: 'conn-1',
  name: 'Primary',
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

const translate = (key: string, params?: Record<string, unknown>) => {
  const renderedParams = params
    ? Object.entries(params).map(([name, value]) => `${name}=${value}`).join('|')
    : '';
  return `T:${key}${renderedParams ? ` ${renderedParams}` : ''}`;
};

describe('aiDatabaseToolExecutor i18n', () => {
  it('uses the translated missing-connection wrapper for database tool calls', async () => {
    const result = await executeLocalAIToolCall({
      toolCall: buildToolCall('get_databases', {
        connectionId: 'missing-conn',
      }),
      connections: [],
      mcpTools: [],
      toolContextMap: new Map(),
      translate,
      runtime: {},
    });

    expect(result.success).toBe(false);
    expect(result.content).toBe('T:ai_chat.panel.tool_error.connection_not_found');
    expect(result.content).not.toContain('Connection not found');
  });

  it.each([
    {
      toolName: 'get_databases',
      runtimeMethod: 'getDatabases',
      expectedKey: 'ai_chat.panel.tool_error.fetch_databases_failed',
      oldText: 'Failed to fetch DBs',
    },
    {
      toolName: 'get_tables',
      runtimeMethod: 'getTables',
      expectedKey: 'ai_chat.panel.tool_error.fetch_tables_failed',
      oldText: 'Failed to fetch Tables',
      args: { dbName: 'HR' },
    },
    {
      toolName: 'get_all_columns',
      runtimeMethod: 'getAllColumns',
      expectedKey: 'ai_chat.panel.tool_error.fetch_all_columns_failed',
      oldText: 'Failed to fetch all columns',
      args: { dbName: 'HR' },
    },
    {
      toolName: 'get_columns',
      runtimeMethod: 'getColumns',
      expectedKey: 'ai_chat.panel.tool_error.fetch_columns_failed',
      oldText: 'Failed to fetch columns',
      args: { dbName: 'HR', tableName: 'EMPLOYEES' },
    },
    {
      toolName: 'get_indexes',
      runtimeMethod: 'getIndexes',
      expectedKey: 'ai_chat.panel.tool_error.fetch_indexes_failed',
      oldText: 'Failed to fetch indexes',
      args: { dbName: 'HR', tableName: 'EMPLOYEES' },
    },
    {
      toolName: 'get_foreign_keys',
      runtimeMethod: 'getForeignKeys',
      expectedKey: 'ai_chat.panel.tool_error.fetch_foreign_keys_failed',
      oldText: 'Failed to fetch foreign keys',
      args: { dbName: 'HR', tableName: 'EMPLOYEES' },
    },
    {
      toolName: 'get_triggers',
      runtimeMethod: 'getTriggers',
      expectedKey: 'ai_chat.panel.tool_error.fetch_triggers_failed',
      oldText: 'Failed to fetch triggers',
      args: { dbName: 'HR', tableName: 'EMPLOYEES' },
    },
  ])('uses translated wrappers when $toolName returns no message detail', async ({
    toolName,
    runtimeMethod,
    expectedKey,
    oldText,
    args = {},
  }) => {
    const result = await executeLocalAIToolCall({
      toolCall: buildToolCall(toolName, {
        connectionId: 'conn-1',
        ...args,
      }),
      connections: [buildSqlExecutionConnection()],
      mcpTools: [],
      toolContextMap: new Map(),
      translate,
      runtime: {
        [runtimeMethod]: vi.fn().mockResolvedValue({ success: false }),
      },
    });

    expect(result.success).toBe(false);
    expect(result.content).toBe(`T:${expectedKey} detail=T:ai_chat.inspection.diagnostics.error.unknown`);
    expect(result.content).not.toContain(oldText);
  });

  it.each([
    {
      toolName: 'get_databases',
      runtimeMethod: 'getDatabases',
      expectedKey: 'ai_chat.panel.tool_error.fetch_databases_failed',
      oldText: '获取数据库列表失败',
    },
    {
      toolName: 'get_tables',
      runtimeMethod: 'getTables',
      expectedKey: 'ai_chat.panel.tool_error.fetch_tables_failed',
      oldText: '获取表列表失败',
      args: { dbName: 'HR' },
    },
    {
      toolName: 'get_all_columns',
      runtimeMethod: 'getAllColumns',
      expectedKey: 'ai_chat.panel.tool_error.fetch_all_columns_failed',
      oldText: '获取全库字段摘要失败',
      args: { dbName: 'HR' },
    },
    {
      toolName: 'get_columns',
      runtimeMethod: 'getColumns',
      expectedKey: 'ai_chat.panel.tool_error.fetch_columns_failed',
      oldText: '获取字段列表失败',
      args: { dbName: 'HR', tableName: 'EMPLOYEES' },
    },
    {
      toolName: 'get_indexes',
      runtimeMethod: 'getIndexes',
      expectedKey: 'ai_chat.panel.tool_error.fetch_indexes_failed',
      oldText: '获取索引定义失败',
      args: { dbName: 'HR', tableName: 'EMPLOYEES' },
    },
    {
      toolName: 'get_foreign_keys',
      runtimeMethod: 'getForeignKeys',
      expectedKey: 'ai_chat.panel.tool_error.fetch_foreign_keys_failed',
      oldText: '获取外键关系失败',
      args: { dbName: 'HR', tableName: 'EMPLOYEES' },
    },
    {
      toolName: 'get_triggers',
      runtimeMethod: 'getTriggers',
      expectedKey: 'ai_chat.panel.tool_error.fetch_triggers_failed',
      oldText: '获取触发器定义失败',
      args: { dbName: 'HR', tableName: 'EMPLOYEES' },
    },
  ])('uses translated wrapper when $toolName throws while preserving raw detail', async ({
    toolName,
    runtimeMethod,
    expectedKey,
    oldText,
    args = {},
  }) => {
    const result = await executeLocalAIToolCall({
      toolCall: buildToolCall(toolName, {
        connectionId: 'conn-1',
        ...args,
      }),
      connections: [buildSqlExecutionConnection()],
      mcpTools: [],
      toolContextMap: new Map(),
      translate,
      runtime: {
        [runtimeMethod]: vi.fn().mockRejectedValue(new Error('driver raw detail')),
      },
    });

    expect(result.success).toBe(false);
    expect(result.content).toBe(`T:${expectedKey} detail=driver raw detail`);
    expect(result.content).not.toContain(oldText);
  });

  it('uses translated wrappers for preview table validation and exception paths', async () => {
    const missingTable = await executeLocalAIToolCall({
      toolCall: buildToolCall('preview_table_rows', {
        connectionId: 'conn-1',
        dbName: 'HR',
        tableName: '   ',
      }),
      connections: [buildSqlExecutionConnection()],
      mcpTools: [],
      toolContextMap: new Map(),
      translate,
      runtime: {},
    });

    expect(missingTable.success).toBe(false);
    expect(missingTable.content).toBe('T:ai_chat.panel.tool_error.table_name_required');
    expect(missingTable.content).not.toContain('tableName 不能为空');

    const failedPreview = await executeLocalAIToolCall({
      toolCall: buildToolCall('preview_table_rows', {
        connectionId: 'conn-1',
        dbName: 'HR',
        tableName: 'EMPLOYEES',
      }),
      connections: [buildSqlExecutionConnection()],
      mcpTools: [],
      toolContextMap: new Map(),
      translate,
      runtime: {
        query: vi.fn().mockRejectedValue(new Error('database timeout')),
      },
    });

    expect(failedPreview.success).toBe(false);
    expect(failedPreview.content).toBe('T:ai_chat.panel.tool_error.preview_table_rows_failed detail=database timeout');
    expect(failedPreview.content).not.toContain('预览表样例数据失败');
  });

  it('uses translated wrappers for execute_sql safety and failure paths while preserving raw details', async () => {
    const blocked = await executeLocalAIToolCall({
      toolCall: buildToolCall('execute_sql', {
        connectionId: 'conn-1',
        dbName: 'HR',
        sql: 'UPDATE EMPLOYEES SET SALARY = SALARY + 1',
      }),
      connections: [buildConnection()],
      mcpTools: [],
      toolContextMap: new Map(),
      translate,
      runtime: {
        checkSQL: vi.fn().mockResolvedValue({
          allowed: false,
          operationType: 'UPDATE',
        }),
      },
    });

    expect(blocked.success).toBe(false);
    expect(blocked.content).toBe('T:ai_chat.panel.tool_error.sql_blocked operationType=UPDATE');
    expect(blocked.content).not.toContain('安全策略拦截');

    const failed = await executeLocalAIToolCall({
      toolCall: buildToolCall('execute_sql', {
        connectionId: 'conn-1',
        dbName: 'HR',
        sql: 'INSERT INTO AUDIT_LOG SELECT * FROM EMPLOYEES',
      }),
      connections: [buildConnection()],
      mcpTools: [],
      toolContextMap: new Map(),
      translate,
      runtime: {
        checkSQL: vi.fn().mockResolvedValue({ allowed: true, operationType: 'INSERT' }),
        query: vi.fn().mockResolvedValue({ success: false }),
      },
    });

    expect(failed.success).toBe(false);
    expect(failed.content).toBe('T:ai_chat.panel.tool_error.sql_execute_failed');
    expect(failed.content).not.toContain('SQL 执行失败');

    const thrown = await executeLocalAIToolCall({
      toolCall: buildToolCall('execute_sql', {
        connectionId: 'conn-1',
        dbName: 'HR',
        sql: 'INSERT INTO AUDIT_LOG SELECT * FROM EMPLOYEES',
      }),
      connections: [buildConnection()],
      mcpTools: [],
      toolContextMap: new Map(),
      translate,
      runtime: {
        checkSQL: vi.fn().mockResolvedValue({ allowed: true, operationType: 'INSERT' }),
        query: vi.fn().mockRejectedValue(new Error('ORA-01013 raw detail')),
      },
    });

    expect(thrown.success).toBe(false);
    expect(thrown.content).toBe('T:ai_chat.panel.tool_error.sql_execute_exception detail=ORA-01013 raw detail');
    expect(thrown.content).not.toContain('SQL 执行异常');
  });

  it('uses the translated truncation marker for database and table list results without storing it as table context', async () => {
    const databases = await executeLocalAIToolCall({
      toolCall: buildToolCall('get_databases', {
        connectionId: 'conn-1',
      }),
      connections: [buildConnection()],
      mcpTools: [],
      toolContextMap: new Map(),
      translate,
      runtime: {
        getDatabases: vi.fn().mockResolvedValue({
          success: true,
          data: Array.from({ length: 51 }, (_, index) => ({ Database: `DB_${index}` })),
        }),
      },
    });

    expect(JSON.parse(databases.content).at(-1)).toBe('T:ai_chat.panel.error.truncated_suffix');
    expect(databases.content).not.toContain('...(截断)');

    const toolContextMap = new Map();
    const tables = await executeLocalAIToolCall({
      toolCall: buildToolCall('get_tables', {
        connectionId: 'conn-1',
        dbName: 'HR',
      }),
      connections: [buildConnection()],
      mcpTools: [],
      toolContextMap,
      translate,
      runtime: {
        getTables: vi.fn().mockResolvedValue({
          success: true,
          data: Array.from({ length: 151 }, (_, index) => ({ name: `TABLE_${index}` })),
        }),
      },
    });

    expect(JSON.parse(tables.content).at(-1)).toBe('T:ai_chat.panel.error.truncated_suffix');
    expect(tables.content).not.toContain('...(截断)');
    expect(toolContextMap.get('conn-1:HR')?.tables).not.toContain('T:ai_chat.panel.error.truncated_suffix');
  });

  it('preserves a real table name that matches the translated truncation marker in tool context', async () => {
    const toolContextMap = new Map();

    await executeLocalAIToolCall({
      toolCall: buildToolCall('get_tables', {
        connectionId: 'conn-1',
        dbName: 'HR',
      }),
      connections: [buildConnection()],
      mcpTools: [],
      toolContextMap,
      translate,
      runtime: {
        getTables: vi.fn().mockResolvedValue({
          success: true,
          data: [
            { name: 'T:ai_chat.panel.error.truncated_suffix' },
            { name: 'EMPLOYEES' },
          ],
        }),
      },
    });

    expect(toolContextMap.get('conn-1:HR')?.tables).toContain('T:ai_chat.panel.error.truncated_suffix');
  });

  it('uses translated wrappers for get_columns field guidance while preserving raw table and column data', async () => {
    const result = await executeLocalAIToolCall({
      toolCall: buildToolCall('get_columns', {
        connectionId: 'conn-1',
        dbName: 'HR',
        tableName: 'EMPLOYEES',
      }),
      connections: [buildConnection()],
      mcpTools: [],
      toolContextMap: new Map(),
      translate,
      runtime: {
        getColumns: vi.fn().mockResolvedValue({
          success: true,
          data: [{ Field: 'EMPLOYEE_ID', Type: 'NUMBER' }],
        }),
      },
    });

    expect(result.success).toBe(true);
    expect(result.content).toContain(
      'T:ai_chat.inspection.table_schema.warning.columns_contract tableName=EMPLOYEES',
    );
    expect(result.content).toContain('T:ai_chat.inspection.table_schema.warning.available_fields fields=EMPLOYEE_ID');
    expect(result.content).toContain('T:ai_chat.inspection.table_schema.warning.detail detail=');
    expect(result.content).toContain('"field":"EMPLOYEE_ID"');
    expect(result.content).not.toContain('以下为');
    expect(result.content).not.toContain('可用字段');
    expect(result.content).not.toContain('详细信息');
  });

  it('passes the translator into table schema DDL fallback wrappers', async () => {
    const result = await executeLocalAIToolCall({
      toolCall: buildToolCall('get_table_ddl', {
        connectionId: 'conn-1',
        dbName: 'HR',
        tableName: 'EMPLOYEES',
      }),
      connections: [buildConnection()],
      mcpTools: [],
      toolContextMap: new Map(),
      translate,
      runtime: {
        getDatabases: vi.fn(),
        getTables: vi.fn(),
        showCreateTable: vi.fn().mockResolvedValue({
          success: false,
          message: 'ORA-31603: object not found or insufficient privileges',
        }),
        getColumns: vi.fn().mockResolvedValue({
          success: true,
          data: [{ Name: 'EMPLOYEE_ID', Type: 'NUMBER' }],
        }),
      },
    });

    expect(result.success).toBe(true);
    expect(result.content).toContain(
      'T:ai_chat.inspection.table_schema.warning.ddl_fallback tableName=EMPLOYEES',
    );
    expect(result.content).toContain('EMPLOYEE_ID');
    expect(result.content).not.toContain('DDL 获取失败');
  });

  it('uses translated wrapper when get_table_ddl throws before the schema resolver can handle it', async () => {
    const result = await executeLocalAIToolCall({
      toolCall: buildToolCall('get_table_ddl', {
        connectionId: 'conn-1',
        dbName: 'HR',
        tableName: 'EMPLOYEES',
      }),
      connections: [buildConnection()],
      mcpTools: [],
      toolContextMap: new Map(),
      translate,
      runtime: {
        showCreateTable: vi.fn().mockRejectedValue(new Error('driver panic')),
        getColumns: vi.fn(),
      },
    });

    expect(result.success).toBe(false);
    expect(result.content).toBe('T:ai_chat.inspection.table_schema.error.ddl_failed detail=driver panic');
    expect(result.content).not.toContain('获取建表语句失败');
  });

  it.each([
    '資料庫連線逾時：mysql 127.0.0.1:3306/HR：網路逾時',
    'データベース接続がタイムアウトしました: mysql 127.0.0.1:3306/HR: タイムアウト',
  ])('still counts localized timeout wrapper %s as a probe failure', async (localizedTimeoutMessage) => {
    const result = await executeLocalAIToolCall({
      toolCall: buildToolCall('get_databases', {
        connectionId: 'conn-1',
      }),
      connections: [buildSqlExecutionConnection()],
      mcpTools: [],
      toolContextMap: new Map(),
      translate,
      runtime: {
        getDatabases: vi.fn().mockResolvedValue({
          success: false,
          message: localizedTimeoutMessage,
        }),
      },
    });

    expect(result.success).toBe(false);
    expect(result.content).toBe(localizedTimeoutMessage);
    expect(result.countsAsProbeFailure).toBe(true);
  });
});
