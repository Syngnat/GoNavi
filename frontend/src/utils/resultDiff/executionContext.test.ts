import { describe, expect, it } from 'vitest';

import type { ResultDiffComparableResult } from './types';
import { canReplayResultDiffSqlInOneContext } from './executionContext';

const result = (overrides: Partial<ResultDiffComparableResult> = {}): ResultDiffComparableResult => ({
  key: 'result',
  label: 'Result',
  sql: 'SELECT * FROM users',
  columns: ['id'],
  rows: [{ id: 1 }],
  executionConnectionId: 'conn-1',
  executionDbName: 'app',
  executionConnectionParams: 'search_path=sales%2Cpublic',
  ...overrides,
});

describe('result diff execution context', () => {
  it('allows SQL replay only when connection database and params all match', () => {
    expect(canReplayResultDiffSqlInOneContext(result(), result({ key: 'other' }))).toBe(true);
    expect(canReplayResultDiffSqlInOneContext(
      result(),
      result({ executionConnectionId: 'conn-2' }),
    )).toBe(false);
    expect(canReplayResultDiffSqlInOneContext(
      result(),
      result({ executionDbName: 'archive' }),
    )).toBe(false);
    expect(canReplayResultDiffSqlInOneContext(
      result(),
      result({ executionConnectionParams: 'search_path=public' }),
    )).toBe(false);
  });

  it('keeps legacy results comparable with the shared fallback database', () => {
    expect(canReplayResultDiffSqlInOneContext(
      result({ executionConnectionId: undefined, executionDbName: undefined, executionConnectionParams: undefined }),
      result({ executionConnectionId: undefined, executionDbName: undefined, executionConnectionParams: undefined }),
      'app',
    )).toBe(true);
  });
});
