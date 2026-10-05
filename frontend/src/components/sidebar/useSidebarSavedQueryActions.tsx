import type { SavedQuery, SavedConnection } from '../../types';
import { t } from '../../i18n';
import { message } from 'antd';
import { useStore } from '../../store';
import type { SidebarTreeNode as TreeNode } from '../sidebarV2Utils';
import { useCallback } from 'react';
import { RevealSavedQueryInFolder } from '../../../wailsjs/go/app/App';
import type { UseSidebarObjectActionsArgs } from './useSidebarObjectActions';

export interface UseSidebarSavedQueryActionsInput {
  setRenameSavedQueryTarget: UseSidebarObjectActionsArgs['setRenameSavedQueryTarget'];
  renameSavedQueryForm: UseSidebarObjectActionsArgs['renameSavedQueryForm'];
  setIsRenameSavedQueryModalOpen: UseSidebarObjectActionsArgs['setIsRenameSavedQueryModalOpen'];
  renameSavedQueryTarget: UseSidebarObjectActionsArgs['renameSavedQueryTarget'];
  saveQuery: UseSidebarObjectActionsArgs['saveQuery'];
  treeDataRef: UseSidebarObjectActionsArgs['treeDataRef'];
  setTreeData: UseSidebarObjectActionsArgs['setTreeData'];
  tabs: UseSidebarObjectActionsArgs['tabs'];
  updateQueryTabDraft: UseSidebarObjectActionsArgs['updateQueryTabDraft'];
  connectionIdSet: UseSidebarObjectActionsArgs['connectionIdSet'];
}

export const useSidebarSavedQueryActions = ({
  setRenameSavedQueryTarget, renameSavedQueryForm, setIsRenameSavedQueryModalOpen,
  renameSavedQueryTarget, saveQuery, treeDataRef, setTreeData, tabs, updateQueryTabDraft,
  connectionIdSet,
}: UseSidebarSavedQueryActionsInput) => {
  const openRenameSavedQueryModal = (query: SavedQuery) => {
    setRenameSavedQueryTarget(query);
    renameSavedQueryForm.setFieldsValue({ name: query.name || t('query_editor.save_modal.unnamed') });
    setIsRenameSavedQueryModalOpen(true);
  };

  const handleRenameSavedQuery = async () => {
    if (!renameSavedQueryTarget) return;
    try {
      const values = await renameSavedQueryForm.validateFields();
      const nextName = String(values.name || '').trim();
      if (!nextName) {
        message.error(t('query_editor.save_modal.name_required'));
        return;
      }
      if (nextName === renameSavedQueryTarget.name) {
        message.warning(t('sidebar.message.saved_query_name_unchanged'));
        return;
      }

      const backendApp = (window as any).go?.app?.App;
      let persisted: SavedQuery;
      if (typeof backendApp?.RenameSavedQuery === 'function') {
        const renamed = await backendApp.RenameSavedQuery(renameSavedQueryTarget.id, nextName);
        persisted = {
          ...renameSavedQueryTarget,
          ...(renamed || {}),
          name: String(renamed?.name || nextName),
        };
        const latestState = useStore.getState();
        latestState.replaceSavedQueries(latestState.savedQueries.map(query => (
          query.id === persisted.id ? { ...query, ...persisted } : query
        )));
      } else {
        persisted = await saveQuery({
          ...renameSavedQueryTarget,
          name: nextName,
        });
      }
      const updateSavedQueryNode = (list: TreeNode[]): TreeNode[] =>
        list.map(node => {
          if (node.type === 'saved-query' && node.dataRef?.id === renameSavedQueryTarget.id) {
            return {
              ...node,
              title: persisted.name,
              dataRef: { ...(node.dataRef || renameSavedQueryTarget), ...persisted },
            };
          }
          return node.children ? { ...node, children: updateSavedQueryNode(node.children) } : node;
        });
      const nextTreeData = updateSavedQueryNode(treeDataRef.current);
      treeDataRef.current = nextTreeData;
      setTreeData(nextTreeData);
      tabs
        .filter(tab => tab.type === 'query' && (tab.savedQueryId === renameSavedQueryTarget.id || tab.id === renameSavedQueryTarget.id))
        .forEach(tab => updateQueryTabDraft(tab.id, { title: persisted.name }));
      message.success(t('sidebar.message.saved_query_renamed'));
      setIsRenameSavedQueryModalOpen(false);
      setRenameSavedQueryTarget(null);
      renameSavedQueryForm.resetFields();
    } catch (e) {
      message.error(t('sidebar.message.saved_query_rename_failed', {
        error: e instanceof Error ? e.message : String(e),
      }));
    }
  };

  const handleRevealSavedQueryInFolder = useCallback(async (query: SavedQuery) => {
    if (!query?.id) return;
    try {
      const res = await RevealSavedQueryInFolder(query.id);
      if (res?.success) {
        message.success(res.message || t('sidebar.message.saved_query_revealed'));
        return;
      }
      message.error(res?.message || t('sidebar.message.saved_query_reveal_failed', {
        error: t('common.unknown'),
      }));
    } catch (error) {
      message.error(t('sidebar.message.saved_query_reveal_failed', {
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }, []);

  const isSavedQueryUnmatched = useCallback((query: SavedQuery): boolean => {
    return query.bindingStatus === 'orphan' || !connectionIdSet.has(query.connectionId);
  }, [connectionIdSet]);

  const handleRebindSavedQuery = useCallback(async (query: SavedQuery, target: SavedConnection) => {
    if (!query?.id || !target?.id) return;
    try {
      const backendApp = (window as any).go?.app?.App;
      let persisted: SavedQuery;
      if (typeof backendApp?.RebindSavedQuery === 'function') {
        persisted = await backendApp.RebindSavedQuery(query.id, target.id);
        await saveQuery(persisted);
      } else {
        persisted = await saveQuery({
          ...query,
          connectionId: target.id,
          originalConnectionId: query.originalConnectionId || query.connectionId,
          bindingStatus: 'active',
        });
      }
      message.success(t('sidebar.message.saved_query_rebind_success', {
        name: target.name || target.id,
      }));
      tabs
        .filter(tab => tab.type === 'query' && (tab.savedQueryId === query.id || tab.id === query.id))
        .forEach(tab => updateQueryTabDraft(tab.id, {
          title: persisted.name,
          connectionId: persisted.connectionId,
          dbName: persisted.dbName,
        }));
    } catch (error) {
      message.error(t('sidebar.message.saved_query_rebind_failed', {
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }, [saveQuery, tabs, updateQueryTabDraft]);
  return {
    openRenameSavedQueryModal, handleRenameSavedQuery, handleRevealSavedQueryInFolder,
    isSavedQueryUnmatched, handleRebindSavedQuery,
  };
};

export type SidebarSavedQueryActionsApi = ReturnType<typeof useSidebarSavedQueryActions>;
