import { describe, expect, it } from 'vitest';

import {
  buildSavedConnectionInput,
  createEmptyConnectionSecretClearState,
} from './connectionModalConfig';

const config = {
  id: 'conn-visibility',
  type: 'mysql',
  host: 'db.local',
  port: 3306,
  user: 'root',
};

describe('connection modal database visibility persistence', () => {
  it('keeps legacy exact names separate from wildcard include and exclude masks', () => {
    const result = buildSavedConnectionInput({
      config,
      values: {
        type: 'mysql',
        name: 'Filtered',
        includeDatabases: ['app_db'],
        includeDatabasePatterns: ['tenant_%', 'reporting*'],
        excludeDatabasePatterns: ['tenant_archive_%'],
      },
      clearSecrets: createEmptyConnectionSecretClearState(),
    });

    expect(result.includeDatabases).toEqual(['app_db']);
    expect(result.includeDatabasePatterns).toEqual(['tenant_%', 'reporting*']);
    expect(result.excludeDatabasePatterns).toEqual(['tenant_archive_%']);
  });
});
