import { describe, expect, it } from 'vitest';

import { buildPgRoutineDefinitionQuery } from './pgRoutineDefinition';

describe('buildPgRoutineDefinitionQuery', () => {
  it('reads the definition field of the record returned by openGauss-kernel servers', () => {
    for (const dialect of ['opengauss', 'gaussdb']) {
      expect(buildPgRoutineDefinitionQuery(dialect, 'public', 'add_one')).toBe(
        "SELECT (pg_get_functiondef(p.oid)).definition AS routine_definition FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid WHERE n.nspname = 'public' AND p.proname = 'add_one' LIMIT 1",
      );
    }
  });

  it('keeps the plain text function for PostgreSQL and other compatible servers', () => {
    for (const dialect of ['postgres', 'kingbase', 'highgo', 'vastbase']) {
      expect(buildPgRoutineDefinitionQuery(dialect, 'sales', "o''brien")).toBe(
        "SELECT pg_get_functiondef(p.oid) AS routine_definition FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid WHERE n.nspname = 'sales' AND p.proname = 'o''brien' LIMIT 1",
      );
    }
  });
});
