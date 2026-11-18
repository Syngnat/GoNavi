import { describe, expect, it } from 'vitest';

import type { TabData } from '../types';
import { resolveDefinitionViewerObjectMeta } from './definitionViewerObjectMeta';

describe('database definition viewer metadata', () => {
  it('labels the database and uses its name for the definition header', () => {
    const tab = {
      id: 'database-def-conn-1-tenant',
      title: 'Database definition: tenant',
      type: 'database-def',
      connectionId: 'conn-1',
      dbName: 'tenant',
    } as TabData;

    expect(resolveDefinitionViewerObjectMeta(tab, (key) => key)).toEqual({
      label: 'definition_viewer.object.database',
      name: 'tenant',
      loadingTip: 'definition_viewer.loading.database_definition',
    });
  });
});
