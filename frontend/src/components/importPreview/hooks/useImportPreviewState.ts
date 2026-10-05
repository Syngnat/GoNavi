import { useState, useRef, useEffect } from 'react';
import { useOptionalI18n } from '../../../i18n/provider';
import { t as defaultTranslate } from '../../../i18n';
import { useStore } from '../../../store';
import {
  buildImportParserOptions,
  type PreviewData,
  type ImportProgress,
  previewImportFileWithOptions,
} from '../importPreviewModel';
import { EventsOn } from '../../../../wailsjs/runtime/runtime';
import { calculateImportTransferMetrics } from '../../importProgressMetrics';
import { buildRpcConnectionConfig } from '../../../utils/connectionRpcConfig';
import { invokeAppWithSignal, isWebRPCAbortError } from '../../../utils/webRpc';
import { DBGetColumns } from '../../../../wailsjs/go/app/App';
import {
  getColumnDefinitionName,
  getColumnDefinitionNullable,
  getColumnDefinitionExtra,
  hasColumnDefinitionDefault,
} from '../../../utils/columnDefinition';
import type { ImportPreviewModalProps } from '../../ImportPreviewModal';

export interface UseImportPreviewStateInput {
  connectionId: ImportPreviewModalProps['connectionId'];
  importOptions: ImportPreviewModalProps['importOptions'];
  continueOnError: Exclude<ImportPreviewModalProps['continueOnError'], undefined>;
  visible: ImportPreviewModalProps['visible'];
  filePath: ImportPreviewModalProps['filePath'];
  dbName: ImportPreviewModalProps['dbName'];
  tableName: ImportPreviewModalProps['tableName'];
  onImportingChange: ImportPreviewModalProps['onImportingChange'];
}

export const useImportPreviewState = ({
  connectionId, importOptions, continueOnError, visible, filePath, dbName, tableName,
  onImportingChange,
}: UseImportPreviewStateInput) => {
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
  const importRPCAbortRef = useRef<AbortController | null>(null);
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
    const controller = new AbortController();
    if (visible && filePath) {
      void loadPreview(requestId, controller.signal);
    }
    return () => {
      controller.abort();
      if (previewRequestRef.current === requestId) {
        previewRequestRef.current += 1;
      }
    };
  }, [visible, filePath, connectionId, dbName, tableName, connection, parserOptionsKey]);

  useEffect(() => () => {
    importRequestRef.current += 1;
    importRPCAbortRef.current?.abort();
    importRPCAbortRef.current = null;
  }, []);

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

  const loadPreview = async (requestId: number, signal: AbortSignal) => {
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
      const previewFile = previewImportFileWithOptions;
      if (typeof previewFile !== "function") {
        setError(t("data_import.capability.reason.capability_unavailable"));
        return;
      }
      const [previewRes, columnsRes] = await Promise.all([
        invokeAppWithSignal(
          "PreviewImportFileWithOptions",
          [filePath, parserOptions],
          signal,
          () => previewFile(filePath, parserOptions),
        ),
        invokeAppWithSignal(
          "DBGetColumns",
          [rpcConfig, dbName, tableName],
          signal,
          () => DBGetColumns(rpcConfig, dbName, tableName),
        ),
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
      if (isWebRPCAbortError(e)) return;
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
  return {
    i18n, t, connection, parserOptions, loading, previewData, targetColumns, columnMappings,
    setColumnMappings, error, setError, importing, setImporting, stopping, setStopping, progress,
    setProgress, importResult, setImportResult, importRequestRef, importRPCAbortRef, importingRef,
    stoppingRef, activeImportJobIdRef, previewConnectionConfigRef, importStartedAtRef,
    latestProgressRef, secondaryTextColor, mappingHeaderColor, mappingFieldBackground, dividerColor,
    dangerColor, warningSoftBackground, warningBorderColor, mappedTargetColumns,
    mappingValidationError,
  };
};

export type ImportPreviewStateApi = ReturnType<typeof useImportPreviewState>;
