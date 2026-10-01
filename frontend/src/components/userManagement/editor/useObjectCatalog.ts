import { useCallback, useEffect, useRef, useState } from 'react';
import { normalizeDatabaseNames } from '../../sidebar/databaseSchemaVisibility';
import { normalizeTableNamesFromMetadataRows } from '../../../utils/tableMetadataRows';
import type { RpcConnectionConfig } from '../../../utils/connectionRpcConfig';
import type { SavedConnection } from '../../../types';
import { loadFunctions, loadSequences, loadViews } from '../../sidebar/sidebarMetadataLoaders';
import type { UserManagementBackend } from '../userManagementRpc';
import { splitQualifiedTable, type CatalogObject } from './objectPrivilegeTree';

/** DBGetDatabases 返回 {Database: 名称} 行对象（也兼容纯字符串），统一取出库名。 */
export const extractDatabaseNames = (data: unknown): string[] => normalizeDatabaseNames(
  (Array.isArray(data) ? data : []).map((row) => (row && typeof row === 'object'
    ? (row as Record<string, unknown>).Database ?? (row as Record<string, unknown>).database ?? (row as Record<string, unknown>).name
    : row)),
);

const columnNames = (data: unknown): string[] => (Array.isArray(data) ? data : [])
  .map((row) => (row && typeof row === 'object' ? String((row as Record<string, unknown>).name || '') : String(row || '')))
  .filter(Boolean);

/**
 * 懒加载库/表/列清单并按键缓存，供对象权限树与库选择器复用。
 * 走已有的元数据绑定，不为用户管理新增元数据 RPC。
 */
export const useObjectCatalog = (
  backend: UserManagementBackend,
  config: RpcConnectionConfig | null,
  enabled: boolean,
  connection: SavedConnection | null = null,
  objectScopes: string[] = [],
) => {
  const [databases, setDatabases] = useState<string[]>([]);
  const cache = useRef(new Map<string, string[]>());
  const objectCache = useRef(new Map<string, CatalogObject[]>());
  const wantsSequences = objectScopes.includes('sequence');
  const wantsRoutines = objectScopes.includes('routine');

  useEffect(() => {
    cache.current.clear();
    objectCache.current.clear();
    if (!enabled || !config || typeof backend.DBGetDatabases !== 'function') {
      setDatabases([]);
      return;
    }
    let alive = true;
    backend.DBGetDatabases(config).then((result) => {
      if (alive && result?.success !== false) setDatabases(extractDatabaseNames(result?.data));
    }).catch(() => {
      if (alive) setDatabases([]);
    });
    return () => { alive = false; };
  }, [backend, config, enabled]);

  const loadTables = useCallback(async (database: string): Promise<string[]> => {
    const key = `t:${database}`;
    const cached = cache.current.get(key);
    if (cached) return cached;
    if (!config || typeof backend.DBGetTables !== 'function') return [];
    const result = await backend.DBGetTables(config, database);
    const names = result?.success === false ? [] : normalizeTableNamesFromMetadataRows(result?.data);
    cache.current.set(key, names);
    return names;
  }, [backend, config]);

  const loadColumns = useCallback(async (database: string, table: string): Promise<string[]> => {
    const key = `c:${database}\u001f${table}`;
    const cached = cache.current.get(key);
    if (cached) return cached;
    if (!config || typeof backend.DBGetColumns !== 'function') return [];
    const result = await backend.DBGetColumns(config, database, table);
    const names = result?.success === false ? [] : columnNames(result?.data);
    cache.current.set(key, names);
    return names;
  }, [backend, config]);

  /** 库 / 模式下除表以外的对象：视图、序列、函数与存储过程（复用侧栏元数据查询）。 */
  const loadObjects = useCallback(async (database: string): Promise<CatalogObject[]> => {
    const cached = objectCache.current.get(database);
    if (cached) return cached;
    if (!connection) return [];
    const [views, sequences, routines] = await Promise.all([
      loadViews(connection, database).catch(() => null),
      wantsSequences ? loadSequences(connection, database).catch(() => null) : null,
      wantsRoutines ? loadFunctions(connection, database).catch(() => null) : null,
    ]);
    const objects: CatalogObject[] = [
      ...(views?.views ?? []).map((item): CatalogObject => ({ kind: 'view', schema: item.schemaName || '', name: item.viewName })),
      ...(sequences?.sequences ?? []).map((item): CatalogObject => {
        const prefix = item.schemaName ? `${item.schemaName}.` : '';
        return { kind: 'sequence', schema: item.schemaName || '', name: prefix && item.sequenceName.startsWith(prefix) ? item.sequenceName.slice(prefix.length) : item.sequenceName };
      }),
      ...(routines?.routines ?? []).map((item): CatalogObject => {
        const { schema, table } = splitQualifiedTable(item.routineName);
        return { kind: 'routine', schema, name: table, objectType: item.routineType === 'PROCEDURE' ? 'PROCEDURE' : 'FUNCTION' };
      }),
    ];
    objectCache.current.set(database, objects);
    return objects;
  }, [connection, wantsRoutines, wantsSequences]);

  return { databases, loadTables, loadColumns, loadObjects };
};
