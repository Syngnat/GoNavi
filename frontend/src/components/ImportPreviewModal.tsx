import React from "react";
import Modal from './common/ResizableDraggableModal';
import { type DataImportPreferences } from "./dataImportPreferences";
import { useImportPreviewState } from './importPreview/hooks/useImportPreviewState';
import { useImportPreviewActions } from './importPreview/hooks/useImportPreviewActions';
import { useImportPreviewContent } from './importPreview/hooks/useImportPreviewContent';

export interface ImportPreviewModalProps {
  visible: boolean;
  filePath: string;
  connectionId: string;
  dbName: string;
  tableName: string;
  continueOnError?: boolean;
  importOptions?: DataImportPreferences;
  onClose: () => void;
  onSuccess: () => void | Promise<void>;
  onImportingChange?: (importing: boolean) => void;
  presentation?: "modal" | "embedded";
}

const ImportPreviewModal: React.FC<ImportPreviewModalProps> = ({
  visible,
  filePath,
  connectionId,
  dbName,
  tableName,
  continueOnError = false,
  importOptions,
  onClose,
  onSuccess,
  onImportingChange,
  presentation = "modal",
}) => {
  const {
    i18n, t, connection, parserOptions, loading, previewData, targetColumns, columnMappings,
    setColumnMappings, error, setError, importing, setImporting, stopping, setStopping, progress,
    setProgress, importResult, setImportResult, importRequestRef, importRPCAbortRef, importingRef,
    stoppingRef, activeImportJobIdRef, previewConnectionConfigRef, importStartedAtRef,
    latestProgressRef, secondaryTextColor, mappingHeaderColor, mappingFieldBackground, dividerColor,
    dangerColor, warningSoftBackground, warningBorderColor, mappedTargetColumns,
    mappingValidationError,
  } = useImportPreviewState({
    connectionId, importOptions, continueOnError, visible, filePath, dbName, tableName,
    onImportingChange,
  });

  const {
    columns, progressMode, progressPercent, progressTransferText, errorArtifactCount,
    errorArtifactOmittedCount, errorArtifactRetryableCount, errorArtifactUnretryableCount,
    hasErrorArtifactMetadata, handleExportRejectedRows, footer,
  } = useImportPreviewActions({
    dbName, tableName, filePath, onSuccess, previewData, mappingValidationError, importingRef,
    connection, t, importRequestRef, stoppingRef, activeImportJobIdRef, importStartedAtRef,
    setImporting, setStopping, setError, latestProgressRef, setProgress, setImportResult,
    importRPCAbortRef, previewConnectionConfigRef, columnMappings, parserOptions, progress, i18n,
    importResult, onClose, importing, stopping, loading,
  });

  const { content } = useImportPreviewContent({
    error, loading, t, previewData, importing, importResult, mappingFieldBackground,
    secondaryTextColor, mappingHeaderColor, columnMappings, setColumnMappings, targetColumns,
    mappedTargetColumns, mappingValidationError, columns, progress, stopping, progressMode,
    progressPercent, dangerColor, progressTransferText, hasErrorArtifactMetadata,
    errorArtifactCount, errorArtifactOmittedCount, errorArtifactRetryableCount,
    errorArtifactUnretryableCount, handleExportRejectedRows, warningSoftBackground,
    warningBorderColor,
  });

  if (presentation === "embedded") {
    if (!visible) return null;
    return (
      <section
        data-import-preview-embedded="true"
        style={{
          display: "flex",
          minWidth: 0,
          flexDirection: "column",
          overflow: "visible",
        }}
      >
        <div
          style={{
            marginBottom: 16,
            fontSize: 15,
            fontWeight: 600,
          }}
        >
          {t("import_preview.title")}
        </div>
        <div
          data-import-preview-embedded-content="true"
          style={{ minWidth: 0, overflow: "visible" }}
        >
          {content}
        </div>
        {footer && (
          <div
            data-import-preview-embedded-footer="true"
            style={{
              display: "flex",
              justifyContent: "flex-end",
              marginTop: 16,
              paddingTop: 16,
              borderTop: `1px solid ${dividerColor}`,
            }}
          >
            {footer}
          </div>
        )}
      </section>
    );
  }

  return (
    <Modal
      title={t("import_preview.title")}
      open={visible}
      onCancel={() => {
        if (!importing) onClose();
      }}
      closable={!importing}
      maskClosable={!importing}
      keyboard={!importing}
      width={900}
      footer={footer}
    >
      {content}
    </Modal>
  );
};

export default ImportPreviewModal;
