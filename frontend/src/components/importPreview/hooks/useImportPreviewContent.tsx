import { Alert, Select, Table, Spin, Progress, Button } from 'antd';
import { CheckCircleOutlined, CloseCircleOutlined } from '@ant-design/icons';
import type { ImportPreviewStateApi } from './useImportPreviewState';
import type { ImportPreviewActionsApi } from './useImportPreviewActions';

export interface UseImportPreviewContentInput {
  error: ImportPreviewStateApi['error'];
  loading: ImportPreviewStateApi['loading'];
  t: ImportPreviewStateApi['t'];
  previewData: ImportPreviewStateApi['previewData'];
  importing: ImportPreviewStateApi['importing'];
  importResult: ImportPreviewStateApi['importResult'];
  mappingFieldBackground: ImportPreviewStateApi['mappingFieldBackground'];
  secondaryTextColor: ImportPreviewStateApi['secondaryTextColor'];
  mappingHeaderColor: ImportPreviewStateApi['mappingHeaderColor'];
  columnMappings: ImportPreviewStateApi['columnMappings'];
  setColumnMappings: ImportPreviewStateApi['setColumnMappings'];
  targetColumns: ImportPreviewStateApi['targetColumns'];
  mappedTargetColumns: ImportPreviewStateApi['mappedTargetColumns'];
  mappingValidationError: ImportPreviewStateApi['mappingValidationError'];
  columns: ImportPreviewActionsApi['columns'];
  progress: ImportPreviewStateApi['progress'];
  stopping: ImportPreviewStateApi['stopping'];
  progressMode: ImportPreviewActionsApi['progressMode'];
  progressPercent: ImportPreviewActionsApi['progressPercent'];
  dangerColor: ImportPreviewStateApi['dangerColor'];
  progressTransferText: ImportPreviewActionsApi['progressTransferText'];
  hasErrorArtifactMetadata: ImportPreviewActionsApi['hasErrorArtifactMetadata'];
  errorArtifactCount: ImportPreviewActionsApi['errorArtifactCount'];
  errorArtifactOmittedCount: ImportPreviewActionsApi['errorArtifactOmittedCount'];
  errorArtifactRetryableCount: ImportPreviewActionsApi['errorArtifactRetryableCount'];
  errorArtifactUnretryableCount: ImportPreviewActionsApi['errorArtifactUnretryableCount'];
  handleExportRejectedRows: ImportPreviewActionsApi['handleExportRejectedRows'];
  warningSoftBackground: ImportPreviewStateApi['warningSoftBackground'];
  warningBorderColor: ImportPreviewStateApi['warningBorderColor'];
}

