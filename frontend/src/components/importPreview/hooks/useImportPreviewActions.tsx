import { Space, Button } from 'antd';
import { StopOutlined } from '@ant-design/icons';
import { confirmProductionRisk } from '../../../utils/productionRiskConfirm';
import { createImportJobId, type ImportProgress, cancelImportJob } from '../importPreviewModel';
import { buildRpcConnectionConfig } from '../../../utils/connectionRpcConfig';
import { invokeAppWithSignal, isWebRPCAbortError } from '../../../utils/webRpc';
import {
  ImportDataWithProgressOptions,
  ExportImportErrorRows,
} from '../../../../wailsjs/go/app/App';
import { formatImportBytes, formatImportDuration } from '../../importProgressMetrics';
import { downloadBrowserFileFromResult } from '../../../utils/browserFileTransfer';
import type { ImportPreviewStateApi } from './useImportPreviewState';
import type { ImportPreviewModalProps } from '../../ImportPreviewModal';

export interface UseImportPreviewActionsInput {
  dbName: ImportPreviewModalProps['dbName'];
  tableName: ImportPreviewModalProps['tableName'];
  filePath: ImportPreviewModalProps['filePath'];
  onSuccess: ImportPreviewModalProps['onSuccess'];
  previewData: ImportPreviewStateApi['previewData'];
  mappingValidationError: ImportPreviewStateApi['mappingValidationError'];
  importingRef: ImportPreviewStateApi['importingRef'];
  connection: ImportPreviewStateApi['connection'];
  t: ImportPreviewStateApi['t'];
  importRequestRef: ImportPreviewStateApi['importRequestRef'];
  stoppingRef: ImportPreviewStateApi['stoppingRef'];
  activeImportJobIdRef: ImportPreviewStateApi['activeImportJobIdRef'];
  importStartedAtRef: ImportPreviewStateApi['importStartedAtRef'];
  setImporting: ImportPreviewStateApi['setImporting'];
  setStopping: ImportPreviewStateApi['setStopping'];
  setError: ImportPreviewStateApi['setError'];
  latestProgressRef: ImportPreviewStateApi['latestProgressRef'];
  setProgress: ImportPreviewStateApi['setProgress'];
  setImportResult: ImportPreviewStateApi['setImportResult'];
  importRPCAbortRef: ImportPreviewStateApi['importRPCAbortRef'];
  previewConnectionConfigRef: ImportPreviewStateApi['previewConnectionConfigRef'];
  columnMappings: ImportPreviewStateApi['columnMappings'];
  parserOptions: ImportPreviewStateApi['parserOptions'];
  progress: ImportPreviewStateApi['progress'];
  i18n: ImportPreviewStateApi['i18n'];
  importResult: ImportPreviewStateApi['importResult'];
  onClose: ImportPreviewModalProps['onClose'];
  importing: ImportPreviewStateApi['importing'];
  stopping: ImportPreviewStateApi['stopping'];
  loading: ImportPreviewStateApi['loading'];
}

