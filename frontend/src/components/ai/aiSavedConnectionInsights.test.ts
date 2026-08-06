import { describe, expect, it } from 'vitest';
import type { SavedConnection } from '../../types';
import { buildSavedConnectionsSnapshot } from './aiSavedConnectionInsights';

describe('buildSavedConnectionsSnapshot database visibility', () => {
  it('reports wildcard-only visibility rules as an active restriction', () => {
    const connection = {
      id: 'conn-1',
      name: 'Tenant databases',
      config: { type: 'mysql' },
      includeDatabasePatterns: ['tenant_%', '  '],
      excludeDatabasePatterns: ['*_archive'],
    } as SavedConnection;

    const snapshot = buildSavedConnectionsSnapshot({ connections: [connection] });

    expect(snapshot.connections).toEqual([
      expect.objectContaining({
        includeDatabaseCount: 0,
        includeDatabasePatternCount: 1,
        excludeDatabasePatternCount: 1,
        databaseVisibilityRestricted: true,
      }),
    ]);
  });

  it('reports an unrestricted connection when no database rules are configured', () => {
    const connection = {
      id: 'conn-2',
      name: 'All databases',
      config: { type: 'postgresql' },
    } as SavedConnection;

    const snapshot = buildSavedConnectionsSnapshot({ connections: [connection] });

    expect(snapshot.connections[0]).toEqual(expect.objectContaining({
      includeDatabaseCount: 0,
      includeDatabasePatternCount: 0,
      excludeDatabasePatternCount: 0,
      databaseVisibilityRestricted: false,
    }));
  });
});
