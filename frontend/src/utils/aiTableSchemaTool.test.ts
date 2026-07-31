import { describe, expect, it, vi } from 'vitest';

import { resolveAITableSchemaToolResult } from './aiTableSchemaTool';

const translate = (key: string, params?: Record<string, unknown>) => {
  const renderedParams = params
    ? Object.entries(params).map(([name, value]) => `${name}=${value}`).join('|')
    : '';
  return `T:${key}${renderedParams ? ` ${renderedParams}` : ''}`;
};

describe('resolveAITableSchemaToolResult', () => {
  it('returns DDL directly when DDL fetch succeeds', async () => {
    const fetchColumns = vi.fn();

    const result = await resolveAITableSchemaToolResult({
      tableName: 'USERS',
      fetchDDL: vi.fn().mockResolvedValue({ success: true, data: 'CREATE TABLE USERS (ID NUMBER)' }),
      fetchColumns,
    });

    expect(result).toEqual({ success: true, content: 'CREATE TABLE USERS (ID NUMBER)' });
    expect(fetchColumns).not.toHaveBeenCalled();
  });

  it('falls back to column metadata when DDL fetch fails due to permissions', async () => {
    const result = await resolveAITableSchemaToolResult({
      tableName: 'USERS',
      fetchDDL: vi.fn().mockResolvedValue({ success: false, message: 'ORA-31603: object not found or insufficient privileges' }),
      fetchColumns: vi.fn().mockResolvedValue({
        success: true,
        data: [
          { Name: 'ID', Type: 'NUMBER', Nullable: 'NO', Default: null, Comment: '主键' },
          { Name: 'NAME', Type: 'VARCHAR2(64)', Nullable: 'YES' },
        ],
      }),
      translate,
    });

    expect(result.success).toBe(true);
    expect(result.content).toContain(
      'T:ai_chat.inspection.table_schema.warning.ddl_fallback tableName=USERS',
    );
    expect(result.content).toContain(
      'T:ai_chat.inspection.table_schema.warning.ddl_error detail=ORA-31603: object not found or insufficient privileges',
    );
    expect(result.content).toContain(
      'T:ai_chat.inspection.table_schema.warning.available_fields fields=ID, NAME',
    );
    expect(result.content).toContain('"field":"ID"');
    expect(result.content).toContain('"type":"NUMBER"');
    expect(result.content).not.toContain('DDL 获取失败');
    expect(result.content).not.toContain('可用字段');
  });

  it('returns a combined failure when both DDL and column metadata fail', async () => {
    const result = await resolveAITableSchemaToolResult({
      tableName: 'USERS',
      fetchDDL: vi.fn().mockResolvedValue({ success: false, message: 'DDL permission denied' }),
      fetchColumns: vi.fn().mockResolvedValue({ success: false, message: 'columns permission denied' }),
      translate,
    });

    expect(result.success).toBe(false);
    expect(result.content).toBe(
      'T:ai_chat.inspection.table_schema.error.ddl_and_columns_failed ddlDetail=DDL permission denied|columnDetail=columns permission denied',
    );
    expect(result.content).toContain('DDL permission denied');
    expect(result.content).toContain('columns permission denied');
    expect(result.content).not.toContain('获取建表语句失败');
  });
});
