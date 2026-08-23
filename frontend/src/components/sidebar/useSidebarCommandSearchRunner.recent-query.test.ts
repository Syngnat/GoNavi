import { describe, expect, it } from 'vitest';

import { resolveRecentQueryConnectionId } from './useSidebarCommandSearchRunner';

const QUERY_CAPABLE = new Set(['mysql-1', 'mqtt-1']);

describe('resolveRecentQueryConnectionId', () => {
  it('does not inherit a Nacos/JVM active context or tab when opening recent SQL', () => {
    expect(resolveRecentQueryConnectionId({
      activeContextConnectionId: 'nacos-1',
      activeTabConnectionId: 'nacos-1',
      queryCapableConnectionIds: QUERY_CAPABLE,
    })).toBe('');
    expect(resolveRecentQueryConnectionId({
      activeContextConnectionId: 'jvm-1',
      queryCapableConnectionIds: QUERY_CAPABLE,
    })).toBe('');
  });

  it('prefers the recent SQL item connection, then the active context, then the active tab', () => {
    expect(resolveRecentQueryConnectionId({
      itemConnectionId: 'mysql-1',
      activeContextConnectionId: 'mqtt-1',
      queryCapableConnectionIds: QUERY_CAPABLE,
    })).toBe('mysql-1');
    expect(resolveRecentQueryConnectionId({
      activeContextConnectionId: 'mqtt-1',
      activeTabConnectionId: 'mysql-1',
      queryCapableConnectionIds: QUERY_CAPABLE,
    })).toBe('mqtt-1');
    expect(resolveRecentQueryConnectionId({
      activeTabConnectionId: 'mysql-1',
      queryCapableConnectionIds: QUERY_CAPABLE,
    })).toBe('mysql-1');
  });

  it('skips unsupported candidates in the priority chain and keeps the first supported one', () => {
    expect(resolveRecentQueryConnectionId({
      itemConnectionId: 'nacos-1',
      activeContextConnectionId: 'mysql-1',
      activeTabConnectionId: 'mqtt-1',
      queryCapableConnectionIds: QUERY_CAPABLE,
    })).toBe('mysql-1');
    expect(resolveRecentQueryConnectionId({
      itemConnectionId: 'nacos-1',
      activeContextConnectionId: 'jvm-1',
      activeTabConnectionId: 'mqtt-1',
      queryCapableConnectionIds: QUERY_CAPABLE,
    })).toBe('mqtt-1');
  });

  it('returns an empty connection id when every candidate is unsupported or missing', () => {
    expect(resolveRecentQueryConnectionId({
      itemConnectionId: 'nacos-1',
      activeContextConnectionId: '',
      activeTabConnectionId: 'redis-1',
      queryCapableConnectionIds: QUERY_CAPABLE,
    })).toBe('');
    expect(resolveRecentQueryConnectionId({
      queryCapableConnectionIds: QUERY_CAPABLE,
    })).toBe('');
  });
});
