import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DBGetColumns,
  DBGetDatabaseForeignKeys,
  DBGetForeignKeys,
  DBGetIndexes,
  DBGetTables,
} from '../../wailsjs/go/app/App';
import type { ColumnDefinition, ForeignKeyDefinition } from '../types';
import { createBoundedAsyncCache } from '../utils/boundedAsyncCache';
import { buildRpcConnectionConfig } from '../utils/connectionRpcConfig';
import { normalizeColumnDefinitions } from '../utils/columnDefinition';
import { resolveDataSourceType } from '../utils/dataSourceCapabilities';
import { resolveUniqueKeyGroupsFromIndexes } from './dataGridCopyInsert';
import {
  buildErDiagramGraph,
  extractErTableNames,
  normalizeErQualifiedName,
  normalizeForeignKeyDefinitions,
  resolveErActualTableName,
  type BuildErDiagramGraphResult,
  type ErDiagramRelation,
  type ErDiagramTableSnapshot,
} from './dataGridErDiagramModel';

type DataGridErDiagramParams = {
  connections: any[];
  connectionId?: string;
  dbName?: string;
  tableName?: string;
  relationDepth?: number;
};

type DataGridErDiagramState = {
  graph: BuildErDiagramGraphResult | null;
  loading: boolean;
  reloading: boolean;
  error: string;
  partial: boolean;
  warningCount: number;
  canExpandRelations: boolean;
};

const ER_SCHEMA_CACHE_MAX_ENTRIES = 32;
const ER_TABLE_METADATA_CACHE_MAX_ENTRIES = 256;

const schemaTableNamesCache = createBoundedAsyncCache<string[]>(ER_SCHEMA_CACHE_MAX_ENTRIES);
const databaseForeignKeysCache = createBoundedAsyncCache<Map<string, ForeignKeyDefinition[]>>(ER_SCHEMA_CACHE_MAX_ENTRIES);
const tableColumnsCache = createBoundedAsyncCache<ColumnDefinition[]>(ER_TABLE_METADATA_CACHE_MAX_ENTRIES);
const tableForeignKeysCache = createBoundedAsyncCache<ForeignKeyDefinition[]>(ER_TABLE_METADATA_CACHE_MAX_ENTRIES);
const tableUniqueKeyGroupsCache = createBoundedAsyncCache<string[][]>(ER_TABLE_METADATA_CACHE_MAX_ENTRIES);

const DEFAULT_EMPTY_STATE: DataGridErDiagramState = {
  graph: null,
  loading: false,
  reloading: false,
  error: '',
  partial: false,
  warningCount: 0,
  canExpandRelations: false,
};

const normalizeConnectionConfig = (connection: any) => ({
  ...connection?.config,
  port: Number(connection?.config?.port),
  password: connection?.config?.password || '',
  database: connection?.config?.database || '',
  useSSH: connection?.config?.useSSH || false,
  ssh: connection?.config?.ssh || { host: '', port: 22, user: '', password: '', keyPath: '' },
});

const invalidateCacheByPrefix = (prefix: string) => {
  [
    schemaTableNamesCache,
    databaseForeignKeysCache,
    tableColumnsCache,
    tableForeignKeysCache,
    tableUniqueKeyGroupsCache,
  ].forEach((cache) => {
    cache.invalidatePrefix(prefix);
  });
};

const runWithConcurrency = async <T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<Array<PromiseSettledResult<R>>> => {
  if (items.length === 0) {
    return [];
  }

  const results: Array<PromiseSettledResult<R>> = new Array(items.length);
  let cursor = 0;

  const executeNext = async (): Promise<void> => {
    const index = cursor;
    cursor += 1;
    if (index >= items.length) {
      return;
    }
    try {
      const value = await worker(items[index]);
      results[index] = { status: 'fulfilled', value };
    } catch (error) {
      results[index] = { status: 'rejected', reason: error };
    }
    await executeNext();
  };

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => executeNext()),
  );

  return results;
};

const loadSchemaTableNames = async (
  config: any,
  dbName: string,
  schemaCacheKey: string,
): Promise<string[]> => schemaTableNamesCache.getOrLoad(schemaCacheKey, async () => {
  const response = await DBGetTables(buildRpcConnectionConfig(config) as any, dbName);
  if (!response?.success) {
    throw new Error(response?.message || 'Failed to load tables');
  }
  return extractErTableNames(response.data);
});

