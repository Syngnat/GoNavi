import React from 'react';
import { Alert, Button, Checkbox, Segmented, Select, message } from 'antd';
import {
  DatabaseOutlined,
  TableOutlined,
} from '@ant-design/icons';
import type { TabData } from '../types';
import { isWebRuntime } from '../utils/browserFileTransfer';
import ImportJobHistoryPanel from './ImportJobHistoryPanel';
import './DataImportWorkbench.css';
import {
  Title,
  Text,
  targetSelectStyle,
} from './dataImport/dataImportWorkbenchModel';
import { useDataImportWorkbenchState } from './dataImport/hooks/useDataImportWorkbenchState';
import {
  useDataImportWorkbenchFileSource,
} from './dataImport/hooks/useDataImportWorkbenchFileSource';
import { DataImportSourceFileField } from './dataImport/DataImportSourceFileField';
import { DataImportAdvancedOptions } from './dataImport/DataImportAdvancedOptions';
import { DataImportPreviewPanel } from './dataImport/DataImportPreviewPanel';

export interface DataImportWorkbenchProps { tab: TabData }

const DataImportWorkbench: React.FC<DataImportWorkbenchProps> = ({ tab }) => {
  const {
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
  } = useDataImportWorkbenchState({ tab });

  const {
    handleImportingChange, handleSelectFile, handleBrowserFileChange, shellBackground,
    panelBackground, panelBorder, selectedFileBackground,
  } = useDataImportWorkbenchFileSource({
    wasImportingRef, setHistoryRefreshToken, setImporting, syncWorkbenchTab, selectedConnectionId,
    selectedDbName, importMode, selectedTableName, capabilityAllowsImport, selectedConnectionConfig,
    selectedConnection, loadingDatabases, loadingTables, tableImportOptionsValid,
    browserFileInputRef, fileSelectionRequestRef, setSelectingFile, setFilePath, setFileName,
    setFileSizeMB, t, darkMode,
  });

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
      {isWebRuntime() ? (
        <input
          ref={browserFileInputRef}
          data-import-browser-file-input="true"
          type="file"
          accept={importMode === 'database' ? '.sql,.sql.gz' : '.csv,.json,.xlsx'}
          style={{ display: 'none' }}
          onChange={(event) => { void handleBrowserFileChange(event); }}
        />
      ) : null}
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
          gridAutoRows: 'max-content',
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

            <DataImportSourceFileField
              importMode={importMode} t={t} filePath={filePath} fileName={fileName}
              selectedFileBackground={selectedFileBackground} selectingFile={selectingFile}
              importing={importing} capabilityAllowsImport={capabilityAllowsImport}
              selectedConnectionConfig={selectedConnectionConfig}
              loadingDatabases={loadingDatabases} loadingTables={loadingTables}
              tableImportOptionsValid={tableImportOptionsValid} selectedDbName={selectedDbName}
              selectedTableName={selectedTableName} handleSelectFile={handleSelectFile}
              capabilityDetails={capabilityDetails}
            />

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
              <DataImportAdvancedOptions
                panelBorder={panelBorder} selectedFileBackground={selectedFileBackground}
                importing={importing} t={t} activePreferences={activePreferences}
                updateImportPreferences={updateImportPreferences}
                capabilityAllowsImport={capabilityAllowsImport}
                supportedConflictPolicies={supportedConflictPolicies}
                conflictKeyColumnsInput={conflictKeyColumnsInput}
                setConflictKeyColumnsInput={setConflictKeyColumnsInput}
                conflictPolicySupported={conflictPolicySupported}
                conflictKeysValid={conflictKeysValid}
              />
            ) : null}
          </div>
        </section>

        <DataImportPreviewPanel
          panelBorder={panelBorder} panelBackground={panelBackground} filePath={filePath}
          capabilityAllowsImport={capabilityAllowsImport} importMode={importMode}
          selectedConnectionId={selectedConnectionId} selectedDbName={selectedDbName}
          selectedConnection={selectedConnection}
          selectedConnectionConfig={selectedConnectionConfig} fileName={fileName}
          fileSizeMB={fileSizeMB} darkMode={darkMode} continueOnError={continueOnError}
          handleImportingChange={handleImportingChange} selectedTableName={selectedTableName}
          activePreferences={activePreferences} clearSelectedFile={clearSelectedFile} t={t}
        />
        <div
          data-data-import-history-panel="true"
          style={{ gridColumn: '1 / -1', minWidth: 0 }}
        >
          <ImportJobHistoryPanel refreshToken={historyRefreshToken} />
        </div>
      </div>
    </div>
  );
};

export default DataImportWorkbench;
