import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Checkbox, Empty, Segmented, Select, Typography, message } from 'antd';
import {
  DatabaseOutlined,
  FileAddOutlined,
  ImportOutlined,
  TableOutlined,
} from '@ant-design/icons';

import {
  DataImportCapability as LoadDataImportCapability,
  DBGetDatabases,
  DBGetTables,
  ImportData,
  SelectSQLFileForExecution,
} from '../../wailsjs/go/app/App';
import { useStore } from '../store';
import type { SavedConnection, TabData } from '../types';
import { t as defaultTranslate } from '../i18n';
import { useOptionalI18n } from '../i18n/provider';
import { BACKEND_CANCELLED_MESSAGE } from '../utils/connectionExport';
import { buildRpcConnectionConfig } from '../utils/connectionRpcConfig';
import { filterVisibleDatabaseNames, isDatabaseVisible } from '../utils/databaseVisibility';
import {
  isConnectionDataImportRestricted,
  isConnectionScriptExecutionRestricted,
  isConnectionStructureEditRestricted,
} from '../utils/connectionReadOnly';
import { getDataSourceCapabilities } from '../utils/dataSourceCapabilities';
import { normalizeTableNamesFromMetadataRows } from '../utils/tableMetadataRows';
import type { DataImportMode } from '../utils/dataImportTab';
import DatabaseImportExecutionPanel from './DatabaseImportExecutionPanel';
import ImportJobHistoryPanel from './ImportJobHistoryPanel';
import ImportPreviewModal from './ImportPreviewModal';
import {
  resolveDataImportCapabilityReasonKey,
  resolveDataImportModeCapability,
  type DataImportCapabilityDTO,
} from './dataImportCapability';
import {
  loadDataImportPreferences,
  saveDataImportPreferences,
  type DataImportPreferenceScope,
  type DataImportPreferences,
} from './dataImportPreferences';
import './DataImportWorkbench.css';

const { Text, Title } = Typography;

const targetSelectStyle: React.CSSProperties = {
  width: '100%',
  minWidth: 0,
  maxWidth: '100%',
};

type SelectOption = {
  value: string;
  label: React.ReactNode;
  title: string;
};

type CapabilityLoadState = {
  connectionId: string;
  status: 'idle' | 'loading' | 'ready' | 'error';
  value?: DataImportCapabilityDTO;
};

const normalizeConnectionConfig = (connection: SavedConnection) => ({
  ...connection.config,
  port: Number(connection.config.port),
  password: connection.config.password || '',
  database: connection.config.database || '',
  useSSH: connection.config.useSSH || false,
  ssh: connection.config.ssh || {
    host: '',
    port: 22,
    user: '',
    password: '',
    keyPath: '',
  },
});

const toSortedOptions = (values: string[]): SelectOption[] => (
  Array.from(new Set(values.map((value) => String(value || '').trim()).filter(Boolean)))
    .sort((left, right) => left.toLowerCase().localeCompare(right.toLowerCase()))
    .map((value) => ({ value, label: value, title: value }))
);

const normalizeDatabaseNames = (rows: unknown): string[] => {
  if (!Array.isArray(rows)) return [];
  return rows
    .map((row) => String(row?.Database || row?.database || '').trim())
    .filter(Boolean);
};

const getFileName = (filePath: string): string => {
  const parts = String(filePath || '').split(/[\\/]/);
  return parts[parts.length - 1] || filePath;
};

const resolvePreferenceStorage = (): Storage | null => {
  try {
    return typeof globalThis.localStorage === 'undefined' ? null : globalThis.localStorage;
  } catch {
    return null;
  }
};

const parseConflictKeyColumns = (value: string): string[] => (
  String(value || '')
    .split(',')
    .map((column) => column.trim().slice(0, 255))
    .filter(Boolean)
    .filter((column, index, columns) => (
      columns.findIndex((candidate) => candidate.toLowerCase() === column.toLowerCase()) === index
    ))
    .slice(0, 64)
);

const normalizeConflictKeyColumnsInput = (value: string): {
  columns: string[];
  displayValue: string;
} => {
  const inputValue = String(value || '');
  const columns = parseConflictKeyColumns(inputValue);
  const trailingSeparator = inputValue.match(/,\s*$/)?.[0] || '';
  return {
    columns,
    displayValue: `${columns.join(', ')}${columns.length < 64 ? trailingSeparator : ''}`,
  };
};

