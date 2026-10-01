import { buildSqlPreviewText } from '../../utils/sqlPreviewText';
import type { SQLAuditEvent, SQLAuditSummary } from '../audit/sqlAuditModel';

export type QueryHistoryStatus = 'success' | 'error' | 'cancelled';
export type QueryHistoryStatusFilter = '' | QueryHistoryStatus;

export interface QueryHistoryStatusCounts {
  all: number;
  success: number;
  error: number;
  cancelled: number;
}

export type QueryHistoryDurationLevel = 'normal' | 'slow' | 'critical';

export type QueryHistoryRowMetric = { kind: 'returned' | 'affected'; count: number };

export interface QueryHistoryDayGroup {
  dayKey: string;
  /** 当日 00:00（本地时间）的时间戳，用于格式化分组标题 */
  dayStart: number;
  items: SQLAuditEvent[];
}

const SLOW_DURATION_MS = 1_000;
const CRITICAL_DURATION_MS = 5_000;
const SQL_PREVIEW_MAX_CHARS = 900;

export const QUERY_HISTORY_STATUS_FILTERS: readonly QueryHistoryStatus[] = ['success', 'error', 'cancelled'];

/** 后端汇总只统计成功/错误，取消数由总数推得；三种状态之外的事件不存在于执行历史。 */
export const deriveQueryHistoryStatusCounts = (
  summary: Pick<SQLAuditSummary, 'totalEvents' | 'successCount' | 'errorCount'>,
): QueryHistoryStatusCounts => ({
  all: summary.totalEvents,
  success: summary.successCount,
  error: summary.errorCount,
  cancelled: Math.max(0, summary.totalEvents - summary.successCount - summary.errorCount),
});

export const resolveQueryHistoryDurationLevel = (durationMs: number): QueryHistoryDurationLevel => {
  if (durationMs >= CRITICAL_DURATION_MS) return 'critical';
  if (durationMs >= SLOW_DURATION_MS) return 'slow';
  return 'normal';
};

/** 毫秒 → 紧凑耗时文本；单位缩写与语言无关。 */
export const formatQueryHistoryDuration = (durationMs: number): string => {
  const ms = Math.max(0, Math.round(durationMs));
  if (ms < SLOW_DURATION_MS) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes} m ${seconds} s`;
};

export const resolveQueryHistoryRowMetric = (
  event: Pick<SQLAuditEvent, 'rowsAffected' | 'rowsReturned'>,
): QueryHistoryRowMetric | null => {
  const { rowsReturned, rowsAffected } = event;
  if (rowsReturned !== undefined && (rowsReturned > 0 || !(rowsAffected && rowsAffected > 0))) {
    return { kind: 'returned', count: rowsReturned };
  }
  if (rowsAffected !== undefined) return { kind: 'affected', count: rowsAffected };
  return null;
};

export const buildQueryHistorySqlPreview = (sqlText: string): string => buildSqlPreviewText(sqlText, SQL_PREVIEW_MAX_CHARS);

const pad2 = (value: number): string => String(value).padStart(2, '0');

const toDayStart = (timestamp: number): Date => {
  const date = new Date(timestamp);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
};

export const getQueryHistoryDayKey = (timestamp: number): string => {
  const day = toDayStart(timestamp);
  return `${day.getFullYear()}-${pad2(day.getMonth() + 1)}-${pad2(day.getDate())}`;
};

/** 按本地日期分组，保持输入顺序（后端已按时间倒序）。 */
export const groupQueryHistoryByDay = (items: SQLAuditEvent[]): QueryHistoryDayGroup[] => {
  const groups: QueryHistoryDayGroup[] = [];
  items.forEach((item) => {
    const dayKey = getQueryHistoryDayKey(item.timestamp);
    const last = groups[groups.length - 1];
    if (last && last.dayKey === dayKey) {
      last.items.push(item);
      return;
    }
    groups.push({ dayKey, dayStart: toDayStart(item.timestamp).getTime(), items: [item] });
  });
  return groups;
};

/** 与当前时间相差的自然日数（今天=0，昨天=1）。 */
export const getQueryHistoryDayOffset = (dayStart: number, now = Date.now()): number => (
  Math.round((toDayStart(now).getTime() - dayStart) / 86_400_000)
);

export const isQueryHistoryStatus = (value: string): value is QueryHistoryStatus => (
  (QUERY_HISTORY_STATUS_FILTERS as readonly string[]).includes(value)
);
