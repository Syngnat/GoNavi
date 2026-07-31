import { describe, expect, it, vi } from 'vitest';

import { setCurrentLanguage } from '../i18n';
import type { SavedQuery, SavedQueryGroup } from '../types';
import { LEGACY_PERSIST_KEY } from './legacyConnectionStorage';
import {
  bootstrapSavedQueries,
  readLegacySavedQueriesFromPayload,
  saveSavedQueryGroupToBackend,
  saveSavedQueryToBackend,
  stripLegacySavedQueries,
} from './savedQueryPersistence';

const createMemoryStorage = () => {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
  };
};

describe('saved query persistence', () => {
  it('imports legacy localStorage queries into backend and clears the legacy field', async () => {
    const storage = createMemoryStorage();
    storage.setItem(LEGACY_PERSIST_KEY, JSON.stringify({
      state: {
        connections: [
          {
            id: 'conn-1',
            name: 'Primary',
            config: {
              id: 'conn-1',
              type: 'postgres',
              host: 'db.local',
              port: 5432,
              user: 'app',
              password: 'secret',
            },
          },
        ],
        theme: 'dark',
        savedQueries: [
          {
            id: 'saved-1',
            name: 'Orders',
            sql: '  select * from orders;\n',
            connectionId: 'conn-1',
            dbName: 'app',
            createdAt: 100,
          },
        ],
      },
      version: 10,
    }));

    let backendQueries: SavedQuery[] = [];
    const ImportSavedQueries = vi.fn(async (payload: { queries: SavedQuery[] }) => {
      backendQueries = payload.queries;
      return backendQueries;
    });
    const GetSavedQueries = vi.fn(async () => backendQueries);
    const replaceSavedQueries = vi.fn();

    const result = await bootstrapSavedQueries({
      storage,
      replaceSavedQueries,
      backend: {
        ImportSavedQueries,
        GetSavedQueries,
      },
    });

    expect(result).toEqual({ importedLegacyCount: 1, loadedCount: 1 });
    expect(ImportSavedQueries).toHaveBeenCalledWith(expect.objectContaining({
      queries: [
        expect.objectContaining({
          id: 'saved-1',
          sql: '  select * from orders;\n',
        }),
      ],
      legacyConnections: [
        expect.objectContaining({
          id: 'conn-1',
          config: expect.objectContaining({
            host: 'db.local',
          }),
        }),
      ],
    }));
    expect(replaceSavedQueries).toHaveBeenCalledWith([
      expect.objectContaining({
        id: 'saved-1',
        sql: '  select * from orders;\n',
      }),
    ]);

    const cleanedPayload = JSON.parse(storage.getItem(LEGACY_PERSIST_KEY) || '{}');
    expect(cleanedPayload.state.theme).toBe('dark');
    expect(cleanedPayload.state.savedQueries).toBeUndefined();
  });

  it('reads and strips legacy saved queries without altering other persisted state', () => {
    const payload = JSON.stringify({
      state: {
        savedQueries: [
          {
            id: 'saved-1',
            name: 'Analytics',
            sql: '\nselect 1;',
            connectionId: 'conn-1',
            dbName: 'warehouse',
            createdAt: 200,
          },
          {
            id: 'invalid',
            name: 'Missing context',
            sql: 'select 2;',
          },
        ],
        sidebarWidth: 320,
      },
    });

    expect(readLegacySavedQueriesFromPayload(payload)).toEqual([
      expect.objectContaining({
        id: 'saved-1',
        sql: '\nselect 1;',
      }),
    ]);

    const stripped = JSON.parse(stripLegacySavedQueries(payload));
    expect(stripped.state.savedQueries).toBeUndefined();
    expect(stripped.state.sidebarWidth).toBe(320);
  });

  it('localizes generated legacy saved query names', () => {
    setCurrentLanguage('en-US');
    const payload = JSON.stringify({
      state: {
        savedQueries: [
          {
            id: 'saved-generated-name',
            sql: 'select 1;',
            connectionId: 'conn-1',
            dbName: 'warehouse',
            createdAt: 200,
          },
        ],
      },
    });

    expect(readLegacySavedQueriesFromPayload(payload)).toEqual([
      expect.objectContaining({
        id: 'saved-generated-name',
        name: 'Query 1',
      }),
    ]);
  });

  it('localizes missing context errors when saving a query', async () => {
    setCurrentLanguage('en-US');

    await expect(saveSavedQueryToBackend(undefined, {
      id: 'missing-context',
      name: 'Missing context',
      sql: '',
      connectionId: '',
      dbName: '',
      createdAt: 100,
    })).rejects.toThrow('Saved query is missing SQL, connection, or database context');
  });

  it('preserves child-group ordering returned after saving a parent group', async () => {
    const savedGroup: SavedQueryGroup = {
      id: 'parent',
      name: 'Parent',
      parentGroupId: '',
      queryIds: ['query-1'],
      childOrder: ['group:child', 'query:query-1'],
    };
    const SaveSavedQueryGroup = vi.fn(async () => savedGroup);

    await expect(saveSavedQueryGroupToBackend(
      { SaveSavedQueryGroup },
      savedGroup,
    )).resolves.toEqual(savedGroup);
    expect(SaveSavedQueryGroup).toHaveBeenCalledWith(savedGroup);
  });
});
