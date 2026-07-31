import { describe, expect, it } from 'vitest';

import type { SavedConnection } from '../../types';
import { catalogs } from '../../i18n/catalog';
import { buildRedisTopologySnapshot } from './aiRedisTopologyInsights';

const REDIS_TOPOLOGY_I18N_KEYS = [
  'ai_chat.inspection.redis_topology.label.single',
  'ai_chat.inspection.redis_topology.label.cluster',
  'ai_chat.inspection.redis_topology.label.sentinel',
  'ai_chat.inspection.redis_topology.warning.missing_host',
  'ai_chat.inspection.redis_topology.warning.ssh_unsupported',
  'ai_chat.inspection.redis_topology.warning.missing_sentinel_master',
  'ai_chat.inspection.redis_topology.warning.single_sentinel_node',
  'ai_chat.inspection.redis_topology.warning.sentinel_default_redis_port',
  'ai_chat.inspection.redis_topology.warning.cluster_single_seed',
  'ai_chat.inspection.redis_topology.warning.cluster_logical_db',
  'ai_chat.inspection.redis_topology.warning.cluster_sentinel_fields_ignored',
  'ai_chat.inspection.redis_topology.warning.single_multiple_nodes',
  'ai_chat.inspection.redis_topology.warning.single_sentinel_fields_ignored',
  'ai_chat.inspection.redis_topology.db_note.cluster_logical_namespace',
  'ai_chat.inspection.redis_topology.db_note.sentinel_selected_db',
  'ai_chat.inspection.redis_topology.db_note.single_selected_db',
  'ai_chat.inspection.redis_topology.next_action.fill_host',
  'ai_chat.inspection.redis_topology.next_action.fill_sentinel_master',
  'ai_chat.inspection.redis_topology.next_action.disable_ssh',
  'ai_chat.inspection.redis_topology.next_action.check_sentinel_port',
  'ai_chat.inspection.redis_topology.next_action.review_cluster_logical_db',
  'ai_chat.inspection.redis_topology.next_action.align_single_topology',
  'ai_chat.inspection.redis_topology.next_action.test_connection',
  'ai_chat.inspection.redis_topology.recommendation.sentinel_addresses',
  'ai_chat.inspection.redis_topology.recommendation.separate_auth',
  'ai_chat.inspection.redis_topology.recommendation.cluster_multiple_seeds',
  'ai_chat.inspection.redis_topology.recommendation.cluster_namespace',
  'ai_chat.inspection.redis_topology.recommendation.single_one_address',
  'ai_chat.inspection.redis_topology.recommendation.network_for_cluster_sentinel',
  'ai_chat.inspection.redis_topology.recommendation.check_tls',
] as const;

const translateWithKeyEcho = (key: string, params?: Record<string, unknown>) =>
  `T:${key}${params ? `:${JSON.stringify(params)}` : ''}`;

const buildRedisConnection = (
  id: string,
  name: string,
  config: Partial<SavedConnection['config']>,
  extra: Partial<SavedConnection> = {},
): SavedConnection => ({
  id,
  name,
  config: {
    type: 'redis',
    host: '127.0.0.1',
    port: 6379,
    user: '',
    ...config,
  },
  ...extra,
});

