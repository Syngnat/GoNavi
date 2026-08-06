import { describe, expect, it } from 'vitest';

import { t as catalogTranslate } from '../i18n/catalog';
import type { SavedConnection, TabData } from '../types';
import {
  applyTabDisplaySettingsPatch,
  buildTabDisplayModel,
  buildTabDisplayTitle,
  DEFAULT_TAB_DISPLAY_SETTINGS,
  getDefaultTabDisplaySnapshot,
  getTabDisplayKindLabel,
  resolveTabDisplayElementOrder,
  resolveConnectionHostSummary,
  sanitizeTabDisplaySettings,
  switchTabDisplayLayout,
  stripSchemaFromTabObjectLabel,
} from './tabDisplay';

const keyEchoTranslate = (key: string, params?: Record<string, unknown>): string => {
  if (key === 'sidebar.tab.new_query') return 'T(New query)';
  if (key === 'sidebar.tab.new_query_database') return `T(New query (${params?.database}))`;
  if (key === 'sidebar.tab.redis_command') return `T(Command ${params?.database})`;
  if (key === 'sidebar.tab.redis_monitor') return `T(Monitor ${params?.database})`;
  return key;
};

const redisConnection: SavedConnection = {
  id: 'redis-1',
  name: '订单缓存',
  config: {
    type: 'redis',
    host: '10.10.0.12',
    port: 6379,
    user: '',
    database: '',
    hosts: ['10.10.0.13:6379', '10.10.0.14:6379'],
  },
};

