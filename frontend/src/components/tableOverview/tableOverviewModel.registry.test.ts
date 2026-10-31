import { describe, expect, it } from 'vitest';

import { resolveSqlDialect } from '../../utils/sqlDialectCore';
import { getMetadataDialect, parseTableStats, usesTableListOverview } from './tableOverviewModel';

describe('table overview for command-language registry types', () => {
  it('lists tables through DBGetTables instead of information_schema', () => {
    for (const type of ['zookeeper', 'etcd', 'weaviate', 'influxdb']) {
      expect(usesTableListOverview(resolveSqlDialect(type), type), type).toBe(true);
    }
    // 声明了表状态查询或借用 SQL 方言的描述表类型继续走 SQL。
    for (const type of ['questdb', 'tidb', 'cockroachdb', 'timescaledb']) {
      expect(usesTableListOverview(resolveSqlDialect(type), type), type).toBe(false);
    }
    expect(usesTableListOverview('sqlite', 'sqlite')).toBe(true);
    expect(usesTableListOverview('mysql', 'mysql')).toBe(false);
  });

  it('uses the table list for MongoDB, which has no information_schema', () => {
    expect(usesTableListOverview('mongodb', 'mongodb')).toBe(true);
  });

  it('uses the table list for Hive, which has no information_schema', () => {
    expect(usesTableListOverview('hive', 'hive')).toBe(true);
    expect(parseTableStats('hive', [{ Table: 'probe_m1' }])).toMatchObject([{ name: 'probe_m1' }]);
  });

  it('uses the table list for vector, time-series and search engines without information_schema', () => {
    // chroma / qdrant / iotdb 没有描述文件；elasticsearch 与 opensearch 的元数据方言都归一为
    // elasticsearch，五个连接类型因此共用同一条表名列表路径。这里走 getMetadataDialect 而不是
    // 直接传方言，保证归一链路本身也在覆盖范围内。
    for (const type of ['chroma', 'qdrant', 'iotdb', 'elasticsearch', 'opensearch']) {
      const dialect = getMetadataDialect(type);
      expect(usesTableListOverview(dialect, type), `${type} -> ${dialect}`).toBe(true);
    }
  });

  it('uses the table list for message queues and Redis, whose drivers reject SQL metadata queries', () => {
    // 这些驱动的「表」是 topic / queue / key：Kafka 只认 SHOW TOPICS 一类语句，Redis 把 SQL 当命令执行，
    // information_schema 查询必然失败，表概览必须走 DBGetTables。
    for (const type of ['kafka', 'pulsar', 'rocketmq', 'mqtt', 'rabbitmq', 'redis']) {
      const dialect = getMetadataDialect(type);
      expect(usesTableListOverview(dialect, type), `${type} -> ${dialect}`).toBe(true);
    }
  });
});
