import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { message } from 'antd';

import { useStore } from '../../../store';
import { t } from '../../../i18n';
import { useAutoFetchVisibility } from '../../../utils/autoFetchVisibility';
import { loadViews } from '../../sidebar/sidebarMetadataObjectLoaders';
import { loadFunctions, loadDatabaseEvents } from '../../sidebar/sidebarMetadataRoutineLoaders';
import {
  type ObjectListKind,
  type ObjectOverviewRow,
  buildObjectOpenTab,
} from '../objectOverviewModel';
import type { ObjectOverviewProps } from '../ObjectOverview';

export interface UseObjectOverviewStateInput {
  tab: ObjectOverviewProps['tab'];
}

export const useObjectOverviewState = ({ tab }: UseObjectOverviewStateInput) => {
  const connections = useStore(state => state.connections);
  const addTab = useStore(state => state.addTab);
  const setActiveContext = useStore(state => state.setActiveContext);

  const kind: ObjectListKind = tab.overviewKind === 'routines'
    ? 'routines'
    : tab.overviewKind === 'events' ? 'events' : 'views';
  const schemaName = String(tab.schemaName || '').trim() || undefined;
  const connection = useMemo(
    () => connections.find(c => c.id === tab.connectionId),
    [connections, tab.connectionId],
  );

  const [rows, setRows] = useState<ObjectOverviewRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [unsupported, setUnsupported] = useState(false);
  const [searchText, setSearchText] = useState('');
  const [selectedName, setSelectedName] = useState('');
  const loadRequestIdRef = useRef(0);
  const autoFetchVisible = useAutoFetchVisibility();

  const loadData = useCallback(async () => {
    const requestId = loadRequestIdRef.current + 1;
    loadRequestIdRef.current = requestId;
    const isLatestRequest = () => loadRequestIdRef.current === requestId;
    if (!connection) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setUnsupported(false);
    try {
      if (kind === 'views') {
        const result = await loadViews(connection, tab.dbName || '');
        if (!isLatestRequest()) return;
        setUnsupported(!result.supported);
        setRows(result.views.map(view => ({ name: view.viewName })));
        if (!result.supported && result.failureMessage) {
          message.warning(t('object_overview.message.unsupported', {
            detail: result.failureMessage,
          }));
        }
        return;
      }
      if (kind === 'events') {
        const result = await loadDatabaseEvents(connection, tab.dbName || '');
        if (!isLatestRequest()) return;
        setUnsupported(!result.supported);
        setRows(result.events.map(event => ({ name: event.eventName })));
        if (!result.supported && result.failureMessage) {
          message.warning(t('object_overview.message.unsupported', {
            detail: result.failureMessage,
          }));
        }
        return;
      }
      const result = await loadFunctions(connection, tab.dbName || '');
      if (!isLatestRequest()) return;
      setUnsupported(!result.supported);
      setRows(result.routines.map(routine => ({
        name: routine.routineName,
        subType: routine.routineType,
      })));
      if (!result.supported && result.failureMessage) {
        message.warning(t('object_overview.message.unsupported', {
          detail: result.failureMessage,
        }));
      }
    } catch (e: any) {
      if (!isLatestRequest()) return;
      message.error(t('object_overview.message.load_failed', {
        detail: e?.message || String(e),
      }));
    } finally {
      if (isLatestRequest()) {
        setLoading(false);
      }
    }
  }, [connection, kind, tab.dbName]);

  useEffect(() => {
    if (!autoFetchVisible) return;
    void loadData();
  }, [autoFetchVisible, loadData]);

  const normalizedSearch = searchText.trim().toLowerCase();
  const filteredRows = useMemo(() => {
    const sorted = [...rows].sort((a, b) => a.name.localeCompare(b.name));
    if (!normalizedSearch) return sorted;
    return sorted.filter(row => row.name.toLowerCase().includes(normalizedSearch));
  }, [normalizedSearch, rows]);

  const openObject = useCallback((row: ObjectOverviewRow) => {
    if (!connection) return;
    setActiveContext({
      connectionId: connection.id,
      dbName: tab.dbName || '',
      schemaName: schemaName || undefined,
    });
    addTab(buildObjectOpenTab(kind, connection, tab.dbName || '', schemaName, row, t));
  }, [addTab, connection, kind, schemaName, setActiveContext, tab.dbName]);

  const handleCopyName = useCallback(async (row: ObjectOverviewRow) => {
    try {
      await navigator.clipboard.writeText(row.name);
      message.success(t('object_overview.message.copy_name_success'));
    } catch (e: any) {
      message.error(t('object_overview.message.copy_name_failed', {
        detail: e?.message || String(e),
      }));
    }
  }, []);

  return {
    kind, rows, filteredRows, loading, unsupported, searchText, setSearchText,
    selectedName, setSelectedName, connection, schemaName, loadData, openObject, handleCopyName,
  };
};

export type ObjectOverviewStateApi = ReturnType<typeof useObjectOverviewState>;
