import { beforeEach, describe, expect, it, vi } from 'vitest';

const dbQuery = vi.hoisted(() => vi.fn());

vi.mock('../../wailsjs/go/app/App', () => ({ DBQuery: dbQuery }));
vi.mock('./connectionRpcConfig', () => ({
  buildRpcConnectionConfig: (config: unknown) => config,
}));

import { fetchDatabaseDefinition } from './databaseDefinitionFetch';

describe('fetchDatabaseDefinition', () => {
  beforeEach(() => {
    dbQuery.mockReset();
  });

  it('returns the explicit MySQL CREATE DATABASE generated from schema metadata', async () => {
    dbQuery.mockResolvedValueOnce({
      success: true,
      data: [{
        database_name: 'front_end_sys_dev',
        database_charset: 'utf8mb4',
        database_collation: 'utf8mb4_0900_ai_ci',
      }],
    });

    await expect(fetchDatabaseDefinition(
      { type: 'mysql' },
      'mysql',
      'front_end_sys_dev',
    )).resolves.toEqual({
      success: true,
      definition: [
        'CREATE DATABASE `front_end_sys_dev`',
        '  DEFAULT CHARACTER SET utf8mb4',
        '  COLLATE utf8mb4_0900_ai_ci;',
      ].join('\n'),
    });
  });

  it('falls back to SHOW CREATE DATABASE when metadata is empty', async () => {
    dbQuery
      .mockResolvedValueOnce({ success: true, data: [] })
      .mockResolvedValueOnce({
        success: true,
        data: [{ 'Create Database': 'CREATE DATABASE `tenant` DEFAULT CHARACTER SET utf8mb4' }],
      });

    const result = await fetchDatabaseDefinition({ type: 'mysql' }, 'mysql', 'tenant');
    expect(result.definition).toBe(
      'CREATE DATABASE `tenant` DEFAULT CHARACTER SET utf8mb4;',
    );
    expect(dbQuery).toHaveBeenCalledTimes(2);
  });

  it('supports TDengine and static IoTDB definitions', async () => {
    dbQuery.mockResolvedValueOnce({
      success: true,
      data: [{ 'Create Database': 'CREATE DATABASE `metrics` PRECISION ms' }],
    });
    await expect(fetchDatabaseDefinition({ type: 'tdengine' }, 'tdengine', 'metrics')).resolves.toEqual({
      success: true,
      definition: 'CREATE DATABASE `metrics` PRECISION ms;',
    });

    dbQuery.mockClear();
    await expect(fetchDatabaseDefinition({ type: 'iotdb' }, 'iotdb', 'root.smoke')).resolves.toEqual({
      success: true,
      definition: 'CREATE DATABASE root.smoke;',
    });
    expect(dbQuery).not.toHaveBeenCalled();
  });

  it('marks dialects without database DDL as unsupported', async () => {
    await expect(fetchDatabaseDefinition({ type: 'influxdb' }, 'influxdb', 'metrics')).resolves.toEqual({
      success: false,
      definition: '',
      unsupported: true,
    });
  });
});
