import { describe, expect, it } from 'vitest';

import { formatEnabledDefaultExpression } from './tableDesignerSchemaSqlColumns';

const format = (dbType: string, value: string): string => formatEnabledDefaultExpression(
  { default: value } as any,
  dbType,
);

describe('table designer default expressions', () => {
  it('keeps Oracle function defaults unquoted', () => {
    expect(format('oracle', 'SYS_GUID()')).toBe('SYS_GUID()');
    expect(format('oracle', 'EMPTY_CLOB()')).toBe('EMPTY_CLOB()');
    expect(format('oracle', 'seq_name.NEXTVAL')).toBe('seq_name.NEXTVAL');
    expect(format('oracle', 'CURRENT_USER')).toBe('CURRENT_USER');
  });

  it('keeps PostgreSQL and SQL Server function defaults unquoted', () => {
    expect(format('postgres', 'gen_random_uuid()')).toBe('gen_random_uuid()');
    expect(format('postgres', 'clock_timestamp()')).toBe('clock_timestamp()');
    expect(format('sqlserver', 'GETDATE()')).toBe('GETDATE()');
    expect(format('sqlserver', 'USER_NAME()')).toBe('USER_NAME()');
  });

  it('keeps function calls with literal arguments unquoted', () => {
    expect(format('sqlite', "datetime('now')")).toBe("datetime('now')");
    expect(format('mysql', 'JSON_OBJECT()')).toBe('JSON_OBJECT()');
  });

  it('still quotes plain text literals and escapes quotes', () => {
    expect(format('oracle', 'hello')).toBe("'hello'");
    expect(format('oracle', "O'Brien")).toBe("'O''Brien'");
    expect(format('mysql', 'active')).toBe("'active'");
  });

  it('keeps numeric and boolean defaults unquoted', () => {
    expect(format('oracle', '1')).toBe('1');
    expect(format('mysql', 'TRUE')).toBe('TRUE');
    expect(format('mysql', 'null')).toBe('NULL');
  });
});
