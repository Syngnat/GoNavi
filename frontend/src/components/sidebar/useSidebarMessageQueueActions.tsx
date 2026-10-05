import type { SavedConnection } from '../../types';
import { getDataSourceCapabilities } from '../../utils/dataSourceCapabilities';
import { resolveSidebarMessageActionTarget } from './sidebarMessageActions';
import { message } from 'antd';
import { t } from '../../i18n';
import type {
  SidebarMessagePublishTarget,
  UseSidebarObjectActionsArgs,
} from './useSidebarObjectActions';

export interface UseSidebarMessageQueueActionsInput {
  connections: UseSidebarObjectActionsArgs['connections'];
  addTab: UseSidebarObjectActionsArgs['addTab'];
  setMessagePublishTarget: UseSidebarObjectActionsArgs['setMessagePublishTarget'];
}

export const useSidebarMessageQueueActions = ({ connections, addTab, setMessagePublishTarget }: UseSidebarMessageQueueActionsInput) => {
  const resolveMessagePublishTarget = (node: any): SidebarMessagePublishTarget | null => {
    const connectionId = String(node?.dataRef?.id || '').trim();
    const liveConnection = connections.find((item) => item.id === connectionId);
    const sourceConnection = (liveConnection || node?.dataRef) as SavedConnection | undefined;
    if (!sourceConnection?.config) return null;
    const capabilities = getDataSourceCapabilities(sourceConnection.config);
    if (!capabilities.supportsMessagePublish) return null;
    const actionTarget = resolveSidebarMessageActionTarget(node);

    return {
      connection: sourceConnection,
      executionDbName: actionTarget?.executionDbName || String(node?.dataRef?.dbName || ''),
      destination: actionTarget?.publish.destination || '',
      ...(actionTarget?.publish.exchange ? { exchange: actionTarget.publish.exchange } : {}),
    };
  };

  const openMessageQueueWorkbench = (
    node: any,
    action: 'open' | 'consume' | 'publish' = 'open',
  ) => {
    const connectionId = String(node?.dataRef?.id || node?.key || '').trim();
    const liveConnection = connections.find((item) => item.id === connectionId);
    const sourceConnection = (liveConnection || node?.dataRef) as SavedConnection | undefined;
    const actionTarget = resolveSidebarMessageActionTarget(node);
    if (!sourceConnection?.config || !actionTarget) {
      message.warning(t('sidebar.message.message_queue_workbench_unsupported'));
      return;
    }
    const dbName = actionTarget.executionDbName
      || String(node?.dataRef?.dbName || sourceConnection.config.database || '').trim();
    const target = action === 'publish'
      ? actionTarget.publish.destination
      : actionTarget.consume.destination;
    addTab({
      id: `message-queue-${sourceConnection.id}-${encodeURIComponent(dbName || 'default')}`,
      title: `${sourceConnection.name} · ${t('message_queue_workbench.tab_kind')}`,
      type: 'message-queue',
      connectionId: sourceConnection.id,
      dbName,
      messageQueueTarget: target,
      messageQueueObjectKind: actionTarget.objectKind || undefined,
      messageQueueAction: action,
      messageQueueRequestKey: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    });
  };

  const openMessagePublishModal = (node: any) => {
    const target = resolveMessagePublishTarget(node);
    if (!target) {
      message.warning(t('sidebar.message.message_publish_unsupported'));
      return;
    }
    setMessagePublishTarget(target);
  };

  const handleMessagePublishSuccess = (result: { destination: string; affectedRows: number }) => {
    const destination = String(result.destination || '').trim() || t('sidebar.message.message_publish_target_fallback');
    if (result.affectedRows > 0) {
      message.success(t('sidebar.message.message_publish_success_with_count', {
        destination,
        count: result.affectedRows,
      }));
    } else {
      message.success(t('sidebar.message.message_publish_success', { destination }));
    }
    setMessagePublishTarget(null);
  };
  return {
    resolveMessagePublishTarget, openMessageQueueWorkbench, openMessagePublishModal,
    handleMessagePublishSuccess,
  };
};

export type SidebarMessageQueueActionsApi = ReturnType<typeof useSidebarMessageQueueActions>;
