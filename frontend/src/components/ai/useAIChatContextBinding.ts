import React from 'react';
import { message } from 'antd';
import { t as catalogTranslate } from '../../i18n/catalog';
import type { I18nParams } from '../../i18n/types';

import type { AIContextItem, AIEditorSelection } from '../../types';
import { useStore } from '../../store';
import { buildRpcConnectionConfig } from '../../utils/connectionRpcConfig';
import { resolveAITableSchemaToolResult } from '../../utils/aiTableSchemaTool';
import { normalizeTableNamesFromMetadataRows } from '../../utils/tableMetadataRows';
import { DBGetColumns, DBGetDatabases, DBGetTables, DBShowCreateTable } from '../../../wailsjs/go/app/App';
import {
  buildAIEditorSelectionContextItem,
  isAIEditorSelectionContext,
  isAITableSchemaContext,
  refreshAIEditorSelection,
} from './aiEditorSelectionContext';
import { bindAIEditorSelectionContext } from './bindAIEditorSelectionContext';

interface ActiveContextRef {
  connectionId?: string | null;
  dbName?: string | null;
}

interface UseAIChatContextBindingParams {
  activeContext: ActiveContextRef | null;
  activeEditorSelection?: AIEditorSelection | null;
  activeContextItems: AIContextItem[];
  connectionKey: string;
  addAIContext: (connectionKey: string, item: AIContextItem) => void;
  removeAIContext: (connectionKey: string, dbName: string, tableName: string) => void;
  translate?: AIChatContextBindingTranslate;
}

type AIChatContextBindingTranslate = (key: string, params?: I18nParams) => string;

const defaultTranslate: AIChatContextBindingTranslate = (key, params) =>
  catalogTranslate('en-US', key, params);

const getErrorDetail = (value: unknown): string => {
  if (value instanceof Error) {
    return value.message || 'unknown error';
  }
  const detail = String(value || '').trim();
  return detail || 'unknown error';
};

export const normalizeAIContextTables = (data: unknown): { name: string }[] => {
  return normalizeTableNamesFromMetadataRows(data).map((name) => ({ name }));
};

