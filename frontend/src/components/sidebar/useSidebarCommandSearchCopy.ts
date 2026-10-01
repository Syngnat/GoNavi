import { useCallback } from 'react';
import { message } from 'antd';

import { t } from '../../i18n';
import type { SavedConnection } from '../../types';
import { resolveSidebarNodeConnectionId, type V2CommandSearchItem } from '../sidebarV2Utils';
import type { V2CommandSearchCopyAction, V2CommandSearchCopyOption } from './SidebarSearchPanel';
import {
  isV2SidebarObjectNode,
  resolveSidebarDatabaseNameForCopy,
  resolveSidebarTableNameForCopy,
} from './sidebarHelpers';

type UseSidebarCommandSearchCopyArgs = {
  connections: ReadonlyArray<SavedConnection>;
  connectionIds: string[];
};

/** Right-click "copy name / SQL" menu of the command palette rows. */
export const useSidebarCommandSearchCopy = ({ connections, connectionIds }: UseSidebarCommandSearchCopyArgs) => {
  const getCommandSearchCopyOptions = useCallback((item: V2CommandSearchItem): V2CommandSearchCopyOption[] => {
    if (item.kind === 'action') return [];

    if (item.kind === 'recent') {
      const options: V2CommandSearchCopyOption[] = [];
      if (String(item.sql || '').trim()) {
        options.push({
          action: 'sql',
          label: t('sidebar.command_search.context_menu.copy_sql'),
        });
      }
      if (String(item.dbName || '').trim()) {
        options.push({
          action: 'database-name',
          label: t('sidebar.command_search.context_menu.copy_database_name'),
        });
      }
      const connectionId = String(item.connectionId || '').trim();
      const connectionName = connections.find((connection) => connection.id === connectionId)?.name?.trim() || '';
      if (connectionName) {
        options.push({
          action: 'connection-name',
          label: t('sidebar.command_search.context_menu.copy_connection_name'),
        });
      }
      return options;
    }

    const node = item.node;
    const nodeType = String(node?.type || '');
    const options: V2CommandSearchCopyOption[] = [];
    if (isV2SidebarObjectNode(node)) {
      options.push({
        action: 'object-name',
        label: t('sidebar.command_search.context_menu.copy_object_name'),
      });
    }
    if (nodeType !== 'connection') {
      options.push({
        action: 'database-name',
        label: t('sidebar.command_search.context_menu.copy_database_name'),
      });
    }
    const connectionId = resolveSidebarNodeConnectionId(node, connectionIds);
    const connectionName = connections.find((connection) => connection.id === connectionId)?.name?.trim() || '';
    if (connectionName) {
      options.push({
        action: 'connection-name',
        label: t('sidebar.command_search.context_menu.copy_connection_name'),
      });
    }
    return options.filter((option) => {
      if (option.action === 'object-name') return Boolean(resolveSidebarTableNameForCopy(node));
      if (option.action === 'database-name') return Boolean(resolveSidebarDatabaseNameForCopy(node));
      return true;
    });
  }, [connectionIds, connections]);

  const handleCopyCommandSearchItem = useCallback(async (
    item: V2CommandSearchItem,
    action: V2CommandSearchCopyAction,
  ): Promise<void> => {
    let value = '';
    if (item.kind === 'recent') {
      if (action === 'sql') value = item.sql;
      if (action === 'database-name') value = String(item.dbName || '');
      if (action === 'connection-name') {
        const connectionId = String(item.connectionId || '').trim();
        value = connections.find((connection) => connection.id === connectionId)?.name || '';
      }
    } else if (item.kind === 'node') {
      if (action === 'object-name') value = resolveSidebarTableNameForCopy(item.node);
      if (action === 'database-name') value = resolveSidebarDatabaseNameForCopy(item.node);
      if (action === 'connection-name') {
        const connectionId = resolveSidebarNodeConnectionId(item.node, connectionIds);
        value = connections.find((connection) => connection.id === connectionId)?.name || '';
      }
    }

    const normalizedValue = String(value || '').trim();
    if (!normalizedValue) {
      message.warning(t('sidebar.copy_object_name.empty', {
        label: t(`sidebar.command_search.context_menu.copy_${action.replace('-', '_')}`),
      }));
      return;
    }

    try {
      const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
      if (!clipboard?.writeText) throw new Error('Clipboard API unavailable');
      await clipboard.writeText(value);
      message.success(t('sidebar.command_search.copy_success'));
    } catch (error: any) {
      message.error(t('sidebar.command_search.copy_failed', {
        error: error?.message || String(error),
      }));
    }
  }, [connectionIds, connections]);

  return { getCommandSearchCopyOptions, handleCopyCommandSearchItem };
};
