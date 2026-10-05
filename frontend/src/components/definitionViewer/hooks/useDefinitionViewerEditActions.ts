import { useEffect, useCallback } from 'react';
import { buildEditableDefinitionSql } from '../definitionViewerSql';
import { clearQueryTabDraft } from '../../../utils/sqlFileTabDrafts';
import type { DefinitionViewerStateApi } from './useDefinitionViewerState';
import type { DefinitionViewerLoaderApi } from './useDefinitionViewerLoader';
import type { DefinitionViewerProps } from '../../DefinitionViewer';

export interface UseDefinitionViewerEditActionsInput {
  editorRef: DefinitionViewerStateApi['editorRef'];
  tab: DefinitionViewerProps['tab'];
  loadedDefinitionKeyRef: DefinitionViewerStateApi['loadedDefinitionKeyRef'];
  objectIdentityKey: DefinitionViewerStateApi['objectIdentityKey'];
  setDefinition: DefinitionViewerStateApi['setDefinition'];
  normalizedObjectName: DefinitionViewerLoaderApi['normalizedObjectName'];
  editableDefinitionCopy: DefinitionViewerLoaderApi['editableDefinitionCopy'];
  setActiveContext: DefinitionViewerStateApi['setActiveContext'];
  addTab: DefinitionViewerStateApi['addTab'];
  editTabTitle: DefinitionViewerLoaderApi['editTabTitle'];
  openingObjectEdit: DefinitionViewerStateApi['openingObjectEdit'];
  setOpeningObjectEdit: DefinitionViewerStateApi['setOpeningObjectEdit'];
  currentDefinition: DefinitionViewerLoaderApi['currentDefinition'];
  setError: DefinitionViewerStateApi['setError'];
  loadDefinition: DefinitionViewerLoaderApi['loadDefinition'];
  isMountedRef: DefinitionViewerStateApi['isMountedRef'];
  t: DefinitionViewerStateApi['t'];
}

export const useDefinitionViewerEditActions = ({
  editorRef, tab, loadedDefinitionKeyRef, objectIdentityKey, setDefinition, normalizedObjectName,
  editableDefinitionCopy, setActiveContext, addTab, editTabTitle, openingObjectEdit,
  setOpeningObjectEdit, currentDefinition, setError, loadDefinition, isMountedRef, t,
}: UseDefinitionViewerEditActionsInput) => {
  useEffect(() => () => {
      editorRef.current = null;
  }, []);

  const openObjectEditTab = useCallback((sourceDefinition: string) => {
      const dbName = String(tab.dbName || '').trim();
      const schemaName = String(tab.schemaName || '').trim();
      const latestDefinition = String(sourceDefinition || '');
      loadedDefinitionKeyRef.current = objectIdentityKey;
      setDefinition(latestDefinition);
      const query = buildEditableDefinitionSql(tab, latestDefinition, normalizedObjectName, editableDefinitionCopy);
      setActiveContext({
          connectionId: tab.connectionId,
          dbName,
          schemaName: schemaName || undefined,
      });
      clearQueryTabDraft(tab.id);
      const isViewObject = tab.type === 'view-def' || Boolean(tab.viewName);
      const isRoutineObject = tab.type === 'routine-def' || Boolean(tab.routineName);
      const isSequenceObject = tab.type === 'sequence-def' || Boolean(tab.sequenceName);
      const isPackageObject = tab.type === 'package-def' || Boolean(tab.packageName);
      const isEventObject = tab.type === 'event-def' || Boolean(tab.eventName);
      const isTriggerObject = tab.type === 'trigger' || Boolean(tab.triggerName);
      addTab({
          id: tab.id,
          title: editTabTitle,
          type: 'query',
          connectionId: tab.connectionId,
          dbName,
          query,
          queryMode: 'object-edit',
          returnToTabId: undefined,
          // 保留当前对象身份，供侧栏定位与「验证数据变化」解析；无关字段显式清空避免串对象
          viewName: isViewObject ? (tab.viewName || normalizedObjectName) : undefined,
          viewKind: isViewObject ? tab.viewKind : undefined,
          eventName: isEventObject ? (tab.eventName || normalizedObjectName) : undefined,
          routineName: isRoutineObject ? (tab.routineName || normalizedObjectName) : undefined,
          routineType: isRoutineObject ? tab.routineType : undefined,
          sequenceName: isSequenceObject ? (tab.sequenceName || normalizedObjectName) : undefined,
          packageName: isPackageObject ? (tab.packageName || normalizedObjectName) : undefined,
          triggerName: isTriggerObject ? (tab.triggerName || normalizedObjectName) : undefined,
          triggerTableName: isTriggerObject ? tab.triggerTableName : undefined,
          schemaName: schemaName || undefined,
          objectType: isViewObject
              ? (tab.viewKind === 'materialized' ? 'materialized-view' : 'view')
              : undefined,
          tableName: undefined,
          sidebarLocateKey: String(tab.sidebarLocateKey || '').trim() || undefined,
      });
  }, [
      addTab,
      editTabTitle,
      editableDefinitionCopy,
      normalizedObjectName,
      objectIdentityKey,
      setActiveContext,
      tab,
  ]);

  const openObjectEditQuery = async () => {
      if (!normalizedObjectName || openingObjectEdit) return;
      if (String(currentDefinition || '').trim()) {
          openObjectEditTab(currentDefinition);
          return;
      }
      setOpeningObjectEdit(true);
      setError(null);
      try {
          const result = await loadDefinition();
          if (!isMountedRef.current) {
              return;
          }
          if (!result.success) {
              setError(result.error || t('definition_viewer.error.query_failed'));
              return;
          }
          openObjectEditTab(String(result.definition || ''));
      } finally {
          if (isMountedRef.current) {
              setOpeningObjectEdit(false);
          }
      }
  };
  return { openObjectEditQuery };
};

export type DefinitionViewerEditActionsApi = ReturnType<typeof useDefinitionViewerEditActions>;
