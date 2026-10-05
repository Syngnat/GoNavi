import { useState, useRef, useMemo, useEffect } from "react";
import { theme as antdTheme } from "antd";
import { useOptionalI18n } from "../../../i18n/provider";
import { t } from "../../../i18n";
import { resolveDataSyncEntryModePresentation } from "../../dataSyncEntryMode";
import { useDataSyncBackgroundTask } from "../../dataSyncBackgroundTask";
import { useStore } from "../../../store";
import {
    resolveAppearanceValues,
    normalizeOpacityForPlatform,
    isMacLikePlatform,
} from "../../../utils/appearance";
import type { DataSyncCapabilitySnapshot } from "../../dataSyncCapability";
import {
    type SourceDatasetMode,
    resolveDataSyncTargetTableStrategy,
    buildDataSyncAnalysisFingerprint,
    validateDataSyncExecutionReadiness,
} from "../../dataSyncRequest";
import type {
    WorkflowType,
    TableDiffSummary,
    TableOps,
    SyncLogItem,
    SyncLogEvent,
    SyncProgressEvent,
} from "../dataSyncModalTypes";
import { SavedConnection } from "../../../types";
import { buildRpcConnectionConfig } from "../../../utils/connectionRpcConfig";
import { isServiceNameBackedSyncConnection } from "../dataSyncSqlPreview";
import { resolveSqlDialect } from "../../../utils/sqlDialect";
import { supportsIndependentSchemaSelection } from "../../../utils/connectionDriverType";
import { EventsOn } from "../../../../wailsjs/runtime/runtime";
import type { DataSyncModalProps } from "../../DataSyncModal";

export interface UseDataSyncModalStateInput {
    entryMode: Exclude<DataSyncModalProps['entryMode'], undefined>;
    taskKey: DataSyncModalProps['taskKey'];
    open: DataSyncModalProps['open'];
}

