import { describe, expect, it } from 'vitest';

import { resolveSqlDialect } from '../../utils/sqlDialectCore';
import { usesTableListOverview } from './tableOverviewModel';

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
});