const loadTableColumns = async (
  config: any,
  dbName: string,
  tableName: string,
  cacheKey: string,
): Promise<ColumnDefinition[]> => tableColumnsCache.getOrLoad(cacheKey, async () => {
  const response = await DBGetColumns(buildRpcConnectionConfig(config) as any, dbName, tableName);
  if (!response?.success) {
    throw new Error(response?.message || `Failed to load columns for ${tableName}`);
  }
  return normalizeColumnDefinitions(response.data);
});

const loadTableForeignKeys = async (
  config: any,
  dbName: string,
  tableName: string,
  cacheKey: string,
): Promise<ForeignKeyDefinition[]> => tableForeignKeysCache.getOrLoad(cacheKey, async () => {
  const response = await DBGetForeignKeys(buildRpcConnectionConfig(config) as any, dbName, tableName);
  if (!response?.success) {
    throw new Error(response?.message || `Failed to load foreign keys for ${tableName}`);
  }
  return normalizeForeignKeyDefinitions(response.data);
});

const loadDatabaseForeignKeys = async (
  config: any,
  dbName: string,
  cacheKey: string,
): Promise<Map<string, ForeignKeyDefinition[]>> => databaseForeignKeysCache.getOrLoad(cacheKey, async () => {
  const response = await DBGetDatabaseForeignKeys(buildRpcConnectionConfig(config) as any, dbName);
  if (!response?.success || !response.data || typeof response.data !== 'object' || Array.isArray(response.data)) {
    throw new Error(response?.message || 'Failed to load database foreign keys');
  }

  const result = new Map<string, ForeignKeyDefinition[]>();
  Object.entries(response.data as Record<string, unknown>).forEach(([sourceTableName, rawForeignKeys]) => {
    const key = normalizeErQualifiedName(sourceTableName);
    if (!key) {
      return;
    }
    result.set(key, normalizeForeignKeyDefinitions(rawForeignKeys));
  });
  return result;
});

const loadTableUniqueKeyGroups = async (
  config: any,
  dbName: string,
  tableName: string,
  cacheKey: string,
): Promise<string[][]> => tableUniqueKeyGroupsCache.getOrLoad(cacheKey, async () => {
  const response = await DBGetIndexes(buildRpcConnectionConfig(config) as any, dbName, tableName);
  if (!response?.success || !Array.isArray(response.data)) {
    return [];
  }
  return resolveUniqueKeyGroupsFromIndexes(response.data);
});

const loadTableSnapshot = async (
  config: any,
  dbName: string,
  tableName: string,
  tableCacheKey: string,
  prefetchedForeignKeys?: Promise<ForeignKeyDefinition[]>,
): Promise<ErDiagramTableSnapshot> => {
  const [columnsResult, foreignKeysResult, uniqueKeyGroupsResult] = await Promise.allSettled([
    loadTableColumns(config, dbName, tableName, `${tableCacheKey}|columns`),
    prefetchedForeignKeys
      || loadTableForeignKeys(config, dbName, tableName, `${tableCacheKey}|foreignKeys`),
    loadTableUniqueKeyGroups(config, dbName, tableName, `${tableCacheKey}|uniqueKeys`),
  ]);

  if (columnsResult.status === 'rejected') {
    throw columnsResult.reason;
  }

  return {
    tableName,
    columns: columnsResult.value,
    foreignKeys: foreignKeysResult.status === 'fulfilled' ? foreignKeysResult.value : [],
    uniqueKeyGroups: uniqueKeyGroupsResult.status === 'fulfilled' ? uniqueKeyGroupsResult.value : [],
  };
};

const dedupeRelations = (relations: ErDiagramRelation[]): ErDiagramRelation[] => {
  const seen = new Set<string>();
  const result: ErDiagramRelation[] = [];
  relations.forEach((relation) => {
    const key = [
      normalizeErQualifiedName(relation.sourceTableName),
      normalizeErQualifiedName(relation.targetTableName),
      relation.columnName.toLowerCase(),
      relation.refColumnName.toLowerCase(),
      relation.direction,
      relation.constraintName.toLowerCase(),
    ].join('|');
    if (!key || seen.has(key)) {
      return;
    }
    seen.add(key);
    result.push(relation);
  });
  return result;
};

