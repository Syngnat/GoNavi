import { describe, expect, it } from 'vitest';

import { normalizeRedisTopologyToken, supportsRedisSshTunnel } from './redisTopologySsh';

describe('supportsRedisSshTunnel', () => {
  it('keeps SSH available for standalone Redis topologies', () => {
    ['single', '', undefined, null, ' SINGLE '].forEach((topology) => {
      expect(supportsRedisSshTunnel(topology), JSON.stringify(topology)).toBe(true);
    });
  });

  it('rejects SSH for Cluster and Sentinel topologies regardless of casing', () => {
    ['cluster', 'Cluster', 'CLUSTER', 'sentinel', 'Sentinel', 'SENTINEL'].forEach((topology) => {
      expect(supportsRedisSshTunnel(topology), JSON.stringify(topology)).toBe(false);
    });
  });

  it('normalizes topology tokens consistently', () => {
    expect(normalizeRedisTopologyToken('  Cluster ')).toBe('cluster');
    expect(normalizeRedisTopologyToken(undefined)).toBe('');
  });
});
