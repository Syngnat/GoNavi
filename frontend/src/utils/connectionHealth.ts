import type { ConnectionTag, SavedConnection } from '../types';

export type ConnectionHealthStatus = 'passed' | 'failed' | 'unsupported';

export type ConnectionHealthCheck = {
  key: string;
  status: ConnectionHealthStatus;
  durationMs?: number;
  detail?: string;
  recommendation?: string;
};

export type ConnectionHealthReport = {
  connectionId: string;
  connectionName?: string;
  connectionType?: string;
  overallStatus: ConnectionHealthStatus;
  durationMs: number;
  checks: ConnectionHealthCheck[];
};

export type ConnectionHealthGroup = {
  id: string;
  name: string;
  connectionIds: string[];
};

const HEALTH_REPORT_SCHEMA_VERSION = 1;
const MAX_VERSION_DETAIL_LENGTH = 256;
const HEALTH_VERSION_TOKEN_PATTERN = /^v?([0-9]+(?:\.[0-9]+){1,2})(?:[-+][a-z0-9][a-z0-9._-]*)?$/i;
const POSTGRES_HEALTH_VERSION_PATTERN = /^postgres(?:ql)?\s+([0-9]+(?:\.[0-9]+){1,5})/i;
const SQL_SERVER_HEALTH_VERSION_PATTERN = /^microsoft\s+sql\s+server[\s\S]*?\b([0-9]+(?:\.[0-9]+){2,3})\b/i;
const ORACLE_HEALTH_VERSION_PATTERN = /^oracle\s+database[\s\S]*?\brelease\s+([0-9]+(?:\.[0-9]+){1,5})\b/i;
const PRODUCT_HEALTH_VERSION_PATTERN = /^(?:mysql|mariadb|clickhouse|tidb|starrocks|oceanbase|duckdb|sqlite)[^0-9]*([0-9]+(?:\.[0-9]+){1,3})/i;
const HEALTH_RECOMMENDATIONS = new Set([
  'adjust_visibility_or_permissions',
  'check_connection_settings',
  'connection_configuration_invalid',
  'driver_unavailable',
  'enable_tls',
  'grant_metadata_read',
  'not_applicable',
  'not_available',
  'restore_connectivity_first',
  'review_driver_compatibility',
]);
const HEALTH_CHECK_KEYS = new Set([
  'driver',
  'ping',
  'version',
  'tls',
  'permissions',
  'schema_visibility',
  'pagination',
  'response',
]);

const asTrimmedString = (value: unknown): string => (
  typeof value === 'string' ? value.trim() : ''
);

const normalizeStatus = (value: unknown): ConnectionHealthStatus => {
  switch (value) {
    case 'passed':
    case 'failed':
    case 'unsupported':
      return value;
    default:
      return 'failed';
  }
};

const normalizeDuration = (value: unknown): number => {
  const duration = Number(value);
  return Number.isFinite(duration) && duration >= 0 ? Math.round(duration) : 0;
};

const isIPv4Literal = (value: string): boolean => {
  const octets = value.split('.');
  return octets.length === 4 && octets.every((octet) => {
    if (!/^\d{1,3}$/.test(octet)) return false;
    const number = Number(octet);
    return number >= 0 && number <= 255;
  });
};

const sanitizeVersionDetail = (value: unknown): string => {
  const detail = asTrimmedString(value)
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .slice(0, MAX_VERSION_DETAIL_LENGTH);
  if (!detail) return '';

  const canonicalVersion = (version: string, prefix = '') => {
    const token = version.trim();
    if (
      !token
      || token.includes('://')
      || isIPv4Literal(token)
      || /\b(?:password|passwd|secret|token|apikey|dsn)\b/i.test(token)
    ) return '';
    return `${prefix}${token}`;
  };
  const postgres = detail.match(POSTGRES_HEALTH_VERSION_PATTERN);
  if (postgres) return canonicalVersion(postgres[1], 'PostgreSQL ');
  const sqlServer = detail.match(SQL_SERVER_HEALTH_VERSION_PATTERN);
  if (sqlServer) return canonicalVersion(sqlServer[1], 'Microsoft SQL Server ');
  const oracle = detail.match(ORACLE_HEALTH_VERSION_PATTERN);
  if (oracle) return canonicalVersion(oracle[1], 'Oracle Database ');
  const product = detail.match(PRODUCT_HEALTH_VERSION_PATTERN);
  if (product) return canonicalVersion(product[1]);
  const token = detail.match(HEALTH_VERSION_TOKEN_PATTERN);
  return token ? canonicalVersion(token[1]) : '';
};

const sanitizeHealthRecommendation = (value: unknown): string => {
  const recommendation = asTrimmedString(value);
  return HEALTH_RECOMMENDATIONS.has(recommendation) ? recommendation : '';
};