const dedupeTableNames = (tableNames: string[]): string[] => {
  const seen = new Set<string>();
  const result: string[] = [];
  tableNames.forEach((tableName) => {
    const normalized = normalizeErQualifiedName(tableName);
    if (!normalized || seen.has(normalized)) {
      return;
    }
    seen.add(normalized);
    result.push(tableName);
  });
  return result;
};

const createEmptySnapshot = (tableName: string): ErDiagramTableSnapshot => ({
  tableName,
  columns: [],
  foreignKeys: [],
  uniqueKeyGroups: [],
});

type CollectErDiagramNeighborhoodParams = {
  currentSnapshot: ErDiagramTableSnapshot;
  schemaTableNames: string[];
  relationDepth: number;
  loadSnapshot: (tableName: string) => Promise<ErDiagramTableSnapshot>;
  loadForeignKeys: (tableName: string) => Promise<ForeignKeyDefinition[]>;
  resolveTableName: (tableName: string) => string;
  prefetchedForeignKeysByTable?: ReadonlyMap<string, ForeignKeyDefinition[]>;
};

type CollectErDiagramNeighborhoodResult = {
  relatedSnapshots: ErDiagramTableSnapshot[];
  relations: ErDiagramRelation[];
  warningCount: number;
  canExpandRelations: boolean;
};

