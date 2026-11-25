import { useRef, type RefObject } from 'react';

import { useStore } from '../../../store';
import { t } from '../../../i18n';
import type { SavedConnection, TabData } from '../../../types';
import { buildRpcConnectionConfig } from '../../../utils/connectionRpcConfig';
import { confirmProductionMutation } from '../../../utils/productionRiskConfirm';
import { buildDataSyncPasteWorkbenchTab } from '../../../utils/dataSyncTab';
import { dispatchSidebarTableCreated } from '../../../utils/sidebarDatabaseRefresh';
import { confirmCopyTables } from '../../tableCopyAction';
import { useSidebarTableClipboard } from '../../sidebar/useSidebarTableClipboard';
import type { ShortcutPlatform } from '../../../utils/shortcuts';

type UseTableOverviewClipboardInput = {
  rootRef: RefObject<HTMLDivElement | null>;
  selectedNames: string[];
  tab: TabData;
  connection: SavedConnection | undefined;
  schemaName?: string;
  activeShortcutPlatform: ShortcutPlatform;
  loadData: () => Promise<void>;
  blocked: boolean;
};

export const useTableOverviewClipboard = ({
  rootRef, selectedNames, tab, connection, activeShortcutPlatform, loadData, blocked, schemaName = tab.schemaName || '',
}: UseTableOverviewClipboardInput): void => {
  const connections = useStore((state) => state.connections);
  const activeTabId = useStore((state) => state.activeTabId);
  const addTab = useStore((state) => state.addTab);
  const dataRef = {
    ...connection,
    id: tab.connectionId,
    dbName: tab.dbName || '',
    schemaName,
  };
  const nodes = selectedNames.length > 0
    ? selectedNames.map((tableName) => ({
      type: 'table', title: tableName, dataRef: { ...dataRef, tableName },
    }))
    : [{ type: 'database', title: tab.dbName || '', dataRef }];
  const selectedNodesRef = useRef(nodes);
  selectedNodesRef.current = nodes;

  useSidebarTableClipboard({
    rootRef,
    selectedNodesRef,
    connectionIds: connections.map((item) => item.id),
    activeShortcutPlatform,
    blocked: blocked || Boolean(activeTabId && activeTabId !== tab.id),
    onCopyTables: async (sourceNodes, _target, options) => {
      const source = sourceNodes[0]?.dataRef;
      const sourceConnection = connections.find((item) => item.id === source?.id);
      if (!source || !sourceConnection) return;
      const tableNames: string[] = sourceNodes.map((node) => String(node.dataRef.tableName));
      if (!await confirmProductionMutation(
        sourceConnection, t('connection.production_risk.action.execute_sql'),
        [source.dbName, tableNames.join(', ')].filter(Boolean).join(' / '), t,
      )) return;
      confirmCopyTables({
        config: buildRpcConnectionConfig(sourceConnection.config, { id: sourceConnection.id }),
        dbName: source.dbName,
        sourceSchemaName: source.schemaName,
        sourceTableNames: tableNames,
        skipConfirmation: options?.skipConfirmation === true,
        onSuccess: async (targets) => {
          dispatchSidebarTableCreated({
            connectionId: sourceConnection.id, dbName: source.dbName,
            schemaName: source.schemaName, tableName: targets[0],
          });
          await loadData();
        },
      });
    },
    onOpenDataSyncWorkbench: (entryMode, pastePrefill) => {
      addTab(buildDataSyncPasteWorkbenchTab({ entryMode, pastePrefill }));
    },
  });
};
