import { beforeAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildTableAccessCountKey, MAX_TABLE_ACCESS_COUNT_ENTRIES } from './utils/tableAccessCount';

class MemoryStorage implements Storage {
  private data = new Map<string, string>();

  get length(): number {
    return this.data.size;
  }

  clear(): void {
    this.data.clear();
  }

  getItem(key: string): string | null {
    return this.data.has(key) ? this.data.get(key)! : null;
  }

  key(index: number): string | null {
    return Array.from(this.data.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.data.delete(key);
  }

  setItem(key: string, value: string): void {
    this.data.set(key, String(value));
  }
}

const importStore = async () => {
  const store = await import('./store');
  await store.useStore.persist.rehydrate();
  return store;
};

describe('store appearance persistence', () => {
  // 预热 store 模块转换缓存：拆分后的首个用例不必在默认超时内承担冷编译
  beforeAll(async () => {
    vi.stubGlobal('localStorage', new MemoryStorage());
    await import('./store');
    vi.unstubAllGlobals();
    vi.resetModules();
  }, 30_000);

  let storage: MemoryStorage;

  beforeEach(() => {
    storage = new MemoryStorage();
    vi.stubGlobal('localStorage', storage);
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('sanitizes persisted database include and exclude masks without rewriting legacy exact names', async () => {
    const { useStore } = await importStore();
    const validUnicodePattern = '租'.repeat(85);
    const invalidUnicodePattern = '租'.repeat(86);
    const includePatterns = [
      invalidUnicodePattern,
      validUnicodePattern,
      ' tenant_% ',
      'tenant_%',
      ...Array.from({ length: 260 }, (_, index) => `app_${index}%`),
      'x'.repeat(257),
    ];

    useStore.getState().replaceConnections([{
      id: 'filtered-db',
      name: 'Filtered DB',
      includeDatabases: ['app_db'],
      includeDatabasePatterns: includePatterns,
      excludeDatabasePatterns: [' archive_% ', 'archive_%', ''],
      config: {
        id: 'filtered-db',
        type: 'mysql',
        host: 'db.local',
        port: 3306,
        user: 'root',
      },
    }]);

    const saved = useStore.getState().connections[0];
    expect(saved?.includeDatabases).toEqual(['app_db']);
    expect(saved?.includeDatabasePatterns?.[0]).toBe(validUnicodePattern);
    expect(saved?.includeDatabasePatterns).not.toContain(invalidUnicodePattern);
    expect(saved?.includeDatabasePatterns).toHaveLength(256);
    expect(saved?.excludeDatabasePatterns).toEqual(['archive_%']);
  });

  it('preserves case-distinct schema visibility entries according to datasource capability', async () => {
    const { useStore } = await importStore();

    useStore.getState().replaceConnections([
      {
        id: 'postgres-schemas',
        name: 'Postgres schemas',
        schemaVisibilityByDatabase: {
          analytics: { mode: 'include', schemas: ['foo', 'Foo', 'foo'] },
          Analytics: { mode: 'exclude', schemas: ['temp'] },
        },
        config: {
          id: 'postgres-schemas',
          type: 'postgres',
          host: 'db.local',
          port: 5432,
          user: 'postgres',
        },
      },
      {
        id: 'duckdb-schemas',
        name: 'DuckDB schemas',
        schemaVisibilityByDatabase: {
          analytics: { mode: 'include', schemas: ['foo', 'Foo', 'foo'] },
        },
        config: {
          id: 'duckdb-schemas',
          type: 'duckdb',
          host: 'D:/db/analytics.duckdb',
          port: 0,
          user: '',
        },
      },
      {
        id: 'sqlserver-schemas',
        name: 'SQL Server schemas',
        schemaVisibilityByDatabase: {
          analytics: { mode: 'include', schemas: ['foo', 'Foo', 'foo'] },
        },
        config: {
          id: 'sqlserver-schemas',
          type: 'sqlserver',
          host: 'db.local',
          port: 1433,
          user: 'sa',
        },
      },
    ]);

    const [postgres, duckdb, sqlserver] = useStore.getState().connections;
    expect(postgres?.schemaVisibilityByDatabase?.analytics.schemas).toEqual(['foo', 'Foo']);
    expect(postgres?.schemaVisibilityByDatabase?.Analytics.schemas).toEqual(['temp']);
    expect(duckdb?.schemaVisibilityByDatabase?.analytics.schemas).toEqual(['foo']);
    expect(sqlserver?.schemaVisibilityByDatabase?.analytics.schemas).toEqual(['foo']);
  });

  it('keeps InterSystems IRIS saved connections as independent datasource type', async () => {
    const { useStore } = await importStore();

    useStore.getState().replaceConnections([
      {
        id: 'iris-user',
        name: 'IRIS USER',
        config: {
          id: 'iris-user',
          type: 'iris',
          host: 'iris.local',
          port: 1972,
          user: '_SYSTEM',
          database: 'USER',
        },
      },
      {
        id: 'iris-alias',
        name: 'IRIS Alias',
        config: {
          id: 'iris-alias',
          type: 'InterSystemsIRIS',
          host: 'iris-alias.local',
          port: 1972,
          user: '_SYSTEM',
          database: 'USER',
        },
      },
    ]);

    const connections = useStore.getState().connections;
    expect(connections[0]?.config.type).toBe('iris');
    expect(connections[0]?.config.port).toBe(1972);
    expect(connections[1]?.config.type).toBe('iris');
  });

  it('keeps InterSystems Caché saved connections independent from IRIS', async () => {
    const { useStore } = await importStore();

    useStore.getState().replaceConnections([
      {
        id: 'cache-user',
        name: 'Caché USER',
        config: {
          id: 'cache-user',
          type: 'cache',
          host: 'cache.local',
          port: 1972,
          user: '_SYSTEM',
          database: 'USER',
        },
      },
      {
        id: 'cache-alias',
        name: 'Caché Alias',
        config: {
          id: 'cache-alias',
          type: 'InterSystems Caché',
          host: 'cache-alias.local',
          port: 1972,
          user: '_SYSTEM',
          database: 'APP',
        },
      },
    ]);

    const connections = useStore.getState().connections;
    expect(connections[0]?.config.type).toBe('cache');
    expect(connections[0]?.config.port).toBe(1972);
    expect(connections[1]?.config.type).toBe('cache');
    expect(connections.every((connection) => connection.config.type !== 'iris')).toBe(true);
  });

  it('normalizes saved connection type aliases without falling back to mysql', async () => {
    const { useStore } = await importStore();

    useStore.getState().replaceConnections([
      { id: 'pg', name: 'Postgres', config: { id: 'pg', type: 'PostgreSQL', host: 'pg.local', port: 5432, user: 'postgres' } },
      { id: 'mssql', name: 'MSSQL', config: { id: 'mssql', type: 'mssql', host: 'sql.local', port: 1433, user: 'sa' } },
      { id: 'kingbase', name: 'Kingbase', config: { id: 'kingbase', type: 'kingbase8', host: 'kingbase.local', port: 54321, user: 'system' } },
      { id: 'dm', name: 'Dameng', config: { id: 'dm', type: 'dm8', host: 'dm.local', port: 5236, user: 'SYSDBA' } },
      { id: 'sqlite', name: 'SQLite', config: { id: 'sqlite', type: 'sqlite3', host: 'D:/db/app.sqlite', port: 0, user: '' } },
      { id: 'milvusdb', name: 'Milvus DB', config: { id: 'milvusdb', type: 'milvusdb', host: 'milvus.local', port: 19530, user: '' } },
      { id: 'milvus-db', name: 'Milvus DB Alias', config: { id: 'milvus-db', type: 'milvus-db', host: 'milvus-alias.local', port: 19530, user: '' } },
    ]);

    expect(useStore.getState().connections.map((conn) => conn.config.type)).toEqual([
      'postgres',
      'sqlserver',
      'kingbase',
      'dameng',
      'sqlite',
      'milvus',
      'milvus',
    ]);
  });

  it('preserves built-in document, vector, and messaging datasource types', async () => {
    const { useStore } = await importStore();

    const datasourceTypes = [
      ['chroma', 8000],
      ['qdrant', 6333],
      ['milvus', 19530],
      ['rocketmq', 9876],
      ['mqtt', 1883],
      ['rabbitmq', 15672],
    ] as const;

    useStore.getState().replaceConnections(
      datasourceTypes.map(([type, port]) => ({
        id: `conn-${type}`,
        name: type,
        config: {
          id: `conn-${type}`,
          type,
          host: `${type}.local`,
          port,
          user: '',
        },
      })),
    );

    expect(
      useStore.getState().connections.map((conn) => [
        conn.config.type,
        conn.config.port,
      ]),
    ).toEqual(datasourceTypes);
  });

  it('preserves SSL certificate paths for SSL-capable saved connections', async () => {
    const { useStore } = await importStore();

    useStore.getState().replaceConnections([
      {
        id: 'postgres-ssl',
        name: 'Postgres SSL',
        config: {
          id: 'postgres-ssl',
          type: 'postgres',
          host: 'db.local',
          port: 5432,
          user: 'postgres',
          useSSL: true,
          sslMode: 'required',
          sslCAPath: 'C:/certs/ca.pem',
          sslCertPath: 'C:/certs/client-cert.pem',
          sslKeyPath: 'C:/certs/client-key.pem',
        },
      },
    ]);

    const config = useStore.getState().connections[0]?.config;
    expect(config?.sslCAPath).toBe('C:/certs/ca.pem');
    expect(config?.sslCertPath).toBe('C:/certs/client-cert.pem');
    expect(config?.sslKeyPath).toBe('C:/certs/client-key.pem');
  });

  it('normalizes OceanBase protocol override when replacing saved connections', async () => {
    const { useStore } = await importStore();

    useStore.getState().replaceConnections([
      {
        id: 'oceanbase-oracle',
        name: 'OceanBase Oracle',
        config: {
          id: 'oceanbase-oracle',
          type: 'oceanbase',
          host: 'ob.local',
          port: 2881,
          user: 'sys@oracle001',
          oceanBaseProtocol: 'oracle',
        },
      },
    ]);

    expect(useStore.getState().connections[0]?.config.oceanBaseProtocol).toBe(
      'oracle',
    );
  });

  it('restores OceanBase protocol from saved URI or connection params', async () => {
    const { useStore } = await importStore();

    useStore.getState().replaceConnections([
      {
        id: 'oceanbase-uri-oracle',
        name: 'OceanBase URI Oracle',
        config: {
          id: 'oceanbase-uri-oracle',
          type: 'oceanbase',
          host: 'ob.local',
          port: 2881,
          user: 'sys@oracle001',
          uri: 'oceanbase://sys%40oracle001:pass@ob.local:2881/OBORCL?protocol=oracle',
        },
      },
      {
        id: 'oceanbase-param-oracle',
        name: 'OceanBase Param Oracle',
        config: {
          id: 'oceanbase-param-oracle',
          type: 'oceanbase',
          host: 'ob.local',
          port: 2881,
          user: 'sys@oracle001',
          connectionParams: 'tenantMode=oracle&PREFETCH_ROWS=5000',
        },
      },
    ]);

    expect(useStore.getState().connections[0]?.config.oceanBaseProtocol).toBe(
      'oracle',
    );
    expect(useStore.getState().connections[1]?.config.oceanBaseProtocol).toBe(
      'oracle',
    );
  });

  it('prefers OceanBase protocol query key over legacy aliases when restoring saved connections', async () => {
    const { useStore } = await importStore();

    useStore.getState().replaceConnections([
      {
        id: 'oceanbase-conflict',
        name: 'OceanBase Conflict',
        config: {
          id: 'oceanbase-conflict',
          type: 'oceanbase',
          host: 'ob.local',
          port: 2881,
          user: 'root@test',
          connectionParams: 'protocol=mysql&tenantMode=oracle',
        },
      },
    ]);

    expect(useStore.getState().connections[0]?.config.oceanBaseProtocol).toBe(
      'mysql',
    );
  });

  it('keeps saved OceanBase native protocol loadable for connect-time rejection', async () => {
    const { useStore } = await importStore();

    expect(() => useStore.getState().replaceConnections([
      {
        id: 'oceanbase-native',
        name: 'OceanBase Native',
        config: {
          id: 'oceanbase-native',
          type: 'oceanbase',
          host: 'ob.local',
          port: 2881,
          user: 'root@test',
          oceanBaseProtocol: 'mysql',
          connectionParams: 'protocol=native',
        },
      },
    ])).not.toThrow();
    expect(useStore.getState().connections[0]?.config.connectionParams).toBe(
      'protocol=native',
    );
    expect(useStore.getState().connections[0]?.config.oceanBaseProtocol).toBe(
      'mysql',
    );
  });

  it('normalizes OceanBase protocol when updating a saved connection', async () => {
    const { useStore } = await importStore();

    useStore.getState().replaceConnections([
      {
        id: 'oceanbase-existing',
        name: 'OceanBase Existing',
        config: {
          id: 'oceanbase-existing',
          type: 'oceanbase',
          host: 'ob.local',
          port: 2881,
          user: 'root@test',
          connectionParams: 'protocol=mysql',
        },
      },
    ]);

    useStore.getState().updateConnection({
      id: 'oceanbase-existing',
      name: 'OceanBase Existing',
      config: {
        id: 'oceanbase-existing',
        type: 'oceanbase',
        host: 'ob.local',
        port: 2881,
        user: 'sys@oracle001',
        connectionParams: 'protocol=oracle',
      },
    });

    expect(useStore.getState().connections[0]?.config.oceanBaseProtocol).toBe(
      'oracle',
    );
  });

  it('normalizes connection environment metadata without storing group presets', async () => {
    const { useStore } = await importStore();

    useStore.getState().replaceConnections([
      {
        id: 'conn-production',
        name: 'Production',
        environmentType: 'production',
        config: {
          id: 'conn-production',
          type: 'postgres',
          host: 'prod.local',
          port: 5432,
          user: 'postgres',
        },
      },
      {
        id: 'conn-legacy',
        name: 'Legacy',
        config: {
          id: 'conn-legacy',
          type: 'sqlite',
          host: '',
          port: 0,
          user: '',
        },
      },
    ]);
    useStore.getState().addConnectionTag({
      id: 'tag-test',
      name: 'Test',
      environmentType: 'test',
      connectionIds: ['conn-production'],
    } as any);
    useStore.getState().addConnectionTag({
      id: 'tag-legacy',
      name: 'Legacy',
      connectionIds: ['conn-legacy'],
    });

    expect(useStore.getState().connections.map((item) => item.environmentType)).toEqual([
      'production',
      'local',
    ]);
    expect(useStore.getState().connectionTags).toEqual([
      expect.objectContaining({ id: 'tag-test', name: 'Test' }),
      expect.objectContaining({ id: 'tag-legacy', name: 'Legacy' }),
    ]);
    expect(useStore.getState().connectionTags.every((item) => !('environmentType' in item))).toBe(true);
  }, 30_000);

  it('keeps group order custom while storing independent connection display sorting', async () => {
    const { useStore } = await importStore();

    useStore.getState().replaceConnections([
      {
        id: 'conn-a',
        name: 'A',
        config: { id: 'conn-a', type: 'mysql', host: 'a.local', port: 3306, user: 'root' },
      },
      {
        id: 'conn-b',
        name: 'B',
        config: { id: 'conn-b', type: 'mysql', host: 'b.local', port: 3306, user: 'root' },
      },
      {
        id: 'conn-c',
        name: 'C',
        config: { id: 'conn-c', type: 'mysql', host: 'c.local', port: 3306, user: 'root' },
      },
      {
        id: 'conn-d',
        name: 'D',
        config: { id: 'conn-d', type: 'mysql', host: 'd.local', port: 3306, user: 'root' },
      },
    ]);
    useStore.getState().addConnectionTag({
      id: 'tag-dev',
      name: '开发',
      connectionIds: ['conn-b', 'conn-d'],
    });

    useStore.getState().setConnectionDisplaySortMode('tag-dev', 'name');
    useStore.getState().setConnectionDisplaySortMode(null, 'createdAt');

    expect(useStore.getState().connectionTags[0]).toEqual(expect.objectContaining({
      sortMode: 'manual',
      connectionSortMode: 'name',
    }));
    expect(useStore.getState().rootSortMode).toBe('manual');
    expect(useStore.getState().rootConnectionSortMode).toBe('createdAt');
  });

  it('reorders sidebar root items across tags and ungrouped hosts', async () => {
    const {
      buildSidebarRootConnectionToken,
      buildSidebarRootTagToken,
      resolveSidebarRootOrderTokens,
      useStore,
    } = await importStore();

    useStore.getState().replaceConnections([
      {
        id: 'conn-a',
        name: 'A',
        config: { id: 'conn-a', type: 'mysql', host: 'a.local', port: 3306, user: 'root' },
      },
      {
        id: 'conn-b',
        name: 'B',
        config: { id: 'conn-b', type: 'mysql', host: 'b.local', port: 3306, user: 'root' },
      },
      {
        id: 'conn-c',
        name: 'C',
        config: { id: 'conn-c', type: 'mysql', host: 'c.local', port: 3306, user: 'root' },
      },
    ]);
    useStore.getState().addConnectionTag({
      id: 'tag-dev',
      name: '开发',
      connectionIds: ['conn-b'],
    });

    const initialOrder = resolveSidebarRootOrderTokens(
      useStore.getState().sidebarRootOrder,
      useStore.getState().connectionTags,
      useStore.getState().connections,
    );
    expect(initialOrder).toEqual([
      buildSidebarRootTagToken('tag-dev'),
      buildSidebarRootConnectionToken('conn-a'),
      buildSidebarRootConnectionToken('conn-c'),
    ]);

    useStore.getState().reorderSidebarRoot(
      buildSidebarRootTagToken('tag-dev'),
      buildSidebarRootConnectionToken('conn-c'),
      false,
    );

    expect(resolveSidebarRootOrderTokens(
      useStore.getState().sidebarRootOrder,
      useStore.getState().connectionTags,
      useStore.getState().connections,
    )).toEqual([
      buildSidebarRootConnectionToken('conn-a'),
      buildSidebarRootConnectionToken('conn-c'),
      buildSidebarRootTagToken('tag-dev'),
    ]);
  });

  it('restores ungrouped host root order after moving a host out of a tag', async () => {
    const {
      buildSidebarRootConnectionToken,
      buildSidebarRootTagToken,
      resolveSidebarRootOrderTokens,
      useStore,
    } = await importStore();

    useStore.getState().replaceConnections([
      {
        id: 'conn-a',
        name: 'A',
        config: { id: 'conn-a', type: 'mysql', host: 'a.local', port: 3306, user: 'root' },
      },
      {
        id: 'conn-b',
        name: 'B',
        config: { id: 'conn-b', type: 'mysql', host: 'b.local', port: 3306, user: 'root' },
      },
    ]);
    useStore.getState().addConnectionTag({
      id: 'tag-dev',
      name: '开发',
      connectionIds: ['conn-b'],
    });

    useStore.getState().moveConnectionToTag('conn-a', 'tag-dev');
    useStore.getState().moveConnectionToTag('conn-a', null);

    expect(resolveSidebarRootOrderTokens(
      useStore.getState().sidebarRootOrder,
      useStore.getState().connectionTags,
      useStore.getState().connections,
    )).toEqual([
      buildSidebarRootTagToken('tag-dev'),
      buildSidebarRootConnectionToken('conn-a'),
    ]);
  });

  it('keeps persisted sidebar root order until backend connections reload on startup', async () => {
    storage.setItem('lite-db-storage', JSON.stringify({
      state: {
        connectionTags: [
          {
            id: 'tag-redis',
            name: 'Redis',
            connectionIds: ['conn-b'],
          },
        ],
        sidebarRootOrder: [
          'connection:conn-a',
          'connection:conn-c',
          'tag:tag-redis',
        ],
      },
      version: 13,
    }));

    const {
      buildSidebarRootConnectionToken,
      buildSidebarRootTagToken,
      resolveSidebarRootOrderTokens,
      useStore,
    } = await importStore();

    expect(useStore.getState().sidebarRootOrder).toEqual([
      buildSidebarRootConnectionToken('conn-a'),
      buildSidebarRootConnectionToken('conn-c'),
      buildSidebarRootTagToken('tag-redis'),
    ]);

    useStore.getState().replaceConnections([
      {
        id: 'conn-a',
        name: 'A',
        config: { id: 'conn-a', type: 'mysql', host: 'a.local', port: 3306, user: 'root' },
      },
      {
        id: 'conn-b',
        name: 'B',
        config: { id: 'conn-b', type: 'redis', host: 'b.local', port: 6379, user: 'default' },
      },
      {
        id: 'conn-c',
        name: 'C',
        config: { id: 'conn-c', type: 'mysql', host: 'c.local', port: 3306, user: 'root' },
      },
    ]);

    expect(resolveSidebarRootOrderTokens(
      useStore.getState().sidebarRootOrder,
      useStore.getState().connectionTags,
      useStore.getState().connections,
    )).toEqual([
      buildSidebarRootConnectionToken('conn-a'),
      buildSidebarRootConnectionToken('conn-c'),
      buildSidebarRootTagToken('tag-redis'),
    ]);
  });

  it('atomically replaces the connection sidebar layout loaded from the backend', async () => {
    const { useStore } = await importStore();
    useStore.getState().replaceConnections([
      {
        id: 'conn-a',
        name: 'A',
        config: { id: 'conn-a', type: 'mysql', host: 'a.local', port: 3306, user: 'root' },
      },
      {
        id: 'conn-b',
        name: 'B',
        config: { id: 'conn-b', type: 'redis', host: 'b.local', port: 6379, user: 'default' },
      },
    ]);

    useStore.getState().replaceConnectionSidebarLayout({
      connectionTags: [
        {
          id: 'tag-remote',
          name: '远端分组',
          connectionIds: ['conn-b'],
          childOrder: ['connection:conn-b'],
        },
      ],
      sidebarRootOrder: ['connection:conn-a', 'tag:tag-remote'],
    });

    expect(useStore.getState().connectionTags).toEqual([
      expect.objectContaining({
        id: 'tag-remote',
        name: '远端分组',
        connectionIds: ['conn-b'],
        childOrder: ['connection:conn-b'],
      }),
    ]);
    expect(useStore.getState().sidebarRootOrder).toEqual([
      'connection:conn-a',
      'tag:tag-remote',
    ]);
  });

  it('persists the table designer schema per connection and clears it with the connection', async () => {
    const { useStore } = await importStore();
    useStore.getState().replaceConnections([{
      id: 'pg-conn',
      name: 'PostgreSQL',
      config: { id: 'pg-conn', type: 'postgres', host: 'localhost', port: 5432, user: 'postgres' },
    }]);

    useStore.getState().setTableDesignerSchema('pg-conn', 'sales');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(useStore.getState().tableDesignerSchemaByConnection).toEqual({ 'pg-conn': 'sales' });
    expect(JSON.parse(storage.getItem('lite-db-storage') || '{}').state.tableDesignerSchemaByConnection)
      .toEqual({ 'pg-conn': 'sales' });

    vi.resetModules();
    const reloaded = await importStore();
    expect(reloaded.useStore.getState().tableDesignerSchemaByConnection).toEqual({ 'pg-conn': 'sales' });

    reloaded.useStore.getState().removeConnection('pg-conn');
    expect(reloaded.useStore.getState().tableDesignerSchemaByConnection).toEqual({});
  });

  it('clears remembered table designer schemas when connections are replaced', async () => {
    const { useStore } = await importStore();
    useStore.getState().replaceConnections([
      { id: 'pg-1', name: 'PG 1', config: { id: 'pg-1', type: 'postgres', host: 'one', port: 5432, user: 'postgres' } },
      { id: 'pg-2', name: 'PG 2', config: { id: 'pg-2', type: 'postgres', host: 'two', port: 5432, user: 'postgres' } },
    ]);
    useStore.getState().setTableDesignerSchema('pg-1', 'sales');
    useStore.getState().setTableDesignerSchema('pg-2', 'archive');

    useStore.getState().replaceConnections([
      { id: 'pg-2', name: 'PG 2', config: { id: 'pg-2', type: 'postgres', host: 'two', port: 5432, user: 'postgres' } },
    ]);

    expect(useStore.getState().tableDesignerSchemaByConnection).toEqual({ 'pg-2': 'archive' });
  });

  it('migrates flat v15 connection groups to explicit root child order', async () => {
    storage.setItem('lite-db-storage', JSON.stringify({
      state: {
        connectionTags: [
          {
            id: 'tag-legacy',
            name: 'Legacy',
            connectionIds: ['conn-a', 'conn-b'],
          },
        ],
        sidebarRootOrder: ['tag:tag-legacy'],
      },
      version: 15,
    }));

    const {
      buildSidebarRootConnectionToken,
      resolveConnectionTagChildOrder,
      useStore,
    } = await importStore();

    const legacyTag = useStore.getState().connectionTags[0];
    expect(legacyTag?.parentTagId).toBeUndefined();
    expect(legacyTag?.childOrder).toEqual([
      buildSidebarRootConnectionToken('conn-a'),
      buildSidebarRootConnectionToken('conn-b'),
    ]);
    expect(resolveConnectionTagChildOrder(
      'tag-legacy',
      useStore.getState().connectionTags,
    )).toEqual(legacyTag?.childOrder);

    const persisted = JSON.parse(storage.getItem('lite-db-storage') || '{}');
    expect(persisted.version).toBe(21);
    expect(persisted.state.connectionTags[0].childOrder).toEqual([
      'connection:conn-a',
      'connection:conn-b',
    ]);
  });

  it('supports three-level groups with hosts and child groups in one ordered list', async () => {
    const {
      buildSidebarRootConnectionToken,
      buildSidebarRootTagToken,
      resolveConnectionTagChildOrder,
      useStore,
    } = await importStore();
    useStore.getState().replaceConnections(
      ['host-1', 'host-2', 'host-3', 'host-4', 'host-5', 'host-6'].map((id) => ({
        id,
        name: id,
        config: { id, type: 'mysql', host: `${id}.local`, port: 3306, user: 'root' },
      })),
    );
    useStore.getState().addConnectionTag({
      id: 'group-1',
      name: '分组1',
      connectionIds: ['host-1', 'host-2'],
    });
    useStore.getState().addConnectionTag({
      id: 'group-1-1',
      name: '分组1-1',
      parentTagId: 'group-1',
      connectionIds: ['host-3', 'host-4'],
    });
    useStore.getState().addConnectionTag({
      id: 'group-1-1-1',
      name: '分组1-1-1',
      parentTagId: 'group-1-1',
      connectionIds: ['host-5', 'host-6'],
    });

    // A child group may be placed between its parent's direct hosts.
    useStore.getState().moveConnectionTag(
      'group-1-1',
      'group-1',
      buildSidebarRootConnectionToken('host-1'),
      false,
    );

    expect(resolveConnectionTagChildOrder(
      'group-1',
      useStore.getState().connectionTags,
    )).toEqual([
      buildSidebarRootConnectionToken('host-1'),
      buildSidebarRootTagToken('group-1-1'),
      buildSidebarRootConnectionToken('host-2'),
    ]);
    expect(resolveConnectionTagChildOrder(
      'group-1-1',
      useStore.getState().connectionTags,
    )).toEqual([
      buildSidebarRootConnectionToken('host-3'),
      buildSidebarRootConnectionToken('host-4'),
      buildSidebarRootTagToken('group-1-1-1'),
    ]);
    expect(useStore.getState().connectionTags.find(
      (tag) => tag.id === 'group-1-1-1',
    )?.parentTagId).toBe('group-1-1');
  });

  it('keeps a host in exactly one nested group while moving and reordering it', async () => {
    const {
      buildSidebarRootConnectionToken,
      resolveConnectionTagChildOrder,
      useStore,
    } = await importStore();
    useStore.getState().replaceConnections(
      ['host-1', 'host-2'].map((id) => ({
        id,
        name: id,
        config: { id, type: 'mysql', host: `${id}.local`, port: 3306, user: 'root' },
      })),
    );
    useStore.getState().addConnectionTag({
      id: 'group-1',
      name: '分组1',
      connectionIds: ['host-1'],
    });
    useStore.getState().addConnectionTag({
      id: 'group-1-1',
      name: '分组1-1',
      parentTagId: 'group-1',
      connectionIds: ['host-2'],
    });

    useStore.getState().moveConnectionToTag(
      'host-1',
      'group-1-1',
      buildSidebarRootConnectionToken('host-2'),
      true,
    );
    useStore.getState().reorderConnections(
      'host-2',
      'host-1',
      'group-1-1',
      true,
    );

    const groups = useStore.getState().connectionTags;
    expect(groups.find((tag) => tag.id === 'group-1')?.connectionIds).toEqual([]);
    expect(groups.find((tag) => tag.id === 'group-1-1')?.connectionIds).toEqual([
      'host-2',
      'host-1',
    ]);
    expect(groups.filter((tag) => tag.connectionIds.includes('host-1'))).toHaveLength(1);
    expect(resolveConnectionTagChildOrder('group-1-1', groups)).toEqual([
      buildSidebarRootConnectionToken('host-2'),
      buildSidebarRootConnectionToken('host-1'),
    ]);
  });

  it('promotes direct hosts and child groups in place when deleting an intermediate group', async () => {
    const {
      buildSidebarRootConnectionToken,
      buildSidebarRootTagToken,
      resolveConnectionTagChildOrder,
      useStore,
    } = await importStore();
    useStore.getState().replaceConnections(
      ['host-1', 'host-2', 'host-3', 'host-4', 'host-5', 'host-6'].map((id) => ({
        id,
        name: id,
        config: { id, type: 'mysql', host: `${id}.local`, port: 3306, user: 'root' },
      })),
    );
    useStore.getState().addConnectionTag({
      id: 'group-1',
      name: '分组1',
      connectionIds: ['host-1', 'host-2'],
    });
    useStore.getState().addConnectionTag({
      id: 'group-1-1',
      name: '分组1-1',
      parentTagId: 'group-1',
      connectionIds: ['host-3', 'host-4'],
    });
    useStore.getState().addConnectionTag({
      id: 'group-1-1-1',
      name: '分组1-1-1',
      parentTagId: 'group-1-1',
      connectionIds: ['host-5', 'host-6'],
    });
    useStore.getState().moveConnectionTag(
      'group-1-1',
      'group-1',
      buildSidebarRootConnectionToken('host-1'),
      false,
    );

    useStore.getState().removeConnectionTag('group-1-1');

    expect(useStore.getState().connectionTags.some(
      (tag) => tag.id === 'group-1-1',
    )).toBe(false);
    expect(useStore.getState().connectionTags.find(
      (tag) => tag.id === 'group-1-1-1',
    )?.parentTagId).toBe('group-1');
    expect(resolveConnectionTagChildOrder(
      'group-1',
      useStore.getState().connectionTags,
    )).toEqual([
      buildSidebarRootConnectionToken('host-1'),
      buildSidebarRootConnectionToken('host-3'),
      buildSidebarRootConnectionToken('host-4'),
      buildSidebarRootTagToken('group-1-1-1'),
      buildSidebarRootConnectionToken('host-2'),
    ]);
    expect(useStore.getState().connectionTags.find(
      (tag) => tag.id === 'group-1',
    )?.connectionIds).toEqual(['host-1', 'host-3', 'host-4', 'host-2']);
  });

  it('rejects duplicate group names under the same parent but permits them elsewhere', async () => {
    const { useStore } = await importStore();
    useStore.getState().addConnectionTag({ id: 'root-a', name: 'Shared', connectionIds: [] });
    useStore.getState().addConnectionTag({ id: 'root-b', name: ' shared ', connectionIds: [] });
    useStore.getState().addConnectionTag({ id: 'parent', name: 'Parent', connectionIds: [] });
    useStore.getState().addConnectionTag({ id: 'child', name: 'shared', parentTagId: 'parent', connectionIds: [] });

    expect(useStore.getState().connectionTags.map((tag) => tag.id)).toEqual(['root-a', 'parent', 'child']);
  });

  it('removes a group subtree without promoting its descendants', async () => {
    const { useStore } = await importStore();
    useStore.getState().addConnectionTag({ id: 'root', name: 'Root', connectionIds: [] });
    useStore.getState().addConnectionTag({ id: 'child', name: 'Child', parentTagId: 'root', connectionIds: [] });
    useStore.getState().addConnectionTag({ id: 'grandchild', name: 'Grandchild', parentTagId: 'child', connectionIds: [] });
    useStore.getState().addConnectionTag({ id: 'other', name: 'Other', connectionIds: [] });

    useStore.getState().removeConnectionTagTree('root');

    expect(useStore.getState().connectionTags.map((tag) => tag.id)).toEqual(['other']);
  });

  it('rejects moving a group into itself or a descendant', async () => {
    const { useStore } = await importStore();
    useStore.getState().addConnectionTag({
      id: 'group-1',
      name: '分组1',
      connectionIds: [],
    });
    useStore.getState().addConnectionTag({
      id: 'group-1-1',
      name: '分组1-1',
      parentTagId: 'group-1',
      connectionIds: [],
    });
    useStore.getState().addConnectionTag({
      id: 'group-1-1-1',
      name: '分组1-1-1',
      parentTagId: 'group-1-1',
      connectionIds: [],
    });

    useStore.getState().moveConnectionTag('group-1', 'group-1-1-1');
    useStore.getState().moveConnectionTag('group-1-1', 'group-1-1');

    const groups = useStore.getState().connectionTags;
    expect(groups.find((tag) => tag.id === 'group-1')?.parentTagId).toBeUndefined();
    expect(groups.find((tag) => tag.id === 'group-1-1')?.parentTagId).toBe('group-1');
    expect(groups.find((tag) => tag.id === 'group-1-1-1')?.parentTagId).toBe('group-1-1');
  });

  it('sanitizes malformed persisted group parents and duplicate host ownership', async () => {
    storage.setItem('lite-db-storage', JSON.stringify({
      state: {
        connectionTags: [
          {
            id: 'group-a',
            name: 'A',
            parentTagId: 'group-b',
            connectionIds: ['shared-host'],
            childOrder: ['connection:shared-host', 'tag:group-b'],
          },
          {
            id: 'group-b',
            name: 'B',
            parentTagId: 'group-a',
            connectionIds: ['shared-host'],
          },
          {
            id: 'group-orphan',
            name: 'Orphan',
            parentTagId: 'missing-group',
            connectionIds: [],
          },
        ],
      },
      version: 16,
    }));

    const { useStore } = await importStore();
    const groups = useStore.getState().connectionTags;

    expect(groups.find((tag) => tag.id === 'group-a')?.parentTagId).toBeUndefined();
    expect(groups.find((tag) => tag.id === 'group-b')?.parentTagId).toBeUndefined();
    expect(groups.find((tag) => tag.id === 'group-orphan')?.parentTagId).toBeUndefined();
    expect(groups.find((tag) => tag.id === 'group-a')?.connectionIds).toEqual([
      'shared-host',
    ]);
    expect(groups.find((tag) => tag.id === 'group-b')?.connectionIds).toEqual([]);
  });

  it('removes host tokens from nested group order when deleting a connection', async () => {
    const {
      buildSidebarRootConnectionToken,
      resolveConnectionTagChildOrder,
      useStore,
    } = await importStore();
    useStore.getState().replaceConnections(
      ['host-1', 'host-2'].map((id) => ({
        id,
        name: id,
        config: { id, type: 'mysql', host: `${id}.local`, port: 3306, user: 'root' },
      })),
    );
    useStore.getState().addConnectionTag({
      id: 'group-1',
      name: '分组1',
      connectionIds: [],
    });
    useStore.getState().addConnectionTag({
      id: 'group-1-1',
      name: '分组1-1',
      parentTagId: 'group-1',
      connectionIds: ['host-1', 'host-2'],
    });

    useStore.getState().removeConnection('host-1');

    expect(resolveConnectionTagChildOrder(
      'group-1-1',
      useStore.getState().connectionTags,
    )).toEqual([buildSidebarRootConnectionToken('host-2')]);
    expect(useStore.getState().connectionTags.find(
      (tag) => tag.id === 'group-1-1',
    )?.connectionIds).toEqual(['host-2']);
  });

  it('bounds hydrated table access counts while retaining frequent and recent entries', async () => {
    const tableAccessCount = Object.fromEntries([
      ['priority-main-users', 100],
      ...Array.from(
        { length: MAX_TABLE_ACCESS_COUNT_ENTRIES + 1 },
        (_, index) => [`connection-${index}-main-table`, 1] as const,
      ),
    ]);
    storage.setItem('lite-db-storage', JSON.stringify({
      state: { tableAccessCount },
      version: 17,
    }));

    const { useStore } = await importStore();
    const hydrated = useStore.getState().tableAccessCount;

    expect(Object.keys(hydrated)).toHaveLength(MAX_TABLE_ACCESS_COUNT_ENTRIES);
    expect(hydrated['priority-main-users']).toBe(100);
    expect(hydrated['connection-0-main-table']).toBeUndefined();
    expect(hydrated[`connection-${MAX_TABLE_ACCESS_COUNT_ENTRIES}-main-table`]).toBe(1);
  });

  it('bounds directly injected table access counts before persistence', async () => {
    const { useStore } = await importStore();
    useStore.setState({
      tableAccessCount: Object.fromEntries(
        Array.from(
          { length: MAX_TABLE_ACCESS_COUNT_ENTRIES + 10 },
          (_, index) => [`injected-${index}`, index + 1],
        ),
      ),
    });

    const persisted = JSON.parse(storage.getItem('lite-db-storage') || '{}');
    expect(Object.keys(persisted.state.tableAccessCount)).toHaveLength(
      MAX_TABLE_ACCESS_COUNT_ENTRIES,
    );
    expect(persisted.state.tableAccessCount['injected-0']).toBeUndefined();
    expect(persisted.state.tableAccessCount[
      `injected-${MAX_TABLE_ACCESS_COUNT_ENTRIES + 9}`
    ]).toBe(MAX_TABLE_ACCESS_COUNT_ENTRIES + 10);
  });

  it('bounds runtime table access counts and evicts the oldest least-used entry', async () => {
    const { useStore } = await importStore();
    useStore.setState({
      tableAccessCount: Object.fromEntries(
        Array.from(
          { length: MAX_TABLE_ACCESS_COUNT_ENTRIES },
          (_, index) => [buildTableAccessCountKey('conn', 'main', `table-${index}`), 1],
        ),
      ),
    });

    useStore.getState().recordTableAccess('conn', 'main', 'table-0');
    useStore.getState().recordTableAccess('conn', 'main', 'new-table');

    const counts = useStore.getState().tableAccessCount;
    expect(Object.keys(counts)).toHaveLength(MAX_TABLE_ACCESS_COUNT_ENTRIES);
    expect(counts[buildTableAccessCountKey('conn', 'main', 'table-0')]).toBe(2);
    expect(counts[buildTableAccessCountKey('conn', 'main', 'table-1')]).toBeUndefined();
    expect(counts[buildTableAccessCountKey('conn', 'main', 'new-table')]).toBe(1);
  });
});
