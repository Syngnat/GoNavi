import { message, Empty } from 'antd';
import DatabaseImportExecutionPanel from '../DatabaseImportExecutionPanel';
import ImportPreviewModal from '../ImportPreviewModal';
import { Text } from './dataImportWorkbenchModel';
import type { DataImportWorkbenchFileSourceApi } from './hooks/useDataImportWorkbenchFileSource';
import type { DataImportWorkbenchStateApi } from './hooks/useDataImportWorkbenchState';

export interface DataImportPreviewPanelProps {
  panelBorder: DataImportWorkbenchFileSourceApi['panelBorder'];
  panelBackground: DataImportWorkbenchFileSourceApi['panelBackground'];
  filePath: DataImportWorkbenchStateApi['filePath'];
  capabilityAllowsImport: DataImportWorkbenchStateApi['capabilityAllowsImport'];
  importMode: DataImportWorkbenchStateApi['importMode'];
  selectedConnectionId: DataImportWorkbenchStateApi['selectedConnectionId'];
  selectedDbName: DataImportWorkbenchStateApi['selectedDbName'];
  selectedConnection: DataImportWorkbenchStateApi['selectedConnection'];
  selectedConnectionConfig: DataImportWorkbenchStateApi['selectedConnectionConfig'];
  fileName: DataImportWorkbenchStateApi['fileName'];
  fileSizeMB: DataImportWorkbenchStateApi['fileSizeMB'];
  darkMode: DataImportWorkbenchStateApi['darkMode'];
  continueOnError: DataImportWorkbenchStateApi['continueOnError'];
  handleImportingChange: DataImportWorkbenchFileSourceApi['handleImportingChange'];
  selectedTableName: DataImportWorkbenchStateApi['selectedTableName'];
  activePreferences: DataImportWorkbenchStateApi['activePreferences'];
  clearSelectedFile: DataImportWorkbenchStateApi['clearSelectedFile'];
  t: DataImportWorkbenchStateApi['t'];
}

export const DataImportPreviewPanel = ({
  panelBorder, panelBackground, filePath, capabilityAllowsImport, importMode, selectedConnectionId,
  selectedDbName, selectedConnection, selectedConnectionConfig, fileName, fileSizeMB, darkMode,
  continueOnError, handleImportingChange, selectedTableName, activePreferences, clearSelectedFile,
  t,
}: DataImportPreviewPanelProps) => (
  <section
    data-data-import-preview-panel="true"
    style={{
      minWidth: 0,
      minHeight: 420,
      alignSelf: 'start',
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
          fileName={fileName}
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
);
