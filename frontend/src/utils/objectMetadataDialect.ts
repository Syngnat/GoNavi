import { getDataSourceSpec } from './dataSourceRegistry';
import { normalizeOceanBaseProtocol } from './oceanBaseProtocol';

// 对象概览与定义查看器拼元数据查询用的方言：自定义连接按驱动名归类，MySQL / Oracle 兼容库归到 mysql / oracle；
// 描述表数据源按借用方言或兼容家族查（TiDB、GreptimeDB → mysql，CockroachDB、TimescaleDB → postgres），否则用自身方言。
export const resolveObjectMetadataDialect = (connType: string, driver?: string, oceanBaseProtocol?: unknown): string => {
  const type = String(connType || '').trim().toLowerCase();
  if (type === 'custom') {
    const name = String(driver || '').trim().toLowerCase();
    if (name === 'diros' || name === 'doris') return 'mysql';
    if (name === 'goldendb' || name === 'greatdb' || name === 'gdb') return 'mysql';
    if (name === 'oceanbase') return normalizeOceanBaseProtocol(oceanBaseProtocol) === 'oracle' ? 'oracle' : 'mysql';
    if (name === 'opengauss' || name === 'open_gauss' || name === 'open-gauss') return 'opengauss';
    if (name === 'gaussdb' || name === 'gauss_db' || name === 'gauss-db') return 'gaussdb';
    return name;
  }
  if (type === 'oceanbase' && normalizeOceanBaseProtocol(oceanBaseProtocol) === 'oracle') return 'oracle';
  if (type === 'goldendb' || type === 'mariadb' || type === 'oceanbase' || type === 'diros' || type === 'sphinx') return 'mysql';
  if (type === 'dameng') return 'dm';
  const spec = getDataSourceSpec(type);
  if (spec) return spec.ddlDialect || spec.family || spec.dialect;
  return type;
};
