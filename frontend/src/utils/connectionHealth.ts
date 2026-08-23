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
const HEALTH_RECOMMENDATIONS = new Set([
  'adjust_visibility_or_permissions',
  'check_connection_settings',
  'enable_tls',
  'grant_metadata_read',
  'not_applicable',
  'not_available',
  'restore_connectivity_first',
  'review_driver_compatibility',
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

const sanitizeVersionDetail = (value: unknown): string => {
  const detail = asTrimmedString(value)
    .replace(/[\r\n]+/g, ' ')
    .slice(0, MAX_VERSION_DETAIL_LENGTH);
  // A health report must never become an alternate transport for opaque
  // connection material, even if an unexpected driver returns it as a version.
  return /(password|passwd|secret|token|apikey|api[_-]?key|dsn|jdbc:|mongodb:\/\/|redis:\/\/)/i.test(detail)
    ? ''
    : detail;
};

const sanitizeHealthRecommendation = (value: unknown): string => {
  const recommendation = asTrimmedString(value);
  return HEALTH_RECOMMENDATIONS.has(recommendation) ? recommendation : '';
};

const sanitizeHealthCheck = (value: unknown): ConnectionHealthCheck | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const key = asTrimmedString(raw.key);
  if (!key) return null;
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
    ...(asTrimmedString(raw.connectionType) ? { connectionType: asTrimmedString(raw.connectionType) } : {}),
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
