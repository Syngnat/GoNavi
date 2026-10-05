import { useState, useMemo, useRef, useCallback, useEffect } from 'react';
import { useOptionalI18n } from '../../../i18n/provider';
import { t as defaultTranslate } from '../../../i18n';
import { useStore } from '../../../store';
import type { DataImportMode } from '../../../utils/dataImportTab';
import { isEligibleImportConnection } from '../dataImportEligibility';
import {
  type SelectOption,
  resolvePreferenceStorage,
  type CapabilityLoadState,
  normalizeConnectionConfig,
  normalizeDatabaseNames,
  toSortedOptions,
} from '../dataImportWorkbenchModel';
import {
  type DataImportPreferenceScope,
  type DataImportPreferences,
  loadDataImportPreferences,
  saveDataImportPreferences,
} from '../../dataImportPreferences';
import {
  resolveDataImportModeCapability,
  resolveDataImportCapabilityReasonKey,
  type DataImportCapabilityDTO,
} from '../../dataImportCapability';
import type { TabData } from '../../../types';
import {
  DataImportCapability as LoadDataImportCapability,
  DBGetDatabases,
  DBGetTables,
} from '../../../../wailsjs/go/app/App';
import { buildRpcConnectionConfig } from '../../../utils/connectionRpcConfig';
import { isDatabaseVisible, filterVisibleDatabaseNames } from '../../../utils/databaseVisibility';
import { normalizeTableNamesFromMetadataRows } from '../../../utils/tableMetadataRows';
import type { DataImportWorkbenchProps } from '../../DataImportWorkbench';

export interface UseDataImportWorkbenchStateInput {
  tab: DataImportWorkbenchProps['tab'];
}