export const useImportPreviewContent = ({
  error, loading, t, previewData, importing, importResult, mappingFieldBackground,
  secondaryTextColor, mappingHeaderColor, columnMappings, setColumnMappings, targetColumns,
  mappedTargetColumns, mappingValidationError, columns, progress, stopping, progressMode,
  progressPercent, dangerColor, progressTransferText, hasErrorArtifactMetadata, errorArtifactCount,
  errorArtifactOmittedCount, errorArtifactRetryableCount, errorArtifactUnretryableCount,
  handleExportRejectedRows, warningSoftBackground, warningBorderColor,
}: UseImportPreviewContentInput) => {
  const content = (
    <>
      {error && (
        <Alert
          type="error"
          message={error}
          style={{ marginBottom: 16 }}
          showIcon
        />
      )}

      {loading && (
        <div style={{ textAlign: "center", padding: 40 }}>
          {t("import_preview.status.loading_preview")}
        </div>
      )}

      {!loading && previewData && !importing && !importResult && (
        <>
          <Alert
            type="info"
            message={t(previewData.totalRowsKnown
              ? "import_preview.preview.summary"
              : "import_preview.preview.summary_sample", {
              rows: previewData.totalRows,
              columns: previewData.columns.length,
            })}
            description={t("import_preview.preview.description")}
            style={{ marginBottom: 16 }}
            showIcon
          />
          <div style={{ marginBottom: 8, fontWeight: 600 }}>
            {t("import_preview.preview.field_list")}
          </div>
          <div
            data-import-preview-source-columns="true"
            style={{
              marginBottom: 16,
              padding: 8,
              background: mappingFieldBackground,
              borderRadius: 4,
            }}
          >
            {previewData.columns.join(", ")}
          </div>
          <div data-import-column-mapping="true" style={{ marginBottom: 16 }}>
            <div style={{ marginBottom: 8, fontWeight: 600 }}>
              {t("import_preview.mapping.title")}
            </div>
            <div style={{ marginBottom: 10, color: secondaryTextColor, fontSize: 12 }}>
              {t("import_preview.mapping.description")}
            </div>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)",
                gap: 8,
                marginBottom: 6,
                color: mappingHeaderColor,
                fontSize: 12,
                fontWeight: 600,
              }}
            >
              <span>{t("import_preview.mapping.source_column")}</span>
              <span>{t("import_preview.mapping.target_column")}</span>
            </div>
            <div
              data-import-column-mapping-list="true"
              style={{ maxHeight: 240, overflowY: "auto", paddingRight: 4 }}
            >
              {previewData.columns.map((sourceColumn) => (
                <div
                  key={sourceColumn}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)",
                    gap: 8,
                    alignItems: "center",
                    marginBottom: 8,
                  }}
                >
                  <div title={sourceColumn} style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {sourceColumn}
                  </div>
                  <Select
                    value={columnMappings[sourceColumn] || ""}
                    options={[
                      { value: "", label: t("import_preview.mapping.ignore") },
                      ...targetColumns.map((targetColumn) => ({
                        value: targetColumn,
                        label: targetColumn,
                        disabled: mappedTargetColumns.includes(targetColumn)
                          && columnMappings[sourceColumn] !== targetColumn,
                      })),
                    ]}
                    onChange={(targetColumn) => setColumnMappings((current) => ({
                      ...current,
                      [sourceColumn]: targetColumn,
                    }))}
                    style={{ width: "100%" }}
                  />
                </div>
              ))}
            </div>
            {mappingValidationError && (
              <Alert type="warning" showIcon message={mappingValidationError} />
            )}
          </div>
          <div style={{ marginBottom: 8, fontWeight: 600 }}>
            {t("import_preview.preview.table_title")}
          </div>
          <Table
            dataSource={previewData.previewRows}
            columns={columns}
            pagination={false}
            scroll={{ x: "max-content" }}
            size="small"
            bordered
          />
        </>
      )}

      {importing && progress && (
        <div style={{ padding: "40px 20px" }}>
          <div
            style={{
              marginBottom: 16,
              fontSize: 16,
              fontWeight: 600,
              textAlign: "center",
            }}
          >
            {stopping
              ? t("import_preview.status.stopping")
              : t("import_preview.status.importing")}
          </div>
          {progressMode === "indeterminate" ? (
            <div
              data-import-progress-mode="indeterminate"
              data-import-progress-indeterminate="true"
              style={{ display: "flex", justifyContent: "center", padding: "8px 0" }}
            >
              <Spin size="large" />
            </div>
          ) : (
            <Progress
              data-import-progress-mode={progressMode}
              percent={progressPercent}
              showInfo
              status="active"
            />
          )}
          <div style={{ marginTop: 16, textAlign: "center", color: secondaryTextColor }}>
            {progress.totalRowsKnown
              ? t("import_preview.progress.processed_rows", {
                  current: progress.current,
                  total: progress.total,
                })
              : t("import_preview.progress.processed_rows_unknown", {
                  current: progress.current,
                })}
            <span
              data-import-progress-success="true"
              style={{ marginLeft: 16, color: "var(--gn-status-connected, #52c41a)" }}
            >
              <CheckCircleOutlined />{" "}
              {t("import_preview.progress.success_count", {
                count: progress.success,
              })}
            </span>
            {progress.errors > 0 && (
              <span style={{ marginLeft: 16, color: dangerColor }}>
                <CloseCircleOutlined />{" "}
                {t("import_preview.progress.error_count", {
                  count: progress.errors,
                })}
              </span>
            )}
            {(progress.skipped || 0) > 0 && (
              <span data-import-progress-skipped="true" style={{ marginLeft: 16, color: secondaryTextColor }}>
                {t("data_import.workbench.progress.skipped", {
                  count: progress.skipped,
                })}
              </span>
            )}
          </div>
          {progress.stage ? (
            <div style={{ marginTop: 8, textAlign: "center", color: secondaryTextColor }}>
              {t(`import_preview.stage.${progress.stage}`)}
            </div>
          ) : null}
          {progressTransferText ? (
            <div style={{ marginTop: 8, textAlign: "center", color: secondaryTextColor, fontSize: 12 }}>
              {progressTransferText}
            </div>
          ) : null}
        </div>
      )}

      {importResult && (
        <div style={{ padding: 20 }}>
          <Alert
            type={importResult.executionFailed
              ? "error"
              : !importResult.cancelled && !importResult.stoppedOnError && importResult.failed === 0
                ? "success"
                : "warning"}
            message={importResult.executionFailed
              ? t("import_preview.error.import_failed")
              : importResult.cancelled
                ? t("import_preview.result.stopped")
                : importResult.stoppedOnError
                  ? t("import_preview.result.stopped_on_error")
                  : t("import_preview.result.completed")}
            description={
              <div>
                {importResult.executionFailed && importResult.failureMessage && (
                  <div>{importResult.failureMessage}</div>
                )}
                <div>
                  {t("import_preview.result.success_rows", {
                    count: importResult.success,
                  })}
                </div>
                {importResult.failed > 0 && (
                  <div>
                    {importResult.outcomeUnknown
                      ? t("import_preview.result.error_count", { count: importResult.failed })
                      : t("import_preview.result.failed_rows", { count: importResult.failed })}
                  </div>
                )}
                {Number(importResult.skipped) > 0 && (
                  <div data-import-result-skipped="true">
                    {t("data_import.workbench.progress.skipped", {
                      count: importResult.skipped,
                    })}
                  </div>
                )}
                {importResult.outcomeUnknown && (
                  <div>{t("import_preview.result.batch_outcome_unknown")}</div>
                )}
              </div>
            }
            showIcon
            style={{ marginBottom: 16 }}
          />
          {hasErrorArtifactMetadata ? (
            <div
              data-import-preview-error-artifact="true"
              style={{ display: "grid", gap: 2, marginBottom: 12 }}
            >
              <div data-import-preview-error-artifact-count="true">
                {t("data_import.error_artifact.count", { count: errorArtifactCount })}
              </div>
              <div data-import-preview-error-artifact-omitted-count="true">
                {t("data_import.error_artifact.omitted_count", { count: errorArtifactOmittedCount })}
              </div>
              <div data-import-preview-error-artifact-retryable-count="true">
                {t("data_import.error_artifact.retryable_count", { count: errorArtifactRetryableCount })}
              </div>
              <div data-import-preview-error-artifact-unretryable-count="true">
                {t("data_import.error_artifact.unretryable_count", { count: errorArtifactUnretryableCount })}
              </div>
              {importResult.errorArtifactTruncated ? (
                <div data-import-preview-error-artifact-truncated="true">
                  {t("data_import.error_artifact.truncated")}
                </div>
              ) : null}
            </div>
          ) : null}
          {importResult.errorArtifactId ? (
            <Button onClick={() => void handleExportRejectedRows()}>
              {t("import_preview.action.export_rejected_rows")}
            </Button>
          ) : null}
          {importResult.errorLogs && importResult.errorLogs.length > 0 && (
            <>
              <div
                data-import-preview-error-log-title="true"
                style={{ marginBottom: 8, fontWeight: 600, color: dangerColor }}
              >
                {t("import_preview.result.error_logs")}
              </div>
              <div
                data-import-preview-error-log-panel="true"
                style={{
                  maxHeight: 300,
                  overflow: "auto",
                  background: warningSoftBackground,
                  border: `1px solid ${warningBorderColor}`,
                  borderRadius: 4,
                  padding: 12,
                  fontSize: 12,
                  fontFamily: "var(--gn-font-mono)",
                }}
              >
                {importResult.errorLogs.map((log: string, idx: number) => (
                  <div key={idx} style={{ marginBottom: 4 }}>
                    {log}
                  </div>
                ))}
                {importResult.errorLogsOmitted > 0 && (
                  <div>
                    {t("import_preview.result.error_logs_omitted", {
                      count: importResult.errorLogsOmitted,
                    })}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </>
  );
  return { content };
};

export type ImportPreviewContentApi = ReturnType<typeof useImportPreviewContent>;
