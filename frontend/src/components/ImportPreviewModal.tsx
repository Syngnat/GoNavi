import Modal from './common/ResizableDraggableModal';
import React, { useState, useEffect, useRef } from "react";
import { Table, Alert, Progress, Button, Space, Select } from 'antd';
import { CheckCircleOutlined, CloseCircleOutlined, StopOutlined } from "@ant-design/icons";
import {
  CancelQuery,
  DBGetColumns,
  PreviewImportFile,
  ImportDataWithProgressOptions,
} from "../../wailsjs/go/app/App";
import { EventsOn } from "../../wailsjs/runtime/runtime";
import { useStore } from "../store";
import { t as defaultTranslate } from "../i18n";
import { useOptionalI18n } from "../i18n/provider";
import { buildRpcConnectionConfig } from "../utils/connectionRpcConfig";
import { getColumnDefinitionName } from "../utils/columnDefinition";
import { confirmProductionRisk } from "../utils/productionRiskConfirm";
interface ImportPreviewModalProps {
  visible: boolean;
  filePath: string;
  connectionId: string;
  dbName: string;
  tableName: string;
  onClose: () => void;
  onSuccess: () => void | Promise<void>;
  onImportingChange?: (importing: boolean) => void;
  presentation?: "modal" | "embedded";
}

interface PreviewData {
  columns: string[];
  totalRows: number;
  previewRows: any[];
}

interface ImportProgress {
  jobId?: string;
  current: number;
  total: number;
  success: number;
  errors: number;
  totalRowsKnown?: boolean;
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
  const [loading, setLoading] = useState(true);
  const [previewData, setPreviewData] = useState<PreviewData | null>(null);
  const [targetColumns, setTargetColumns] = useState<string[]>([]);
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
  const secondaryTextColor = darkMode ? "rgba(255,255,255,0.65)" : "rgba(0,0,0,0.45)";
  const mappingFieldBackground = darkMode ? "rgba(255,255,255,0.06)" : "#f5f5f5";

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
  }, [visible, filePath, connectionId, dbName, tableName, connection]);

  useEffect(() => {
    if (importing) {
      const unsubscribe = EventsOn(
        "import:progress",
        (data: ImportProgress) => {
          if (!data || data.jobId !== activeImportJobIdRef.current) return;
          setProgress((prev) => {
            const fallbackTotal = prev?.total || previewData?.totalRows || 0;
            const nextTotal =
              typeof data.total === "number" && data.total > 0
                ? data.total
                : fallbackTotal;
            return {
              current: data.current ?? prev?.current ?? 0,
              total: nextTotal,
              success: data.success ?? prev?.success ?? 0,
              errors: data.errors ?? prev?.errors ?? 0,
              totalRowsKnown: data.totalRowsKnown ?? nextTotal > 0,
            };
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
    setColumnMappings({});
    setImportResult(null);
    setProgress(null);
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
      const [previewRes, columnsRes] = await Promise.all([
        PreviewImportFile(filePath),
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

      setPreviewData({
        columns: sourceColumns,
        totalRows: previewRes.data.totalRows || 0,
        previewRows: previewRes.data.previewRows || [],
      });
      setTargetColumns(nextTargetColumns);
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
  const mappingValidationError = hasDuplicateSourceColumns
    ? t("import_preview.mapping.validation.duplicate_source")
    : hasDuplicateTargetColumns
      ? t("import_preview.mapping.validation.duplicate_target")
      : mappedTargetColumns.length === 0
        ? t("import_preview.mapping.validation.required")
        : null;

  const handleImport = async () => {
    if (!previewData || mappingValidationError) return;

    const approved = await confirmProductionRisk({
      connection,
      action: t("connection.production_risk.action.execute_sql"),
      target: [dbName, tableName].filter(Boolean).join(" / "),
      translate: t,
    });
    if (!approved) return;

    const importRequestId = importRequestRef.current + 1;
    const importJobId = createImportJobId();
    importRequestRef.current = importRequestId;
    importingRef.current = true;
    stoppingRef.current = false;
    activeImportJobIdRef.current = importJobId;
    setImporting(true);
    setStopping(false);
    setError(null);
    setProgress({
      current: 0,
      total: previewData.totalRows,
      success: 0,
      errors: 0,
    });
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
        { columnMappings: selectedMappings, jobId: importJobId },
      );
      if (importRequestRef.current !== importRequestId) return;

      setError(null);
      if (res.data?.cancelled) {
        setImportResult(res.data);
      } else if (res.success && res.data) {
        setImportResult(res.data);
        if (res.data.failed === 0) {
          await onSuccess();
        }
      } else {
        setError(res.message || t("import_preview.error.import_failed"));
      }
    } catch (e: any) {
      if (importRequestRef.current !== importRequestId) return;
      setError(
        t("import_preview.error.import_failed_detail", {
          detail: String(e?.message || e),
        }),
      );
    } finally {
      if (importRequestRef.current === importRequestId) {
        importingRef.current = false;
        stoppingRef.current = false;
        activeImportJobIdRef.current = "";
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
      const res = await CancelQuery(importJobId);
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

  const progressPercent =
    progress && progress.total > 0
      ? Math.round((progress.current / progress.total) * 100)
      : 0;

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
            message={t("import_preview.preview.summary", {
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
                color: darkMode ? "rgba(255,255,255,0.85)" : "rgba(0,0,0,0.65)",
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
          <Progress percent={progressPercent} status="active" />
          <div style={{ marginTop: 16, textAlign: "center", color: "#666" }}>
            {t("import_preview.progress.processed_rows", {
              current: progress.current,
              total: progress.total,
            })}
            <span style={{ marginLeft: 16, color: "#52c41a" }}>
              <CheckCircleOutlined />{" "}
              {t("import_preview.progress.success_count", {
                count: progress.success,
              })}
            </span>
            {progress.errors > 0 && (
              <span style={{ marginLeft: 16, color: "#ff4d4f" }}>
                <CloseCircleOutlined />{" "}
                {t("import_preview.progress.error_count", {
                  count: progress.errors,
                })}
              </span>
            )}
          </div>
        </div>
      )}

      {importResult && (
        <div style={{ padding: 20 }}>
          <Alert
            type={!importResult.cancelled && importResult.failed === 0 ? "success" : "warning"}
            message={importResult.cancelled
              ? t("import_preview.result.stopped")
              : t("import_preview.result.completed")}
            description={
              <div>
                <div>
                  {t("import_preview.result.success_rows", {
                    count: importResult.success,
                  })}
                </div>
                {importResult.failed > 0 && (
                  <div>
                    {t("import_preview.result.failed_rows", {
                      count: importResult.failed,
                    })}
                  </div>
                )}
              </div>
            }
            showIcon
            style={{ marginBottom: 16 }}
          />
          {importResult.errorLogs && importResult.errorLogs.length > 0 && (
            <>
              <div
                style={{ marginBottom: 8, fontWeight: 600, color: "#ff4d4f" }}
              >
                {t("import_preview.result.error_logs")}
              </div>
              <div
                style={{
                  maxHeight: 300,
                  overflow: "auto",
                  background: "#fff1f0",
                  border: "1px solid #ffccc7",
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
              borderTop: darkMode
                ? "1px solid rgba(255,255,255,0.08)"
                : "1px solid rgba(15,23,42,0.08)",
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
