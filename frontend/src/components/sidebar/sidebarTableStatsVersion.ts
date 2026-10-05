import { needsServerVersionForTableStats } from '../../utils/dataSourceRegistry/tableStats';
import { ensureDatabaseServerVersion, peekDatabaseServerVersion } from '../queryEditor/queryEditorServerVersion';

type VersionedConnection = { id?: string; config?: { type?: string } & Record<string, any> } | null | undefined;

/** 表统计按服务端版本区分的数据源（TimescaleDB、QuestDB）先取版本（按连接缓存）；其余类型不发请求。 */
export const ensureTableStatsServerVersion = async (connection: VersionedConnection): Promise<string> =>
  needsServerVersionForTableStats(connection?.config?.type) ? ensureDatabaseServerVersion(connection as any) : '';

/** 同步读取已缓存的服务端版本（右键统计等同步拼 SQL 的入口用）；未缓存时为空，回落到 PostgreSQL 默认表达式。 */
export const peekTableStatsServerVersion = (connection: VersionedConnection): string =>
  needsServerVersionForTableStats(connection?.config?.type) ? peekDatabaseServerVersion(connection?.id) : '';
