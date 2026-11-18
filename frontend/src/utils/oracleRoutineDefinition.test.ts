import { describe, expect, it } from 'vitest';

import { buildOracleRoutineDefinitionQuery } from './oracleRoutineDefinition';

describe('buildOracleRoutineDefinitionQuery', () => {
  it('keeps Oracle routine source filtering by the reported object type', () => {
    expect(
      buildOracleRoutineDefinitionQuery(
        'oracle',
        'APP',
        'P_REBUILD',
        'PROCEDURE',
      ),
    ).toBe(
      "SELECT TEXT FROM ALL_SOURCE WHERE OWNER = 'APP' AND NAME = 'P_REBUILD' AND TYPE = 'PROCEDURE' ORDER BY LINE",
    );
  });

  it('reads Dameng procedures from the PROC source type', () => {
    const sql = buildOracleRoutineDefinitionQuery(
      'dm',
      'WLJY_WJDP',
      'P_DP_JY_DEAL',
      'PROCEDURE',
    );

    expect(sql).toContain("OWNER = 'WLJY_WJDP'");
    expect(sql).toContain("NAME = 'P_DP_JY_DEAL'");
    expect(sql).toContain("UPPER(TYPE) IN ('PROC', 'PROCEDURE', 'FUNCTION')");
    expect(sql).not.toContain("TYPE = 'PROCEDURE'");
    expect(sql).toContain('ORDER BY LINE');
  });

  it('uses USER_SOURCE for an unqualified Dameng routine', () => {
    expect(
      buildOracleRoutineDefinitionQuery('dameng', '', 'F_CALC', 'FUNCTION'),
    ).toBe(
      "SELECT TEXT FROM USER_SOURCE WHERE NAME = 'F_CALC' AND UPPER(TYPE) IN ('PROC', 'PROCEDURE', 'FUNCTION') ORDER BY LINE",
    );
  });

  it('escapes quoted identifiers in owner and routine names', () => {
    const sql = buildOracleRoutineDefinitionQuery(
      'dm',
      "APP'OWNER",
      "P'ROC",
      'PROCEDURE',
    );

    expect(sql).toContain("OWNER = 'APP''OWNER'");
    expect(sql).toContain("NAME = 'P''ROC'");
  });
});
