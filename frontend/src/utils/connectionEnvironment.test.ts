import { describe, expect, it } from 'vitest';

import type { SavedConnection } from '../types';
import {
  getConnectionEnvironmentMeta,
  normalizeConnectionEnvironmentType,
  resolveConnectionEnvironmentPresentation,
  resolveConnectionEnvironmentType,
} from './connectionEnvironment';

const connection: SavedConnection = {
  id: 'conn-1',
  name: 'Orders',
  environmentType: 'development',
  config: {
    id: 'conn-1',
    type: 'mysql',
    host: 'db.local',
    port: 3306,
    user: 'root',
  },
};

describe('connectionEnvironment', () => {
  it('falls back to local for missing and unsupported persisted values', () => {
    expect(normalizeConnectionEnvironmentType(undefined)).toBe('local');
    expect(normalizeConnectionEnvironmentType('unknown')).toBe('local');
    expect(getConnectionEnvironmentMeta(undefined).color).toBe('#8c8c8c');
  });

  it('uses the connection environment', () => {
    expect(resolveConnectionEnvironmentType(connection)).toBe('development');
  });

  it('does not let group membership override the connection environment', () => {
    expect(resolveConnectionEnvironmentPresentation(
      connection,
      (key) => key,
    )).toEqual({
      type: 'development',
      color: '#1677ff',
      label: 'connection.environment.development',
    });
  });
});
