import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useStore } from '../../../store';
import { DBShowCreateTable } from '../../../../wailsjs/go/app/App';
import { buildRpcConnectionConfig } from '../../../utils/connectionRpcConfig';
import { fetchTableInfo, type TableInfoDetails } from '../../../utils/backendTableInfo';

/**
 * 对象信息面板的数据装配：跟随 activeContext（连接/库/Schema/表）加载
 * 聚合元数据与 DDL；请求带序号防串台，切换目标时旧结果直接丢弃。
 */

export interface ObjectInfoTarget {
  connectionId: string;
  dbName: string;
  schemaName?: string;
  tableName: string;
}

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

  // 活动 tab 是表/设计器时优先用 tab 自带的表名，侧栏单选时用 activeContext。
  const activeTab = useMemo(
    () => tabs.find(tab => tab.id === activeTabId),
    [activeTabId, tabs],
  );

  const target = useMemo<ObjectInfoTarget | null>(() => {
    if (!connection || !activeContext?.dbName) return null;
    const tabTableName = activeTab?.type === 'table' || activeTab?.type === 'design'
      ? String(activeTab.tableName || '').trim()
      : '';
    const tableName = tabTableName || String(activeContext.tableName || '').trim();
    if (!tableName) return null;
    return {
      connectionId: connection.id,
      dbName: String(activeContext.dbName),
      schemaName: String(activeContext.schemaName || '').trim() || undefined,
      tableName,
    };
  }, [activeContext?.dbName, activeContext?.schemaName, activeContext?.tableName, activeTab, connection]);

  const [details, setDetails] = useState<TableInfoDetails | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const [loadState, setLoadState] = useState<ObjectInfoLoadState>('idle');
  const [ddl, setDdl] = useState('');
  const [reloadNonce, setReloadNonce] = useState(0);
  const requestIdRef = useRef(0);

  const targetKey = target
    ? `${target.connectionId}/${target.dbName}/${target.schemaName || ''}/${target.tableName}`
    : '';

  useEffect(() => {
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    const isLatest = () => requestIdRef.current === requestId;
    if (!target || !connection) {
      setDetails(null);
      setUnsupported(false);
      setDdl('');
      setLoadState('idle');
      return;
    }
    setLoadState('loading');
    const rpcConfig = buildRpcConnectionConfig(connection.config) as any;
    void (async () => {
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
    })();
  }, [connection, reloadNonce, target, targetKey]);

  const reload = useCallback(() => {
    setReloadNonce(nonce => nonce + 1);
  }, []);

  return {
    target, targetKey, details, unsupported, ddl, loadState, reload,
    connectionName: connection?.name || '',
  };
};

export type ObjectInfoApi = ReturnType<typeof useObjectInfo>;
