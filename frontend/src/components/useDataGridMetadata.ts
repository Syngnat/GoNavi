import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DBGetColumns, DBGetForeignKeys, DBGetIndexes } from '../../wailsjs/go/app/App';
import { buildRpcConnectionConfig } from '../utils/connectionRpcConfig';
import { resolveDataSourceType } from '../utils/dataSourceCapabilities';
import { requestTableMetadata } from '../utils/tableMetadataRequestCache';
import { GONAVI_ROW_KEY } from './DataGridCore';
import { buildColumnMetaMap, hasUsableColumnMeta } from './dataGridColumnMeta';
import {
  applyIndexColumnKeysToColumnMetaMap,
  resolveIndexColumnKeys,
  type DataGridColumnIndexKey,
} from './dataGridColumnTypeMarker';
import { resolveUniqueKeyGroupsFromIndexes } from './dataGridCopyInsert';

type UseDataGridMetadataContext = Record<string, any>;

export const useDataGridMetadata = (ctx: UseDataGridMetadataContext) => {
  const {
    connections,
    connectionId,
    connectionParamsOverride,
    dbName,
    tableName,
    exportScope,
    visibleColumnNames,
    loading,
    initialColumnMetaMap,
    initialUniqueKeyGroups,
  } = ctx;

  const isKingbaseQueryResult = exportScope === 'queryResult'
    && resolveDataSourceType(connections.find((item: { id: string }) => item.id === connectionId)?.config) === 'kingbase';
  const hasAuthoritativeEmptyMap = isKingbaseQueryResult && initialColumnMetaMap != null
    && typeof initialColumnMetaMap === 'object' && !Array.isArray(initialColumnMetaMap) && Object.keys(initialColumnMetaMap).length === 0;
  const hasInitialColumnMeta = hasUsableColumnMeta(initialColumnMetaMap || {});
  const hasInitialUniqueKeyGroups = Array.isArray(initialUniqueKeyGroups);

  const [columnMetaMap, setColumnMetaMap] = useState<Record<string, any>>({});
  const [foreignKeyMap, setForeignKeyMap] = useState<Record<string, any>>({});
  const [uniqueKeyGroups, setUniqueKeyGroups] = useState<string[][]>([]);
  const [metadataReloadVersion, setMetadataReloadVersion] = useState(0);
  const columnMetaCacheRef = useRef<Record<string, Record<string, any>>>({});
  const columnMetaSeqRef = useRef(0);
  const foreignKeyCacheRef = useRef<Record<string, Record<string, any>>>({});
  const foreignKeySeqRef = useRef(0);
  const uniqueKeyGroupsCacheRef = useRef<Record<string, string[][]>>({});
  const uniqueKeyGroupsSeqRef = useRef(0);
  const indexColumnKeysRef = useRef<Record<string, Record<string, DataGridColumnIndexKey>>>({});
  const metadataConnectionParams = useMemo(() => {
    if (connectionParamsOverride !== undefined) {
      return String(connectionParamsOverride || '');
    }
    const conn = connections.find((item: any) => item.id === connectionId);
    return String(conn?.config?.connectionParams || '');
  }, [connectionId, connectionParamsOverride, connections]);
  const metadataCacheKey = useMemo(() => JSON.stringify([
    String(connectionId || '').trim(),
    String(dbName || '').trim(),
    String(tableName || '').trim(),
    metadataConnectionParams,
  ]), [connectionId, dbName, metadataConnectionParams, tableName]);
  const deferKingbaseMetadata = useMemo(() => {
    if (!loading) return false;
    const conn = connections.find((item: any) => item.id === connectionId);
    return resolveDataSourceType(conn?.config) === 'kingbase';
  }, [connections, connectionId, loading]);

  useEffect(() => {
    const normalizedTableName = String(tableName || '').trim();
    const normalizedDbName = String(dbName || '').trim();
    if (!connectionId || !normalizedTableName) {
      setColumnMetaMap(current => Object.keys(current).length ? {} : current);
      setForeignKeyMap(current => Object.keys(current).length ? {} : current);
      setUniqueKeyGroups(current => current.length ? [] : current);
      return;
    }
    const cacheKey = metadataCacheKey;
    columnMetaSeqRef.current += 1;
    if (hasInitialColumnMeta) {
      columnMetaCacheRef.current[cacheKey] = initialColumnMetaMap;
    } else {
      setColumnMetaMap(columnMetaCacheRef.current[cacheKey] || {});
    }
    foreignKeySeqRef.current += 1;
    const cachedForeignKeys = exportScope === 'table' ? foreignKeyCacheRef.current[cacheKey] : undefined;
    setForeignKeyMap(current => cachedForeignKeys || (Object.keys(current).length ? {} : current));
    uniqueKeyGroupsSeqRef.current += 1;
    if (hasInitialUniqueKeyGroups) {
      uniqueKeyGroupsCacheRef.current[cacheKey] = initialUniqueKeyGroups;
    } else {
      setUniqueKeyGroups(uniqueKeyGroupsCacheRef.current[cacheKey] || []);
    }
  }, [connectionId, dbName, tableName, exportScope, hasInitialColumnMeta, hasInitialUniqueKeyGroups, initialColumnMetaMap, initialUniqueKeyGroups, metadataCacheKey]);

  useEffect(() => {
    const normalizedTableName = String(tableName || '').trim();
    const normalizedDbName = String(dbName || '').trim();
    if (!connectionId || !normalizedTableName || deferKingbaseMetadata || hasInitialColumnMeta || hasAuthoritativeEmptyMap) return;

    const cacheKey = metadataCacheKey;
    if (columnMetaCacheRef.current[cacheKey]) return;

    const conn = connections.find((item: any) => item.id === connectionId);
    if (!conn) {
      setColumnMetaMap({});
      return;
    }

    const config = {
      ...conn.config,
      port: Number(conn.config.port),
      password: conn.config.password || '',
      database: conn.config.database || '',
      useSSH: conn.config.useSSH || false,
      ssh: conn.config.ssh || { host: '', port: 22, user: '', password: '', keyPath: '' },
    };

    const seq = ++columnMetaSeqRef.current;
    const loadColumnMeta = async () => {
      let nextMap: Record<string, any> | null = null;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const res = await requestTableMetadata(
            {
              connectionId,
              dbName: normalizedDbName,
              tableName: normalizedTableName,
              kind: 'columns',
              connectionParams: metadataConnectionParams,
            },
            () => DBGetColumns(buildRpcConnectionConfig(config) as any, normalizedDbName, normalizedTableName),
            { force: metadataReloadVersion > 0 || attempt > 0 },
          );
          if (seq !== columnMetaSeqRef.current) return;
          if (!res.success || !Array.isArray(res.data)) {
            continue;
          }
          const candidateMap = applyIndexColumnKeysToColumnMetaMap(
            buildColumnMetaMap(res.data as any[]),
            indexColumnKeysRef.current[cacheKey],
          );
          if (!hasUsableColumnMeta(candidateMap)) {
            continue;
          }
          nextMap = candidateMap;
          break;
        } catch {
          if (seq !== columnMetaSeqRef.current) return;
        }
      }

      if (seq !== columnMetaSeqRef.current) return;
      if (nextMap) {
        columnMetaCacheRef.current[cacheKey] = nextMap;
        setColumnMetaMap(nextMap);
        return;
      }
      setColumnMetaMap({});
    };

    void loadColumnMeta();
  }, [
    connections,
    connectionId,
    dbName,
    tableName,
    metadataReloadVersion,
    deferKingbaseMetadata,
    metadataCacheKey,
    metadataConnectionParams,
    hasInitialColumnMeta,
    hasAuthoritativeEmptyMap,
  ]);

  useEffect(() => {
    const normalizedTableName = String(tableName || '').trim();
    const normalizedDbName = String(dbName || '').trim();
    if (!connectionId || !normalizedTableName || exportScope !== 'table' || deferKingbaseMetadata) return;

    const cacheKey = metadataCacheKey;
    if (foreignKeyCacheRef.current[cacheKey]) return;

    const conn = connections.find((item: any) => item.id === connectionId);
    if (!conn) {
      setForeignKeyMap({});
      return;
    }

    const config = {
      ...conn.config,
      port: Number(conn.config.port),
      password: conn.config.password || '',
      database: conn.config.database || '',
      useSSH: conn.config.useSSH || false,
      ssh: conn.config.ssh || { host: '', port: 22, user: '', password: '', keyPath: '' },
    };

    const seq = ++foreignKeySeqRef.current;
    requestTableMetadata(
      {
        connectionId,
        dbName: normalizedDbName,
        tableName: normalizedTableName,
        kind: 'foreignKeys',
        connectionParams: metadataConnectionParams,
      },
      () => DBGetForeignKeys(buildRpcConnectionConfig(config) as any, normalizedDbName, normalizedTableName),
      { force: metadataReloadVersion > 0 },
    )
      .then((res) => {
        if (seq !== foreignKeySeqRef.current) return;
        if (!res.success || !Array.isArray(res.data)) {
          setForeignKeyMap({});
          return;
        }
        const nextMap: Record<string, any> = {};
        (res.data as any[]).forEach((fk: any) => {
          const columnName = String(fk?.columnName ?? fk?.ColumnName ?? '').trim();
          const refTableName = String(fk?.refTableName ?? fk?.RefTableName ?? '').trim();
          if (!columnName || !refTableName || refTableName === '-') return;
          nextMap[columnName] = {
            columnName,
            refTableName,
            refColumnName: String(fk?.refColumnName ?? fk?.RefColumnName ?? '').trim(),
            constraintName: String(fk?.constraintName ?? fk?.ConstraintName ?? fk?.name ?? fk?.Name ?? '').trim(),
          };
        });
        foreignKeyCacheRef.current[cacheKey] = nextMap;
        setForeignKeyMap(nextMap);
      })
      .catch(() => {
        if (seq !== foreignKeySeqRef.current) return;
        setForeignKeyMap({});
      });
  }, [
    connections,
    connectionId,
    dbName,
    tableName,
    exportScope,
    metadataReloadVersion,
    deferKingbaseMetadata,
    metadataCacheKey,
    metadataConnectionParams,
  ]);

  useEffect(() => {
    const normalizedTableName = String(tableName || '').trim();
    const normalizedDbName = String(dbName || '').trim();
    if (!connectionId || !normalizedTableName || deferKingbaseMetadata || hasInitialUniqueKeyGroups) return;

    const cacheKey = metadataCacheKey;
    if (uniqueKeyGroupsCacheRef.current[cacheKey]) return;

    const conn = connections.find((item: any) => item.id === connectionId);
    if (!conn) {
      setUniqueKeyGroups([]);
      return;
    }

    const config = {
      ...conn.config,
      port: Number(conn.config.port),
      password: conn.config.password || '',
      database: conn.config.database || '',
      useSSH: conn.config.useSSH || false,
      ssh: conn.config.ssh || { host: '', port: 22, user: '', password: '', keyPath: '' },
    };

    const seq = ++uniqueKeyGroupsSeqRef.current;
    requestTableMetadata(
      {
        connectionId,
        dbName: normalizedDbName,
        tableName: normalizedTableName,
        kind: 'indexes',
        connectionParams: metadataConnectionParams,
      },
      () => DBGetIndexes(config as any, normalizedDbName, normalizedTableName),
      { force: metadataReloadVersion > 0 },
    )
      .then((res) => {
        if (seq !== uniqueKeyGroupsSeqRef.current) return;
        if (!res.success || !Array.isArray(res.data)) {
          setUniqueKeyGroups([]);
          return;
        }
        const nextGroups = resolveUniqueKeyGroupsFromIndexes(res.data as any[]);
        uniqueKeyGroupsCacheRef.current[cacheKey] = nextGroups;
        setUniqueKeyGroups(nextGroups);
        const nextIndexKeys = resolveIndexColumnKeys(res.data as any[]);
        indexColumnKeysRef.current[cacheKey] = nextIndexKeys;
        setColumnMetaMap((prev) => {
          const merged = applyIndexColumnKeysToColumnMetaMap(prev, nextIndexKeys);
          if (Object.keys(prev).length > 0) {
            columnMetaCacheRef.current[cacheKey] = merged;
          }
          return merged;
        });
      })
      .catch(() => {
        if (seq !== uniqueKeyGroupsSeqRef.current) return;
        setUniqueKeyGroups([]);
      });
  }, [
    connections,
    connectionId,
    dbName,
    tableName,
    metadataReloadVersion,
    deferKingbaseMetadata,
    metadataCacheKey,
    metadataConnectionParams,
    hasInitialUniqueKeyGroups,
  ]);

  const resolvedColumnMetaMap = hasInitialColumnMeta || hasAuthoritativeEmptyMap ? initialColumnMetaMap : columnMetaMap;
  const resolvedUniqueKeyGroups = hasInitialUniqueKeyGroups ? initialUniqueKeyGroups : uniqueKeyGroups;

  const columnMetaMapByLowerName = useMemo(() => {
    const next: Record<string, any> = {};
    Object.entries(resolvedColumnMetaMap).forEach(([name, meta]) => {
      const lowerName = String(name || '').toLowerCase();
      if (!lowerName || next[lowerName]) return;
      next[lowerName] = meta;
    });
    return next;
  }, [resolvedColumnMetaMap]);

  const columnTypeMapByLowerName = useMemo(() => {
    const next: Record<string, string> = {};
    Object.entries(columnMetaMapByLowerName).forEach(([name, meta]) => {
      const type = String((meta as any)?.type || '').trim();
      if (!name || !type) return;
      next[name] = type;
    });
    return next;
  }, [columnMetaMapByLowerName]);

  const foreignKeyMapByLowerName = useMemo(() => {
    const next: Record<string, any> = {};
    Object.entries(foreignKeyMap).forEach(([name, target]) => {
      const lowerName = String(name || '').toLowerCase();
      if (!lowerName || next[lowerName]) return;
      next[lowerName] = target;
    });
    return next;
  }, [foreignKeyMap]);

  const getColumnFilterType = useCallback((columnName: string): string => {
    const normalizedName = String(columnName || '').trim();
    if (!normalizedName) return '';
    return (resolvedColumnMetaMap[normalizedName] || columnMetaMapByLowerName[normalizedName.toLowerCase()])?.type || '';
  }, [resolvedColumnMetaMap, columnMetaMapByLowerName]);

  const allTableColumnNames = useMemo(() => {
    const metaColumns = Object.keys(resolvedColumnMetaMap);
    if (exportScope !== 'table') {
      // 查询结果页：元数据可能来自按列名回填的多张源表，只能暴露结果集里真实出现的列，
      // 否则快捷过滤/复制语句会提示并使用结果集中不存在的列。
      if (metaColumns.length === 0) return [];
      const metaColumnKeys = new Set(metaColumns.map((name) => String(name || '').toLowerCase()));
      return visibleColumnNames.filter((columnName: string) => (
        columnName !== GONAVI_ROW_KEY && metaColumnKeys.has(String(columnName || '').toLowerCase())
      ));
    }
    if (metaColumns.length > 0) {
      return metaColumns;
    }
    return visibleColumnNames.filter((columnName: string) => columnName !== GONAVI_ROW_KEY);
  }, [resolvedColumnMetaMap, exportScope, visibleColumnNames]);

  return {
    allTableColumnNames,
    columnMetaCacheRef,
    columnMetaMap: resolvedColumnMetaMap,
    columnMetaMapByLowerName,
    columnTypeMapByLowerName,
    foreignKeyCacheRef,
    foreignKeyMap,
    foreignKeyMapByLowerName,
    getColumnFilterType,
    metadataCacheKey,
    metadataReloadVersion,
    setMetadataReloadVersion,
    uniqueKeyGroups: resolvedUniqueKeyGroups,
    uniqueKeyGroupsCacheRef,
  };
};
