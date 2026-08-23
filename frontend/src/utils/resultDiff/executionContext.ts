import type { ResultDiffComparableResult } from './types';

const normalize = (value: unknown): string => String(value ?? '').trim();

export const buildResultDiffExecutionContextKey = (
  result: ResultDiffComparableResult | null | undefined,
  fallbackDatabase = '',
): string => JSON.stringify([
  normalize(result?.executionConnectionId),
  normalize(result?.executionDbName) || normalize(fallbackDatabase),
  String(result?.executionConnectionParams ?? ''),
]);

export const canReplayResultDiffSqlInOneContext = (
  left: ResultDiffComparableResult | null | undefined,
  right: ResultDiffComparableResult | null | undefined,
  fallbackDatabase = '',
): boolean => Boolean(left && right)
  && buildResultDiffExecutionContextKey(left, fallbackDatabase)
    === buildResultDiffExecutionContextKey(right, fallbackDatabase);
