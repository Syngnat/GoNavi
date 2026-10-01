import { describe, expect, it } from 'vitest';

import { COMMON_COLUMN_DEFAULT_OPTIONS, resolveColumnDefaultOptions } from './columnDefaultOptions';

const values = (options: Array<{ value: string }>) => options.map((item) => item.value);

describe('columnDefaultOptions', () => {
  it('keeps the original four common defaults as the unknown-dialect fallback', () => {
    expect(values(COMMON_COLUMN_DEFAULT_OPTIONS)).toEqual([
      'CURRENT_TIMESTAMP',
      'NULL',
      '0',
      "''",
    ]);
    expect(values(resolveColumnDefaultOptions('unknown'))).toEqual(values(COMMON_COLUMN_DEFAULT_OPTIONS));
  });

  it('offers a complete PostgreSQL-family default list for Kingbase, including Oracle-compat expressions', () => {
    const kingbase = values(resolveColumnDefaultOptions('kingbase'));
    const kingbase8 = values(resolveColumnDefaultOptions('kingbase8'));

    expect(kingbase.length).toBeGreaterThan(20);
    expect(kingbase8).toEqual(kingbase);
    expect(kingbase).toEqual(expect.arrayContaining([
      'CURRENT_TIMESTAMP',
      'NULL',
      '0',
      "''",
      'now()',
      'CURRENT_DATE',
      'LOCALTIMESTAMP',
      'TRUE',
      'FALSE',
      "nextval('seq_name')",
      'gen_random_uuid()',
      'SYSDATE',
      'SYSTIMESTAMP',
      'SYS_GUID()',
      "'{}'::jsonb",
    ]));
    expect(kingbase).not.toContain('GETDATE()');
    expect(kingbase).not.toContain('UUID()');
  });

  it('uses PostgreSQL defaults for highgo and Oracle-compat extras for openGauss-family engines', () => {
    const postgres = values(resolveColumnDefaultOptions('postgres'));
    const highgo = values(resolveColumnDefaultOptions('highgo'));
    const opengauss = values(resolveColumnDefaultOptions('opengauss'));

    expect(highgo).toEqual(postgres);
    expect(postgres).toContain('now()');
    expect(postgres).not.toContain('SYSDATE');
    expect(opengauss).toEqual(expect.arrayContaining(['now()', 'SYSDATE', 'SYS_GUID()']));
  });

  it('offers complete default lists for other SQL datasources', () => {
    expect(values(resolveColumnDefaultOptions('mysql'))).toEqual(expect.arrayContaining([
      'NOW()',
      'CURRENT_TIMESTAMP(6)',
      'UUID()',
      'JSON_OBJECT()',
      'CURRENT_DATE',
    ]));
    expect(values(resolveColumnDefaultOptions('mysql'))).not.toContain('SYSDATE');
    expect(values(resolveColumnDefaultOptions('oracle'))).toEqual(expect.arrayContaining([
      'SYSDATE',
      'SYSTIMESTAMP',
      'SYS_GUID()',
      'EMPTY_CLOB()',
    ]));
    expect(values(resolveColumnDefaultOptions('oracle'))).not.toContain('now()');
    expect(values(resolveColumnDefaultOptions('dameng'))).toEqual(expect.arrayContaining([
      'SYSDATE',
      'NOW()',
      'GETDATE()',
    ]));
    expect(values(resolveColumnDefaultOptions('sqlserver'))).toEqual(expect.arrayContaining([
      'GETDATE()',
      'SYSDATETIME()',
      'NEWID()',
      'USER_NAME()',
    ]));
    expect(values(resolveColumnDefaultOptions('sqlite'))).toContain("datetime('now')");
    expect(values(resolveColumnDefaultOptions('duckdb'))).toContain('gen_random_uuid()');
    expect(values(resolveColumnDefaultOptions('clickhouse'))).toContain('generateUUIDv4()');
    expect(values(resolveColumnDefaultOptions('tdengine'))).toContain('NOW');
    expect(values(resolveColumnDefaultOptions('starrocks'))).toContain('UUID()');
    expect(values(resolveColumnDefaultOptions('starrocks'))).not.toContain('UNIX_TIMESTAMP()');
  });

  it('prioritizes type-relevant defaults without dropping the rest of the dialect list', () => {
    const timestampDefaults = values(resolveColumnDefaultOptions('kingbase', 'timestamp without time zone'));
    const uuidDefaults = values(resolveColumnDefaultOptions('kingbase', 'uuid'));
    const integerDefaults = values(resolveColumnDefaultOptions('kingbase', 'bigint'));
    const textDefaults = values(resolveColumnDefaultOptions('kingbase', 'varchar(255)'));

    expect(timestampDefaults.indexOf('CURRENT_TIMESTAMP')).toBeLessThan(timestampDefaults.indexOf('0'));
    expect(timestampDefaults.indexOf('now()')).toBeLessThan(timestampDefaults.indexOf("''"));
    expect(uuidDefaults[0]).toBe('gen_random_uuid()');
    expect(integerDefaults.indexOf('0')).toBeLessThan(integerDefaults.indexOf('CURRENT_TIMESTAMP'));
    expect(integerDefaults.indexOf("nextval('seq_name')")).toBeLessThan(integerDefaults.indexOf('CURRENT_TIMESTAMP'));
    expect(textDefaults[0]).toBe("''");
    expect(timestampDefaults).toEqual(expect.arrayContaining(values(resolveColumnDefaultOptions('kingbase'))));
  });
});
