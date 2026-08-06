import type { SavedConnection } from '../../types';

const normalizeLimit = (input: unknown, fallback: number, max: number): number => {
  const value = Math.floor(Number(input) || fallback);
  if (value < 1) return 1;
  if (value > max) return max;
  return value;
};

const normalizeKeyword = (input: unknown): string => String(input || '').trim().toLowerCase();

const matchesKeyword = (keyword: string, fields: Array<string | undefined>): boolean => {
  if (!keyword) {
    return true;
  }
  return fields.some((field) => String(field || '').toLowerCase().includes(keyword));
};

const normalizeTypeFilter = (input: unknown): string =>
  String(input || '').trim().toLowerCase();

export const buildSavedConnectionsSnapshot = (params: {
  connections: SavedConnection[];
  keyword?: unknown;
  type?: unknown;
  limit?: unknown;
}) => {
  const {
    connections,
    keyword,
    type,
    limit,
  } = params;
  const safeKeyword = normalizeKeyword(keyword);
  const safeType = normalizeTypeFilter(type);
  const safeLimit = normalizeLimit(limit, 20, 100);

  const filteredConnections = connections.filter((connection) => {
    const config = connection.config || {};
    const connectionType = String(config.type || '').trim().toLowerCase();
    if (safeType && connectionType !== safeType) {
      return false;
    }
    return matchesKeyword(safeKeyword, [
      connection.id,
      connection.name,
      config.type,
      config.host,
      config.database,
      config.user,
      config.driver,
      config.topology,
      config.ssh?.host,
      config.proxy?.host,
      config.httpTunnel?.host,
    ]);
  });

  const visibleConnections = filteredConnections
    .slice(0, safeLimit)
    .map((connection) => {
      const config = connection.config || {};
      const includeDatabases = Array.isArray(connection.includeDatabases)
        ? connection.includeDatabases.filter(Boolean)
        : [];
      const includeDatabasePatterns = Array.isArray(connection.includeDatabasePatterns)
        ? connection.includeDatabasePatterns.filter((item) => typeof item === 'string' && item.trim())
        : [];
      const excludeDatabasePatterns = Array.isArray(connection.excludeDatabasePatterns)
        ? connection.excludeDatabasePatterns.filter((item) => typeof item === 'string' && item.trim())
        : [];
      const includeRedisDatabases = Array.isArray(connection.includeRedisDatabases)
        ? connection.includeRedisDatabases.filter((item) => typeof item === 'number')
        : [];

      return {
        id: connection.id,
        name: connection.name,
        type: config.type || '',
        host: config.host || '',
        port: typeof config.port === 'number' ? config.port : null,
        user: config.user || '',
        configuredDatabase: config.database || '',
        driver: config.driver || '',
        topology: config.topology || 'single',
        useSSL: config.useSSL === true,
        useSSH: config.useSSH === true,
        sshHost: config.useSSH ? (config.ssh?.host || '') : '',
        sshPort: config.useSSH && typeof config.ssh?.port === 'number' ? config.ssh.port : null,
        useProxy: config.useProxy === true,
        proxyType: config.useProxy ? (config.proxy?.type || '') : '',
        proxyHost: config.useProxy ? (config.proxy?.host || '') : '',
        proxyPort: config.useProxy && typeof config.proxy?.port === 'number' ? config.proxy.port : null,
        useHttpTunnel: config.useHttpTunnel === true,
        httpTunnelHost: config.useHttpTunnel ? (config.httpTunnel?.host || '') : '',
        httpTunnelPort: config.useHttpTunnel && typeof config.httpTunnel?.port === 'number' ? config.httpTunnel.port : null,
        hasOpaqueURI: connection.hasOpaqueURI === true,
        hasOpaqueDSN: connection.hasOpaqueDSN === true,
        hasConnectionParams: Boolean(String(config.connectionParams || '').trim()),
        includeDatabaseCount: includeDatabases.length,
        includeDatabasePatternCount: includeDatabasePatterns.length,
        excludeDatabasePatternCount: excludeDatabasePatterns.length,
        databaseVisibilityRestricted: includeDatabases.length > 0
          || includeDatabasePatterns.length > 0
          || excludeDatabasePatterns.length > 0,
        includeRedisDatabaseCount: includeRedisDatabases.length,
      };
    });

  const typeBreakdown = filteredConnections.reduce<Record<string, number>>((acc, connection) => {
    const key = String(connection.config?.type || 'unknown').trim() || 'unknown';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});

  return {
    keyword: safeKeyword,
    type: safeType,
    limit: safeLimit,
    totalMatched: filteredConnections.length,
    returnedConnections: visibleConnections.length,
    truncated: filteredConnections.length > visibleConnections.length,
    sshEnabledCount: filteredConnections.filter((item) => item.config?.useSSH === true).length,
    proxyEnabledCount: filteredConnections.filter((item) => item.config?.useProxy === true).length,
    httpTunnelEnabledCount: filteredConnections.filter((item) => item.config?.useHttpTunnel === true).length,
    typeBreakdown,
    connections: visibleConnections,
  };
};
