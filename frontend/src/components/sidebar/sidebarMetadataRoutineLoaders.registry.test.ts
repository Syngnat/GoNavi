import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../wailsjs/go/app/App', () => ({
  DBQuery: vi.fn(),
}));

import { DBQuery } from '../../../wailsjs/go/app/App';
import { loadFunctions } from './sidebarMetadataRoutineLoaders';
import { buildFunctionsMetadataQuerySpecs } from './sidebarMetadataQuerySpecs';

const mockedDBQuery = vi.mocked(DBQuery);

beforeEach(() => {
  mockedDBQuery.mockReset();
  mockedDBQuery.mockResolvedValue({
    success: true,
    message: '',
    data: [{ schema_name: 'public', routine_name: 'gonavi_user_fn', routine_type: 'FUNCTION' }],
  } as never);
});

describe('routine metadata for registry data sources', () => {
  it('appends the extension-member filter before ORDER BY only when asked', () => {
    expect(buildFunctionsMetadataQuerySpecs('postgres', 'tsdb').some((spec) => spec.sql.includes('pg_depend'))).toBe(false);
    const filtered = buildFunctionsMetadataQuerySpecs('postgres', 'tsdb', { excludeExtensionMembers: true });
    expect(filtered).toHaveLength(3);
    for (const spec of filtered) {
      const filter = spec.sql.indexOf("deptype = 'e'");
      expect(filter).toBeGreaterThan(0);
      expect(filter).toBeLessThan(spec.sql.indexOf('ORDER BY'));
    }
  });

  it('hides TimescaleDB extension functions but keeps them for PostgreSQL', async () => {
    const timescale = await loadFunctions({ config: { type: 'timescaledb' } }, 'tsdb');
    expect(timescale.routines.map((routine) => routine.routineName)).toEqual(['public.gonavi_user_fn']);
    expect(String(mockedDBQuery.mock.calls[0]?.[2])).toContain("deptype = 'e'");

    mockedDBQuery.mockClear();
    await loadFunctions({ config: { type: 'postgres' } }, 'app');
    expect(String(mockedDBQuery.mock.calls[0]?.[2])).not.toContain('pg_depend');
  });
});
