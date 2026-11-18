import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useStore } from '../../../store';
import { DBShowCreateTable } from '../../../../wailsjs/go/app/App';
import { buildRpcConnectionConfig } from '../../../utils/connectionRpcConfig';
import { fetchTableInfo, type TableInfoDetails } from '../../../utils/backendTableInfo';
import { fetchDatabaseDefinition } from '../../../utils/databaseDefinitionFetch';
import { resolveObjectMetadataDialect } from '../../../utils/objectMetadataDialect';
import {
  resolveObjectInfoTarget,
  type ObjectInfoTarget,
} from '../objectInfoTarget';

/**
 * 对象信息面板的数据装配：跟随 activeContext（连接/库/Schema/表）加载
 * 聚合元数据与 DDL；请求带序号防串台，切换目标时旧结果直接丢弃。
 */

export type ObjectInfoLoadState = 'idle' | 'loading' | 'ready' | 'error';

export const useObjectInfo = () => {
  const connections = useStore(state => state.connections);
  const activeContext = useStore(state => state.activeContext);
  const tabs = useStore(state => state.tabs);
  const activeTabId = useStore(state => state.activeTabId);

  const connection = useMemo(
    () => connections.find(c => c.id === activeContext?.connectionId),
    [activeContext?.connectionId, connections],
  );

  // activeContext 已由标签页切换和侧栏选择同步；仅在其缺少完整目标时用活动标签兜底。
  const activeTab = useMemo(
    () => tabs.find(tab => tab.id === activeTabId),
    [activeTabId, tabs],
  );

  const target = useMemo<ObjectInfoTarget | null>(
    () => (connection ? resolveObjectInfoTarget(activeContext, activeTab) : null),
    [activeContext, activeTab, connection],
  );

  const [details, setDetails] = useState<TableInfoDetails | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const [loadState, setLoadState] = useState<ObjectInfoLoadState>('idle');
  const [ddl, setDdl] = useState('');
  const [databaseDdlUnsupported, setDatabaseDdlUnsupported] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [loadedTargetKey, setLoadedTargetKey] = useState('');
  const [reloadNonce, setReloadNonce] = useState(0);
  const requestIdRef = useRef(0);

  const targetKey = target
    ? `${target.kind}/${target.connectionId}/${target.dbName}/${target.schemaName || ''}/${target.kind === 'table' ? target.tableName : ''}`
    : '';

  useEffect(() => {
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    const isLatest = () => requestIdRef.current === requestId;
    if (!target || !connection) {
      setDetails(null);
      setUnsupported(false);
      setDdl('');
      setDatabaseDdlUnsupported(false);
      setLoadError('');
      setLoadedTargetKey('');
      setLoadState('idle');
      return;
    }
    setLoadError('');
    setDatabaseDdlUnsupported(false);
    setLoadState('loading');
    const rpcConfig = buildRpcConnectionConfig(connection.config) as any;
    void (async () => {
      if (target.kind === 'database') {
        setDetails(null);
        setUnsupported(false);
        const dialect = resolveObjectMetadataDialect(
          connection.config?.type || '',
          connection.config?.driver,
          connection.config?.oceanBaseProtocol,
        );
        const result = await fetchDatabaseDefinition(
          connection.config as unknown as Record<string, unknown>,
          dialect,
          target.dbName,
        );
        if (!isLatest()) return;
        setDdl(result.definition);
        setDatabaseDdlUnsupported(Boolean(result.unsupported));
        setLoadError(result.success ? '' : String(result.message || ''));
        setLoadState('ready');
        setLoadedTargetKey(targetKey);
        return;
      }
      const info = await fetchTableInfo(rpcConfig, target.dbName, target.schemaName, target.tableName);
      if (!isLatest()) return;
      setUnsupported(info.details === null);
      setDetails(info.details);
      try {
        const ddlRes = await DBShowCreateTable(rpcConfig, target.dbName, target.tableName);
        if (!isLatest()) return;
        setDdl(ddlRes?.success ? String(ddlRes.data || '') : '');
      } catch {
        if (isLatest()) setDdl('');
      }
      setLoadState('ready');
      setLoadedTargetKey(targetKey);
    })();
  }, [connection, reloadNonce, target, targetKey]);

  const reload = useCallback(() => {
    setReloadNonce(nonce => nonce + 1);
  }, []);

  const targetDataReady = Boolean(targetKey) && loadedTargetKey === targetKey;
  return {
    target, targetKey,
    details: targetDataReady ? details : null,
    unsupported: targetDataReady ? unsupported : false,
    ddl: targetDataReady ? ddl : '',
    loadState,
    reload,
    databaseDdlUnsupported: targetDataReady ? databaseDdlUnsupported : false,
    loadError: targetDataReady ? loadError : '',
    connectionName: connection?.name || '',
  };
};

export type ObjectInfoApi = ReturnType<typeof useObjectInfo>;
