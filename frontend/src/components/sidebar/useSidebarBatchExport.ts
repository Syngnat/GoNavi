import type { MutableRefObject } from 'react';
import { message } from 'antd';

import type { SavedConnection } from '../../types';
import { t } from '../../i18n';
import { getDataSourceCapabilities } from '../../utils/dataSourceCapabilities';
import {
  buildBatchConnectionWorkbenchTab,
  buildBatchDatabaseExportWorkbenchTab,
  buildBatchTableExportWorkbenchTab,
  buildDatabaseExportWorkbenchTab,
  buildSchemaExportWorkbenchTab,
} from '../../utils/tableExportTab';
import { showSQLExportOptionsDialog } from '../SQLExportOptionsDialog';

const createTableExportKey = (prefix: string): string => (
  `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`
);

const isBatchWorkbenchConnection = (connection: SavedConnection | undefined): connection is SavedConnection => (
  !!connection && getDataSourceCapabilities(connection.config).supportsSqlQueryExport
);

const BATCH_WORKBENCH_NODE_TYPES = new Set([
  'connection',
  'database',
  'table',
  'view',
  'materialized-view',
]);

const isBatchWorkbenchTreeNode = (value: any): boolean => (
  !!value
  && typeof value === 'object'
  && (
    (!!value.dataRef && typeof value.dataRef === 'object')
    || BATCH_WORKBENCH_NODE_TYPES.has(String(value.type || '').trim())
  )
);

const resolveBatchWorkbenchSelection = (
  selectedNodesRef: MutableRefObject<any[]>,
  node?: any,
): any[] => (
  isBatchWorkbenchTreeNode(node) ? [node] : selectedNodesRef.current
);

export const resolveBatchWorkbenchContext = (
  selectedNodes: any[],
  connections: SavedConnection[],
): { connectionId: string; dbName: string } => {
  const node = selectedNodes[0];
  const rawConnectionId = String(node?.dataRef?.id || (node?.type === 'connection' ? node?.key : '') || '').trim();
  const selectedConnection = connections.find((connection) => connection.id === rawConnectionId);
  const fallbackConnection = connections.find(isBatchWorkbenchConnection);
  const connectionId = isBatchWorkbenchConnection(selectedConnection)
    ? selectedConnection.id
    : (fallbackConnection?.id || '');

  if (!node || connectionId !== rawConnectionId) {
    return { connectionId, dbName: '' };
  }

  if (node.type === 'database') {
    return {
      connectionId,
      dbName: String(node?.dataRef?.dbName || node?.title || '').trim(),
    };
  }
  if (node.type === 'table' || node.type === 'view' || node.type === 'materialized-view') {
    return {
      connectionId,
      dbName: String(node?.dataRef?.dbName || '').trim(),
    };
  }
  return { connectionId, dbName: '' };
};

export const resolveBatchConnectionIds = (
  selectedNodes: any[],
  connections: SavedConnection[],
): string[] => {
  const existingIds = new Set(connections.map((connection) => connection.id));
  const seen = new Set<string>();
  const ids: string[] = [];
  const consider = (rawId: string) => {
    const connectionId = String(rawId || '').trim();
    if (!connectionId || !existingIds.has(connectionId) || seen.has(connectionId)) return;
    seen.add(connectionId);
    ids.push(connectionId);
  };
  selectedNodes.forEach((node) => {
    if (node?.type === 'connection') {
      consider(String(node.key || node.dataRef?.id || ''));
      return;
    }
    consider(String(node?.dataRef?.id || ''));
  });
  return ids;
};

interface UseSidebarBatchExportArgs {
  connections: SavedConnection[];
  selectedNodesRef: MutableRefObject<any[]>;
  addTab: (tab: any) => void;
}

export const useSidebarBatchExport = ({
  connections,
  selectedNodesRef,
  addTab,
}: UseSidebarBatchExportArgs) => {
  const handleExportDatabaseSQL = async (node: any, includeData: boolean) => {
    const conn = node.dataRef;
    const dbName = conn.dbName || node.title;
    addTab(buildDatabaseExportWorkbenchTab({
      connectionId: String(conn.id || '').trim(),
      dbName,
      contentMode: includeData ? 'backup' : 'schema',
      includeDropIfExists: false,
      launchKey: createTableExportKey('database'),
    }));
  };

  const handleExportSchemaSQL = async (node: any, includeData: boolean) => {
    const conn = node?.dataRef;
    const dbName = String(conn?.dbName || '').trim();
    const schemaName = String(conn?.schemaName || '').trim();
    if (!conn || !dbName || !schemaName) {
      message.error(t('sidebar.message.schema_export_target_missing'));
      return;
    }
    const exportOptions = await showSQLExportOptionsDialog();
    if (!exportOptions) return;
    addTab(buildSchemaExportWorkbenchTab({
      connectionId: String(conn.id || '').trim(),
      dbName,
      schemaName,
      contentMode: includeData ? 'backup' : 'schema',
      includeDropIfExists: exportOptions.includeDropIfExists,
      requestKey: createTableExportKey('schema'),
    }));
  };

  const openBatchTableWorkbench = (node?: any) => {
    const selectedNodes = resolveBatchWorkbenchSelection(selectedNodesRef, node);
    const { connectionId, dbName } = resolveBatchWorkbenchContext(selectedNodes, connections);
    const initialObjectNames = selectedNodes
      .filter((item) => item?.type === 'table' || item?.type === 'view' || item?.type === 'materialized-view')
      .map((item) => String(item?.dataRef?.tableName || item?.title || '').trim())
      .filter(Boolean);
    addTab(buildBatchTableExportWorkbenchTab({
      connectionId,
      dbName: dbName || undefined,
      ...(initialObjectNames.length > 0 ? { initialObjectNames } : {}),
      launchKey: createTableExportKey('batch-tables'),
      title: t('sidebar.action.batch_tables'),
    }));
  };

  const openBatchDatabaseWorkbench = (node?: any) => {
    const selectedNodes = resolveBatchWorkbenchSelection(selectedNodesRef, node);
    const { connectionId } = resolveBatchWorkbenchContext(selectedNodes, connections);
    addTab(buildBatchDatabaseExportWorkbenchTab({
      connectionId,
      title: t('sidebar.action.batch_databases'),
    }));
  };

  const openBatchConnectionWorkbench = (node?: any) => {
    const selectedNodes = resolveBatchWorkbenchSelection(selectedNodesRef, node);
    addTab(buildBatchConnectionWorkbenchTab({
      title: t('sidebar.action.batch_connections'),
      initialConnectionIds: resolveBatchConnectionIds(selectedNodes, connections),
    }));
  };

  return {
    handleExportDatabaseSQL,
    handleExportSchemaSQL,
    openBatchTableWorkbench,
    openBatchDatabaseWorkbench,
    openBatchConnectionWorkbench,
  };
};
