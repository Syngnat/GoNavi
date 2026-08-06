import type { MutableRefObject } from 'react';
import { message } from 'antd';

import type { SavedConnection } from '../../types';
import { t } from '../../i18n';
import { getDataSourceCapabilities } from '../../utils/dataSourceCapabilities';
import {
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
    const selectedNodes = node ? [node] : selectedNodesRef.current;
    const { connectionId, dbName } = resolveBatchWorkbenchContext(selectedNodes, connections);
    addTab(buildBatchTableExportWorkbenchTab({
      connectionId,
      dbName: dbName || undefined,
      title: t('sidebar.action.batch_tables'),
    }));
  };

  const openBatchDatabaseWorkbench = (node?: any) => {
    const selectedNodes = node ? [node] : selectedNodesRef.current;
    const { connectionId } = resolveBatchWorkbenchContext(selectedNodes, connections);
    addTab(buildBatchDatabaseExportWorkbenchTab({
      connectionId,
      title: t('sidebar.action.batch_databases'),
    }));
  };

  return {
    handleExportDatabaseSQL,
    handleExportSchemaSQL,
    openBatchTableWorkbench,
    openBatchDatabaseWorkbench,
  };
};