export const useDataSyncModalState = ({ entryMode, taskKey, open }: UseDataSyncModalStateInput) => {
    const i18n = useOptionalI18n();
    const i18nLanguage = i18n?.language;
    const tr = (key: string, params?: Parameters<typeof t>[1]) =>
      t(key, params, i18nLanguage);
    const entryPresentation = resolveDataSyncEntryModePresentation(entryMode, tr);
    const isSchemaCompareEntry = entryMode === "schemaCompare";
    const isDataCompareEntry = entryMode === "dataCompare";
    const isCompareEntry = entryPresentation.readOnly;
    const resolvedTaskKey = String(taskKey || `data-sync:${entryMode}`).trim();
    const backgroundTask = useDataSyncBackgroundTask(resolvedTaskKey);
    const connections = useStore((state) => state.connections);
    const themeMode = useStore((state) => state.theme);
    const appearance = useStore((state) => state.appearance);
    const [currentStep, setCurrentStep] = useState(0);
    const [loading, setLoading] = useState(false);
    const { token } = antdTheme.useToken();
    const darkMode = themeMode === "dark";
    const resolvedAppearance = resolveAppearanceValues(appearance);
    const effectiveOpacity = normalizeOpacityForPlatform(
      resolvedAppearance.opacity,
    );
    const disableLocalBackdropFilter = isMacLikePlatform();

    // Step 1: Config
    const [sourceConnId, setSourceConnId] = useState<string>("");
    const [targetConnId, setTargetConnId] = useState<string>("");
    const [sourceDb, setSourceDb] = useState<string>("");
    const [targetDb, setTargetDb] = useState<string>("");

    const [sourceDbs, setSourceDbs] = useState<string[]>([]);
    const [targetDbs, setTargetDbs] = useState<string[]>([]);
    const [targetSchemas, setTargetSchemas] = useState<string[]>([]);
    const [targetSchema, setTargetSchema] = useState<string>("");
    const [targetSchemaLoading, setTargetSchemaLoading] =
      useState<boolean>(false);
    const [migrationCapability, setMigrationCapability] =
      useState<DataSyncCapabilitySnapshot | null>(null);
    const [migrationCapabilityStatus, setMigrationCapabilityStatus] = useState<
      "idle" | "loading" | "ready" | "error"
    >("idle");

    // Step 2: Tables
    const [allTables, setAllTables] = useState<string[]>([]);
    const [selectedTables, setSelectedTables] = useState<string[]>([]);
    const [sourceDatasetMode, setSourceDatasetMode] =
      useState<SourceDatasetMode>("table");
    const [sourceQuery, setSourceQuery] = useState<string>("");

    // Options
    const [workflowType, setWorkflowType] = useState<WorkflowType>("sync");
    const [syncContent, setSyncContent] = useState<"data" | "schema" | "both">(
      isSchemaCompareEntry ? "schema" : "data",
    );
    const [syncMode, setSyncMode] = useState<string>("insert_update");
    const [autoAddColumns, setAutoAddColumns] = useState<boolean>(true);
    const [targetTableStrategy, setTargetTableStrategy] = useState<
      "existing_only" | "auto_create_if_missing" | "smart"
    >("existing_only");
    const [createIndexes, setCreateIndexes] = useState<boolean>(false);
    const [mongoCollectionName, setMongoCollectionName] = useState<string>("");
    const [showSameTables, setShowSameTables] = useState<boolean>(false);
    const [analyzing, setAnalyzing] = useState<boolean>(false);
    const [diffTables, setDiffTables] = useState<TableDiffSummary[]>([]);
    const [analyzedFingerprint, setAnalyzedFingerprint] = useState("");
    const [tableOptions, setTableOptions] = useState<Record<string, TableOps>>(
      {},
    );

    const [previewOpen, setPreviewOpen] = useState(false);
    const [previewTable, setPreviewTable] = useState<string>("");
    const [previewLoading, setPreviewLoading] = useState(false);
    const [previewData, setPreviewData] = useState<any>(null);

    // Step 3: Result
    const [syncResult, setSyncResult] = useState<any>(null);
    const [syncing, setSyncing] = useState(false);
    const [syncLogs, setSyncLogs] = useState<SyncLogItem[]>([]);
    const [syncProgress, setSyncProgress] = useState<{
      percent: number;
      current: number;
      total: number;
      table: string;
      stage: string;
    }>({
      percent: 0,
      current: 0,
      total: 0,
      table: "",
      stage: "",
    });
    const jobIdRef = useRef<string>("");
    const runSyncGuardRef = useRef(false);
    const analysisRequestSeqRef = useRef(0);
    const previewRequestSeqRef = useRef(0);
    const analysisAbortRef = useRef<AbortController | null>(null);
    const previewAbortRef = useRef<AbortController | null>(null);
    const sourceDatabaseRequestSeqRef = useRef(0);
    const targetDatabaseRequestSeqRef = useRef(0);
    const tableMetadataRequestSeqRef = useRef(0);
    const targetTableStrategyTouchedRef = useRef(false);
    const logBoxRef = useRef<HTMLDivElement>(null);
    const autoScrollRef = useRef(true);
    const effectiveTargetTableStrategy = resolveDataSyncTargetTableStrategy(
      targetTableStrategy,
      workflowType,
      sourceDatasetMode,
      migrationCapability?.supportsAutoCreate === true,
      targetTableStrategyTouchedRef.current,
      syncContent,
    );

    const currentAnalysisFingerprint = useMemo(
      () =>
        buildDataSyncAnalysisFingerprint({
          sourceConnectionId: sourceConnId,
          targetConnectionId: targetConnId,
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
        }),
      [
        sourceConnId,
        targetConnId,
        sourceDb,
        targetDb,
        targetSchema,
        selectedTables,
        sourceDatasetMode,
        sourceQuery,
        syncContent,
        syncMode,
        autoAddColumns,
        effectiveTargetTableStrategy,
        createIndexes,
        mongoCollectionName,
      ],
    );
    const currentAnalysisFingerprintRef = useRef(currentAnalysisFingerprint);
    currentAnalysisFingerprintRef.current = currentAnalysisFingerprint;
    const currentTableEndpointFingerprint = useMemo(
      () =>
        JSON.stringify([
          sourceDatasetMode,
          sourceDatasetMode === "query" ? targetConnId : sourceConnId,
          sourceDatasetMode === "query" ? targetDb : sourceDb,
          sourceDatasetMode === "query" ? targetSchema : "",
        ]),
      [
        sourceDatasetMode,
        sourceConnId,
        targetConnId,
        sourceDb,
        targetDb,
        targetSchema,
      ],
    );
    const currentTableEndpointFingerprintRef = useRef(
      currentTableEndpointFingerprint,
    );
    currentTableEndpointFingerprintRef.current = currentTableEndpointFingerprint;
    const executionReadiness = useMemo(
      () =>
        validateDataSyncExecutionReadiness({
          requiresAnalysis: syncContent !== "schema",
          syncContent,
          syncMode,
          currentFingerprint: currentAnalysisFingerprint,
          analyzedFingerprint,
          selectedTables,
          analyzedTables: diffTables,
          tableOptions,
        }),
      [
        analyzedFingerprint,
        currentAnalysisFingerprint,
        diffTables,
        selectedTables,
        syncContent,
        syncMode,
        tableOptions,
      ],
    );

    const normalizeConnConfig = (conn: SavedConnection, database?: string) =>
      buildRpcConnectionConfig(conn.config, {
        database:
          typeof database === "string" && !isServiceNameBackedSyncConnection(conn)
            ? database
            : conn.config.database || "",
      });

    const isSourceQueryMode = sourceDatasetMode === "query";

    const targetConn = useMemo(
      () => connections.find((c) => c.id === targetConnId),
      [connections, targetConnId],
    );

    const targetDialect = useMemo(
      () =>
        resolveSqlDialect(
          targetConn?.config?.type || "",
          targetConn?.config?.driver || "",
          { oceanBaseProtocol: targetConn?.config?.oceanBaseProtocol },
        ),
      [targetConn],
    );

    const targetSupportsSchemaSelection = useMemo(
      () => supportsIndependentSchemaSelection(targetDialect),
      [targetDialect],
    );

    useEffect(() => {
      if (!open) return;

      const offLog = EventsOn("sync:log", (event: SyncLogEvent) => {
        if (!event || event.jobId !== jobIdRef.current) return;
        const msg = String(event.message || "").trim();
        if (!msg) return;
        setSyncLogs((prev) => [
          ...prev,
          { level: String(event.level || "info"), message: msg, ts: event.ts },
        ]);
      });

      const offProgress = EventsOn(
        "sync:progress",
        (event: SyncProgressEvent) => {
          if (!event || event.jobId !== jobIdRef.current) return;
          setSyncProgress((prev) => ({
            percent:
              typeof event.percent === "number" ? event.percent : prev.percent,
            current:
              typeof event.current === "number" ? event.current : prev.current,
            total: typeof event.total === "number" ? event.total : prev.total,
            table: typeof event.table === "string" ? event.table : prev.table,
            stage: typeof event.stage === "string" ? event.stage : prev.stage,
          }));
        },
      );

      return () => {
        if (typeof offLog === "function") offLog();
        if (typeof offProgress === "function") offProgress();
      };
    }, [open]);

    useEffect(() => {
      if (open) return undefined;
      analysisRequestSeqRef.current += 1;
      previewRequestSeqRef.current += 1;
      analysisAbortRef.current?.abort();
      previewAbortRef.current?.abort();
      analysisAbortRef.current = null;
      previewAbortRef.current = null;
      return undefined;
    }, [open]);

    useEffect(() => () => {
      analysisRequestSeqRef.current += 1;
      previewRequestSeqRef.current += 1;
      analysisAbortRef.current?.abort();
      previewAbortRef.current?.abort();
    }, []);

    useEffect(() => {
      if (!logBoxRef.current) return;
      if (!autoScrollRef.current) return;
      logBoxRef.current.scrollTop = logBoxRef.current.scrollHeight;
    }, [syncLogs]);

    useEffect(() => {
      if (open) {
        if (backgroundTask.jobId) {
          jobIdRef.current = backgroundTask.jobId;
          setCurrentStep(2);
          setSyncing(backgroundTask.status === "running");
          setSyncResult(backgroundTask.result);
          setSyncLogs(backgroundTask.logs);
          setSyncProgress(backgroundTask.progress);
          autoScrollRef.current = true;
          return;
        }
        setCurrentStep(0);
        setSourceConnId("");
        setTargetConnId("");
        setSourceDb("");
        setTargetDb("");
        setTargetSchema("");
        setTargetSchemas([]);
        setTargetSchemaLoading(false);
        setAllTables([]);
        setSelectedTables([]);
        setSourceDatasetMode("table");
        setSourceQuery("");
        setWorkflowType("sync");
        setSyncContent(isSchemaCompareEntry ? "schema" : "data");
        setSyncMode("insert_update");
        setAutoAddColumns(true);
        targetTableStrategyTouchedRef.current = false;
        setTargetTableStrategy("existing_only");
        setCreateIndexes(false);
        setShowSameTables(false);
        setAnalyzing(false);
        setDiffTables([]);
        setAnalyzedFingerprint("");
        setTableOptions({});
        setPreviewOpen(false);
        setPreviewTable("");
        setPreviewLoading(false);
        setPreviewData(null);
        setSyncResult(null);
        setSyncing(false);
        setSyncLogs([]);
        setSyncProgress({
          percent: 0,
          current: 0,
          total: 0,
          table: "",
          stage: "",
        });
        jobIdRef.current = "";
        autoScrollRef.current = true;
      }
    }, [backgroundTask.jobId, isSchemaCompareEntry, open]);

    useEffect(() => {
      if (!backgroundTask.jobId) return;
      jobIdRef.current = backgroundTask.jobId;
      setSyncing(backgroundTask.status === "running");
      setSyncResult(backgroundTask.result);
      setSyncLogs(backgroundTask.logs);
      setSyncProgress(backgroundTask.progress);
      setCurrentStep(2);
    }, [
      backgroundTask.jobId,
      backgroundTask.logs,
      backgroundTask.progress,
      backgroundTask.result,
      backgroundTask.status,
    ]);
    return {
        i18nLanguage, tr, entryPresentation, isSchemaCompareEntry, isDataCompareEntry,
        isCompareEntry, resolvedTaskKey, connections, currentStep, setCurrentStep, loading,
        setLoading, token, darkMode, effectiveOpacity, disableLocalBackdropFilter, sourceConnId,
        setSourceConnId, targetConnId, setTargetConnId, sourceDb, setSourceDb, targetDb,
        setTargetDb, sourceDbs, setSourceDbs, targetDbs, setTargetDbs, targetSchemas,
        setTargetSchemas, targetSchema, setTargetSchema, targetSchemaLoading,
        setTargetSchemaLoading, migrationCapability, setMigrationCapability,
        migrationCapabilityStatus, setMigrationCapabilityStatus, allTables, setAllTables,
        selectedTables, setSelectedTables, sourceDatasetMode, setSourceDatasetMode, sourceQuery,
        setSourceQuery, workflowType, setWorkflowType, syncContent, setSyncContent, syncMode,
        setSyncMode, autoAddColumns, setAutoAddColumns, targetTableStrategy, setTargetTableStrategy,
        createIndexes, setCreateIndexes, mongoCollectionName, setMongoCollectionName,
        showSameTables, setShowSameTables, analyzing, setAnalyzing, diffTables, setDiffTables,
        setAnalyzedFingerprint, tableOptions, setTableOptions, previewOpen, setPreviewOpen,
        previewTable, setPreviewTable, previewLoading, setPreviewLoading, previewData,
        setPreviewData, syncResult, setSyncResult, syncing, setSyncing, syncLogs, setSyncLogs,
        syncProgress, setSyncProgress, jobIdRef, runSyncGuardRef, analysisRequestSeqRef,
        previewRequestSeqRef, analysisAbortRef, previewAbortRef, sourceDatabaseRequestSeqRef,
        targetDatabaseRequestSeqRef, tableMetadataRequestSeqRef, targetTableStrategyTouchedRef,
        logBoxRef, autoScrollRef, effectiveTargetTableStrategy, currentAnalysisFingerprint,
        currentAnalysisFingerprintRef, currentTableEndpointFingerprint,
        currentTableEndpointFingerprintRef, executionReadiness, normalizeConnConfig,
        isSourceQueryMode, targetConn, targetDialect, targetSupportsSchemaSelection,
    };
};

export type DataSyncModalStateApi = ReturnType<typeof useDataSyncModalState>;
