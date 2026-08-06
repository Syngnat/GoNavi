import { beforeEach, describe, expect, it, vi } from 'vitest';

const { dbGetColumnsMock } = vi.hoisted(() => ({
  dbGetColumnsMock: vi.fn(),
}));

vi.mock('../../wailsjs/go/app/App', () => ({
  DBGetColumns: dbGetColumnsMock,
}));

import {
  buildTableSelectQuery,
  extractTableSelectColumnNames,
  isElasticsearchDbType,
  resolveTableSelectQuery,
} from './objectQueryTemplates';

describe('buildTableSelectQuery', () => {
  it('quotes uppercase postgres table names in new query templates', () => {
    expect(buildTableSelectQuery('postgres', 'public.MyTable')).toBe('SELECT * FROM public."MyTable";');
  });

  it('expands provided columns into a multi-line select list', () => {
    expect(buildTableSelectQuery('mysql', 'users', ['id', 'name', 'created_at'])).toBe(
      'SELECT\n  `id`,\n  `name`,\n  `created_at`\nFROM `users`;',
    );
  });

  it('quotes reserved and uppercase column names for postgres', () => {
    expect(buildTableSelectQuery('postgres', 'public.orders', ['user', 'OrderID'])).toBe(
      'SELECT\n  "user",\n  "OrderID"\nFROM public.orders;',
    );
  });

  it('adds a preview limit for RocketMQ topic browsing', () => {
    expect(buildTableSelectQuery('rocketmq', 'orders.events')).toBe('SELECT * FROM "orders.events" LIMIT 100;');
  });

  it('adds a preview limit for Kafka topic browsing', () => {
    expect(buildTableSelectQuery('kafka', 'logs.app-1')).toBe('SELECT * FROM "logs.app-1" LIMIT 100;');
  });

  it('adds a preview limit for MQTT topic browsing', () => {
    expect(buildTableSelectQuery('mqtt', 'devices/+/telemetry')).toBe('SELECT * FROM "devices/+/telemetry" LIMIT 100;');
  });

  it('adds a preview limit for RabbitMQ queue browsing', () => {
    expect(buildTableSelectQuery('rabbitmq', 'orders.events.v1')).toBe('SELECT * FROM "orders.events.v1" LIMIT 100;');
  });

  it('builds an Elasticsearch match_all request for an index', () => {
    expect(buildTableSelectQuery('elasticsearch', 'orders-v1')).toBe(
      'GET /orders-v1/_search\n{\n  "query": {\n    "match_all": {}\n  }\n}\n',
    );
    expect(isElasticsearchDbType('elasticsearch')).toBe(true);
    expect(isElasticsearchDbType('elastic')).toBe(true);
  });
});

describe('extractTableSelectColumnNames', () => {
  it('reads mixed-case column name fields and keeps order without duplicates', () => {
    expect(extractTableSelectColumnNames([
      { Name: 'id' },
      { name: 'name' },
      { COLUMN_NAME: 'name' },
      { field: 'created_at' },
      {},
    ])).toEqual(['id', 'name', 'created_at']);
  });
});

describe('resolveTableSelectQuery', () => {
  beforeEach(() => {
    dbGetColumnsMock.mockReset();
  });

  it('loads columns and expands them into the select list', async () => {
    dbGetColumnsMock.mockResolvedValueOnce({
      success: true,
      data: [
        { name: 'id' },
        { name: 'email' },
      ],
    });

    await expect(resolveTableSelectQuery({
      dbType: 'mysql',
      tableName: 'users',
      dbName: 'app',
      connectionConfig: { type: 'mysql', host: 'localhost' },
    })).resolves.toBe('SELECT\n  `id`,\n  `email`\nFROM `users`;');

    expect(dbGetColumnsMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to select star when column metadata is unavailable', async () => {
    dbGetColumnsMock.mockResolvedValueOnce({
      success: false,
      message: 'unavailable',
      data: null,
    });

    await expect(resolveTableSelectQuery({
      dbType: 'postgres',
      tableName: 'public.users',
      dbName: 'app',
      connectionConfig: { type: 'postgres', host: 'localhost' },
    })).resolves.toBe('SELECT * FROM public.users;');
  });

  it('keeps message-queue templates on select star without loading columns', async () => {
    await expect(resolveTableSelectQuery({
      dbType: 'kafka',
      tableName: 'logs.app-1',
      connectionConfig: { type: 'kafka' },
    })).resolves.toBe('SELECT * FROM "logs.app-1" LIMIT 100;');

    expect(dbGetColumnsMock).not.toHaveBeenCalled();
  });

  it('opens an Elasticsearch index with a match_all request without loading SQL columns', async () => {
    await expect(resolveTableSelectQuery({
      dbType: 'elasticsearch',
      tableName: 'orders-v1',
      connectionConfig: { type: 'elasticsearch' },
    })).resolves.toBe('GET /orders-v1/_search\n{\n  "query": {\n    "match_all": {}\n  }\n}\n');

    expect(dbGetColumnsMock).not.toHaveBeenCalled();
  });
});
