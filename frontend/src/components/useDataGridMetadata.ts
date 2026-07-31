import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DBGetColumns, DBGetForeignKeys, DBGetIndexes } from '../../wailsjs/go/app/App';
import { buildRpcConnectionConfig } from '../utils/connectionRpcConfig';
import { resolveDataSourceType } from '../utils/dataSourceCapabilities';
import { requestTableMetadata } from '../utils/tableMetadataRequestCache';
import {
  buildColumnMetaMap,
  GONAVI_ROW_KEY,
  hasUsableColumnMeta,
} from './DataGridCore';
import { resolveUniqueKeyGroupsFromIndexes } from './dataGridCopyInsert';

type UseDataGridMetadataContext = Record<string, any>;

export const useDataGridMetadata = (ctx: UseDataGridMetadataContext) => {
  const {
    connections,
    connectionId,
    dbName,
    tableName,
    exportScope,
    visibleColumnNames,
    loading,
  } = ctx;

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
  const deferKingbaseMetadata = useMemo(() => {
    if (!loading) return false;
    const conn = connections.find((item: any) => item.id === connectionId);
    return resolveDataSourceType(conn?.config) === 'kingbase';
  }, [connections, connectionId, loading]);

  useEffect(() => {
    const normalizedTableName = String(tableName || '').trim();
    const normalizedDbName = String(dbName || '').trim();
    if (!connectionId || !normalizedTableName) {
      setColumnMetaMap({});
      setForeignKeyMap({});
      setUniqueKeyGroups([]);
      return;
    }
    const cacheKey = `${connectionId}|${normalizedDbName}|${normalizedTableName}`;
    columnMetaSeqRef.current += 1;
    setColumnMetaMap(columnMetaCacheRef.current[cacheKey] || {});
    foreignKeySeqRef.current += 1;
    setForeignKeyMap(exportScope === 'table' ? (foreignKeyCacheRef.current[cacheKey] || {}) : {});
    uniqueKeyGroupsSeqRef.current += 1;
    setUniqueKeyGroups(uniqueKeyGroupsCacheRef.current[cacheKey] || []);
  }, [connectionId, dbName, tableName, exportScope]);

  useEffect(() => {
    const normalizedTableName = String(tableName || '').trim();
    const normalizedDbName = String(dbName || '').trim();
    if (!connectionId || !normalizedTableName || deferKingbaseMetadata) return;

    const cacheKey = `${connectionId}|${normalizedDbName}|${normalizedTableName}`;
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
            { connectionId, dbName: normalizedDbName, tableName: normalizedTableName, kind: 'columns' },
            () => DBGetColumns(buildRpcConnectionConfig(config) as any, normalizedDbName, normalizedTableName),
            { force: metadataReloadVersion > 0 || attempt > 0 },
          );
          if (seq !== columnMetaSeqRef.current) return;
          if (!res.success || !Array.isArray(res.data)) {
            continue;
          }
          const candidateMap = buildColumnMetaMap(res.data as any[]);
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
  }, [connections, connectionId, dbName, tableName, metadataReloadVersion, deferKingbaseMetadata]);

  useEffect(() => {
    const normalizedTableName = String(tableName || '').trim();
    const normalizedDbName = String(dbName || '').trim();
    if (!connectionId || !normalizedTableName || exportScope !== 'table' || deferKingbaseMetadata) return;

    const cacheKey = `${connectionId}|${normalizedDbName}|${normalizedTableName}`;
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
      { connectionId, dbName: normalizedDbName, tableName: normalizedTableName, kind: 'foreignKeys' },
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
  }, [connections, connectionId, dbName, tableName, exportScope, metadataReloadVersion, deferKingbaseMetadata]);

  useEffect(() => {
    const normalizedTableName = String(tableName || '').trim();
    const normalizedDbName = String(dbName || '').trim();
    if (!connectionId || !normalizedTableName || deferKingbaseMetadata) return;

    const cacheKey = `${connectionId}|${normalizedDbName}|${normalizedTableName}`;
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
      { connectionId, dbName: normalizedDbName, tableName: normalizedTableName, kind: 'indexes' },
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
      })
      .catch(() => {
        if (seq !== uniqueKeyGroupsSeqRef.current) return;
        setUniqueKeyGroups([]);
      });
  }, [connections, connectionId, dbName, tableName, metadataReloadVersion, deferKingbaseMetadata]);

  const columnMetaMapByLowerName = useMemo(() => {
    const next: Record<string, any> = {};
    Object.entries(columnMetaMap).forEach(([name, meta]) => {
      const lowerName = String(name || '').toLowerCase();
      if (!lowerName || next[lowerName]) return;
      next[lowerName] = meta;
    });
    return next;
  }, [columnMetaMap]);

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
    return (columnMetaMap[normalizedName] || columnMetaMapByLowerName[normalizedName.toLowerCase()])?.type || '';
  }, [columnMetaMap, columnMetaMapByLowerName]);

  const allTableColumnNames = useMemo(() => {
    const metaColumns = Object.keys(columnMetaMap);
    if (metaColumns.length > 0) {
      return metaColumns;
    }
    if (exportScope === 'table') {
      return visibleColumnNames.filter((columnName: string) => columnName !== GONAVI_ROW_KEY);
    }
    return [];
  }, [columnMetaMap, exportScope, visibleColumnNames]);

  return {
    allTableColumnNames,
    columnMetaCacheRef,
    columnMetaMap,
    columnMetaMapByLowerName,
    columnTypeMapByLowerName,
    foreignKeyCacheRef,
    foreignKeyMap,
    foreignKeyMapByLowerName,
    getColumnFilterType,
    metadataReloadVersion,
    setMetadataReloadVersion,
    uniqueKeyGroups,
    uniqueKeyGroupsCacheRef,
  };
};
