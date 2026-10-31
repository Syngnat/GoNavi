import { describe, expect, it } from 'vitest';
import { hasUnsafeHiveReadOnlyOperation, isHiveReadOnlySet } from './hiveProtectedSql';
import { findPotentiallyMutatingConnectionStatements } from './connectionReadOnly';

const config = { type: 'hive', host: '', port: 10000, user: '' };

describe('Hive protected SQL execution', () => {
  it.each([
    "SELECT '${hivevar:payload}'",
    "SELECT ${hiveconf:payload}",
    "SELECT TRANSFORM (id) USING 'cat' AS id FROM t",
    "SELECT MAP (id) USING 'script' AS id FROM t",
    "SELECT REDUCE (id) USING 'script' AS id FROM t",
    "SELECT reflect('java.lang.System','getenv')",
    "SELECT java_method('java.lang.Runtime','getRuntime')",
    "SELECT \x60reflect\x60 /* ignored */ ('java.lang.System','getenv')",
    "WITH t AS (SELECT reflect2('x','y')) SELECT * FROM t",
  ])('rejects script and reflective Java calls: %s', statement => {
    expect(hasUnsafeHiveReadOnlyOperation(statement)).toBe(true);
    expect(findPotentiallyMutatingConnectionStatements(config, statement)).toEqual([statement]);
  });

  it.each(['SET', 'SET -v', 'SET hive.exec.dynamic.partition', 'SET hivevar:key', '/* note */ SET hiveconf:key;', 'SELECT 1', "SELECT 'reflect(x), transform using'", 'SELECT map(1, 2) FROM t', 'SELECT * FROM a JOIN b USING (id)'])('allows actual introspection and inert strings: %s', statement => {
    expect(hasUnsafeHiveReadOnlyOperation(statement)).toBe(false);
    expect(findPotentiallyMutatingConnectionStatements(config, statement)).toEqual([]);
  });

  it.each(['SET hive.exec.dynamic.partition=true', 'SET hivevar:key=value', "SET 'key'", 'SET x y', 'SET; DROP TABLE t'])('does not classify SET assignment or malformed commands as introspection: %s', statement => {
    expect(isHiveReadOnlySet(statement)).toBe(false);
    expect(findPotentiallyMutatingConnectionStatements(config, statement).length).toBeGreaterThan(0);
  });
});
