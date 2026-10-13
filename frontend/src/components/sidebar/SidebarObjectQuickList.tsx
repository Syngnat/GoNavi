import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { t } from '../../i18n';
import { useStore } from '../../store';
import { DBGetTables } from '../../../wailsjs/go/app/App';
import { buildRpcConnectionConfig } from '../../utils/connectionRpcConfig';
import { extractTableNameFromMetadataRow } from '../../utils/tableMetadataRows';

/**
 * 侧栏底部「对象」页签：当前连接/库的表快览（Navicat 原型 objGrid）。
 * 行单击选中（联动「信息」页签），双击打开数据网格；顶部 mini 工具条
 * 提供 设计表 / 打开表 / 刷新。
 */

interface QuickObjectRow {
  name: string;
  comment: string;
}

export const SidebarObjectQuickList: React.FC = () => {
  const connections = useStore(state => state.connections);
  const activeContext = useStore(state => state.activeContext);
  const addTab = useStore(state => state.addTab);
  const setActiveContext = useStore(state => state.setActiveContext);
  const setActiveInfoTab = useStore(state => state.setSideInfoPanelActiveTab);

  const [rows, setRows] = useState<QuickObjectRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedName, setSelectedName] = useState('');
  const [reloadNonce, setReloadNonce] = useState(0);
  const loadRequestIdRef = useRef(0);

  const connection = useMemo(
    () => connections.find(c => c.id === activeContext?.connectionId),
    [activeContext?.connectionId, connections],
  );
  const dbName = String(activeContext?.dbName || '').trim();
  const schemaName = String(activeContext?.schemaName || '').trim() || undefined;
  const contextReady = !!connection && dbName !== '';

  useEffect(() => {
    const requestId = loadRequestIdRef.current + 1;
    loadRequestIdRef.current = requestId;
    const isLatest = () => loadRequestIdRef.current === requestId;
    if (!contextReady || !connection) {
      setRows([]);
      setSelectedName(String(activeContext?.tableName || ''));
      return;
    }
    setLoading(true);
    const config = {
      ...connection.config,
      port: Number(connection.config.port),
      password: connection.config.password || '',
      database: connection.config.database || '',
      useSSH: connection.config.useSSH || false,
      ssh: connection.config.ssh || { host: '', port: 22, user: '', password: '', keyPath: '' },
    };
    void (async () => {
      try {
        const res = await DBGetTables(buildRpcConnectionConfig(config) as any, dbName);
        if (!isLatest()) return;
        if (res.success && Array.isArray(res.data)) {
          const nextRows = (res.data as Array<Record<string, any>>)
            .map(row => ({
              name: extractTableNameFromMetadataRow(row),
              comment: String(row.table_comment ?? row.TABLE_COMMENT ?? row.comment ?? '').trim(),
            }))
            .filter(row => row.name !== '');
          nextRows.sort((a, b) => a.name.localeCompare(b.name));
          setRows(nextRows);
        } else {
          setRows([]);
        }
      } catch {
        if (isLatest()) setRows([]);
      } finally {
        if (isLatest()) setLoading(false);
      }
    })();
  }, [activeContext?.tableName, connection, contextReady, dbName, reloadNonce]);

  const selected = selectedName || String(activeContext?.tableName || '');
  const tableIdSuffix = `${connection?.id || 'none'}-${dbName}${schemaName ? `-${schemaName}` : ''}`;

  const openTable = useCallback((mode: 'data' | 'design') => {
    if (!connection || !selected) return;
    setActiveContext({ connectionId: connection.id, dbName, schemaName: schemaName || undefined, tableName: selected });
    addTab(mode === 'data' ? {
      id: `${tableIdSuffix}-${selected}`,
      title: selected,
      type: 'table',
      connectionId: connection.id,
      dbName,
      tableName: selected,
      schemaName,
      objectType: 'table',
    } : {
      id: `design-${tableIdSuffix}-${selected}`,
      title: t('table_overview.tab.design_table_title', { table: selected }),
      type: 'design',
      connectionId: connection.id,
      dbName,
      tableName: selected,
      schemaName,
      initialTab: 'columns',
    } as any);
  }, [addTab, connection, dbName, schemaName, selected, setActiveContext, tableIdSuffix]);

  const reload = useCallback(() => setReloadNonce(nonce => nonce + 1), []);

  return (
    <div className="gn-side-quick">
      <div className="gn-side-quick-toolbar">
        <button
          type="button"
          className="gn-side-quick-btn"
          disabled={!selected}
          title={t('sidebar.menu.design_table')}
          onClick={() => openTable('design')}
        >🖉</button>
        <button
          type="button"
          className="gn-side-quick-btn"
          disabled={!selected}
          title={t('data_grid.metadata_view.er_open_table')}
          onClick={() => openTable('data')}
        >▤</button>
        <button
          type="button"
          className="gn-side-quick-btn"
          title={t('object_overview.tooltip.refresh')}
          onClick={reload}
        >⟳</button>
        <span className="gn-side-quick-count">
          {loading ? '…' : t('object_overview.summary.count', { count: rows.length })}
        </span>
      </div>
      <div className="gn-side-quick-list">
        {!contextReady ? (
          <div className="gn-side-quick-empty">{t('object_info.empty.no_table')}</div>
        ) : rows.length === 0 && !loading ? (
          <div className="gn-side-quick-empty">{t('object_overview.empty.no_matches')}</div>
        ) : rows.map(row => (
          <div
            key={row.name}
            className={`gn-side-quick-row${selected === row.name ? ' is-selected' : ''}`}
            title={row.comment ? `${row.name} — ${row.comment}` : row.name}
            onClick={() => {
              setSelectedName(row.name);
              if (connection) {
                setActiveContext({ connectionId: connection.id, dbName, schemaName: schemaName || undefined, tableName: row.name });
              }
            }}
            onDoubleClick={() => {
              setSelectedName(row.name);
              if (connection) {
                setActiveContext({ connectionId: connection.id, dbName, schemaName: schemaName || undefined, tableName: row.name });
              }
              setActiveInfoTab('info');
            }}
          >
            <span className="gn-side-quick-row-name">{row.name}</span>
            {row.comment && <span className="gn-side-quick-row-comment">{row.comment}</span>}
          </div>
        ))}
      </div>
    </div>
  );
};

export default SidebarObjectQuickList;
