import React, { useCallback } from 'react';
import { Button, List, message, Typography } from 'antd';
import { DeleteOutlined } from '@ant-design/icons';
import Modal from '../common/ResizableDraggableModal';
import { useStore } from '../../store';
import type { SavedConnection } from '../../types';
import { t } from '../../i18n';

const DELETE_PREVIEW_LIMIT = 8;

type ConnectionDeleteBackend = {
  DeleteConnections?: (ids: string[]) => Promise<unknown>;
};

const resolveConnectionDeleteBackend = (): ConnectionDeleteBackend | undefined => (
  (window as unknown as { go?: { app?: { App?: ConnectionDeleteBackend } } }).go?.app?.App
);

type Props = {
  selectedConnectionIds: string[];
  connectionById: Map<string, SavedConnection>;
  onCloseTabsByConnection?: (connectionId: string) => void;
};

/**
 * Deletes exactly the connections ticked in the group management table and
 * leaves every group in place. The group-level delete removes a whole group
 * no matter what is ticked, so a selection needs its own explicit action.
 */
export const useDeleteSelectedConnections = ({ selectedConnectionIds, connectionById, onCloseTabsByConnection }: Props) => {
  const removeConnection = useStore((state) => state.removeConnection);

  return useCallback(() => {
    const ids = selectedConnectionIds.filter((id) => connectionById.has(id));
    if (ids.length === 0) return;
    const preview = ids.slice(0, DELETE_PREVIEW_LIMIT);
    Modal.confirm({
      title: t('sidebar.modal.confirm_delete_selected_connections.title'),
      content: <div>
        <Typography.Paragraph style={{ marginBottom: 8 }}>
          {t('sidebar.modal.confirm_delete_selected_connections.content', { count: ids.length })}
        </Typography.Paragraph>
        <List
          size="small"
          dataSource={preview}
          renderItem={(connectionId) => <List.Item key={connectionId}>{connectionById.get(connectionId)?.name || connectionId}</List.Item>}
        />
        {ids.length > preview.length && <Typography.Text type="secondary">
          {t('connection.sidebar.management.movePreviewRemaining', { count: ids.length - preview.length })}
        </Typography.Text>}
      </div>,
      okButtonProps: { danger: true },
      onOk: async () => {
        const backendApp = resolveConnectionDeleteBackend();
        if (typeof backendApp?.DeleteConnections !== 'function') {
          message.error(t('sidebar.message.delete_connection_backend_unavailable'));
          throw new Error('DeleteConnections unavailable');
        }
        try {
          await backendApp.DeleteConnections(ids);
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error ?? '').trim();
          message.error(t('sidebar.message.delete_connections_failed', {
            error: detail || t('sidebar.message.delete_connection_failed'),
          }));
          throw error;
        }
        ids.forEach((connectionId) => {
          onCloseTabsByConnection?.(connectionId);
          removeConnection(connectionId);
        });
        message.success(t('sidebar.message.delete_connections_success', { count: ids.length }));
      },
    });
  }, [connectionById, onCloseTabsByConnection, removeConnection, selectedConnectionIds]);
};

// Rendered by the caller only while rows are ticked: antd Space keeps a gap
// for every child element, including one that renders nothing.
const ConnectionGroupSelectionActions: React.FC<Props> = (props) => {
  const deleteSelectedConnections = useDeleteSelectedConnections(props);
  return <Button
    className="connection-group-management-delete-selected"
    danger
    icon={<DeleteOutlined />}
    onClick={deleteSelectedConnections}
  >
    {t('connection.sidebar.management.deleteSelected')}
  </Button>;
};

export default ConnectionGroupSelectionActions;
