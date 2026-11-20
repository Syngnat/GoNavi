export type QueryResultTabRetention = 'history' | 'latest';

export const DEFAULT_QUERY_RESULT_TAB_RETENTION: QueryResultTabRetention = 'latest';

export const sanitizeQueryResultTabRetention = (
  value: unknown,
): QueryResultTabRetention => (
  value === 'history' ? 'history' : DEFAULT_QUERY_RESULT_TAB_RETENTION
);

export const isQueryResultTabRetention = (
  value: unknown,
): value is QueryResultTabRetention => value === 'history' || value === 'latest';

export const shouldReplaceQueryResultTabs = (
  value: unknown,
): boolean => sanitizeQueryResultTabRetention(value) === 'latest';

export const isQueryResultTabProtected = (result: {
  pinned?: boolean;
  hasPendingChanges?: boolean;
}): boolean => result.pinned === true || result.hasPendingChanges === true;