export const collectErDiagramNeighborhood = async (
  params: CollectErDiagramNeighborhoodParams,
): Promise<CollectErDiagramNeighborhoodResult> => {
  const maxDepth = Math.max(1, Math.floor(Number(params.relationDepth) || 1));
  const currentTableName = String(params.currentSnapshot.tableName || '').trim();
  const currentKey = normalizeErQualifiedName(currentTableName);
  const tableNameByKey = new Map<string, string>();
  const snapshotByKey = new Map<string, ErDiagramTableSnapshot>();
  const foreignKeysByKey = new Map<string, ForeignKeyDefinition[]>();
  const visitedKeys = new Set<string>();
  const relations: ErDiagramRelation[] = [];
  let warningCount = 0;

  const registerTableName = (tableName: string): string => {
    const actualTableName = String(tableName || '').trim();
    const normalized = normalizeErQualifiedName(actualTableName);
    if (!normalized) {
      return actualTableName;
    }
    if (!tableNameByKey.has(normalized)) {
      tableNameByKey.set(normalized, actualTableName);
    }
    return tableNameByKey.get(normalized) || actualTableName;
  };

  const registerRelationTarget = (tableName: string): string => registerTableName(params.resolveTableName(tableName));

  registerTableName(currentTableName);
  params.schemaTableNames.forEach(registerTableName);
  params.prefetchedForeignKeysByTable?.forEach((foreignKeys, tableName) => {
    const actualTableName = registerTableName(tableName);
    const tableKey = normalizeErQualifiedName(actualTableName);
    if (tableKey) {
      foreignKeysByKey.set(tableKey, foreignKeys);
    }
  });
  params.currentSnapshot.foreignKeys.forEach((foreignKey) => {
    registerRelationTarget(foreignKey.refTableName);
  });
  const currentForeignKeys = foreignKeysByKey.has(currentKey)
    ? foreignKeysByKey.get(currentKey) || []
    : params.currentSnapshot.foreignKeys || [];
  snapshotByKey.set(currentKey, {
    ...params.currentSnapshot,
    tableName: registerTableName(params.currentSnapshot.tableName),
    foreignKeys: currentForeignKeys,
  });
  foreignKeysByKey.set(currentKey, currentForeignKeys);
  visitedKeys.add(currentKey);

  const loadSnapshotByKey = async (tableKey: string): Promise<ErDiagramTableSnapshot> => {
    const cached = snapshotByKey.get(tableKey);
    if (cached) {
      return cached;
    }

    const tableName = tableNameByKey.get(tableKey) || tableKey;
    try {
      const snapshot = await params.loadSnapshot(tableName);
      const actualTableName = registerTableName(snapshot.tableName || tableName);
      const normalizedActualTableName = normalizeErQualifiedName(actualTableName);
      const snapshotForeignKeys = foreignKeysByKey.has(tableKey)
        ? foreignKeysByKey.get(tableKey) || []
        : snapshot.foreignKeys || [];
      const nextSnapshot = {
        ...snapshot,
        tableName: actualTableName,
        foreignKeys: snapshotForeignKeys,
      };
      snapshotByKey.set(tableKey, nextSnapshot);
      foreignKeysByKey.set(tableKey, snapshotForeignKeys);
      snapshotByKey.set(normalizedActualTableName, nextSnapshot);
      foreignKeysByKey.set(normalizedActualTableName, snapshotForeignKeys);
      return nextSnapshot;
    } catch {
      warningCount += 1;
      const emptySnapshot = createEmptySnapshot(tableName);
      snapshotByKey.set(tableKey, emptySnapshot);
      foreignKeysByKey.set(tableKey, []);
      return emptySnapshot;
    }
  };

  const loadForeignKeysByKey = async (tableKey: string): Promise<ForeignKeyDefinition[]> => {
    const cached = foreignKeysByKey.get(tableKey);
    if (cached) {
      return cached;
    }

    const tableName = tableNameByKey.get(tableKey) || tableKey;
    try {
      const foreignKeys = await params.loadForeignKeys(tableName);
      foreignKeysByKey.set(tableKey, foreignKeys);
      return foreignKeys;
    } catch {
      warningCount += 1;
      foreignKeysByKey.set(tableKey, []);
      return [];
    }
  };

  const frontierHasUndiscoveredNeighbors = async (frontierKeys: string[]): Promise<boolean> => {
    if (frontierKeys.length === 0) {
      return false;
    }

    const frontierSet = new Set(frontierKeys);
    await runWithConcurrency(frontierKeys, 4, async (frontierKey) => {
      await loadSnapshotByKey(frontierKey);
      return frontierKey;
    });

    for (const frontierKey of frontierKeys) {
      const snapshot = snapshotByKey.get(frontierKey) || createEmptySnapshot(tableNameByKey.get(frontierKey) || frontierKey);
      for (const foreignKey of snapshot.foreignKeys) {
        const targetTableName = registerRelationTarget(foreignKey.refTableName);
        const targetKey = normalizeErQualifiedName(targetTableName);
        if (targetKey && targetKey !== frontierKey && !visitedKeys.has(targetKey)) {
          return true;
        }
      }
    }

    const candidateKeys = Array.from(tableNameByKey.keys()).filter(
      (candidateKey) => !visitedKeys.has(candidateKey) && !frontierSet.has(candidateKey),
    );
    const incomingResults = await runWithConcurrency(candidateKeys, 6, async (candidateKey) => ({
      candidateKey,
      foreignKeys: await loadForeignKeysByKey(candidateKey),
    }));
    return incomingResults.some((result) => {
      if (result.status !== 'fulfilled') {
        return false;
      }
      return result.value.foreignKeys.some((foreignKey) => {
        const targetTableName = registerRelationTarget(foreignKey.refTableName);
        const targetKey = normalizeErQualifiedName(targetTableName);
        return Boolean(targetKey) && frontierSet.has(targetKey);
      });
    });
  };

  let frontierKeys = [currentKey];

  for (let depth = 0; depth < maxDepth; depth += 1) {
    if (frontierKeys.length === 0) {
      break;
    }

    const frontierSet = new Set(frontierKeys);
    await runWithConcurrency(frontierKeys, 4, async (frontierKey) => {
      await loadSnapshotByKey(frontierKey);
      return frontierKey;
    });

    const nextFrontierKeys = new Set<string>();

    frontierKeys.forEach((frontierKey) => {
      const snapshot = snapshotByKey.get(frontierKey) || createEmptySnapshot(tableNameByKey.get(frontierKey) || frontierKey);
      snapshot.foreignKeys.forEach((foreignKey) => {
        const targetTableName = registerRelationTarget(foreignKey.refTableName);
        const targetKey = normalizeErQualifiedName(targetTableName);
        if (!targetKey) {
          return;
        }
        relations.push({
          sourceTableName: snapshot.tableName,
          targetTableName,
          columnName: foreignKey.columnName,
          refColumnName: foreignKey.refColumnName,
          constraintName: foreignKey.constraintName || foreignKey.name || '',
          direction: targetKey === frontierKey ? 'self' : 'outgoing',
        });
        if (targetKey !== frontierKey && !visitedKeys.has(targetKey)) {
          visitedKeys.add(targetKey);
          nextFrontierKeys.add(targetKey);
        }
      });
    });

    const incomingResults = await runWithConcurrency(
      Array.from(tableNameByKey.keys()).filter((candidateKey) => !frontierSet.has(candidateKey)),
      6,
      async (candidateKey) => ({
        candidateKey,
        foreignKeys: await loadForeignKeysByKey(candidateKey),
      }),
    );

    incomingResults.forEach((result) => {
      if (result.status !== 'fulfilled') {
        return;
      }

      const sourceTableName = tableNameByKey.get(result.value.candidateKey) || result.value.candidateKey;
      result.value.foreignKeys.forEach((foreignKey) => {
        const targetTableName = registerRelationTarget(foreignKey.refTableName);
        const targetKey = normalizeErQualifiedName(targetTableName);
        if (!targetKey || !frontierSet.has(targetKey)) {
          return;
        }
        relations.push({
          sourceTableName,
          targetTableName: tableNameByKey.get(targetKey) || targetTableName,
          columnName: foreignKey.columnName,
          refColumnName: foreignKey.refColumnName,
          constraintName: foreignKey.constraintName || foreignKey.name || '',
          direction: result.value.candidateKey === targetKey ? 'self' : 'incoming',
        });
        if (result.value.candidateKey !== targetKey && !visitedKeys.has(result.value.candidateKey)) {
          visitedKeys.add(result.value.candidateKey);
          nextFrontierKeys.add(result.value.candidateKey);
        }
      });
    });

    frontierKeys = Array.from(nextFrontierKeys);
  }

  const relatedKeys = Array.from(visitedKeys).filter((tableKey) => tableKey !== currentKey);
  await runWithConcurrency(relatedKeys, 4, async (relatedKey) => {
    await loadSnapshotByKey(relatedKey);
    return relatedKey;
  });

  return {
    relatedSnapshots: relatedKeys.map((relatedKey) => (
      snapshotByKey.get(relatedKey) || createEmptySnapshot(tableNameByKey.get(relatedKey) || relatedKey)
    )),
    relations: dedupeRelations(relations),
    warningCount,
    canExpandRelations: await frontierHasUndiscoveredNeighbors(frontierKeys),
  };
};

