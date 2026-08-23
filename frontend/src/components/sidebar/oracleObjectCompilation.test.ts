import { describe, expect, it } from 'vitest';

import {
  buildOracleObjectCompileSQL,
  normalizeOracleObjectCompileStatus,
} from './oracleObjectCompilation';

describe('Oracle object compilation helpers', () => {
  it('normalizes only Oracle compiler states that can be presented in the sidebar', () => {
    expect(normalizeOracleObjectCompileStatus(' valid ')).toBe('VALID');
    expect(normalizeOracleObjectCompileStatus('INVALID')).toBe('INVALID');
    expect(normalizeOracleObjectCompileStatus('ENABLED')).toBe('');
  });

  it('builds schema-qualified and safely quoted compile statements', () => {
    expect(buildOracleObjectCompileSQL({
      kind: 'routine',
      objectName: 'APP."refresh.daily"',
      routineType: 'PROCEDURE',
    })).toBe('ALTER PROCEDURE "APP"."refresh.daily" COMPILE');

    expect(buildOracleObjectCompileSQL({
      kind: 'trigger',
      objectName: 'TRG_AUDIT',
      schemaName: 'APP',
    })).toBe('ALTER TRIGGER "APP"."TRG_AUDIT" COMPILE');
  });

  it('refuses unsupported routine kinds and malformed object references', () => {
    expect(buildOracleObjectCompileSQL({
      kind: 'routine',
      objectName: 'APP.P_REBUILD',
      routineType: 'PACKAGE',
    })).toBe('');
    expect(buildOracleObjectCompileSQL({
      kind: 'trigger',
      objectName: 'A.B.C',
    })).toBe('');
  });
});
