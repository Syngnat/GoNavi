import Modal from './common/ResizableDraggableModal';
import React, { useState, useEffect, useRef } from "react";
import { Table, Alert, Progress, Button, Space, Select, Spin } from 'antd';
import { CheckCircleOutlined, CloseCircleOutlined, StopOutlined } from "@ant-design/icons";
import {
  DBGetColumns,
  ExportImportErrorRows,
  ImportDataWithProgressOptions,
} from "../../wailsjs/go/app/App";
import * as AppBindings from "../../wailsjs/go/app/App";
import { EventsOn } from "../../wailsjs/runtime/runtime";
import { useStore } from "../store";
import { t as defaultTranslate } from "../i18n";
import { useOptionalI18n } from "../i18n/provider";
import { buildRpcConnectionConfig } from "../utils/connectionRpcConfig";
import {
  getColumnDefinitionExtra,
  getColumnDefinitionName,
  getColumnDefinitionNullable,
  hasColumnDefinitionDefault,
} from "../utils/columnDefinition";
import { confirmProductionRisk } from "../utils/productionRiskConfirm";
import { calculateImportTransferMetrics, formatImportBytes, formatImportDuration } from "./importProgressMetrics";
import {
  DEFAULT_DATA_IMPORT_PREFERENCES,
  type DataImportPreferences,
} from "./dataImportPreferences";
interface ImportPreviewModalProps {
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

interface PreviewData {
  columns: string[];
  totalRows: number;
  totalRowsKnown: boolean;
  fileSize: number;
  sourceIdentityToken: string;
  previewRows: any[];
}

type ImportParserOptions = Omit<DataImportPreferences, "nullToken" | "sheetName"> & {
  nullToken?: string;
  sheetName?: string;
};

const previewImportFileWithOptions = (
  AppBindings as unknown as {
    PreviewImportFileWithOptions?: (filePath: string, options: ImportParserOptions) => Promise<any>;
  }
).PreviewImportFileWithOptions;

const cancelImportJob = (
  AppBindings as unknown as {
    CancelImportJob?: (jobId: string) => Promise<any>;
  }
).CancelImportJob;

const buildImportParserOptions = (
  importOptions: DataImportPreferences | undefined,
  continueOnError: boolean,
): ImportParserOptions => {
  const normalized = {
    ...DEFAULT_DATA_IMPORT_PREFERENCES,
    ...importOptions,
    continueOnError,
  };
  return {
    continueOnError: normalized.continueOnError,
    conflictPolicy: normalized.conflictPolicy,
    conflictKeyColumns: Array.from(new Set(
      normalized.conflictKeyColumns.map((column) => column.trim()).filter(Boolean),
    )),
    encoding: normalized.encoding,
    delimiter: normalized.delimiter,
    headerRow: normalized.headerRow,
    emptyStringAsNull: normalized.emptyStringAsNull,
    ...(normalized.nullToken !== "" ? { nullToken: normalized.nullToken } : {}),
    ...(normalized.sheetName !== "" ? { sheetName: normalized.sheetName } : {}),
  };
};

interface ImportProgress {
  jobId?: string;
  current: number;
  total: number;
  success: number;
  errors: number;
  skipped?: number;
  totalRowsKnown?: boolean;
  bytesRead?: number;
  totalBytes?: number;
  bytesPerSecond?: number;
  etaSeconds?: number;
  stage?: string;
}

const createImportJobId = (): string => {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return `import-${globalThis.crypto.randomUUID()}`;
  }
  return `import-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
};

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
  const i18n = useOptionalI18n();
  const t = i18n?.t ?? defaultTranslate;
  const connections = useStore((state) => state.connections);
  const darkMode = useStore((state) => state.theme === "dark");
  const connection = connections.find((item) => item.id === connectionId);
  const parserOptions = buildImportParserOptions(importOptions, continueOnError);
  const parserOptionsKey = JSON.stringify({
    encoding: parserOptions.encoding,
    delimiter: parserOptions.delimiter,
    headerRow: parserOptions.headerRow,
    nullToken: parserOptions.nullToken,
    emptyStringAsNull: parserOptions.emptyStringAsNull,
    sheetName: parserOptions.sheetName,
  });
  const [loading, setLoading] = useState(true);
  const [previewData, setPreviewData] = useState<PreviewData | null>(null);
  const [targetColumns, setTargetColumns] = useState<string[]>([]);
  const [targetColumnDefinitions, setTargetColumnDefinitions] = useState<unknown[]>([]);
  const [columnMappings, setColumnMappings] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [importResult, setImportResult] = useState<any>(null);
  const previewRequestRef = useRef(0);
  const importRequestRef = useRef(0);
  const importingRef = useRef(false);
  const stoppingRef = useRef(false);
  const activeImportJobIdRef = useRef("");
  const previewConnectionConfigRef = useRef<any>(null);
  const importStartedAtRef = useRef(0);
  const latestProgressRef = useRef<ImportProgress | null>(null);
  const secondaryTextColor = `var(--gn-fg-3, ${darkMode
    ? "rgba(255,255,255,0.65)"
    : "rgba(0,0,0,0.45)"})`;
  const mappingHeaderColor = `var(--gn-fg-2, ${darkMode
    ? "rgba(255,255,255,0.85)"
    : "rgba(0,0,0,0.65)"})`;
  const mappingFieldBackground = `var(--gn-bg-subtle, var(--gn-bg-panel-2, ${darkMode
    ? "rgba(255,255,255,0.06)"
    : "#f5f5f5"}))`;
  const dividerColor = `var(--gn-br-1, ${darkMode
    ? "rgba(255,255,255,0.08)"
    : "rgba(15,23,42,0.08)"})`;
  const dangerColor = `var(--gn-danger, ${darkMode ? "#ff7875" : "#ff4d4f"})`;
  const warningSoftBackground = `var(--gn-warn-soft, ${darkMode
    ? "rgba(250,173,20,0.16)"
    : "#fff1f0"})`;
  const warningBorderColor = `var(--gn-warn, ${darkMode ? "#d89614" : "#ffccc7"})`;

  useEffect(() => {
    if (importingRef.current) return undefined;
    const requestId = previewRequestRef.current + 1;
    previewRequestRef.current = requestId;
    if (visible && filePath) {
      void loadPreview(requestId);
    }
    return () => {
      if (previewRequestRef.current === requestId) {
        previewRequestRef.current += 1;
      }
    };
  }, [visible, filePath, connectionId, dbName, tableName, connection, parserOptionsKey]);

  useEffect(() => {
    if (importing) {
      const unsubscribe = EventsOn(
        "import:progress",
        (data: ImportProgress) => {
          if (!data || data.jobId !== activeImportJobIdRef.current) return;
          setProgress((prev) => {
            const totalRowsKnown = prev?.totalRowsKnown === true
              ? true
              : (data.totalRowsKnown ?? previewData?.totalRowsKnown ?? false);
            const fallbackTotal = totalRowsKnown
              ? (prev?.total || previewData?.totalRows || 0)
              : 0;
            const nextTotal =
              totalRowsKnown && typeof data.total === "number" && data.total > 0
                ? data.total
                : fallbackTotal;
            const bytesRead = Math.max(0, Math.trunc(Number(data.bytesRead ?? prev?.bytesRead) || 0));
            const totalBytes = Math.max(0, Math.trunc(Number(data.totalBytes ?? prev?.totalBytes ?? previewData?.fileSize) || 0));
            const transferMetrics = calculateImportTransferMetrics({
              startedAt: importStartedAtRef.current,
              now: Date.now(),
              bytesRead,
              totalBytes,
            });
            const nextProgress = {
              current: data.current ?? prev?.current ?? 0,
              total: nextTotal,
              success: data.success ?? prev?.success ?? 0,
              errors: data.errors ?? prev?.errors ?? 0,
              skipped: data.skipped ?? prev?.skipped ?? 0,
              totalRowsKnown,
              bytesRead,
              totalBytes,
              bytesPerSecond: transferMetrics.bytesPerSecond,
              etaSeconds: transferMetrics.etaSeconds,
              stage: data.stage || prev?.stage || "",
            };
            latestProgressRef.current = nextProgress;
            return nextProgress;
          });
        },
      );
      return () => {
        unsubscribe?.();
      };
    }
  }, [importing, previewData?.totalRows]);

  useEffect(() => {
    onImportingChange?.(importing);
    return () => {
      if (importing) onImportingChange?.(false);
    };
  }, [importing, onImportingChange]);

  const loadPreview = async (requestId: number) => {
    importRequestRef.current += 1;
    importingRef.current = false;
    stoppingRef.current = false;
    activeImportJobIdRef.current = "";
    previewConnectionConfigRef.current = null;
    setImporting(false);
    setStopping(false);
    setLoading(true);
    setError(null);
    setPreviewData(null);
    setTargetColumns([]);
    setTargetColumnDefinitions([]);
    setColumnMappings({});
    setImportResult(null);
    setProgress(null);
    latestProgressRef.current = null;
    try {
      const conn = connection;
      if (!conn) {
        setError(t("import_preview.error.connection_config_not_found"));
        return;
      }

      const config = {
        ...conn.config,
        port: Number(conn.config.port),
        password: conn.config.password || "",
        database: conn.config.database || "",
        useSSH: conn.config.useSSH || false,
        ssh: conn.config.ssh || {
          host: "",
          port: 22,
          user: "",
          password: "",
          keyPath: "",
        },
      };
      const rpcConfig = buildRpcConnectionConfig(config) as any;
      if (typeof previewImportFileWithOptions !== "function") {
        setError(t("data_import.capability.reason.capability_unavailable"));
        return;
      }
      const [previewRes, columnsRes] = await Promise.all([
        previewImportFileWithOptions(filePath, parserOptions),
        DBGetColumns(rpcConfig, dbName, tableName),
      ]);
      if (previewRequestRef.current !== requestId) return;
      if (!previewRes.success || !previewRes.data) {
        setError(previewRes.message || t("import_preview.error.preview_failed"));
        return;
      }
      if (!columnsRes.success || !Array.isArray(columnsRes.data)) {
        setError(columnsRes.message || t("import_preview.error.target_columns_failed"));
        return;
      }

      previewConnectionConfigRef.current = config;

      const sourceColumns: string[] = Array.isArray(previewRes.data.columns)
        ? previewRes.data.columns
          .map((column: unknown) => String(column))
          .filter((column: string) => column.trim().length > 0)
        : [];
      const nextTargetColumns = Array.from(new Set(
        columnsRes.data.map(getColumnDefinitionName).filter(Boolean),
      ));
      const targetsByLowerName = new Map<string, string[]>();
      nextTargetColumns.forEach((column) => {
        const key = column.toLowerCase();
        targetsByLowerName.set(key, [...(targetsByLowerName.get(key) || []), column]);
      });
      const nextMappings: Record<string, string> = {};
      sourceColumns.forEach((sourceColumn) => {
        const exactTarget = nextTargetColumns.find((targetColumn) => targetColumn === sourceColumn);
        const insensitiveTargets = targetsByLowerName.get(sourceColumn.toLowerCase()) || [];
        nextMappings[sourceColumn] = exactTarget || (insensitiveTargets.length === 1 ? insensitiveTargets[0] : "");
      });

      const previewTotalRows = Math.max(0, Number(previewRes.data.totalRows) || 0);
      setPreviewData({
        columns: sourceColumns,
        totalRows: previewTotalRows,
        totalRowsKnown: previewRes.data.totalRowsKnown === true
          || (previewRes.data.totalRowsKnown == null && previewTotalRows > 0),
        fileSize: Math.max(0, Number(previewRes.data.fileSize) || 0),
        sourceIdentityToken: String(previewRes.data.sourceIdentity?.token || "").trim(),
        previewRows: previewRes.data.previewRows || [],
      });
      setTargetColumns(nextTargetColumns);
      setTargetColumnDefinitions(columnsRes.data);
      setColumnMappings(nextMappings);
    } catch (e: any) {
      if (previewRequestRef.current !== requestId) return;
      setError(
        t("import_preview.error.preview_failed_detail", {
          detail: String(e?.message || e),
        }),
      );
    } finally {
      if (previewRequestRef.current === requestId) {
        setLoading(false);
      }
    }
  };

  const mappedTargetColumns = Object.values(columnMappings).filter(Boolean);
  const hasDuplicateSourceColumns = previewData
    ? new Set(previewData.columns).size !== previewData.columns.length
    : false;
  const hasDuplicateTargetColumns = new Set(mappedTargetColumns).size !== mappedTargetColumns.length;
  const normalizedMappedTargetColumns = new Set(
    mappedTargetColumns.map((column) => column.trim().toLowerCase()),
  );
  const requiredTargetColumns = targetColumnDefinitions
    .filter((column) => {
      const nullable = getColumnDefinitionNullable(column).toUpperCase();
      const extra = getColumnDefinitionExtra(column).toLowerCase();
      return nullable === "NO"
        && !hasColumnDefinitionDefault(column)
        && !(column && typeof column === "object" && "default" in column && (column as { default?: unknown }).default != null)
        && !extra.includes("auto_increment")
        && !extra.includes("identity")
        && !extra.includes("generated");
    })
    .map(getColumnDefinitionName)
    .filter(Boolean);
  const unmappedRequiredColumns = requiredTargetColumns.filter(
    (column) => !normalizedMappedTargetColumns.has(column.toLowerCase()),
  );
  const unmappedConflictKeys = parserOptions.conflictPolicy === "upsert"
    ? parserOptions.conflictKeyColumns.filter((column) => (
        !normalizedMappedTargetColumns.has(column.trim().toLowerCase())
      ))
    : [];
  const importOptionsValidationError = parserOptions.conflictPolicy === "upsert"
    && parserOptions.conflictKeyColumns.length === 0
    ? t("data_import.workbench.advanced.conflict_keys_required")
    : unmappedConflictKeys.length > 0
      ? t("data_import.workbench.advanced.conflict_keys_not_mapped", {
          columns: unmappedConflictKeys.join(", "),
        })
      : unmappedRequiredColumns.length > 0
        ? t("import_preview.mapping.validation.required_database_columns", {
            columns: unmappedRequiredColumns.join(", "),
          })
      : null;
  const mappingValidationError = importOptionsValidationError || (hasDuplicateSourceColumns
    ? t("import_preview.mapping.validation.duplicate_source")
    : hasDuplicateTargetColumns
      ? t("import_preview.mapping.validation.duplicate_target")
      : mappedTargetColumns.length === 0
        ? t("import_preview.mapping.validation.required")
        : null);

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

    try {
      const config = previewConnectionConfigRef.current;
      if (!config) {
        setError(t("import_preview.error.connection_config_not_found"));
        return;
      }

      const selectedMappings = Object.fromEntries(
        Object.entries(columnMappings).filter(([, targetColumn]) => Boolean(targetColumn)),
      );
      const res = await ImportDataWithProgressOptions(
        buildRpcConnectionConfig(config) as any,
        dbName,
        tableName,
        filePath,
        {
          ...parserOptions,
          columnMappings: selectedMappings,
          jobId: importJobId,
          ...(previewData.sourceIdentityToken
            ? { sourceIdentityToken: previewData.sourceIdentityToken }
            : {}),
        },
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

  const handleExportRejectedRows = async () => {
    const artifactID = String(importResult?.errorArtifactId || "").trim();
    if (!artifactID) return;
    setError(null);
    try {
      const result = await ExportImportErrorRows(artifactID);
      if (!result.success) {
        setError(result.message || t("import_preview.error.export_rejected_rows_failed"));
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

  if (presentation === "embedded") {
    if (!visible) return null;
    return (
      <section
        data-import-preview-embedded="true"
        style={{
          display: "flex",
          minWidth: 0,
          flexDirection: "column",
          overflow: "hidden",
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
        <div style={{ minWidth: 0, overflow: "auto" }}>{content}</div>
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
