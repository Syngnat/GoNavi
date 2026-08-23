import { beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveResultDiffColumnMeta } from './columnMeta';
import type { ResultDiffComparableResult } from './types';

const backendApp = vi.hoisted(() => ({
  DBGetColumns: vi.fn(),
}));

vi.mock('../../../wailsjs/go/app/App', () => backendApp);

const result = (
  key: string,
  connectionParams: string,
): ResultDiffComparableResult => ({
  key,
  label: key,
  sql: 'SELECT * FROM users',
  columns: ['id'],
  rows: [{ id: 1 }],
  executionConnectionId: 'conn-1',
  executionDbName: 'app',
  executionConnectionParams: connectionParams,
  metadataDbName: 'app',
  metadataTableName: 'users',
});

describe('resolveResultDiffColumnMeta execution context', () => {
  beforeEach(() => {
    backendApp.DBGetColumns.mockReset().mockResolvedValue({ success: true, data: [] });
  });

  it('loads the same table once per schema execution context', async () => {
    const left = result('sales', 'search_path=sales%2Cpublic');
    const right = result('public', 'search_path=public');

    await resolveResultDiffColumnMeta({
      connectionConfig: { connectionParams: 'search_path=wrong' },
      database: 'app',
      left,
      right,
      resolveExecutionConnectionConfig: (item) => ({
        connectionParams: item.executionConnectionParams,
      }),
    });

    expect(backendApp.DBGetColumns).toHaveBeenCalledTimes(2);
    expect(backendApp.DBGetColumns.mock.calls.map((call) => call[0]?.connectionParams)).toEqual([
      'search_path=sales%2Cpublic',
      'search_path=public',
    ]);
  });
});
