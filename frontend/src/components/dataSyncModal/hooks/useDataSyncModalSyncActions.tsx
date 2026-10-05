import { message } from "antd";
import { useMemo } from "react";
import {
    validateDataSyncSelection,
    buildDataSyncRequest,
    buildInitialDataSyncTableOptions,
} from "../../dataSyncRequest";
import { invokeAppWithSignal, isWebRPCAbortError } from "../../../utils/webRpc";
import { DataSyncAnalyze, DataSyncPreview, DataSync } from "../../../../wailsjs/go/app/App";
import type { TableDiffSummary, TableOps, SyncLogItem } from "../dataSyncModalTypes";
import Modal from "../../common/ResizableDraggableModal";
import { confirmProductionMutation } from "../../../utils/productionRiskConfirm";
import {
    startDataSyncBackgroundTask,
    finishDataSyncBackgroundTask,
    resolveDataSyncTaskLogLevel,
    failDataSyncBackgroundTask,
} from "../../dataSyncBackgroundTask";
import { buildSqlPreview } from "../dataSyncSqlPreview";
import { isTargetTableCreationAllowed } from "../../dataSyncTableCreation";
import { resolveDataSyncCapabilityPresentation } from "../../dataSyncCapability";
import type { DataSyncModalStateApi } from "./useDataSyncModalState";
import type { DataSyncModalTableSelectionApi } from "./useDataSyncModalTableSelection";

export interface UseDataSyncModalSyncActionsInput {
    sourceDatasetMode: DataSyncModalStateApi['sourceDatasetMode'];
    selectedTables: DataSyncModalStateApi['selectedTables'];
    sourceQuery: DataSyncModalStateApi['sourceQuery'];
    syncContent: DataSyncModalStateApi['syncContent'];
    tr: DataSyncModalStateApi['tr'];
    sourceConnId: DataSyncModalStateApi['sourceConnId'];
    targetConnId: DataSyncModalStateApi['targetConnId'];
    sourceDb: DataSyncModalStateApi['sourceDb'];
    targetDb: DataSyncModalStateApi['targetDb'];
    ensureTargetSchemaSelected: DataSyncModalTableSelectionApi['ensureTargetSchemaSelected'];
    setLoading: DataSyncModalStateApi['setLoading'];
    setAnalyzing: DataSyncModalStateApi['setAnalyzing'];
    setDiffTables: DataSyncModalStateApi['setDiffTables'];
    setAnalyzedFingerprint: DataSyncModalStateApi['setAnalyzedFingerprint'];
    setTableOptions: DataSyncModalStateApi['setTableOptions'];
    setSyncLogs: DataSyncModalStateApi['setSyncLogs'];
    analysisRequestSeqRef: DataSyncModalStateApi['analysisRequestSeqRef'];
    currentAnalysisFingerprint: DataSyncModalStateApi['currentAnalysisFingerprint'];
    analysisAbortRef: DataSyncModalStateApi['analysisAbortRef'];
    connections: DataSyncModalStateApi['connections'];
    jobIdRef: DataSyncModalStateApi['jobIdRef'];
    autoScrollRef: DataSyncModalStateApi['autoScrollRef'];
    setSyncProgress: DataSyncModalStateApi['setSyncProgress'];
    normalizeConnConfig: DataSyncModalStateApi['normalizeConnConfig'];
    targetSchema: DataSyncModalStateApi['targetSchema'];
    syncMode: DataSyncModalStateApi['syncMode'];
    autoAddColumns: DataSyncModalStateApi['autoAddColumns'];
    effectiveTargetTableStrategy: DataSyncModalStateApi['effectiveTargetTableStrategy'];
    createIndexes: DataSyncModalStateApi['createIndexes'];
    mongoCollectionName: DataSyncModalStateApi['mongoCollectionName'];
    currentAnalysisFingerprintRef: DataSyncModalStateApi['currentAnalysisFingerprintRef'];
    setPreviewOpen: DataSyncModalStateApi['setPreviewOpen'];
    setPreviewTable: DataSyncModalStateApi['setPreviewTable'];
    setPreviewLoading: DataSyncModalStateApi['setPreviewLoading'];
    setPreviewData: DataSyncModalStateApi['setPreviewData'];
    previewRequestSeqRef: DataSyncModalStateApi['previewRequestSeqRef'];
    previewAbortRef: DataSyncModalStateApi['previewAbortRef'];
    executionReadiness: DataSyncModalStateApi['executionReadiness'];
    runSyncGuardRef: DataSyncModalStateApi['runSyncGuardRef'];
    setSyncing: DataSyncModalStateApi['setSyncing'];
    setCurrentStep: DataSyncModalStateApi['setCurrentStep'];
    setSyncResult: DataSyncModalStateApi['setSyncResult'];
    resolvedTaskKey: DataSyncModalStateApi['resolvedTaskKey'];
    tableOptions: DataSyncModalStateApi['tableOptions'];
    i18nLanguage: DataSyncModalStateApi['i18nLanguage'];
    previewData: DataSyncModalStateApi['previewData'];
    previewTable: DataSyncModalStateApi['previewTable'];
    diffTables: DataSyncModalStateApi['diffTables'];
    isCompareEntry: DataSyncModalStateApi['isCompareEntry'];
    workflowType: DataSyncModalStateApi['workflowType'];
    migrationCapability: DataSyncModalStateApi['migrationCapability'];
    migrationCapabilityStatus: DataSyncModalStateApi['migrationCapabilityStatus'];
    targetConn: DataSyncModalStateApi['targetConn'];
}

