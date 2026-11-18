import { describe, expect, it } from 'vitest';

import { t } from '../../i18n';
import { buildSidebarEntityHoverModel } from './sidebarEntityHoverModel';

const connection = {
  id: 'conn-1',
  name: '开发 240',
  config: {
    type: 'mysql',
    host: '192.168.1.240',
    port: 3306,
    database: 'mkefu_prod1',
  },
};

describe('sidebar entity hover metadata', () => {
  it('describes a connection with its loaded database and table counts', () => {
    const model = buildSidebarEntityHoverModel({
      type: 'connection',
      title: '开发 240',
      dataRef: connection,
      children: [
        {
          type: 'database',
          dataRef: { ...connection, dbName: 'front_end_sys_dev' },
          children: [
            {
              type: 'object-group',
              dataRef: { groupKey: 'tables' },
              children: [
                { type: 'table', dataRef: { ...connection, dbName: 'front_end_sys_dev', tableName: 'users' } },
                { type: 'table', dataRef: { ...connection, dbName: 'front_end_sys_dev', tableName: 'orders' } },
              ],
            },
          ],
        },
        {
          type: 'database',
          dataRef: { ...connection, dbName: 'front_end_sys' },
        },
      ],
    }, '开发 240', 'success');

    expect(model).not.toBeNull();
    expect(model?.dataKind).toBe('connection');
    expect(model?.title).toBe('开发 240');
    expect(model?.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'driver', value: 'mysql' }),
      expect.objectContaining({ key: 'databaseCount', value: '2' }),
      expect.objectContaining({ key: 'tableCount', value: '2' }),
      expect.objectContaining({ key: 'status', value: t('common.success') }),
    ]));
  });

  it('describes a database with the connection, host, and loaded table count', () => {
    const model = buildSidebarEntityHoverModel({
      type: 'database',
      title: 'front_end_sys_dev',
      dataRef: { ...connection, dbName: 'front_end_sys_dev' },
      children: [{
        type: 'object-group',
        dataRef: { groupKey: 'tables' },
        children: [
          { type: 'table', dataRef: { ...connection, dbName: 'front_end_sys_dev', tableName: 'users' } },
        ],
      }],
    }, 'front_end_sys_dev');

    expect(model?.dataKind).toBe('database');
    expect(model?.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'connection', value: '开发 240' }),
      expect.objectContaining({ key: 'host', value: expect.stringContaining('192.168.1.240') }),
      expect.objectContaining({ key: 'tableCount', value: '1' }),
    ]));
  });

  it('keeps the table metadata fields used by the sidebar card', () => {
    const model = buildSidebarEntityHoverModel({
      type: 'table',
      title: 'users',
      dataRef: {
        ...connection,
        dbName: 'front_end_sys_dev',
        tableName: 'users',
        tableComment: '账号',
        rowCount: 1532,
        tableSize: 2048,
        createdAt: '2026-05-29 11:57:12',
        updatedAt: '2026-11-17 14:59:52',
      },
    }, 'users');

    expect(model?.dataKind).toBe('table');
    expect(model?.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'comment', value: '账号' }),
      expect.objectContaining({ key: 'rows', value: '1.5K' }),
      expect.objectContaining({ key: 'size', value: '2 KB' }),
    ]));
  });
});
