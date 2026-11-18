import { describe, expect, it } from 'vitest';

import { buildTableOverviewHoverModel } from './tableOverviewMetadata';

describe('table overview hover metadata', () => {
  it('matches the sidebar card fields for table overview rows', () => {
    const model = buildTableOverviewHoverModel({
      table: {
        name: 'users',
        comment: '账号表',
        rows: 1532,
        dataSize: 2048,
        indexSize: 1024,
        engine: 'InnoDB',
        charset: 'utf8mb4',
        collation: 'utf8mb4_0900_ai_ci',
        createTime: '2026-05-29 11:57:12',
        updateTime: '2026-11-17 14:59:52',
      },
      displayName: 'users',
      connectionName: '开发 240',
      hostSummary: '192.168.1.240:3306',
      dbName: 'front_end_sys_dev',
    });

    expect(model.title).toBe('users');
    expect(model.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'connection', value: '开发 240' }),
      expect.objectContaining({ key: 'host', value: '192.168.1.240:3306' }),
      expect.objectContaining({ key: 'database', value: 'front_end_sys_dev' }),
      expect.objectContaining({ key: 'rows', value: '1.5K' }),
      expect.objectContaining({ key: 'charset', value: 'utf8mb4' }),
      expect.objectContaining({ key: 'collation', value: 'utf8mb4_0900_ai_ci' }),
    ]));
  });
});