describe('buildRedisTopologySnapshot', () => {
  it('summarizes Redis Sentinel settings without exposing passwords', () => {
    const snapshot = buildRedisTopologySnapshot({
      connections: [
        buildRedisConnection('redis-sentinel', 'Production Redis Sentinel', {
          host: 'sentinel-a.local',
          port: 6379,
          hosts: ['sentinel-b.local:26379'],
          topology: 'sentinel',
          user: 'app',
          password: 'redis-secret',
          redisSentinelUser: 'sentinel-user',
          redisSentinelPassword: 'sentinel-secret',
          redisDB: 2,
          useSSL: true,
          sslMode: 'required',
        }, {
          hasRedisSentinelPassword: true,
        }),
      ],
      keyword: 'production',
    });

    expect(snapshot.totalRedisConnections).toBe(1);
    expect(snapshot.totalMatched).toBe(1);
    expect(snapshot.topologyBreakdown).toEqual({ sentinel: 1 });
    expect(snapshot.blockedCount).toBe(1);
    expect(snapshot.connections[0].status).toBe('blocked');
    expect(snapshot.connections[0].backendAdapter).toBe('go-redis FailoverClient');
    expect(snapshot.connections[0].effectiveTopology).toBe('sentinel');
    expect(snapshot.connections[0].topologyMismatch).toBe(false);
    expect(snapshot.connections[0].sentinelMaster).toBe('');
    expect(snapshot.connections[0].hasRedisAuth).toBe(true);
    expect(snapshot.connections[0].hasSentinelAuth).toBe(true);
    expect(snapshot.connections[0].safeUriExample).toContain('rediss://app:<hidden>@sentinel-a.local:6379,sentinel-b.local:26379/2');
    expect(snapshot.connections[0].safeUriExample).toContain('topology=sentinel');
    expect(snapshot.connections[0].safeUriExample).toContain('sentinel_user=sentinel-user');
    expect(snapshot.connections[0].safeUriExample).toContain('sentinel_password=%3Chidden%3E');
    expect(snapshot.connections[0].dbSemantics).toMatchObject({
      physicalDb: 2,
      mode: 'failover_selected_db',
    });
    expect(snapshot.connections[0].warnings.length).toBeGreaterThan(0);
    expect(snapshot.connections[0].warnings.join('\n')).toContain('Sentinel');
    expect(snapshot.connections[0].warnings.join('\n')).toContain('go-redis FailoverClient');
    expect(snapshot.connections[0].warnings.join('\n')).toContain('26379');
    expect(snapshot.connections[0].blockingReasons.length).toBeGreaterThan(0);
    expect(snapshot.connections[0].blockingReasons.join('\n')).toContain('go-redis FailoverClient');
    expect(snapshot.connections[0].nextActions.join('\n')).toContain('Sentinel');
    expect(JSON.stringify(snapshot)).not.toContain('redis-secret');
    expect(JSON.stringify(snapshot)).not.toContain('sentinel-secret');
  });

  it('reports cluster logical-db and SSH risks', () => {
    const snapshot = buildRedisTopologySnapshot({
      connections: [
        buildRedisConnection('redis-cluster', 'Orders Redis Cluster', {
          host: '10.10.1.10',
          port: 6379,
          hosts: ['10.10.1.11:6379', '10.10.1.12:6379'],
          topology: 'cluster',
          redisDB: 4,
          useSSH: true,
        }, {
          includeRedisDatabases: [0, 4],
        }),
      ],
      connectionId: 'redis-cluster',
    });

    expect(snapshot.connections[0].topology).toBe('cluster');
    expect(snapshot.connections[0].effectiveTopology).toBe('cluster');
    expect(snapshot.connections[0].topologyMismatch).toBe(false);
    expect(snapshot.connections[0].status).toBe('blocked');
    expect(snapshot.connections[0].backendAdapter).toBe('go-redis ClusterClient');
    expect(snapshot.connections[0].seedAddressCount).toBe(3);
    expect(snapshot.connections[0].safeUriExample).toBe('redis://10.10.1.10:6379,10.10.1.11:6379,10.10.1.12:6379/0?topology=cluster');
    expect(snapshot.connections[0].dbSemantics).toMatchObject({
      physicalDb: 0,
      selectedDb: 4,
      mode: 'cluster_logical_namespace',
    });
    expect(snapshot.connections[0].warnings.join('\n')).toContain('Redis Cluster');
    expect(snapshot.connections[0].warnings.join('\n')).toContain('SSH');
    expect(snapshot.connections[0].warnings.join('\n')).toContain('__gonavi_db_N__');
    expect(snapshot.connections[0].nextActions.join('\n')).toContain('SSH');
    expect(snapshot.connections[0].recommendations?.join('\n')).toContain('Redis Cluster');
  });

  it('filters out non-Redis connections and warns about multi-host single mode', () => {
    const snapshot = buildRedisTopologySnapshot({
      connections: [
        buildRedisConnection('redis-single', 'Cache Standalone', {
          host: 'redis.local',
          port: 6379,
          topology: 'single',
          hosts: ['redis-2.local:6379'],
        }),
        {
          id: 'mysql-1',
          name: 'Business Database',
          config: {
            type: 'mysql',
            host: 'mysql.local',
            port: 3306,
            user: 'root',
          },
        },
      ],
    });

    expect(snapshot.totalRedisConnections).toBe(1);
    expect(snapshot.connections).toHaveLength(1);
    expect(snapshot.connections[0].status).toBe('needs_attention');
    expect(snapshot.connections[0].topology).toBe('single');
    expect(snapshot.connections[0].effectiveTopology).toBe('cluster');
    expect(snapshot.connections[0].topologyMismatch).toBe(true);
    expect(snapshot.connections[0].backendAdapter).toBe('go-redis ClusterClient');
    expect(snapshot.connections[0].safeUriExample).toBe('redis://redis.local:6379,redis-2.local:6379/0?topology=cluster');
    expect(snapshot.connections[0].dbSemantics).toMatchObject({
      physicalDb: 0,
      mode: 'cluster_logical_namespace',
    });
    expect(snapshot.connections[0].warnings.join('\n')).toContain('Cluster');
    expect(snapshot.connections[0].nextActions.join('\n')).toContain('Cluster');
  });

  it('localizes controlled Redis topology diagnostics while preserving raw Redis values', () => {
    const snapshot = buildRedisTopologySnapshot({
      connections: [
        buildRedisConnection('redis-cluster', 'Orders Redis Cluster', {
          host: '10.10.1.10',
          port: 6379,
          hosts: ['10.10.1.11:6379'],
          topology: 'cluster',
          redisDB: 3,
          useSSH: true,
          useSSL: true,
        }, {
          includeRedisDatabases: [0, 3],
        }),
      ],
      connectionId: 'redis-cluster',
      translate: translateWithKeyEcho,
    });

    const connection = snapshot.connections[0];
    expect(connection.topologyLabel).toBe('T:ai_chat.inspection.redis_topology.label.cluster');
    expect(connection.effectiveTopologyLabel).toBe('T:ai_chat.inspection.redis_topology.label.cluster');
    expect(connection.warnings).toContain('T:ai_chat.inspection.redis_topology.warning.ssh_unsupported:{"topologyLabel":"T:ai_chat.inspection.redis_topology.label.cluster"}');
    expect(connection.warnings).toContain('T:ai_chat.inspection.redis_topology.warning.cluster_logical_db');
    expect(connection.blockingReasons).toContain('T:ai_chat.inspection.redis_topology.warning.ssh_unsupported:{"topologyLabel":"T:ai_chat.inspection.redis_topology.label.cluster"}');
    expect(connection.dbSemantics.note).toBe('T:ai_chat.inspection.redis_topology.db_note.cluster_logical_namespace');
    expect(connection.nextActions).toContain('T:ai_chat.inspection.redis_topology.next_action.disable_ssh');
    expect(connection.recommendations).toContain('T:ai_chat.inspection.redis_topology.recommendation.check_tls');
    expect(connection.safeUriExample).toBe('rediss://10.10.1.10:6379,10.10.1.11:6379/0?topology=cluster&skip_verify=true');
    expect(JSON.stringify(connection)).toContain('Redis Cluster');
    expect(JSON.stringify(connection)).toContain('go-redis ClusterClient');
  });

  it('keeps Redis topology snapshot copy behind six-language catalog keys', () => {
    for (const [language, catalog] of Object.entries(catalogs)) {
      const missing = REDIS_TOPOLOGY_I18N_KEYS.filter((key) => !(key in catalog));
      expect(missing, language).toEqual([]);
    }
  });
});
