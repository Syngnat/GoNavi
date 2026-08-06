import { describe, expect, it } from 'vitest';

import { t } from '../i18n';
import { duplicateBrowserMockConnection } from './browserMockConnections';

describe('duplicateBrowserMockConnection', () => {
  it('rewrites config.id to match the duplicated top-level id', () => {
    const duplicated = duplicateBrowserMockConnection({
      existing: {
        id: 'conn-1',
        name: 'Primary',
        config: {
          id: 'conn-1',
          type: 'postgres',
        },
        includeDatabases: ['appdb'],
        includeDatabasePatterns: ['tenant_%'],
        excludeDatabasePatterns: ['tenant_archive_%'],
        schemaVisibilityByDatabase: {
          appdb: { mode: 'include', schemas: ['public'] },
        },
      },
      items: [],
      nextId: 'conn-2',
    });

    expect(duplicated.id).toBe('conn-2');
    expect(duplicated.config.id).toBe('conn-2');
    expect(duplicated.name).toBe(`Primary${t('connection.copy_suffix')}`);
    expect(duplicated.includeDatabases).toEqual(['appdb']);
    expect(duplicated.includeDatabasePatterns).toEqual(['tenant_%']);
    expect(duplicated.excludeDatabasePatterns).toEqual(['tenant_archive_%']);
    expect(duplicated.schemaVisibilityByDatabase).toEqual({
      appdb: { mode: 'include', schemas: ['public'] },
    });
  });
});