export const useDataSyncModalSyncActions = ({
    sourceDatasetMode, selectedTables, sourceQuery, syncContent, tr, sourceConnId, targetConnId,
    sourceDb, targetDb, ensureTargetSchemaSelected, setLoading, setAnalyzing, setDiffTables,
    setAnalyzedFingerprint, setTableOptions, setSyncLogs, analysisRequestSeqRef,
    currentAnalysisFingerprint, analysisAbortRef, connections, jobIdRef, autoScrollRef,
    setSyncProgress, normalizeConnConfig, targetSchema, syncMode, autoAddColumns,
    effectiveTargetTableStrategy, createIndexes, mongoCollectionName, currentAnalysisFingerprintRef,
    setPreviewOpen, setPreviewTable, setPreviewLoading, setPreviewData, previewRequestSeqRef,
    previewAbortRef, executionReadiness, runSyncGuardRef, setSyncing, setCurrentStep, setSyncResult,
    resolvedTaskKey, tableOptions, i18nLanguage, previewData, previewTable, diffTables,
    isCompareEntry, workflowType, migrationCapability, migrationCapabilityStatus, targetConn,
}: UseDataSyncModalSyncActionsInput) => {
    const analyzeDiff = async () => {
      const selectionError = validateDataSyncSelection({
        sourceDatasetMode,
        selectedTables,
        sourceQuery,
        syncContent,
      });
      if (selectionError) return message.error(tr(selectionError));
      if (!sourceConnId || !targetConnId)
        return message.error(tr("data_sync.message.select_connections_first"));
      if (!sourceDb || !targetDb)
        return message.error(tr("data_sync.message.select_databases_first"));
      if (!ensureTargetSchemaSelected()) return;

      setLoading(true);
      setAnalyzing(true);
      setDiffTables([]);
      setAnalyzedFingerprint("");
      setTableOptions({});
      setSyncLogs([]);

      const requestSeq = ++analysisRequestSeqRef.current;
      const requestFingerprint = currentAnalysisFingerprint;
      analysisAbortRef.current?.abort();
      const controller = new AbortController();
      analysisAbortRef.current = controller;

      const sConn = connections.find((c) => c.id === sourceConnId)!;
      const tConn = connections.find((c) => c.id === targetConnId)!;
      const jobId = `analyze-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
      jobIdRef.current = jobId;
      autoScrollRef.current = true;
      setSyncProgress({
        percent: 0,
        current: 0,
        total: selectedTables.length,
        table: "",
        stage: tr("data_sync.progress.stage.analyzing_diff"),
      });

      const config = buildDataSyncRequest({
        sourceConfig: normalizeConnConfig(sConn, sourceDb),
        targetConfig: normalizeConnConfig(tConn, targetDb),
        sourceDatabase: sourceDb,
        targetDatabase: targetDb,
        targetSchema,
        selectedTables,
        sourceDatasetMode,
        sourceQuery,
        syncContent,
        syncMode,
        autoAddColumns,
        targetTableStrategy: effectiveTargetTableStrategy,
        createIndexes,
        mongoCollectionName,
        jobId,
      });

      try {
        const res = await invokeAppWithSignal(
          "DataSyncAnalyze",
          [config],
          controller.signal,
          () => DataSyncAnalyze(config as any),
        );
        if (
          requestSeq !== analysisRequestSeqRef.current ||
          requestFingerprint !== currentAnalysisFingerprintRef.current
        ) {
          return;
        }
        if (res.success) {
          const tables = ((res.data as any)?.tables || []) as TableDiffSummary[];
          setDiffTables(tables);
          const init: Record<string, TableOps> = {};
          tables.forEach((t) => {
            init[t.table] = buildInitialDataSyncTableOptions(t, syncMode);
          });
          setTableOptions(init);
          setAnalyzedFingerprint(requestFingerprint);
          message.success(tr("data_sync.message.analysis_complete"));
        } else {
          setAnalyzedFingerprint("");
          message.error(
            res.message
              ? tr("data_sync.message.analysis_failed_detail", {
                  detail: res.message,
                })
              : tr("data_sync.message.analysis_failed"),
          );
        }
      } catch (e: any) {
        if (
          requestSeq !== analysisRequestSeqRef.current ||
          requestFingerprint !== currentAnalysisFingerprintRef.current
        ) {
          return;
        }
        if (isWebRPCAbortError(e)) return;
        setAnalyzedFingerprint("");
        message.error(
          tr("data_sync.message.analysis_failed_detail", {
            detail: e?.message || String(e),
          }),
        );
      } finally {
        if (analysisAbortRef.current === controller) {
          analysisAbortRef.current = null;
        }
        if (requestSeq === analysisRequestSeqRef.current) {
          setLoading(false);
          setAnalyzing(false);
        }
      }
    };

    const openPreview = async (table: string) => {
      if (!table) return;
      if (!ensureTargetSchemaSelected()) return;
      const sConn = connections.find((c) => c.id === sourceConnId)!;
      const tConn = connections.find((c) => c.id === targetConnId)!;

      setPreviewOpen(true);
      setPreviewTable(table);
      setPreviewLoading(true);
      setPreviewData(null);
      const requestSeq = ++previewRequestSeqRef.current;
      previewAbortRef.current?.abort();
      const controller = new AbortController();
      previewAbortRef.current = controller;

      const config = buildDataSyncRequest({
        sourceConfig: normalizeConnConfig(sConn, sourceDb),
        targetConfig: normalizeConnConfig(tConn, targetDb),
        sourceDatabase: sourceDb,
        targetDatabase: targetDb,
        targetSchema,
        selectedTables,
        sourceDatasetMode,
        sourceQuery,
        syncContent,
        syncMode,
        autoAddColumns,
        targetTableStrategy: effectiveTargetTableStrategy,
        createIndexes,
        mongoCollectionName,
      });

      try {
        const res = await invokeAppWithSignal(
          "DataSyncPreview",
          [config, table, 200],
          controller.signal,
          () => DataSyncPreview(config as any, table, 200),
        );
        if (requestSeq !== previewRequestSeqRef.current) return;
        if (res.success) {
          setPreviewData(res.data);
        } else {
          message.error(
            res.message
              ? tr("data_sync.message.preview_load_failed_detail", {
                  detail: res.message,
                })
              : tr("data_sync.message.preview_load_failed"),
          );
        }
      } catch (e: any) {
        if (requestSeq !== previewRequestSeqRef.current || isWebRPCAbortError(e)) return;
        message.error(
          tr("data_sync.message.preview_load_failed_detail", {
            detail: e?.message || String(e),
          }),
        );
      }

      if (previewAbortRef.current === controller) previewAbortRef.current = null;
      if (requestSeq === previewRequestSeqRef.current) setPreviewLoading(false);
    };

    const runSync = async () => {
      const selectionError = validateDataSyncSelection({
        sourceDatasetMode,
        selectedTables,
        sourceQuery,
        syncContent,
      });
      if (selectionError) {
        message.error(tr(selectionError));
        return;
      }
      if (!ensureTargetSchemaSelected()) return;
      if (!executionReadiness.ready) {
        message.error(
          executionReadiness.message || tr("data_sync.message.analyze_before_sync"),
        );
        return;
      }
      if (runSyncGuardRef.current) {
        message.warning(tr("data_sync.message.close_blocked_running"));
        return;
      }
      runSyncGuardRef.current = true;
      try {
        if (syncContent !== "schema" && syncMode === "full_overwrite") {
          const ok = await new Promise<boolean>((resolve) => {
            Modal.confirm({
              title: tr("data_sync.modal.full_overwrite_title"),
              content: tr("data_sync.modal.full_overwrite_content"),
              okText: tr("data_sync.modal.full_overwrite_ok"),
              cancelText: tr("common.cancel"),
              onOk: () => resolve(true),
              onCancel: () => resolve(false),
            });
          });
          if (!ok) return;
        }

        const sConn = connections.find((c) => c.id === sourceConnId)!;
        const tConn = connections.find((c) => c.id === targetConnId)!;
        if (!await confirmProductionMutation(
          tConn,
          tr("connection.production_risk.action.sync_data"),
          [targetDb, targetSchema, selectedTables.join(', ')].filter(Boolean).join(' / '),
          tr,
        )) return;

        setLoading(true);
        setSyncing(true);
        setCurrentStep(2);
        setSyncResult(null);
        setSyncLogs([]);

        const jobId = `sync-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
        jobIdRef.current = jobId;
        autoScrollRef.current = true;
        setSyncProgress({
          percent: 0,
          current: 0,
          total: selectedTables.length,
          table: "",
          stage: tr("data_sync.progress.stage.preparing"),
        });
        const taskStarted = startDataSyncBackgroundTask({
          taskKey: resolvedTaskKey,
          jobId,
          total: selectedTables.length,
          stage: tr("data_sync.progress.stage.preparing"),
        });
        if (!taskStarted) {
          message.warning(tr("data_sync.message.close_blocked_running"));
          return;
        }

        const config = buildDataSyncRequest({
          sourceConfig: normalizeConnConfig(sConn, sourceDb),
          targetConfig: normalizeConnConfig(tConn, targetDb),
          sourceDatabase: sourceDb,
          targetDatabase: targetDb,
          targetSchema,
          selectedTables,
          sourceDatasetMode,
          sourceQuery,
          syncContent,
          syncMode,
          autoAddColumns,
          targetTableStrategy: effectiveTargetTableStrategy,
          createIndexes,
          mongoCollectionName,
          tableOptions,
          jobId,
        });

        try {
          const res = await DataSync(config as any);
          setSyncResult(res);
          finishDataSyncBackgroundTask(resolvedTaskKey, jobId, res);
          if (Array.isArray(res?.logs) && res.logs.length > 0) {
            setSyncLogs((prev) => {
              if (prev.length > 0) return prev;
              return (res.logs as string[]).map((log) => {
                const msg = String(log || "").trim();
                return { level: resolveDataSyncTaskLogLevel(msg), message: msg };
              });
            });
          }
        } catch (e: any) {
          const failedResult = {
            success: false,
            message: tr("data_sync.message.sync_execution_failed"),
            logs: [],
          };
          message.error(
            tr("data_sync.message.sync_execution_failed_detail", {
              detail: e?.message || String(e),
            }),
          );
          setSyncResult(failedResult);
          failDataSyncBackgroundTask(resolvedTaskKey, jobId, failedResult);
        }
      } finally {
        runSyncGuardRef.current = false;
        setLoading(false);
        setSyncing(false);
      }
    };

    const renderSyncLogItem = (item: SyncLogItem) => {
      const level = String(item.level || "info").toLowerCase();
      const color =
        level === "error" ? "#ff4d4f" : level === "warn" ? "#faad14" : "#595959";
      const label =
        level === "error"
          ? tr("data_sync.log.level.error")
          : level === "warn"
            ? tr("data_sync.log.level.warn")
            : tr("data_sync.log.level.info");
      const timeText =
        typeof item.ts === "number"
          ? new Date(item.ts).toLocaleTimeString(i18nLanguage || undefined, {
              hour12: false,
            })
          : "";
      return (
        <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
          <span style={{ color, flex: "0 0 auto" }}>● {label}</span>
          {timeText && (
            <span style={{ color: "#8c8c8c", flex: "0 0 auto" }}>{timeText}</span>
          )}
          <span style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
            {item.message}
          </span>
        </div>
      );
    };

    const previewSql = useMemo(() => {
      if (!previewData || !previewTable)
        return { sqlText: "", statementCount: 0 };
      const targetType = String(
        connections.find((c) => c.id === targetConnId)?.config?.type || "",
      );
      const ops = tableOptions[previewTable] || {
        insert: true,
        update: true,
        delete: false,
      };
      return buildSqlPreview(previewData, previewTable, targetType, ops);
    }, [previewData, previewTable, targetConnId, connections, tableOptions]);
    // Old Redis/Mongo preview payloads did not set RowSelectionSupported, but
    // still include a usable pkColumn. Preserve their existing row-selection UI.
    const previewRowSelectionSupported =
      previewData?.rowSelectionSupported !== false || Boolean(previewData?.pkColumn);
    const previewHasSchemaStatements = useMemo(
      () =>
        Array.isArray(previewData?.schemaStatements) &&
        previewData.schemaStatements.length > 0,
      [previewData],
    );
    const previewSchemaWarnings = useMemo(
      () =>
        Array.isArray(previewData?.schemaWarnings)
          ? (previewData.schemaWarnings as string[])
          : [],
      [previewData],
    );
    const previewHasDataDiff = useMemo(
      () =>
        Number(previewData?.totalInserts || 0) +
          Number(previewData?.totalUpdates || 0) +
          Number(previewData?.totalDeletes || 0) >
        0,
      [previewData],
    );

    const analysisWarnings = useMemo(() => {
      const items: string[] = [];
      diffTables.forEach((table) => {
        (table.warnings || []).forEach((warning) =>
          items.push(`${table.table}: ${warning}`),
        );
        (table.unsupportedObjects || []).forEach((warning) =>
          items.push(`${table.table}: ${warning}`),
        );
      });
      return Array.from(new Set(items));
    }, [diffTables]);
    const isMigrationWorkflow = !isCompareEntry && workflowType === "migration";
    const tableCreationAllowed = !isCompareEntry && isTargetTableCreationAllowed(workflowType, syncContent, sourceDatasetMode);
    const sourceConn = useMemo(
      () => connections.find((c) => c.id === sourceConnId),
      [connections, sourceConnId],
    );
    const capabilityPresentation = useMemo(
      () =>
        migrationCapability
          ? resolveDataSyncCapabilityPresentation(migrationCapability, tr)
          : null,
      [migrationCapability, i18nLanguage],
    );
    const capabilityStatusPresentation = useMemo(() => {
      if (migrationCapabilityStatus === "loading") {
        return {
          alertType: "info" as const,
          message: tr("data_sync.capability.loading"),
        };
      }
      if (migrationCapabilityStatus === "error") {
        return {
          alertType: "error" as const,
          message: tr("data_sync.capability.load_failed"),
        };
      }
      return null;
    }, [migrationCapabilityStatus, i18nLanguage]);
    const sourceType = String(sourceConn?.config?.type || "").toLowerCase();
    const targetType = String(targetConn?.config?.type || "").toLowerCase();
    return {
        analyzeDiff, openPreview, runSync, renderSyncLogItem, previewSql,
        previewRowSelectionSupported, previewHasSchemaStatements, previewSchemaWarnings,
        previewHasDataDiff, analysisWarnings, isMigrationWorkflow, tableCreationAllowed, sourceConn,
        capabilityPresentation, capabilityStatusPresentation, sourceType, targetType,
    };
};

export type DataSyncModalSyncActionsApi = ReturnType<typeof useDataSyncModalSyncActions>;