export const useAIChatContextBinding = ({
  activeContext,
  activeEditorSelection,
  activeContextItems,
  connectionKey,
  addAIContext,
  removeAIContext,
  translate = defaultTranslate,
}: UseAIChatContextBindingParams) => {
  const [contextOpen, setContextOpen] = React.useState(false);
  const [contextLoading, setContextLoading] = React.useState(false);
  const [contextTables, setContextTables] = React.useState<{ name: string }[]>([]);
  const [selectedTableKeys, setSelectedTableKeys] = React.useState<string[]>([]);
  const [selectedEditorSelection, setSelectedEditorSelection] = React.useState(false);
  const [searchText, setSearchText] = React.useState('');
  const [appendingContext, setAppendingContext] = React.useState(false);
  const [dbList, setDbList] = React.useState<string[]>([]);
  const [selectedDbName, setSelectedDbName] = React.useState('');
  const [contextExpanded, setContextExpanded] = React.useState(false);

  const filteredTables = React.useMemo(
    () => contextTables.filter((table) => table.name.toLowerCase().includes(searchText.toLowerCase())),
    [contextTables, searchText],
  );

  const translateMessage = React.useCallback((
    key: string,
    fallback: string,
    params?: I18nParams,
  ) => {
    const translated = translate(key, params);
    return translated && translated !== key ? translated : fallback;
  }, [translate]);

  const fetchTablesForDb = React.useCallback(async (dbName: string, connConfig: any) => {
    setContextLoading(true);
    setSelectedDbName(dbName);
    try {
      const res = await DBGetTables(buildRpcConnectionConfig(connConfig), dbName);
      if (res.success && Array.isArray(res.data)) {
        setContextTables(normalizeAIContextTables(res.data));
      } else {
        const detail = getErrorDetail(res.message);
        message.error(translateMessage(
          'ai_chat.input.message.fetch_tables_failed',
          `Failed to load tables: ${detail}`,
          { detail },
        ));
        setContextTables([]);
      }
    } catch (error: any) {
      const detail = getErrorDetail(error);
      message.error(translateMessage(
        'ai_chat.input.message.fetch_tables_failed',
        `Failed to load tables: ${detail}`,
        { detail },
      ));
      setContextTables([]);
    } finally {
      setContextLoading(false);
    }
  }, [translateMessage]);

  const handleOpenContext = React.useCallback(async () => {
    if (!activeContext?.connectionId) {
      message.warning(translateMessage(
        'ai_chat.input.message.select_database_context_first',
        'Select a database on the left before attaching chat context',
      ));
      return;
    }

    const connection = useStore.getState().connections.find((item) => item.id === activeContext.connectionId);
    if (!connection) {
      return;
    }

    setContextOpen(true);
    setContextLoading(true);
    setSearchText('');
    setSelectedTableKeys(activeContextItems
      .filter(isAITableSchemaContext)
      .map((item) => `${item.dbName}::${item.tableName}`));
    const currentSelectionTabId = String(activeEditorSelection?.tabId || '').trim();
    const currentSelectionText = String(activeEditorSelection?.text || '');
    setSelectedEditorSelection(activeContextItems.some((item) => {
      if (!isAIEditorSelectionContext(item)) return false;
      return item.source?.tabId === currentSelectionTabId
        && String(item.content || item.ddl || '') === currentSelectionText;
    }));

    try {
      const dbRes = await DBGetDatabases(buildRpcConnectionConfig(connection.config) as any);
      if (dbRes.success && Array.isArray(dbRes.data)) {
        setDbList(dbRes.data.map((row: any) => Object.values(row)[0] as string));
      }

      const initialDbName = activeContext.dbName || '';
      setSelectedDbName(initialDbName);
      const tablesRes = await DBGetTables(buildRpcConnectionConfig(connection.config) as any, initialDbName);
      if (tablesRes.success && Array.isArray(tablesRes.data)) {
        setContextTables(normalizeAIContextTables(tablesRes.data));
      } else {
        const detail = getErrorDetail(tablesRes.message);
        message.error(translateMessage(
          'ai_chat.input.message.fetch_tables_failed',
          `Failed to load tables: ${detail}`,
          { detail },
        ));
        setContextTables([]);
      }
    } catch (error: any) {
      const detail = getErrorDetail(error);
      message.error(translateMessage(
        'ai_chat.input.message.context_load_failed',
        `Failed to load table context: ${detail}`,
        { detail },
      ));
    } finally {
      setContextLoading(false);
    }
  }, [activeContext, activeContextItems, activeEditorSelection, translateMessage]);

  const handleAppendContext = React.useCallback(async () => {
    if (!activeContext?.connectionId) {
      return;
    }

    const connection = useStore.getState().connections.find((item) => item.id === activeContext.connectionId);
    if (!connection) {
      return;
    }

    setAppendingContext(true);
    try {
      let addedCount = 0;
      let removedCount = 0;
      let selectionChanged = false;

      const tableItems = activeContextItems.filter(isAITableSchemaContext);
      const selectionItems = activeContextItems.filter(isAIEditorSelectionContext);

      for (const item of tableItems) {
        const key = `${item.dbName}::${item.tableName}`;
        if (!selectedTableKeys.includes(key)) {
          removeAIContext(connectionKey, item.dbName, item.tableName);
          removedCount += 1;
        }
      }

      const currentSelectionText = String(activeEditorSelection?.text || '');
      const currentSelectionTabId = String(activeEditorSelection?.tabId || '').trim();
      const keepSelection = Boolean(selectedEditorSelection && currentSelectionText.trim() && currentSelectionTabId);
      for (const item of selectionItems) {
        const matchesCurrentSelection = keepSelection
          && item.source?.tabId === currentSelectionTabId
          && String(item.content || item.ddl || '') === currentSelectionText;
        if (!matchesCurrentSelection) {
          removeAIContext(connectionKey, item.dbName, item.tableName);
          removedCount += 1;
          selectionChanged = true;
        }
      }

      if (keepSelection && activeEditorSelection) {
        if (!selectionItems.some((item) => item.source?.tabId === currentSelectionTabId
          && String(item.content || item.ddl || '') === currentSelectionText)) {
          addAIContext(connectionKey, buildAIEditorSelectionContextItem(activeEditorSelection));
          addedCount += 1;
          selectionChanged = true;
        }
      }

      for (const key of selectedTableKeys) {
        const [dbName, tableName] = key.split('::');
        if (!dbName || !tableName) {
          continue;
        }

        if (activeContextItems.some((item) => item.dbName === dbName && item.tableName === tableName)) {
          continue;
        }

        const rpcConfig = buildRpcConnectionConfig(connection.config) as any;
        const schemaResult = await resolveAITableSchemaToolResult({
          tableName,
          fetchDDL: () => DBShowCreateTable(rpcConfig, dbName, tableName),
          fetchColumns: () => DBGetColumns(rpcConfig, dbName, tableName),
        });

        if (!schemaResult.success) {
          const table = `${dbName}.${tableName}`;
          const detail = getErrorDetail(schemaResult.content);
          message.error(translateMessage(
            'ai_chat.input.message.fetch_table_schema_failed',
            `Failed to load structure for ${table}: ${detail}`,
            { table, detail },
          ));
          continue;
        }

        if (schemaResult.content) {
          addAIContext(connectionKey, {
            dbName,
            tableName,
            ddl: schemaResult.content,
          });
          addedCount += 1;
        }
      }

      if (addedCount > 0 || removedCount > 0) {
        if (addedCount > 0 && removedCount === 0) {
          message.success(translateMessage(
            selectionChanged ? 'ai_chat.input.message.context_items_added' : 'ai_chat.input.message.context_added',
            `Added ${addedCount} context item(s)`,
            { count: addedCount },
          ));
        } else if (removedCount > 0 && addedCount === 0) {
          message.success(translateMessage(
            selectionChanged ? 'ai_chat.input.message.context_items_removed' : 'ai_chat.input.message.context_removed',
            `Removed ${removedCount} context item(s) from the context`,
            { count: removedCount },
          ));
        } else {
          message.success(translateMessage(
            'ai_chat.input.message.context_synced',
            `Context synced: added ${addedCount}, removed ${removedCount}`,
            { added: addedCount, removed: removedCount },
          ));
        }
        if (addedCount > 0) {
          setContextExpanded(true);
        }
      } else {
        message.info(translateMessage(
          'ai_chat.input.message.selection_unchanged',
          'Selected tables did not change',
        ));
      }
      setContextOpen(false);
    } catch (error: any) {
      const detail = getErrorDetail(error);
      message.error(translateMessage(
        'ai_chat.input.message.context_sync_failed',
        `Failed to sync AI context: ${detail}`,
        { detail },
      ));
    } finally {
      setAppendingContext(false);
    }
  }, [activeContext, activeContextItems, activeEditorSelection, addAIContext, connectionKey, removeAIContext, selectedEditorSelection, selectedTableKeys, translateMessage]);

  const handleDbChange = React.useCallback((value: string) => {
    const connection = useStore.getState().connections.find((item) => item.id === activeContext?.connectionId);
    if (connection) {
      void fetchTablesForDb(value, connection.config);
    }
  }, [activeContext?.connectionId, fetchTablesForDb]);

  const handleRemoveContextItem = React.useCallback((dbName: string, tableName: string) => {
    removeAIContext(connectionKey, dbName, tableName);
  }, [connectionKey, removeAIContext]);

  const handleBindEditorSelection = React.useCallback(() => {
    // Read the editor now: the stored copy follows editor events and can be behind
    // (select-all by keyboard, then a click that moves focus to this panel).
    const selection = refreshAIEditorSelection(useStore.getState().activeTabId) ?? activeEditorSelection;
    if (!selection?.text.trim()) {
      message.warning(translateMessage(
        'ai_chat.input.message.select_editor_text_first',
        'Select non-empty text in the editor before binding it to AI context',
      ));
      return;
    }
    // The selection knows which connection and database it came from; use that when
    // the sidebar has no active context, and make it the active one so the chat
    // reads the same attachment key.
    const connectionId = String(activeContext?.connectionId || selection.connectionId || '').trim();
    if (!connectionId) {
      message.warning(translateMessage(
        'ai_chat.input.message.select_database_context_first',
        'Select a database on the left before attaching chat context',
      ));
      return;
    }
    let bindKey = connectionKey;
    if (!activeContext?.connectionId) {
      const dbName = String(selection.dbName || '').trim();
      useStore.getState().setActiveContext({ connectionId, dbName });
      bindKey = `${connectionId}:${dbName}`;
    }

    const result = bindAIEditorSelectionContext({
      selection,
      connectionKey: bindKey,
      contextItems: activeContextItems,
      addAIContext,
      removeAIContext,
    });
    if (result === 'unchanged') {
      message.info(translateMessage(
        'ai_chat.input.message.context_selection_unchanged',
        'The current editor selection is already attached',
      ));
      setContextExpanded(true);
      return;
    }

    setContextExpanded(true);
    if (result === 'added') {
      message.success(translateMessage(
        'ai_chat.input.message.context_selection_added',
        'Editor selection attached to AI context',
      ));
    }
  }, [activeContext?.connectionId, activeContextItems, activeEditorSelection, addAIContext, connectionKey, removeAIContext, translateMessage]);

  return {
    appendingContext,
    contextExpanded,
    contextLoading,
    contextOpen,
    dbList,
    filteredTables,
    handleAppendContext,
    handleBindEditorSelection,
    handleDbChange,
    handleOpenContext,
    handleRemoveContextItem,
    searchText,
    selectedDbName,
    selectedEditorSelection,
    selectedTableKeys,
    setContextExpanded,
    setContextOpen,
    setSearchText,
    setSelectedTableKeys,
    setSelectedEditorSelection,
  };
};