export const useDataImportWorkbenchState = ({ tab }: UseDataImportWorkbenchStateInput) => {
  const i18n = useOptionalI18n();
  const t = i18n?.t ?? defaultTranslate;
  const connections = useStore((state) => state.connections);
  const darkMode = useStore((state) => state.theme === 'dark');
  const addTab = useStore((state) => state.addTab);
  const [importMode, setImportMode] = useState<DataImportMode>(
    () => (tab.dataImportMode === 'database' ? 'database' : 'table'),
  );
  const eligibleConnections = useMemo(
    () => connections.filter((connection) => isEligibleImportConnection(connection, importMode)),
    [connections, importMode],
  );
  const connectionOptions = useMemo<SelectOption[]>(
    () => eligibleConnections.map((connection) => ({
      value: connection.id,
      label: connection.name,
      title: connection.name,
    })),
    [eligibleConnections],
  );

  const [selectedConnectionId, setSelectedConnectionId] = useState(() => String(tab.connectionId || '').trim());
  const [selectedDbName, setSelectedDbName] = useState(() => String(tab.dbName || '').trim());
  const [selectedTableName, setSelectedTableName] = useState(() => String(tab.tableName || '').trim());
  const [databaseOptions, setDatabaseOptions] = useState<SelectOption[]>([]);
  const [tableOptions, setTableOptions] = useState<SelectOption[]>([]);
  const [filePath, setFilePath] = useState('');
  const [fileName, setFileName] = useState('');
  const [fileSizeMB, setFileSizeMB] = useState('');
  const [loadingDatabases, setLoadingDatabases] = useState(false);
  const [loadingTables, setLoadingTables] = useState(false);
  const [selectingFile, setSelectingFile] = useState(false);
  const [importing, setImporting] = useState(false);
  const [preferencesByMode, setPreferencesByMode] = useState<Record<DataImportPreferenceScope, DataImportPreferences>>(() => {
    const storage = resolvePreferenceStorage();
    return {
      table: loadDataImportPreferences(storage, 'table'),
      database: loadDataImportPreferences(storage, 'database'),
    };
  });
  const [conflictKeyColumnsInput, setConflictKeyColumnsInput] = useState(
    () => preferencesByMode.table.conflictKeyColumns.join(', '),
  );
  const [historyRefreshToken, setHistoryRefreshToken] = useState(0);
  const [databaseError, setDatabaseError] = useState('');
  const [tableError, setTableError] = useState('');
  const [capabilityState, setCapabilityState] = useState<CapabilityLoadState>({
    connectionId: '',
    status: 'idle',
  });
  const [capabilityRequestToken, setCapabilityRequestToken] = useState(0);
  const appliedPrefillRef = useRef<string | null>(null);
  const fileSelectionRequestRef = useRef(0);
  const browserFileInputRef = useRef<HTMLInputElement>(null);
  const tabRef = useRef(tab);
  const wasImportingRef = useRef(false);
  tabRef.current = tab;

  const selectedConnection = useMemo(
    () => eligibleConnections.find((connection) => connection.id === selectedConnectionId),
    [eligibleConnections, selectedConnectionId],
  );
  const selectedConnectionConfig = useMemo(
    () => (selectedConnection ? normalizeConnectionConfig(selectedConnection) : null),
    [selectedConnection],
  );
  const targetLocked = Boolean(filePath) || importing;
  const activeCapability = capabilityState.connectionId === selectedConnectionId
    && capabilityState.status === 'ready'
    ? capabilityState.value
    : undefined;
  const modeCapability = resolveDataImportModeCapability(
    activeCapability,
    importMode === 'database' ? 'sqlFile' : 'table',
  );
  const capabilityAllowsImport = capabilityState.connectionId === selectedConnectionId
    && capabilityState.status === 'ready'
    && modeCapability.supported;
  const activePreferences = preferencesByMode[importMode];
  const continueOnError = capabilityAllowsImport
    && modeCapability.supportsContinue
    && activePreferences.continueOnError;
  const supportedConflictPolicies = modeCapability.supportedConflictPolicies || [];
  const conflictPolicySupported = importMode !== 'table'
    || !capabilityAllowsImport
    || supportedConflictPolicies.includes(activePreferences.conflictPolicy);
  const conflictKeysValid = activePreferences.conflictPolicy !== 'upsert'
    || activePreferences.conflictKeyColumns.length > 0;
  const tableImportOptionsValid = conflictPolicySupported && conflictKeysValid;
  const capabilityReason = capabilityState.connectionId === selectedConnectionId
    ? capabilityState.status === 'loading'
      ? 'loading'
      : capabilityState.status === 'error'
        ? 'rpc_failed'
        : capabilityState.status === 'ready' && !modeCapability.supported
          ? (modeCapability.reason || 'capability_unavailable')
          : ''
    : '';
  const capabilityMessageKey = capabilityReason === 'loading'
    ? 'data_import.capability.loading'
    : capabilityReason === 'rpc_failed'
      ? 'data_import.capability.rpc_failed'
      : capabilityReason
        ? resolveDataImportCapabilityReasonKey(capabilityReason)
        : '';
  const capabilityDetails = [
    { key: 'formats', values: modeCapability.supportedFormats },
    { key: 'encodings', values: modeCapability.supportedEncodings },
    { key: 'compressions', values: modeCapability.supportedCompressions },
    { key: 'directives', values: modeCapability.supportedClientDirectives },
  ].map(({ key, values }) => ({
    key,
    values: Array.isArray(values)
      ? Array.from(new Set(values.map((value) => String(value || '').trim()).filter(Boolean)))
      : [],
  })).filter(({ values }) => values.length > 0);

  const syncWorkbenchTab = useCallback((patch: Partial<TabData>) => {
    addTab({
      ...tabRef.current,
      ...patch,
      id: tabRef.current.id,
      type: 'data-import',
    });
  }, [addTab]);

  const updateImportPreferences = useCallback((
    scope: DataImportPreferenceScope,
    patch: Partial<DataImportPreferences>,
  ) => {
    setPreferencesByMode((current) => {
      const nextPreferences = { ...current[scope], ...patch };
      saveDataImportPreferences(resolvePreferenceStorage(), scope, nextPreferences);
      return { ...current, [scope]: nextPreferences };
    });
  }, []);

  const invalidateFileSelection = useCallback(() => {
    fileSelectionRequestRef.current += 1;
    setSelectingFile(false);
    setFilePath('');
    setFileName('');
    setFileSizeMB('');
    if (browserFileInputRef.current) browserFileInputRef.current.value = '';
  }, []);

  useEffect(() => {
    if (importing) return;
    const nextMode: DataImportMode = tab.dataImportMode === 'database' ? 'database' : 'table';
    const prefillKey = [
      tab.dataImportLaunchKey,
      nextMode,
      tab.connectionId,
      tab.dbName,
      nextMode === 'table' ? tab.tableName : '',
    ]
      .map((value) => String(value || '').trim())
      .join('::');
    if (appliedPrefillRef.current === prefillKey) return;
    appliedPrefillRef.current = prefillKey;
    setImportMode(nextMode);
    setSelectedConnectionId(String(tab.connectionId || '').trim());
    setSelectedDbName(String(tab.dbName || '').trim());
    setSelectedTableName(nextMode === 'table' ? String(tab.tableName || '').trim() : '');
    setDatabaseError('');
    setTableError('');
    invalidateFileSelection();
  }, [
    importing,
    invalidateFileSelection,
    tab.connectionId,
    tab.dataImportLaunchKey,
    tab.dataImportMode,
    tab.dbName,
    tab.tableName,
  ]);

  useEffect(() => {
    if (importing) return;
    if (connections.length === 0) return;
    if (eligibleConnections.some((connection) => connection.id === selectedConnectionId)) return;
    const nextConnectionId = eligibleConnections[0]?.id || '';
    setSelectedConnectionId(nextConnectionId);
    setSelectedDbName('');
    setSelectedTableName('');
    invalidateFileSelection();
    syncWorkbenchTab({
      connectionId: nextConnectionId,
      dbName: undefined,
      tableName: undefined,
      dataImportMode: importMode,
      dataImportRunning: false,
    });
  }, [
    connections.length,
    eligibleConnections,
    importMode,
    importing,
    invalidateFileSelection,
    selectedConnectionId,
    syncWorkbenchTab,
  ]);

  useEffect(() => {
    if (importing) return undefined;
    if (!selectedConnectionConfig || !selectedConnectionId) {
      setCapabilityState({ connectionId: '', status: 'idle' });
      return undefined;
    }

    let active = true;
    setCapabilityState({ connectionId: selectedConnectionId, status: 'loading' });
    void Promise.resolve()
      .then(() => LoadDataImportCapability(buildRpcConnectionConfig(selectedConnectionConfig) as any))
      .then((capability) => {
        if (!active) return;
        setCapabilityState({
          connectionId: selectedConnectionId,
          status: 'ready',
          value: capability as unknown as DataImportCapabilityDTO,
        });
      })
      .catch(() => {
        if (!active) return;
        setCapabilityState({ connectionId: selectedConnectionId, status: 'error' });
      });

    return () => {
      active = false;
    };
  }, [capabilityRequestToken, importing, selectedConnectionConfig, selectedConnectionId]);

  useEffect(() => {
    if (importing) return undefined;
    if (!selectedConnectionConfig || !selectedConnection) {
      setDatabaseOptions([]);
      setLoadingDatabases(false);
      setDatabaseError('');
      return undefined;
    }

    let alive = true;
    setDatabaseOptions([]);
    setLoadingDatabases(true);
    setDatabaseError('');
    if (selectedDbName && !isDatabaseVisible(selectedConnection, selectedDbName)) {
      setSelectedDbName('');
      setSelectedTableName('');
      setTableOptions([]);
      invalidateFileSelection();
    }
    DBGetDatabases(buildRpcConnectionConfig(selectedConnectionConfig) as any)
      .then((res) => {
        if (!alive) return;
        if (!res.success) {
          setDatabaseOptions([]);
          setSelectedDbName('');
          setSelectedTableName('');
          setTableOptions([]);
          invalidateFileSelection();
          setDatabaseError(t('data_import.workbench.message.load_databases_failed', {
            detail: res.message || '',
          }));
          return;
        }
        const databaseNames = filterVisibleDatabaseNames(
          selectedConnection,
          normalizeDatabaseNames(res.data),
        );
        const nextOptions = toSortedOptions(databaseNames);
        setDatabaseOptions(nextOptions);
        const availableNames = new Set(nextOptions.map((option) => option.value));
        const configuredDatabase = String(selectedConnection.config.database || '').trim();
        const nextDbName = availableNames.has(selectedDbName)
          ? selectedDbName
          : (availableNames.has(configuredDatabase) ? configuredDatabase : '');
        if (nextDbName !== selectedDbName) {
          setSelectedDbName(nextDbName);
          setSelectedTableName('');
          setTableOptions([]);
          invalidateFileSelection();
        }
      })
      .catch((error: any) => {
        if (!alive) return;
        setDatabaseOptions([]);
        setSelectedDbName('');
        setSelectedTableName('');
        setTableOptions([]);
        invalidateFileSelection();
        setDatabaseError(t('data_import.workbench.message.load_databases_failed', {
          detail: error?.message || String(error),
        }));
      })
      .finally(() => {
        if (alive) setLoadingDatabases(false);
      });

    return () => {
      alive = false;
    };
  }, [importing, invalidateFileSelection, selectedConnection, selectedConnectionConfig, t]);

  useEffect(() => {
    if (importing) return undefined;
    if (importMode !== 'table' || !selectedConnectionConfig || !selectedDbName) {
      setTableOptions([]);
      setLoadingTables(false);
      setTableError('');
      return undefined;
    }

    let alive = true;
    setLoadingTables(true);
    setTableError('');
    DBGetTables(buildRpcConnectionConfig(selectedConnectionConfig) as any, selectedDbName)
      .then((res) => {
        if (!alive) return;
        if (!res.success) {
          setTableOptions([]);
          setSelectedTableName('');
          invalidateFileSelection();
          setTableError(t('data_import.workbench.message.load_tables_failed', {
            detail: res.message || '',
          }));
          return;
        }
        const nextOptions = toSortedOptions(normalizeTableNamesFromMetadataRows(res.data));
        setTableOptions(nextOptions);
        const availableNames = new Set(nextOptions.map((option) => option.value));
        setSelectedTableName((current) => (availableNames.has(current) ? current : ''));
      })
      .catch((error: any) => {
        if (!alive) return;
        setTableOptions([]);
        setSelectedTableName('');
        invalidateFileSelection();
        setTableError(t('data_import.workbench.message.load_tables_failed', {
          detail: error?.message || String(error),
        }));
      })
      .finally(() => {
        if (alive) setLoadingTables(false);
      });

    return () => {
      alive = false;
    };
  }, [importMode, importing, invalidateFileSelection, selectedConnectionConfig, selectedDbName, t]);

  const clearSelectedFile = () => {
    invalidateFileSelection();
  };

  const handleModeChange = (value: string | number) => {
    const nextMode: DataImportMode = value === 'database' ? 'database' : 'table';
    if (nextMode === importMode || importing) return;
    invalidateFileSelection();
    setImportMode(nextMode);
    setSelectedTableName('');
    setTableOptions([]);
    setTableError('');
    syncWorkbenchTab({
      connectionId: selectedConnectionId,
      dbName: selectedDbName || undefined,
      tableName: undefined,
      dataImportMode: nextMode,
      dataImportRunning: false,
    });
  };

  const handleConnectionChange = (connectionId: string) => {
    invalidateFileSelection();
    setSelectedConnectionId(connectionId);
    setSelectedDbName('');
    setSelectedTableName('');
    setDatabaseOptions([]);
    setTableOptions([]);
    setDatabaseError('');
    setTableError('');
    syncWorkbenchTab({
      connectionId,
      dbName: undefined,
      tableName: undefined,
      dataImportMode: importMode,
      dataImportRunning: false,
    });
  };

  const handleDatabaseChange = (value?: string) => {
    const dbName = String(value || '').trim();
    invalidateFileSelection();
    setSelectedDbName(dbName);
    setSelectedTableName('');
    setTableOptions([]);
    setTableError('');
    syncWorkbenchTab({
      connectionId: selectedConnectionId,
      dbName,
      tableName: undefined,
      dataImportMode: importMode,
      dataImportRunning: false,
    });
  };

  const handleTableChange = (tableName: string) => {
    invalidateFileSelection();
    setSelectedTableName(tableName);
    syncWorkbenchTab({
      connectionId: selectedConnectionId,
      dbName: selectedDbName,
      tableName,
      dataImportMode: importMode,
      dataImportRunning: false,
    });
  };
  return {
    t, darkMode, importMode, connectionOptions, selectedConnectionId, selectedDbName,
    selectedTableName, databaseOptions, tableOptions, filePath, setFilePath, fileName, setFileName,
    fileSizeMB, setFileSizeMB, loadingDatabases, loadingTables, selectingFile, setSelectingFile,
    importing, setImporting, conflictKeyColumnsInput, setConflictKeyColumnsInput,
    historyRefreshToken, setHistoryRefreshToken, databaseError, tableError,
    setCapabilityRequestToken, fileSelectionRequestRef, browserFileInputRef, wasImportingRef,
    selectedConnection, selectedConnectionConfig, targetLocked, modeCapability,
    capabilityAllowsImport, activePreferences, continueOnError, supportedConflictPolicies,
    conflictPolicySupported, conflictKeysValid, tableImportOptionsValid, capabilityReason,
    capabilityMessageKey, capabilityDetails, syncWorkbenchTab, updateImportPreferences,
    clearSelectedFile, handleModeChange, handleConnectionChange, handleDatabaseChange,
    handleTableChange,
  };
};

export type DataImportWorkbenchStateApi = ReturnType<typeof useDataImportWorkbenchState>;