describe('tabDisplay', () => {
  it('uses the requested double-line tab display defaults', () => {
    expect(DEFAULT_TAB_DISPLAY_SETTINGS).toEqual({
      layout: 'double',
      primaryElements: ['object'],
      secondaryElements: ['kind', 'connection', 'database'],
    });
    expect(getDefaultTabDisplaySnapshot('single')).toEqual({
      primaryElements: ['connection', 'kind', 'object'],
      secondaryElements: [],
    });
    expect(getDefaultTabDisplaySnapshot('double')).toEqual({
      primaryElements: ['object'],
      secondaryElements: ['kind', 'connection', 'database'],
    });
  });

  it('builds compact host summary for multi-host redis connections', () => {
    expect(resolveConnectionHostSummary(redisConnection.config)).toBe('10.10.0.12 +2');
  });

  it('adds connection and host identity to redis key tabs', () => {
    const redisKeysTab: TabData = {
      id: 'redis-keys-redis-1-db0',
      title: 'db0',
      type: 'redis-keys',
      connectionId: 'redis-1',
      redisDB: 0,
    };

    expect(buildTabDisplayTitle(redisKeysTab, redisConnection)).toBe('[订单缓存 | 10.10.0.12 +2] db0');
  });

  it('normalizes redis command and monitor tabs to db-scoped labels', () => {
    const commandTab: TabData = {
      id: 'cmd-1',
      title: '命令 - db1',
      type: 'redis-command',
      connectionId: 'redis-1',
      redisDB: 1,
    };
    const monitorTab: TabData = {
      id: 'monitor-1',
      title: '监控: 订单缓存',
      type: 'redis-monitor',
      connectionId: 'redis-1',
      redisDB: 1,
    };

    expect(buildTabDisplayTitle(commandTab, redisConnection)).toBe('[订单缓存 | 10.10.0.12 +2] Command - db1');
    expect(buildTabDisplayTitle(monitorTab, redisConnection)).toBe('[订单缓存 | 10.10.0.12 +2] Monitor - db1');
  });

  it('localizes redis command and monitor fallback titles while keeping db labels raw', () => {
    const commandTab: TabData = {
      id: 'cmd-1',
      title: '命令 - db1',
      type: 'redis-command',
      connectionId: 'redis-1',
      redisDB: 1,
    };
    const monitorTab: TabData = {
      id: 'monitor-1',
      title: '监控: 订单缓存',
      type: 'redis-monitor',
      connectionId: 'redis-1',
      redisDB: 1,
    };

    expect(buildTabDisplayTitle(commandTab, redisConnection, undefined, keyEchoTranslate)).toBe('[订单缓存 | 10.10.0.12 +2] T(Command db1)');
    expect(buildTabDisplayTitle(monitorTab, redisConnection, undefined, keyEchoTranslate)).toBe('[订单缓存 | 10.10.0.12 +2] T(Monitor db1)');
  });

  it('keeps table tabs on the existing prefix strategy', () => {
    const tableTab: TabData = {
      id: 'table-1',
      title: 'orders',
      type: 'table',
      connectionId: 'redis-1',
      dbName: 'app',
      tableName: 'orders',
    };

    expect(buildTabDisplayTitle(tableTab, redisConnection)).toBe('[订单缓存] orders');
  });

  it('keeps table export tabs on the same connection prefix strategy', () => {
    const exportTab: TabData = {
      id: 'table-export-1',
      title: '导出 public.orders',
      type: 'table-export',
      connectionId: 'redis-1',
      dbName: 'app',
      tableName: 'public.orders',
    };

    expect(buildTabDisplayTitle(exportTab, redisConnection)).toBe('[订单缓存] 导出 orders');
  });

  it('keeps data import tabs on the same connection prefix strategy', () => {
    const importTab: TabData = {
      id: 'data-import-workbench',
      title: '导入 public.orders',
      type: 'data-import',
      connectionId: 'redis-1',
      dbName: 'app',
      tableName: 'public.orders',
    };

    expect(getTabDisplayKindLabel(importTab)).toBe('IMPORT');
    expect(buildTabDisplayTitle(importTab, redisConnection)).toBe('[订单缓存] 导入 orders');
  });

  it('hides schema prefixes from schema-qualified table tab labels', () => {
    const connection: SavedConnection = {
      id: 'kingbase-1',
      name: 'Kingbase DEV',
      config: {
        type: 'kingbase',
        host: '127.0.0.1',
        port: 54321,
        user: 'SYSTEM',
        database: 'appdb',
      },
    };
    const tableTab: TabData = {
      id: 'kingbase-1-appdb-table-ldf_server.andon_events',
      title: 'ldf_server.andon_events',
      type: 'table',
      connectionId: 'kingbase-1',
      dbName: 'appdb',
      tableName: 'ldf_server.andon_events',
    };

    expect(buildTabDisplayTitle(tableTab, connection)).toBe('[DEV] andon_events');
  });

  it('hides schema prefixes from design and definition tab labels', () => {
    const designTab: TabData = {
      id: 'design-1',
      title: '表结构 (public.orders)',
      type: 'design',
      connectionId: 'pg-1',
      dbName: 'app',
      tableName: 'public.orders',
      readOnly: true,
    };
    const viewTab: TabData = {
      id: 'view-1',
      title: '视图: reporting.active_users',
      type: 'view-def',
      connectionId: 'pg-1',
      dbName: 'app',
      viewName: 'reporting.active_users',
    };
    const triggerTab: TabData = {
      id: 'trigger-1',
      title: '触发器: audit.users_bi',
      type: 'trigger',
      connectionId: 'pg-1',
      dbName: 'app',
      triggerName: 'audit.users_bi',
    };
    const routineTab: TabData = {
      id: 'routine-1',
      title: '存储过程: reporting.refresh_stats',
      type: 'routine-def',
      connectionId: 'pg-1',
      dbName: 'app',
      routineName: 'reporting.refresh_stats',
      routineType: 'PROCEDURE',
    };

    expect(buildTabDisplayTitle(designTab)).toBe('表结构 (orders)');
    expect(buildTabDisplayTitle(viewTab)).toBe('视图: active_users');
    expect(buildTabDisplayTitle(triggerTab)).toBe('触发器: users_bi');
    expect(buildTabDisplayTitle(routineTab)).toBe('存储过程: refresh_stats');
  });

  it('keeps quoted dots inside object names when hiding schema prefixes', () => {
    expect(stripSchemaFromTabObjectLabel('"sales.schema"."order.items"')).toBe('order.items');
    expect(stripSchemaFromTabObjectLabel('\\"ldf_server\\".\\"andon_events\\"')).toBe('andon_events');
    expect(stripSchemaFromTabObjectLabel('[dbo].[order.items]')).toBe('order.items');
  });

  it('builds configurable single-line tab labels from ordered elements', () => {
    const connection: SavedConnection = {
      id: 'kingbase-1',
      name: 'Kingbase DEV',
      config: {
        type: 'kingbase',
        host: '192.168.10.8',
        port: 54321,
        user: 'SYSTEM',
        database: 'appdb',
      },
    };
    const tableTab: TabData = {
      id: 'kingbase-1-appdb-table-ldf_server.andon_events',
      title: 'ldf_server.andon_events',
      type: 'table',
      connectionId: 'kingbase-1',
      dbName: 'appdb',
      tableName: 'ldf_server.andon_events',
    };

    expect(buildTabDisplayTitle(tableTab, connection, {
      layout: 'single',
      primaryElements: ['object', 'schema', 'host'],
      secondaryElements: [],
    })).toBe('andon_events SCHEMA:ldf_server 192.168.10.8');
  });

  it('builds the default configurable model with the object on the primary line', () => {
    const connection: SavedConnection = {
      id: 'kingbase-1',
      name: 'Kingbase DEV',
      config: {
        type: 'kingbase',
        host: '192.168.10.8',
        port: 54321,
        user: 'SYSTEM',
        database: 'appdb',
      },
    };
    const tableTab: TabData = {
      id: 'kingbase-1-appdb-table-ldf_server.andon_events',
      title: 'ldf_server.andon_events',
      type: 'table',
      connectionId: 'kingbase-1',
      dbName: 'appdb',
      tableName: 'ldf_server.andon_events',
    };

    const model = buildTabDisplayModel(tableTab, connection);

    expect(model.layout).toBe('double');
    expect(model.primaryText).toBe('andon_events');
    expect(model.secondaryText).toBe('TABLE·[DEV]·appdb');
    expect(model.fullTitle).toBe('andon_events · TABLE·[DEV]·appdb');
  });

  it('keeps query tab labels compact when the title is raw SQL', () => {
    const connection: SavedConnection = {
      id: 'mysql-1',
      name: '开发240',
      config: {
        type: 'mysql',
        host: '192.168.1.240',
        port: 3306,
        user: 'root',
        database: 'front_end_sys',
      },
    };
    const queryTab: TabData = {
      id: 'query-1',
      title: 'select * from fs_org_auth_application where application_id is not null;',
      type: 'query',
      connectionId: 'mysql-1',
      dbName: 'front_end_sys',
      query: 'select * from fs_org_auth_application where application_id is not null;',
    };

    const model = buildTabDisplayModel(queryTab, connection);

    expect(model.primaryText).toBe('New query');
    expect(model.secondaryText).toBe('SQL·[开发240]·front_end_sys');
    expect(model.fullTitle).not.toContain('fs_org_auth_application');
    expect(model.fullTitle).not.toContain('select *');
  });

  it('localizes query tab fallback object labels without translating raw SQL', () => {
    const queryTab: TabData = {
      id: 'query-1',
      title: 'select * from fs_org_auth_application where application_id is not null;',
      type: 'query',
      connectionId: 'mysql-1',
      dbName: 'front_end_sys',
      query: 'select * from fs_org_auth_application where application_id is not null;',
    };

    const model = buildTabDisplayModel(queryTab, undefined, undefined, keyEchoTranslate);

    expect(model.primaryText).toBe('T(New query)');
    expect(model.secondaryText).toBe('SQL·front_end_sys');
    expect(model.fullTitle).not.toContain('fs_org_auth_application');
    expect(model.fullTitle).not.toContain('select *');
  });

  it('relocalizes untitled query tab labels when the stored title came from another locale', () => {
    const queryTab: TabData = {
      id: 'query-1',
      title: catalogTranslate('zh-CN', 'query.new'),
      type: 'query',
      connectionId: 'mysql-1',
      dbName: 'front_end_sys',
      query: 'select 1;',
    };

    const model = buildTabDisplayModel(queryTab, undefined, undefined, keyEchoTranslate);

    expect(model.primaryText).toBe('T(New query)');
    expect(model.secondaryText).toBe('SQL·front_end_sys');
  });

  it('relocalizes database-scoped untitled query labels with the current database name', () => {
    const queryTab: TabData = {
      id: 'query-1',
      title: catalogTranslate('zh-CN', 'sidebar.tab.new_query_database', { database: 'main' }),
      type: 'query',
      connectionId: 'mysql-1',
      dbName: 'main',
      query: 'select 1;',
    };

    const model = buildTabDisplayModel(queryTab, undefined, undefined, keyEchoTranslate);

    expect(model.primaryText).toBe('T(New query (main))');
    expect(model.secondaryText).toBe('SQL·main');
  });

  it('uses SQL file names as compact query tab object labels', () => {
    const queryTab: TabData = {
      id: 'query-file-1',
      title: 'select * from very_long_table_name;',
      type: 'query',
      connectionId: 'mysql-1',
      filePath: '/Users/me/sql/monthly-report.sql',
      query: 'select * from very_long_table_name;',
    };

    const model = buildTabDisplayModel(queryTab);

    expect(model.primaryText).toBe('monthly-report.sql');
    expect(model.secondaryText).toBe('SQL');
  });

  it('builds configurable double-line tab display models', () => {
    const connection: SavedConnection = {
      id: 'pg-1',
      name: 'Postgres PROD',
      config: {
        type: 'postgres',
        host: '10.0.0.9',
        port: 5432,
        user: 'postgres',
        database: 'analytics',
      },
    };
    const tableTab: TabData = {
      id: 'pg-1-analytics-table-reporting.events',
      title: 'reporting.events',
      type: 'table',
      connectionId: 'pg-1',
      dbName: 'analytics',
      tableName: 'reporting.events',
    };

    const model = buildTabDisplayModel(tableTab, connection, {
      layout: 'double',
      primaryElements: ['kind', 'object'],
      secondaryElements: ['connection', 'database', 'schema', 'host'],
    });

    expect(model.layout).toBe('double');
    expect(model.primaryText).toBe('TABLE events');
    expect(model.secondaryText).toBe('[PROD]·analytics·SCHEMA:reporting·10.0.0.9');
    expect(model.fullTitle).toBe('TABLE events · [PROD]·analytics·SCHEMA:reporting·10.0.0.9');
  });

  it('uses explicit schema metadata for unqualified table names', () => {
    const tableTab: TabData = {
      id: 'pg-1-analytics-table-reporting-events',
      title: 'events',
      type: 'table',
      connectionId: 'pg-1',
      dbName: 'analytics',
      tableName: 'events',
      schemaName: 'reporting',
    };

    const model = buildTabDisplayModel(tableTab, undefined, {
      layout: 'double',
      primaryElements: ['object'],
      secondaryElements: ['schema'],
    });

    expect(model.primaryText).toBe('events');
    expect(model.secondaryText).toBe('SCHEMA:reporting');
  });

  it('sanitizes tab display settings with fallback defaults', () => {
    expect(sanitizeTabDisplaySettings({
      layout: 'invalid' as never,
      primaryElements: ['schema', 'schema', 'bad' as never],
      secondaryElements: ['object', 'schema', 'host'],
    })).toEqual({
      layout: 'double',
      primaryElements: ['schema'],
      secondaryElements: ['object', 'host'],
    });

    expect(sanitizeTabDisplaySettings({
      layout: 'double',
      primaryElements: ['bad' as never],
      secondaryElements: [],
    })).toEqual({
      layout: 'double',
      primaryElements: ['object'],
      secondaryElements: [],
    });

    expect(sanitizeTabDisplaySettings({
      layout: 'single',
      primaryElements: ['object'],
      secondaryElements: [],
      single: {
        primaryElements: ['object', 'object', 'host'],
        secondaryElements: ['bad' as never],
      },
      double: {
        primaryElements: ['kind', 'object'],
        secondaryElements: ['connection', 'kind', 'schema'],
      },
    })).toEqual({
      layout: 'single',
      primaryElements: ['object'],
      secondaryElements: [],
      single: {
        primaryElements: ['object', 'host'],
        secondaryElements: [],
      },
      double: {
        primaryElements: ['kind', 'object'],
        secondaryElements: ['connection', 'schema'],
      },
    });
  });

  it('resolves visible tab display elements before hidden elements', () => {
    expect(resolveTabDisplayElementOrder({
      layout: 'double',
      primaryElements: ['object', 'kind'],
      secondaryElements: ['host'],
    })).toEqual(['object', 'kind', 'host', 'connection', 'database', 'schema']);
  });

  it('keeps separate single-line and double-line settings when switching layouts', () => {
    const doubleConfigured = sanitizeTabDisplaySettings({
      layout: 'double',
      primaryElements: ['kind', 'object'],
      secondaryElements: ['connection', 'database'],
    });

    const singleLayout = switchTabDisplayLayout(doubleConfigured, 'single');
    const singleConfigured = applyTabDisplaySettingsPatch(singleLayout, {
      primaryElements: ['object', 'host'],
      secondaryElements: [],
    });
    const restoredDouble = switchTabDisplayLayout(singleConfigured, 'double');
    const restoredSingle = switchTabDisplayLayout(restoredDouble, 'single');

    expect(restoredDouble.layout).toBe('double');
    expect(restoredDouble.primaryElements).toEqual(['kind', 'object']);
    expect(restoredDouble.secondaryElements).toEqual(['connection', 'database']);
    expect(restoredSingle.layout).toBe('single');
    expect(restoredSingle.primaryElements).toEqual(['object', 'host']);
    expect(restoredSingle.secondaryElements).toEqual([]);
  });
});