export const useDataGridErDiagram = (params: DataGridErDiagramParams) => {
  const {
    connections,
    connectionId,
    dbName,
    tableName,
    relationDepth = 1,
  } = params;

  const [state, setState] = useState<DataGridErDiagramState>(DEFAULT_EMPTY_STATE);
  const [reloadVersion, setReloadVersion] = useState(0);
  const requestSeqRef = useRef(0);
  const normalizedDbName = useMemo(() => String(dbName || '').trim(), [dbName]);
  const normalizedTableName = useMemo(() => String(tableName || '').trim(), [tableName]);
  const cachePrefix = useMemo(
    () => `${String(connectionId || '').trim()}|${normalizedDbName}|`,
    [connectionId, normalizedDbName],
  );

  const reload = useCallback(() => {
    if (!cachePrefix) {
      return;
    }
    invalidateCacheByPrefix(cachePrefix);
    requestSeqRef.current += 1;
    setReloadVersion((version) => version + 1);
    setState((prev) => ({
      ...prev,
      loading: !prev.graph,
      reloading: Boolean(prev.graph),
      error: '',
    }));
  }, [cachePrefix]);

  useEffect(() => {
    if (!connectionId || !normalizedTableName) {
      setState(DEFAULT_EMPTY_STATE);
      return;
    }

    const connection = connections.find((item) => item.id === connectionId);
    if (!connection) {
      setState({
        ...DEFAULT_EMPTY_STATE,
        error: 'Connection not found',
      });
      return;
    }

    const seq = ++requestSeqRef.current;
    const config = normalizeConnectionConfig(connection);
    const schemaCacheKey = `${cachePrefix}schemaTables`;
    const databaseForeignKeysCacheKey = `${cachePrefix}databaseForeignKeys`;
    const currentTableCacheKey = `${cachePrefix}${normalizedTableName}`;
    const isKingbase = resolveDataSourceType(config) === 'kingbase';

    setState((prev) => ({
      ...prev,
      loading: !prev.graph,
      reloading: Boolean(prev.graph),
      error: '',
      partial: false,
      warningCount: 0,
      canExpandRelations: false,
    }));

    const loadGraph = async () => {
      let warningCount = 0;
      const databaseForeignKeysResultPromise = isKingbase
        ? loadDatabaseForeignKeys(config, normalizedDbName, databaseForeignKeysCacheKey)
          .then((value) => ({ value, failed: false as const }))
          .catch(() => ({ value: null, failed: true as const }))
        : null;
      const prefetchedCurrentForeignKeys = databaseForeignKeysResultPromise
        ? databaseForeignKeysResultPromise.then((result) => {
          if (result.value) {
            return result.value.get(normalizeErQualifiedName(normalizedTableName)) || [];
          }
          return loadTableForeignKeys(
            config,
            normalizedDbName,
            normalizedTableName,
            `${currentTableCacheKey}|foreignKeys`,
          );
        })
        : undefined;
      const currentSnapshot = await loadTableSnapshot(
        config,
        normalizedDbName,
        normalizedTableName,
        currentTableCacheKey,
        prefetchedCurrentForeignKeys,
      );

      let schemaTableNames = [currentSnapshot.tableName];
      try {
        schemaTableNames = await loadSchemaTableNames(config, normalizedDbName, schemaCacheKey);
      } catch {
        warningCount += 1;
      }

      const resolvedSchemaTableNames = extractErTableNames([
        ...schemaTableNames.map((name) => ({ table: name })),
        ...currentSnapshot.foreignKeys.map((foreignKey) => ({ table: foreignKey.refTableName })),
        { table: currentSnapshot.tableName },
      ]);

      const resolveTableName = (name: string) => resolveErActualTableName(name, resolvedSchemaTableNames);
      let prefetchedForeignKeysByTable: Map<string, ForeignKeyDefinition[]> | undefined;
      if (databaseForeignKeysResultPromise) {
        const databaseForeignKeysResult = await databaseForeignKeysResultPromise;
        prefetchedForeignKeysByTable = new Map(
          resolvedSchemaTableNames.map((name) => [normalizeErQualifiedName(name), []]),
        );
        databaseForeignKeysResult.value?.forEach((foreignKeys, tableKey) => {
          prefetchedForeignKeysByTable?.set(tableKey, foreignKeys);
        });
        prefetchedForeignKeysByTable.set(
          normalizeErQualifiedName(currentSnapshot.tableName),
          currentSnapshot.foreignKeys,
        );
        if (databaseForeignKeysResult.failed) {
          warningCount += 1;
        }
      }

      const neighborhood = await collectErDiagramNeighborhood({
        currentSnapshot,
        schemaTableNames: resolvedSchemaTableNames,
        relationDepth,
        loadSnapshot: async (relatedTableName) => {
          const tableCacheKey = `${cachePrefix}${relatedTableName}`;
          const prefetchedForeignKeys = prefetchedForeignKeysByTable
            ? Promise.resolve(
              prefetchedForeignKeysByTable.get(normalizeErQualifiedName(relatedTableName)) || [],
            )
            : undefined;
          return loadTableSnapshot(
            config,
            normalizedDbName,
            relatedTableName,
            tableCacheKey,
            prefetchedForeignKeys,
          );
        },
        loadForeignKeys: async (relatedTableName) => {
          const tableCacheKey = `${cachePrefix}${relatedTableName}`;
          return loadTableForeignKeys(config, normalizedDbName, relatedTableName, `${tableCacheKey}|foreignKeys`);
        },
        resolveTableName,
        prefetchedForeignKeysByTable,
      });
      warningCount += neighborhood.warningCount;

      return {
        graph: buildErDiagramGraph({
          currentTableName: currentSnapshot.tableName,
          currentSnapshot,
          relatedSnapshots: neighborhood.relatedSnapshots,
          relations: neighborhood.relations,
        }),
        partial: warningCount > 0,
        warningCount,
        canExpandRelations: neighborhood.canExpandRelations,
      };
    };

    void loadGraph()
      .then((result) => {
        if (seq !== requestSeqRef.current) {
          return;
        }
        setState({
          graph: result.graph,
          loading: false,
          reloading: false,
          error: '',
          partial: result.partial,
          warningCount: result.warningCount,
          canExpandRelations: result.canExpandRelations,
        });
      })
      .catch((error) => {
        if (seq !== requestSeqRef.current) {
          return;
        }
        setState({
          graph: null,
          loading: false,
          reloading: false,
          error: error instanceof Error ? error.message : String(error || 'Failed to load ER diagram'),
          partial: false,
          warningCount: 0,
          canExpandRelations: false,
        });
      });
  }, [cachePrefix, connectionId, connections, normalizedDbName, normalizedTableName, relationDepth, reloadVersion]);

  return {
    ...state,
    reload,
  };
};
