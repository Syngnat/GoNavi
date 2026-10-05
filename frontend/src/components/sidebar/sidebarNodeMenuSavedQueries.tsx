import type { SavedQuery, SavedConnection, SavedQueryGroup } from '../../types';
import { getSavedQueryGroupOwnerIds, buildSavedQueryGroupPath } from '../../utils/savedQueryGroups';
import { message, type MenuProps } from 'antd';
import { t } from '../../i18n';
import {
  LinkOutlined, FolderOutlined, ConsoleSqlOutlined, FolderOpenOutlined, EditOutlined,
  DeleteOutlined, FolderAddOutlined,
} from '@ant-design/icons';
import Modal from '../common/ResizableDraggableModal';
import type { TreeNode, SidebarNodeMenuContext } from './sidebarNodeMenuHelpers';

export interface BuildSavedQueryMenuItemsInput {
  node: any;
  context: SidebarNodeMenuContext;
}

export const buildSavedQueryMenuItems = ({ node, context }: BuildSavedQueryMenuItemsInput): MenuProps['items'] => {
  const {
    savedQueryGroups, moveSavedQueryToGroup, isSavedQueryUnmatched, connections,
    handleRebindSavedQuery, addTab, resolveSavedQueryDisplayName, handleRevealSavedQueryInFolder,
    openRenameSavedQueryModal, deleteQuery, treeDataRef, setTreeData,
  } = context;
  const q = node.dataRef as SavedQuery;
  const queryGroupOwners = getSavedQueryGroupOwnerIds(savedQueryGroups || []);
  const currentGroupId = queryGroupOwners.get(q.id) || '';
  const moveQuery = async (targetGroupId: string) => {
      try {
          await moveSavedQueryToGroup(q.id, targetGroupId);
          message.success(t('sidebar.message.saved_query_group_moved'));
      } catch (error) {
          message.error(t('sidebar.message.saved_query_group_move_failed', {
              error: error instanceof Error ? error.message : String(error),
          }));
      }
  };
  const rebindMenuItems: MenuProps['items'] = isSavedQueryUnmatched(q)
      ? [
          {
              key: 'rebind-query',
              label: t('sidebar.menu.bind_to_connection'),
              icon: <LinkOutlined />,
              disabled: connections.length === 0,
              children: connections.length > 0
                  ? connections.map((conn: SavedConnection) => ({
                      key: `rebind-query-${conn.id}`,
                      label: conn.name || conn.id,
                      onClick: () => void handleRebindSavedQuery(q, conn),
                  }))
                  : undefined,
          },
      ]
      : [];
  const moveToGroupMenuItems: NonNullable<MenuProps['items']> = (savedQueryGroups || []).map((group: SavedQueryGroup) => ({
      key: `move-saved-query-to-group-${group.id}`,
      label: buildSavedQueryGroupPath(group.id, savedQueryGroups || []).join(' / ') || group.name,
      icon: <FolderOutlined />,
      disabled: group.id === currentGroupId,
      onClick: () => void moveQuery(group.id),
  }));
  return [
      {
          key: 'open-query',
          label: t('sidebar.menu.open_query'),
          icon: <ConsoleSqlOutlined />,
          onClick: () => {
              addTab({
                  id: q.id,
                  title: resolveSavedQueryDisplayName(q.name),
                  type: 'query',
                  connectionId: q.connectionId,
                  dbName: q.dbName,
                  query: q.sql,
                  savedQueryId: q.id,
              });
          }
      },
      {
          key: 'reveal-saved-query-in-folder',
          label: t('sidebar.menu.reveal_saved_query_in_folder'),
          icon: <FolderOpenOutlined />,
          onClick: () => void handleRevealSavedQueryInFolder(q),
      },
      ...rebindMenuItems,
      {
          key: 'move-saved-query-to-group',
          label: t('sidebar.saved_query_group.move_to_group'),
          icon: <FolderOpenOutlined />,
          disabled: moveToGroupMenuItems.length === 0,
          children: moveToGroupMenuItems.length > 0 ? moveToGroupMenuItems : undefined,
      },
      ...(currentGroupId ? [{
          key: 'move-saved-query-to-ungrouped',
          label: t('sidebar.saved_query_group.move_to_ungrouped'),
          icon: <FolderOutlined />,
          onClick: () => void moveQuery(''),
      }] : []),
      { type: 'divider' },
      {
          key: 'rename-query',
          label: t('sidebar.menu.rename_query'),
          icon: <EditOutlined />,
          onClick: () => openRenameSavedQueryModal(q),
      },
      {
          key: 'delete-query',
          label: t('sidebar.menu.delete_query'),
          icon: <DeleteOutlined />,
          danger: true,
          onClick: () => {
              Modal.confirm({
                  title: t('sidebar.modal.confirm_delete.title'),
                  content: t('sidebar.modal.confirm_delete_saved_query.content', { name: resolveSavedQueryDisplayName(q.name) }),
                  okButtonProps: { danger: true },
                  onOk: async () => {
                      try {
                          await deleteQuery(q.id);
                      } catch (e) {
                          message.error(t('sidebar.message.saved_query_delete_failed', {
                            error: e instanceof Error ? e.message : String(e),
                          }));
                          throw e;
                      }
                      // 从树中移除节点
                      const removeNode = (list: TreeNode[]): TreeNode[] =>
                          list
                              .filter(n => !(n.type === 'saved-query' && n.dataRef?.id === q.id))
                              .map(n => n.children ? { ...n, children: removeNode(n.children) } : n);
                      const nextTreeData = removeNode(treeDataRef.current);
                      treeDataRef.current = nextTreeData;
                      setTreeData(nextTreeData);
                      message.success(t('sidebar.message.saved_query_deleted'));
                  }
              });
          }
      }
  ];
};

