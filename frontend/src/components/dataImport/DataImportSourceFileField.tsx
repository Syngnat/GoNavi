import { Button } from 'antd';
import { FileAddOutlined, ImportOutlined } from '@ant-design/icons';
import { Text, getFileName } from './dataImportWorkbenchModel';
import type { DataImportWorkbenchStateApi } from './hooks/useDataImportWorkbenchState';
import type { DataImportWorkbenchFileSourceApi } from './hooks/useDataImportWorkbenchFileSource';

export interface DataImportSourceFileFieldProps {
  importMode: DataImportWorkbenchStateApi['importMode'];
  t: DataImportWorkbenchStateApi['t'];
  filePath: DataImportWorkbenchStateApi['filePath'];
  fileName: DataImportWorkbenchStateApi['fileName'];
  selectedFileBackground: DataImportWorkbenchFileSourceApi['selectedFileBackground'];
  selectingFile: DataImportWorkbenchStateApi['selectingFile'];
  importing: DataImportWorkbenchStateApi['importing'];
  capabilityAllowsImport: DataImportWorkbenchStateApi['capabilityAllowsImport'];
  selectedConnectionConfig: DataImportWorkbenchStateApi['selectedConnectionConfig'];
  loadingDatabases: DataImportWorkbenchStateApi['loadingDatabases'];
  loadingTables: DataImportWorkbenchStateApi['loadingTables'];
  tableImportOptionsValid: DataImportWorkbenchStateApi['tableImportOptionsValid'];
  selectedDbName: DataImportWorkbenchStateApi['selectedDbName'];
  selectedTableName: DataImportWorkbenchStateApi['selectedTableName'];
  handleSelectFile: DataImportWorkbenchFileSourceApi['handleSelectFile'];
  capabilityDetails: DataImportWorkbenchStateApi['capabilityDetails'];
}

export const DataImportSourceFileField = ({
  importMode, t, filePath, fileName, selectedFileBackground, selectingFile, importing,
  capabilityAllowsImport, selectedConnectionConfig, loadingDatabases, loadingTables,
  tableImportOptionsValid, selectedDbName, selectedTableName, handleSelectFile, capabilityDetails,
}: DataImportSourceFileFieldProps) => (
  <div style={{ display: 'grid', gap: 6 }}>
    <Text type="secondary">
      {importMode === 'database'
        ? t('data_import.workbench.label.sql_file')
        : t('data_import.workbench.label.file')}
    </Text>
    {filePath && (
      <div
        title={fileName || filePath}
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
        {fileName || getFileName(filePath)}
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
);