const sanitizeConnectionType = (value: unknown): string => {
  const type = asTrimmedString(value).toLowerCase();
  return /^[a-z][a-z0-9_-]{0,63}$/.test(type) ? type : '';
};

const sanitizeHealthCheck = (value: unknown): ConnectionHealthCheck | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const key = asTrimmedString(raw.key);
  if (!HEALTH_CHECK_KEYS.has(key)) return null;
  const recommendation = sanitizeHealthRecommendation(raw.recommendation);
  return {
    key,
    status: normalizeStatus(raw.status),
    durationMs: normalizeDuration(raw.durationMs),
    ...(sanitizeVersionDetail(raw.detail) ? { detail: sanitizeVersionDetail(raw.detail) } : {}),
    ...(recommendation ? { recommendation } : {}),
  };
};

export const normalizeConnectionHealthReport = (value: unknown): ConnectionHealthReport | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const connectionId = asTrimmedString(raw.connectionId);
  if (!connectionId) return null;
  const checks = Array.isArray(raw.checks)
    ? raw.checks.map(sanitizeHealthCheck).filter((check): check is ConnectionHealthCheck => check !== null)
    : [];
  return {
    connectionId,
    ...(asTrimmedString(raw.connectionName) ? { connectionName: asTrimmedString(raw.connectionName) } : {}),
    ...(sanitizeConnectionType(raw.connectionType) ? { connectionType: sanitizeConnectionType(raw.connectionType) } : {}),
    overallStatus: normalizeStatus(raw.overallStatus),
    durationMs: normalizeDuration(raw.durationMs),
    checks,
  };
};

export const normalizeConnectionHealthReports = (value: unknown): ConnectionHealthReport[] => (
  Array.isArray(value)
    ? value.map(normalizeConnectionHealthReport).filter((report): report is ConnectionHealthReport => report !== null)
    : []
);

/**
 * Resolves direct and nested sidebar tags to a deduplicated connection list.
 * Groups remain a frontend concern; the backend receives only saved IDs.
 */
export const getConnectionHealthGroupConnectionIds = (
  tags: ConnectionTag[],
  groupId: string,
  connections: SavedConnection[],
): string[] => {
  const validConnectionIDs = new Set(connections.map((connection) => connection.id));
  const childrenByParent = new Map<string, ConnectionTag[]>();
  tags.forEach((tag) => {
    const parent = String(tag.parentTagId || '').trim();
    if (!parent) return;
    const children = childrenByParent.get(parent) || [];
    children.push(tag);
    childrenByParent.set(parent, children);
  });
  const tagsByID = new Map(tags.map((tag) => [tag.id, tag]));
  const visited = new Set<string>();
  const connectionIDs = new Set<string>();
  const visit = (id: string) => {
    if (visited.has(id)) return;
    visited.add(id);
    const tag = tagsByID.get(id);
    if (!tag) return;
    tag.connectionIds.forEach((connectionID) => {
      if (validConnectionIDs.has(connectionID)) connectionIDs.add(connectionID);
    });
    (childrenByParent.get(id) || []).forEach((child) => visit(child.id));
  };
  visit(String(groupId || '').trim());
  return Array.from(connectionIDs);
};

export const buildConnectionHealthGroups = (
  tags: ConnectionTag[],
  connections: SavedConnection[],
): ConnectionHealthGroup[] => tags
  .map((tag) => ({
    id: tag.id,
    name: tag.name,
    connectionIds: getConnectionHealthGroupConnectionIds(tags, tag.id, connections),
  }))
  .filter((group) => group.connectionIds.length > 0);

/**
 * Export only the health findings needed for support. Connection config,
 * endpoints, credentials, metadata rows, internal IDs, and user-supplied
 * connection names are intentionally omitted from the serialized payload.
 */
export const serializeConnectionHealthReportExport = (
  reports: ConnectionHealthReport[],
  generatedAt = new Date().toISOString(),
): string => JSON.stringify({
  schemaVersion: HEALTH_REPORT_SCHEMA_VERSION,
  generatedAt,
  reports: reports.map((report) => ({
    connectionType: report.connectionType || '',
    overallStatus: report.overallStatus,
    durationMs: normalizeDuration(report.durationMs),
    checks: report.checks.map((check) => ({
      key: check.key,
      status: normalizeStatus(check.status),
      durationMs: normalizeDuration(check.durationMs),
      ...(sanitizeVersionDetail(check.detail) ? { detail: sanitizeVersionDetail(check.detail) } : {}),
      ...(sanitizeHealthRecommendation(check.recommendation) ? { recommendation: sanitizeHealthRecommendation(check.recommendation) } : {}),
    })),
  })),
}, null, 2);