export const useImportPreviewActions = ({
  dbName, tableName, filePath, onSuccess, previewData, mappingValidationError, importingRef,
  connection, t, importRequestRef, stoppingRef, activeImportJobIdRef, importStartedAtRef,
  setImporting, setStopping, setError, latestProgressRef, setProgress, setImportResult,
  importRPCAbortRef, previewConnectionConfigRef, columnMappings, parserOptions, progress, i18n,
  importResult, onClose, importing, stopping, loading,
}: UseImportPreviewActionsInput) => {
  const handleImport = async () => {
    if (!previewData || mappingValidationError || importingRef.current) return;

    const approved = await confirmProductionRisk({
      connection,
      action: t("connection.production_risk.action.execute_sql"),
      target: [dbName, tableName].filter(Boolean).join(" / "),
      translate: t,
    });
    if (!approved || importingRef.current) return;

    const importRequestId = importRequestRef.current + 1;
    const importJobId = createImportJobId();
    importRequestRef.current = importRequestId;
    importingRef.current = true;
    stoppingRef.current = false;
    activeImportJobIdRef.current = importJobId;
    importStartedAtRef.current = Date.now();
    setImporting(true);
    setStopping(false);
    setError(null);
    const initialProgress: ImportProgress = {
      current: 0,
      total: previewData.totalRows,
      success: 0,
      errors: 0,
      skipped: 0,
      totalRowsKnown: previewData.totalRowsKnown,
      bytesRead: 0,
      totalBytes: previewData.fileSize,
      bytesPerSecond: 0,
      etaSeconds: 0,
      stage: "prepare",
    };
    latestProgressRef.current = initialProgress;
    setProgress(initialProgress);
    setImportResult(null);
    importRPCAbortRef.current?.abort();
    const controller = new AbortController();
    importRPCAbortRef.current = controller;

    try {
      const config = previewConnectionConfigRef.current;
      if (!config) {
        setError(t("import_preview.error.connection_config_not_found"));
        return;
      }

      const selectedMappings = Object.fromEntries(
        Object.entries(columnMappings).filter(([, targetColumn]) => Boolean(targetColumn)),
      );
      const rpcConfig = buildRpcConnectionConfig(config) as any;
      const options = {
          ...parserOptions,
          columnMappings: selectedMappings,
          jobId: importJobId,
          ...(previewData.sourceIdentityToken
            ? { sourceIdentityToken: previewData.sourceIdentityToken }
            : {}),
      };
      const res = await invokeAppWithSignal(
        "ImportDataWithProgressOptions",
        [rpcConfig, dbName, tableName, filePath, options],
        controller.signal,
        () => ImportDataWithProgressOptions(
          rpcConfig,
          dbName,
          tableName,
          filePath,
          options,
        ),
      );
      if (importRequestRef.current !== importRequestId) return;

      setError(null);
      if (res.data?.cancelled) {
        setImportResult(res.data);
      } else if (res.data?.stoppedOnError) {
        setImportResult(res.data);
      } else if (res.success && res.data) {
        setImportResult(res.data);
        if (res.data.failed === 0) {
          await onSuccess();
        }
      } else {
        const failureMessage = res.message || t("import_preview.error.import_failed");
        if (res.data) {
          setImportResult({
            ...res.data,
            executionFailed: true,
            failureMessage,
          });
        } else {
          const latestProgress = latestProgressRef.current;
          setImportResult({
            success: latestProgress?.success || 0,
            skipped: latestProgress?.skipped || 0,
            failed: latestProgress?.errors || 0,
            total: latestProgress?.current || 0,
            errorLogs: [],
            executionFailed: true,
            failureMessage,
            outcomeUnknown: true,
          });
        }
      }
    } catch (e: any) {
      if (importRequestRef.current !== importRequestId) return;
      if (isWebRPCAbortError(e)) return;
      const failureMessage = t("import_preview.error.import_failed_detail", {
        detail: String(e?.message || e),
      });
      const latestProgress = latestProgressRef.current;
      setError(null);
      setImportResult({
        success: latestProgress?.success || 0,
        skipped: latestProgress?.skipped || 0,
        failed: latestProgress?.errors || 0,
        total: latestProgress?.current || 0,
        errorLogs: [],
        executionFailed: true,
        failureMessage,
        outcomeUnknown: true,
      });
    } finally {
      if (importRPCAbortRef.current === controller) importRPCAbortRef.current = null;
      if (importRequestRef.current === importRequestId) {
        importingRef.current = false;
        stoppingRef.current = false;
        activeImportJobIdRef.current = "";
        importStartedAtRef.current = 0;
        setImporting(false);
        setStopping(false);
      }
    }
  };

  const handleStopImport = async () => {
    const importJobId = activeImportJobIdRef.current;
    if (!importJobId || stoppingRef.current) return;

    stoppingRef.current = true;
    setStopping(true);
    setError(null);
    try {
      if (typeof cancelImportJob !== "function") {
        throw new Error(t("import_preview.error.stop_failed"));
      }
      const res = await cancelImportJob(importJobId);
      if (!importingRef.current || activeImportJobIdRef.current !== importJobId) {
        return;
      }
      if (!res.success) {
        stoppingRef.current = false;
        setStopping(false);
        setError(res.message || t("import_preview.error.stop_failed"));
      }
    } catch (e: any) {
      if (!importingRef.current || activeImportJobIdRef.current !== importJobId) {
        return;
      }
      stoppingRef.current = false;
      setStopping(false);
      setError(t("import_preview.error.stop_failed_detail", {
        detail: String(e?.message || e),
      }));
    }
  };

  const columns =
    previewData?.columns.map((col) => ({
      title: col,
      dataIndex: col,
      key: col,
      ellipsis: true,
      width: 150,
    })) || [];

  const rowProgressKnown = Boolean(progress?.totalRowsKnown && progress.total > 0);
  const byteProgressKnown = Boolean(
    !rowProgressKnown
    && progress
    && Number(progress.bytesRead) > 0
    && Number(progress.totalBytes) > 0,
  );
  const progressMode = rowProgressKnown
    ? "rows"
    : byteProgressKnown
      ? "bytes"
      : "indeterminate";
  const progressPercent = Math.max(0, Math.min(100, Math.round(
    rowProgressKnown
      ? ((progress?.current || 0) / (progress?.total || 1)) * 100
      : byteProgressKnown
        ? ((progress?.bytesRead || 0) / (progress?.totalBytes || 1)) * 100
        : 0,
  )));

  const progressTransferText = progress && (progress.bytesRead || progress.totalBytes)
    ? [
        t("data_import.workbench.progress.bytes", {
          processed: formatImportBytes(progress.bytesRead || 0),
          total: progress.totalBytes ? formatImportBytes(progress.totalBytes) : "—",
        }),
        progress.bytesPerSecond
          ? t("data_import.workbench.progress.throughput", { rate: formatImportBytes(progress.bytesPerSecond) })
          : "",
        progress.etaSeconds
          ? t("data_import.workbench.progress.eta", {
              duration: formatImportDuration(progress.etaSeconds, i18n?.language),
            })
          : "",
      ].filter(Boolean).join(" · ")
    : "";

  const errorArtifactCount = Number(importResult?.errorArtifactCount) || 0;
  const errorArtifactOmittedCount = Number(importResult?.errorArtifactOmittedCount) || 0;
  const errorArtifactRetryableCount = Number(importResult?.errorArtifactRetryableCount) || 0;
  const errorArtifactUnretryableCount = Number(importResult?.errorArtifactUnretryableCount) || 0;
  const hasErrorArtifactMetadata = Boolean(importResult) && (
    importResult?.errorArtifactScopeKnown === true
    || errorArtifactCount > 0
    || errorArtifactOmittedCount > 0
    || errorArtifactRetryableCount > 0
    || errorArtifactUnretryableCount > 0
    || importResult?.errorArtifactTruncated === true
  );

  const handleExportRejectedRows = async () => {
    const artifactID = String(importResult?.errorArtifactId || "").trim();
    if (!artifactID) return;
    setError(null);
    try {
      const result = await ExportImportErrorRows(artifactID);
      if (!result.success) {
        setError(result.message || t("import_preview.error.export_rejected_rows_failed"));
      } else if (!downloadBrowserFileFromResult(result)) {
        setError(t("import_preview.error.export_rejected_rows_failed"));
      }
    } catch (exportError: any) {
      setError(t("import_preview.error.export_rejected_rows_failed_detail", {
        detail: String(exportError?.message || exportError),
      }));
    }
  };

  const footer = importResult ? (
    <Space>
      <Button onClick={onClose}>{t("common.close")}</Button>
    </Space>
  ) : importing ? (
    <Space>
      <Button
        danger
        icon={<StopOutlined />}
        loading={stopping}
        disabled={stopping}
        onClick={() => void handleStopImport()}
      >
        {t("import_preview.action.stop")}
      </Button>
    </Space>
  ) : (
    <Space>
      <Button onClick={onClose}>{t("common.cancel")}</Button>
      <Button
        type="primary"
        onClick={handleImport}
        disabled={!previewData || loading || Boolean(mappingValidationError)}
      >
        {t("import_preview.action.start")}
      </Button>
    </Space>
  );
  return {
    columns, progressMode, progressPercent, progressTransferText, errorArtifactCount,
    errorArtifactOmittedCount, errorArtifactRetryableCount, errorArtifactUnretryableCount,
    hasErrorArtifactMetadata, handleExportRejectedRows, footer,
  };
};

export type ImportPreviewActionsApi = ReturnType<typeof useImportPreviewActions>;