export interface BuildSavedQueryManualGroupMenuItemsInput {
  node: any;
  context: SidebarNodeMenuContext;
}

export const buildSavedQueryManualGroupMenuItems = ({ node, context }: BuildSavedQueryManualGroupMenuItemsInput): MenuProps['items'] => {
  const { openSavedQueryGroupModal, deleteSavedQueryGroup } = context;
  const group = node.dataRef as SavedQueryGroup;
  return [
      {
          key: 'new-saved-query-subgroup',
          label: t('sidebar.saved_query_group.new_subgroup'),
          icon: <FolderAddOutlined />,
          onClick: () => void openSavedQueryGroupModal(null, group.id),
      },
      {
          key: 'edit-saved-query-group',
          label: t('sidebar.saved_query_group.edit'),
          icon: <EditOutlined />,
          onClick: () => void openSavedQueryGroupModal(group),
      },
      { type: 'divider' },
      {
          key: 'delete-saved-query-group',
          label: t('sidebar.saved_query_group.delete'),
          icon: <DeleteOutlined />,
          danger: true,
          onClick: () => {
              Modal.confirm({
                  title: t('sidebar.modal.confirm_delete.title'),
                  content: t('sidebar.saved_query_group.delete_confirm', { name: group.name }),
                  okButtonProps: { danger: true },
                  onOk: async () => {
                      try {
                          await deleteSavedQueryGroup(group.id);
                          message.success(t('sidebar.message.saved_query_group_deleted'));
                      } catch (error) {
                          message.error(t('sidebar.message.saved_query_group_delete_failed', {
                              error: error instanceof Error ? error.message : String(error),
                          }));
                          throw error;
                      }
                  },
              });
          },
      },
  ];
};

export interface BuildAllSavedQueriesMenuItemsInput {
  context: SidebarNodeMenuContext;
}

export const buildAllSavedQueriesMenuItems = ({ context }: BuildAllSavedQueriesMenuItemsInput): MenuProps['items'] => {
  const { openSavedQueryGroupModal } = context;
  return [
      {
          key: 'new-saved-query-group',
          label: t('sidebar.saved_query_group.new_group'),
          icon: <FolderAddOutlined />,
          onClick: () => void openSavedQueryGroupModal(null, null),
      },
  ];
};