const isEligibleImportConnection = (
  connection: SavedConnection,
  mode: DataImportMode,
): boolean => {
  if (mode === 'table') {
    const capabilities = getDataSourceCapabilities(connection.config);
    return capabilities.supportsCopyInsert
      && !isConnectionDataImportRestricted(connection.config);
  }
  return !isConnectionDataImportRestricted(connection.config)
    && !isConnectionStructureEditRestricted(connection.config)
    && !isConnectionScriptExecutionRestricted(connection.config);
};

const DataImportWorkbench: React.FC<{ tab: TabData }> = ({ tab }) => {
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
    setFileSizeMB('');
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

  const handleImportingChange = useCallback((nextImporting: boolean) => {
    if (wasImportingRef.current !== nextImporting) {
      setHistoryRefreshToken((current) => current + 1);
    }
    wasImportingRef.current = nextImporting;
    setImporting(nextImporting);
    syncWorkbenchTab({
      connectionId: selectedConnectionId,
      dbName: selectedDbName || undefined,
      tableName: importMode === 'table' ? selectedTableName || undefined : undefined,
      dataImportMode: importMode,
      dataImportRunning: nextImporting,
    });
  }, [importMode, selectedConnectionId, selectedDbName, selectedTableName, syncWorkbenchTab]);

  const handleSelectFile = async () => {
    if (!capabilityAllowsImport || !selectedConnectionConfig || !selectedConnection || loadingDatabases || loadingTables) return;
    if (importMode === 'table' && !tableImportOptionsValid) return;
    if (importMode === 'table' && (!selectedDbName || !selectedTableName)) return;
    if (selectedDbName && !isDatabaseVisible(selectedConnection, selectedDbName)) return;
    const requestId = fileSelectionRequestRef.current + 1;
    fileSelectionRequestRef.current = requestId;
    setSelectingFile(true);
    try {
      const res = importMode === 'database'
        ? await SelectSQLFileForExecution()
        : await ImportData(
            buildRpcConnectionConfig(selectedConnectionConfig) as any,
            selectedDbName,
            selectedTableName,
          );
      if (fileSelectionRequestRef.current !== requestId) return;
      const nextFilePath = String(res?.data?.filePath || '').trim();
      if (res.success && nextFilePath) {
        setFilePath(nextFilePath);
        setFileSizeMB(importMode === 'database'
          ? String(res?.data?.fileSizeMB || '').trim()
          : '');
        return;
      }
      if (String(res?.message || '').trim() !== BACKEND_CANCELLED_MESSAGE) {
        void message.error(t('data_import.workbench.message.select_file_failed', {
          detail: res?.message || '',
        }));
      }
    } catch (error: any) {
      if (fileSelectionRequestRef.current !== requestId) return;
      void message.error(t('data_import.workbench.message.select_file_failed', {
        detail: error?.message || String(error),
      }));
    } finally {
      if (fileSelectionRequestRef.current === requestId) setSelectingFile(false);
    }
  };

  const shellBackground = `var(--gn-bg-panel-2, ${darkMode ? '#101319' : '#f5f7fb'})`;
  const panelBackground = `var(--gn-bg-panel, ${darkMode ? '#161b22' : '#ffffff'})`;
  const panelBorder = `1px solid var(--gn-br-1, ${darkMode
    ? 'rgba(255,255,255,0.08)'
    : 'rgba(15,23,42,0.08)'})`;
  const selectedFileBackground = `var(--gn-bg-subtle, var(--gn-bg-panel-2, ${darkMode
    ? 'rgba(255,255,255,0.04)'
    : '#f8fafc'}))`;

  return (
    <div
      data-data-import-workbench="true"
      style={{
        display: 'flex',
        flex: 1,
        minWidth: 0,
        minHeight: 0,
        flexDirection: 'column',
        overflow: 'hidden',
        background: shellBackground,
      }}
    >
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 16,
          flexWrap: 'wrap',
          padding: '20px 24px 16px',
          background: panelBackground,
          borderBottom: panelBorder,
        }}
      >
        <div>
          <Title level={4} style={{ margin: 0, letterSpacing: 0 }}>
            {t('data_import.workbench.title')}
          </Title>
          <Text type="secondary">
            {importMode === 'database'
              ? t('data_import.workbench.description.database')
              : t('data_import.workbench.description')}
          </Text>
        </div>
        <Segmented
          data-import-mode-selector="true"
          value={importMode}
          disabled={importing}
          options={[
            {
              value: 'table',
              label: t('data_import.workbench.mode.table'),
              icon: <TableOutlined />,
            },
            {
              value: 'database',
              label: t('data_import.workbench.mode.database'),
              icon: <DatabaseOutlined />,
            },
          ]}
          onChange={handleModeChange}
        />
      </header>

      <div
        data-data-import-workbench-layout="true"
        style={{
          display: 'grid',
          flex: 1,
          minWidth: 0,
          minHeight: 0,
          gridTemplateColumns: 'minmax(280px, 340px) minmax(0, 1fr)',
          gap: 20,
          overflow: 'auto',
          padding: 24,
          alignItems: 'start',
        }}
      >
        <section
          data-data-import-target-config="true"
          style={{ padding: 20, border: panelBorder, borderRadius: 8, background: panelBackground }}
        >
          <div style={{ marginBottom: 16, fontSize: 13, fontWeight: 600 }}>
            {t('data_import.workbench.section.target')}
          </div>

          <div style={{ display: 'grid', gap: 14 }}>
            <label style={{ display: 'grid', gap: 6 }}>
              <Text type="secondary">{t('data_import.workbench.label.connection')}</Text>
              <Select
                data-import-target-field="connection"
                style={targetSelectStyle}
                value={selectedConnectionId || undefined}
                options={connectionOptions}
                placeholder={t('data_import.workbench.placeholder.select_connection')}
                showSearch
                optionFilterProp="title"
                disabled={targetLocked}
                onChange={handleConnectionChange}
              />
            </label>

            <label style={{ display: 'grid', gap: 6 }}>
              <Text type="secondary">
                {importMode === 'database'
                  ? t('data_import.workbench.label.default_database')
                  : t('data_import.workbench.label.database')}
              </Text>
              <Select
                data-import-target-field="database"
                style={targetSelectStyle}
                value={selectedDbName || undefined}
                options={databaseOptions}
                placeholder={loadingDatabases
                  ? t('data_import.workbench.placeholder.loading_databases')
                  : importMode === 'database'
                    ? t('data_import.workbench.placeholder.select_default_database')
                    : t('data_import.workbench.placeholder.select_database')}
                loading={loadingDatabases}
                showSearch
                allowClear={importMode === 'database'}
                optionFilterProp="title"
                disabled={targetLocked || !selectedConnectionId || loadingDatabases}
                onChange={handleDatabaseChange}
              />
            </label>

            {importMode === 'table' ? (
              <label style={{ display: 'grid', gap: 6 }}>
                <Text type="secondary">{t('data_import.workbench.label.table')}</Text>
                <Select
                  data-import-target-field="table"
                  style={targetSelectStyle}
                  value={selectedTableName || undefined}
                  options={tableOptions}
                  placeholder={!selectedDbName
                    ? t('data_import.workbench.placeholder.select_database_first')
                    : loadingTables
                      ? t('data_import.workbench.placeholder.loading_tables')
                      : t('data_import.workbench.placeholder.select_table')}
                  loading={loadingTables}
                  showSearch
                  optionFilterProp="title"
                  disabled={targetLocked || !selectedDbName || loadingTables}
                  onChange={handleTableChange}
                />
              </label>
            ) : null}

            {databaseError && <Alert type="error" showIcon message={databaseError} />}
            {importMode === 'table' && tableError && <Alert type="error" showIcon message={tableError} />}
            {capabilityReason && (
              <Alert
                data-import-capability-alert="true"
                data-import-capability-reason={capabilityReason}
                type={capabilityReason === 'loading' ? 'info' : 'error'}
                showIcon
                message={t(capabilityMessageKey)}
                action={capabilityReason === 'rpc_failed' ? (
                  <Button
                    data-import-capability-retry="true"
                    type="link"
                    size="small"
                    onClick={() => setCapabilityRequestToken((current) => current + 1)}
                  >
                    {t('common.retry')}
                  </Button>
                ) : undefined}
              />
            )}

            <div style={{ display: 'grid', gap: 6 }}>
              <Text type="secondary">
                {importMode === 'database'
                  ? t('data_import.workbench.label.sql_file')
                  : t('data_import.workbench.label.file')}
              </Text>
              {filePath && (
                <div
                  title={filePath}
                  style={{
                    minWidth: 0,
                    overflow: 'hidden',
                    padding: '8px 10px',
                    borderRadius: 6,
                    background: selectedFileBackground,
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    fontFamily: 'var(--gn-font-mono)',
                    fontSize: 12,
                  }}
                >
                  {getFileName(filePath)}
                </div>
              )}
              <Button
                data-import-select-file-action="true"
                type="primary"
                icon={filePath ? <FileAddOutlined /> : <ImportOutlined />}
                loading={selectingFile}
                disabled={
                  importing
                  || !capabilityAllowsImport
                  || !selectedConnectionConfig
                  || loadingDatabases
                  || loadingTables
                  || (importMode === 'table' && !tableImportOptionsValid)
                  || (importMode === 'table' && (!selectedDbName || !selectedTableName))
                }
                onClick={() => void handleSelectFile()}
              >
                {importMode === 'database'
                  ? filePath
                    ? t('data_import.workbench.action.change_sql_file')
                    : t('data_import.workbench.action.select_sql_file')
                  : filePath
                    ? t('data_import.workbench.action.change_file')
                    : t('data_import.workbench.action.select_file')}
              </Button>
              <Text type="secondary" style={{ fontSize: 12 }}>
                {importMode === 'database'
                  ? t('data_import.workbench.helper.sql_file')
                  : t('data_import.workbench.helper.file_formats')}
              </Text>
              {capabilityAllowsImport && capabilityDetails.length > 0 ? (
                <div
                  data-import-capability-details="true"
                  style={{ display: 'grid', gap: 3 }}
                >
                  {capabilityDetails.map(({ key, values }) => (
                    <Text
                      key={key}
                      type="secondary"
                      style={{ fontSize: 12 }}
                      data-import-capability-detail={key}
                    >
                      {t(`data_import.capability.details.${key}`)}: {values.join(', ')}
                    </Text>
                  ))}
                </div>
              ) : null}
            </div>

            <div
              data-import-error-policy="true"
              style={{
                display: 'grid',
                gap: 8,
                padding: '12px 14px',
                border: panelBorder,
                borderRadius: 8,
                background: selectedFileBackground,
              }}
            >
              <Text strong>{t('data_import.workbench.error_policy.title')}</Text>
              <Checkbox
                data-import-continue-on-error="true"
                checked={continueOnError}
                disabled={importing || !capabilityAllowsImport || !modeCapability.supportsContinue}
                onChange={(event) => {
                  if (capabilityAllowsImport && modeCapability.supportsContinue) {
                    updateImportPreferences(importMode, {
                      continueOnError: event.target.checked,
                    });
                  }
                }}
              >
                {importMode === 'database'
                  ? t('data_import.workbench.error_policy.continue')
                  : t('data_import.workbench.error_policy.continue_table')}
              </Checkbox>
              <Text type="secondary" style={{ fontSize: 12 }}>
                {importMode === 'database'
                  ? continueOnError
                    ? t('data_import.workbench.error_policy.continue_description')
                    : t('data_import.workbench.error_policy.stop_description')
                  : continueOnError
                    ? t('data_import.workbench.error_policy.continue_table_description')
                    : t('data_import.workbench.error_policy.stop_table_description')}
              </Text>
            </div>

            {importMode === 'table' ? (
              <details
                data-import-advanced-options="true"
                style={{
                  padding: '12px 14px',
                  border: panelBorder,
                  borderRadius: 8,
                  background: selectedFileBackground,
                }}
              >
                <summary style={{ cursor: importing ? 'default' : 'pointer', fontWeight: 600 }}>
                  {t('data_import.workbench.advanced.title')}
                </summary>
                <Text type="secondary" style={{ display: 'block', marginTop: 8, fontSize: 12 }}>
                  {t('data_import.workbench.advanced.description')}
                </Text>
                <div style={{ display: 'grid', gap: 12, marginTop: 12 }}>
                  <label style={{ display: 'grid', gap: 6 }}>
                    <Text type="secondary">{t('data_import.workbench.advanced.encoding')}</Text>
                    <Select
                      data-import-option-encoding="true"
                      value={activePreferences.encoding}
                      disabled={importing}
                      options={[
                        { value: 'auto', label: t('data_import.workbench.advanced.encoding.auto') },
                        { value: 'utf-8', label: t('data_import.workbench.advanced.encoding.utf8') },
                        { value: 'utf-16le', label: t('data_import.workbench.advanced.encoding.utf16le') },
                        { value: 'utf-16be', label: t('data_import.workbench.advanced.encoding.utf16be') },
                        { value: 'gb18030', label: t('data_import.workbench.advanced.encoding.gb18030') },
                      ]}
                      onChange={(encoding) => updateImportPreferences('table', { encoding })}
                    />
                  </label>
                  <label style={{ display: 'grid', gap: 6 }}>
                    <Text type="secondary">{t('data_import.workbench.advanced.delimiter')}</Text>
                    <Select
                      data-import-option-delimiter="true"
                      value={activePreferences.delimiter}
                      disabled={importing}
                      options={[
                        { value: 'auto', label: t('data_import.workbench.advanced.delimiter.auto') },
                        { value: 'comma', label: t('data_import.workbench.advanced.delimiter.comma') },
                        { value: 'tab', label: t('data_import.workbench.advanced.delimiter.tab') },
                        { value: 'semicolon', label: t('data_import.workbench.advanced.delimiter.semicolon') },
                        { value: 'pipe', label: t('data_import.workbench.advanced.delimiter.pipe') },
                      ]}
                      onChange={(delimiter) => updateImportPreferences('table', { delimiter })}
                    />
                  </label>
                  <label style={{ display: 'grid', gap: 6 }}>
                    <Text type="secondary">{t('data_import.workbench.advanced.header_row')}</Text>
                    <input
                      data-import-option-header-row="true"
                      type="number"
                      min={1}
                      max={1_000_000}
                      value={activePreferences.headerRow}
                      disabled={importing}
                      onChange={(event) => {
                        const headerRow = Math.min(
                          1_000_000,
                          Math.max(1, Math.trunc(Number(event.target.value) || 1)),
                        );
                        updateImportPreferences('table', { headerRow });
                      }}
                    />
                  </label>
                  <label style={{ display: 'grid', gap: 6 }}>
                    <Text type="secondary">{t('data_import.workbench.advanced.null_token')}</Text>
                    <input
                      data-import-option-null-token="true"
                      type="text"
                      maxLength={64}
                      value={activePreferences.nullToken}
                      disabled={importing}
                      onChange={(event) => updateImportPreferences('table', {
                        nullToken: event.target.value,
                      })}
                    />
                  </label>
                  <Checkbox
                    data-import-option-empty-string-as-null="true"
                    checked={activePreferences.emptyStringAsNull}
                    disabled={importing}
                    onChange={(event) => updateImportPreferences('table', {
                      emptyStringAsNull: event.target.checked,
                    })}
                  >
                    {t('data_import.workbench.advanced.empty_string_as_null')}
                  </Checkbox>
                  <label style={{ display: 'grid', gap: 6 }}>
                    <Text type="secondary">{t('data_import.workbench.advanced.sheet_name')}</Text>
                    <input
                      data-import-option-sheet-name="true"
                      type="text"
                      maxLength={255}
                      value={activePreferences.sheetName}
                      disabled={importing}
                      onChange={(event) => updateImportPreferences('table', {
                        sheetName: event.target.value,
                      })}
                    />
                  </label>
                  <label style={{ display: 'grid', gap: 6 }}>
                    <Text type="secondary">{t('data_import.workbench.advanced.conflict_policy')}</Text>
                    <Select
                      data-import-option-conflict-policy="true"
                      value={activePreferences.conflictPolicy}
                      disabled={importing || !capabilityAllowsImport}
                      options={[
                        {
                          value: 'stop',
                          label: t('data_import.workbench.advanced.conflict.stop'),
                          disabled: !supportedConflictPolicies.includes('stop'),
                        },
                        {
                          value: 'skip_duplicates',
                          label: t('data_import.workbench.advanced.conflict.skip_duplicates'),
                          disabled: !supportedConflictPolicies.includes('skip_duplicates'),
                        },
                        {
                          value: 'upsert',
                          label: t('data_import.workbench.advanced.conflict.upsert'),
                          disabled: !supportedConflictPolicies.includes('upsert'),
                        },
                      ]}
                      onChange={(conflictPolicy) => updateImportPreferences('table', { conflictPolicy })}
                    />
                  </label>
                  {activePreferences.conflictPolicy === 'upsert' ? (
                    <label style={{ display: 'grid', gap: 6 }}>
                      <Text type="secondary">{t('data_import.workbench.advanced.conflict_keys')}</Text>
                      <input
                        data-import-option-conflict-keys="true"
                        type="text"
                        maxLength={16_384}
                        value={conflictKeyColumnsInput}
                        disabled={importing || !capabilityAllowsImport || !supportedConflictPolicies.includes('upsert')}
                        placeholder={t('data_import.workbench.advanced.conflict_keys_placeholder')}
                        onChange={(event) => {
                          const normalized = normalizeConflictKeyColumnsInput(event.target.value);
                          setConflictKeyColumnsInput(normalized.displayValue);
                          updateImportPreferences('table', {
                            conflictKeyColumns: normalized.columns,
                          });
                        }}
                      />
                    </label>
                  ) : null}
                  {!conflictPolicySupported ? (
                    <Alert
                      data-import-conflict-policy-error="unsupported"
                      type="error"
                      showIcon
                      message={t('data_import.workbench.advanced.conflict_unsupported')}
                    />
                  ) : !conflictKeysValid ? (
                    <Alert
                      data-import-conflict-policy-error="keys_required"
                      type="error"
                      showIcon
                      message={t('data_import.workbench.advanced.conflict_keys_required')}
                    />
                  ) : null}
                </div>
              </details>
            ) : null}
          </div>
        </section>

        <section
          data-data-import-preview-panel="true"
          style={{
            minWidth: 0,
            minHeight: 420,
            padding: 20,
            border: panelBorder,
            borderRadius: 8,
            background: panelBackground,
          }}
        >
          {filePath && capabilityAllowsImport ? (
            importMode === 'database' ? (
              <DatabaseImportExecutionPanel
                key={JSON.stringify([selectedConnectionId, selectedDbName, filePath])}
                connection={selectedConnection}
                connectionConfig={selectedConnectionConfig}
                dbName={selectedDbName}
                filePath={filePath}
                fileSizeMB={fileSizeMB}
                darkMode={darkMode}
                continueOnError={continueOnError}
                onRunningChange={handleImportingChange}
              />
            ) : (
              <ImportPreviewModal
                visible
                presentation="embedded"
                filePath={filePath}
                connectionId={selectedConnectionId}
                dbName={selectedDbName}
                tableName={selectedTableName}
                continueOnError={continueOnError}
                importOptions={activePreferences}
                onClose={clearSelectedFile}
                onImportingChange={handleImportingChange}
                onSuccess={() => {
                  void message.success(t('data_import.workbench.message.import_done'));
                }}
              />
            )
          ) : (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={(
                <div style={{ display: 'grid', gap: 4 }}>
                  <Text strong>
                    {importMode === 'database'
                      ? t('data_import.workbench.state.awaiting_sql_title')
                      : t('data_import.workbench.state.awaiting_file_title')}
                  </Text>
                  <Text type="secondary">
                    {importMode === 'database'
                      ? t('data_import.workbench.state.awaiting_sql_description')
                      : t('data_import.workbench.state.awaiting_file_description')}
                  </Text>
                </div>
              )}
            />
          )}
        </section>
        <div style={{ gridColumn: '1 / -1' }}>
          <ImportJobHistoryPanel refreshToken={historyRefreshToken} />
        </div>
      </div>
    </div>
  );
};

export default DataImportWorkbench;
