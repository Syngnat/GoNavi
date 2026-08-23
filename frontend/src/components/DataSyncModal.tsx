import Modal from "./common/ResizableDraggableModal";
import React, { useState, useEffect, useMemo, useRef } from "react";
import {
  Form,
  Select,
  Input,
  Button,
  message,
  Steps,
  Transfer,
  Card,
  Alert,
  Divider,
  Typography,
  Progress,
  Checkbox,
  Table,
  Drawer,
  Tabs,
  theme as antdTheme,
} from "antd";
import {
  DatabaseOutlined,
  RocketOutlined,
  SwapOutlined,
  TableOutlined,
} from "@ant-design/icons";
import { useStore } from "../store";
import {
  DBGetDatabases,
  DBGetTables,
  DataSync,
  DataSyncAnalyze,
  DataSyncCapability,
  DataSyncPreview,
} from "../../wailsjs/go/app/App";
import { SavedConnection } from "../types";
import { EventsOn } from "../../wailsjs/runtime/runtime";
import {
  isMacLikePlatform,
  normalizeOpacityForPlatform,
  resolveAppearanceValues,
  resolveTextInputSafeBackdropFilter,
} from "../utils/appearance";
import { buildRpcConnectionConfig } from "../utils/connectionRpcConfig";
import {
  isPostgresSchemaDialect,
  supportsIndependentSchemaSelection,
} from "../utils/connectionDriverType";
import { resolveSqlDialect } from "../utils/sqlDialect";
import { quoteIdentPart, quoteQualifiedIdent } from "../utils/sql";
import { normalizeTableNamesFromMetadataRows } from "../utils/tableMetadataRows";
import { getTableMetadataIssueDetail, isTableMetadataIncomplete } from "../utils/tableMetadataResult";
import {
  formatLocalDateTimeLiteral,
  normalizeTemporalLiteralText,
} from "./dataGridCopyInsert";
import {
  buildDataSyncAnalysisFingerprint,
  buildInitialDataSyncTableOptions,
  buildDataSyncRequest,
  type SourceDatasetMode,
  validateDataSyncExecutionReadiness,
  validateDataSyncSelection,
} from "./dataSyncRequest";
import { t } from "../i18n";
import { useOptionalI18n } from "../i18n/provider";
import { confirmProductionMutation } from "../utils/productionRiskConfirm";
import {
  resolveDataSyncEntryModePresentation,
  type DataSyncEntryMode,
} from "./dataSyncEntryMode";
import { loadSchemas } from "./sidebar/sidebarMetadataLoaders";
import {
  failDataSyncBackgroundTask,
  finishDataSyncBackgroundTask,
  resolveDataSyncTaskLogLevel,
  startDataSyncBackgroundTask,
  useDataSyncBackgroundTask,
} from "./dataSyncBackgroundTask";
import {
  resolveDataSyncCapabilityPresentation,
  type DataSyncCapabilitySnapshot,
} from "./dataSyncCapability";
import { resolveDataSyncDatabaseSelection } from "./dataSyncDatabaseSelection";
const { Title, Text } = Typography;
const { Step } = Steps;
const { Option } = Select;
const { TextArea } = Input;

type SyncLogEvent = {
  jobId: string;
  level?: string;
  message?: string;
  ts?: number;
};
type SyncProgressEvent = {
  jobId: string;
  percent?: number;
  current?: number;
  total?: number;
  table?: string;
  stage?: string;
};
type SyncLogItem = { level: string; message: string; ts?: number };
type TableDiffSummary = {
  table: string;
  pkColumn?: string;
  canSync?: boolean;
  inserts?: number;
  updates?: number;
  deletes?: number;
  same?: number;
  schemaDiffCount?: number;
  message?: string;
  targetTableExists?: boolean;
  plannedAction?: string;
  warnings?: string[];
  unsupportedObjects?: string[];
  indexesToCreate?: number;
  indexesSkipped?: number;
};
type TableOps = {
  insert: boolean;
  update: boolean;
  delete: boolean;
  selectedInsertPks?: string[];
  selectedUpdatePks?: string[];
  selectedDeletePks?: string[];
};

type WorkflowType = "sync" | "migration";

const quoteSqlIdent = (dbType: string, ident: string): string => {
  return quoteIdentPart(dbType, String(ident || "").trim());
};

const quoteSqlTable = (dbType: string, tableName: string): string => {
  return quoteQualifiedIdent(dbType, String(tableName || "").trim());
};

const toSqlLiteral = (value: any, dbType: string): string => {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number")
    return Number.isFinite(value) ? String(value) : "NULL";
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "boolean") {
    const t = String(dbType || "").toLowerCase();
    if (t === "sqlserver") return value ? "1" : "0";
    return value ? "TRUE" : "FALSE";
  }
  if (value instanceof Date) {
    return `'${formatLocalDateTimeLiteral(value).replace(/'/g, "''")}'`;
  }
  if (typeof value === "string") {
    return `'${value.replace(/'/g, "''")}'`;
  }
  if (typeof value === "object") {
    try {
      return `'${JSON.stringify(value).replace(/'/g, "''")}'`;
    } catch {
      return `'${String(value).replace(/'/g, "''")}'`;
    }
  }
  return `'${String(value).replace(/'/g, "''")}'`;
};

const toTypedSqlLiteral = (
  value: any,
  dbType: string,
  columnType?: string,
): string => {
  if (typeof value === "string") {
    const normalized = normalizeTemporalLiteralText(value, columnType, false);
    return toSqlLiteral(normalized, dbType);
  }
  if (value instanceof Date) {
    const normalized = String(columnType || "").trim()
      ? formatLocalDateTimeLiteral(value)
      : value.toISOString();
    return toSqlLiteral(normalized, dbType);
  }
  return toSqlLiteral(value, dbType);
};

const resolveRedisDbIndex = (raw?: string): number => {
  const value = Number(String(raw || "").trim());
  return Number.isInteger(value) && value >= 0 && value <= 15 ? value : 0;
};

const normalizeSchemaName = (raw?: string): string =>
  String(raw || "")
    .trim()
    .toLowerCase();

const resolveSchemaFromQualifiedTableName = (tableName: string): string => {
  const parts = String(tableName || "")
    .trim()
    .split(".")
    .map((part) => part.trim())
    .filter((part) => part !== "");
  if (parts.length < 2) return "";
  return parts.length >= 3 ? parts[parts.length - 2] : parts[0];
};

const filterTablesBySchema = (
  tables: string[],
  schemaName: string,
): string[] => {
  const normalizedSchema = normalizeSchemaName(schemaName);
  if (!normalizedSchema) return tables;

  const filtered = tables.filter((tableName) => {
    const rawTableName = String(tableName || "").trim();
    if (!rawTableName) return false;
    const tableSchema = resolveSchemaFromQualifiedTableName(rawTableName);
    if (!tableSchema) return true;
    return normalizeSchemaName(tableSchema) === normalizedSchema;
  });

  return filtered.length > 0 ? filtered : tables;
};

const resolvePreferredTargetSchema = (
  dialect: string,
  schemaNames: string[],
): string => {
  const preferred = isPostgresSchemaDialect(dialect)
    ? "public"
    : dialect === "sqlserver"
      ? "dbo"
      : dialect === "duckdb"
        ? "main"
        : "";
  if (preferred) {
    const matched = schemaNames.find(
      (item) => item.toLowerCase() === preferred,
    );
    if (matched) return matched;
  }
  if (schemaNames.length === 1) return schemaNames[0];
  return "";
};

const isServiceNameBackedSyncConnection = (conn?: SavedConnection): boolean => {
  const type = String(conn?.config?.type || "")
    .trim()
    .toLowerCase();
  if (type === "oracle") return true;
  if (type !== "oceanbase") return false;
  const explicitProtocol = String(
    (conn?.config as any)?.oceanBaseProtocol || "",
  )
    .trim()
    .toLowerCase();
  if (explicitProtocol === "oracle") return true;
  const params = new URLSearchParams(
    String(conn?.config?.connectionParams || ""),
  );
  const protocol = String(
    params.get("protocol") || params.get("tenantMode") || "",
  )
    .trim()
    .toLowerCase();
  return protocol === "oracle";
};

export const buildSqlPreview = (
  previewData: any,
  tableName: string,
  dbType: string,
  ops?: TableOps,
): { sqlText: string; statementCount: number } => {
  if (!previewData || !tableName) return { sqlText: "", statementCount: 0 };
  const tableExpr = quoteSqlTable(dbType, tableName);
  const pkCol = String(previewData.pkColumn || "id");
  const pkColumns = Array.isArray(previewData.pkColumns)
    ? previewData.pkColumns
        .map((column: unknown) => String(column || "").trim())
        .filter((column: string) => column.length > 0)
    : [];
  if (pkColumns.length === 0) pkColumns.push(pkCol);
  const pkColumnSet = new Set(pkColumns);
  const columnTypesByLowerName =
    previewData?.columnTypes && typeof previewData.columnTypes === "object"
      ? (previewData.columnTypes as Record<string, string>)
      : {};
  const statements: string[] = [];
  const schemaStatements = Array.isArray(previewData.schemaStatements)
    ? previewData.schemaStatements
        .map((item: any) => String(item || "").trim())
        .filter((item: string) => item.length > 0)
    : [];

  schemaStatements.forEach((statement: string) => {
    statements.push(statement.endsWith(";") ? statement : `${statement};`);
  });

  const insertRows = Array.isArray(previewData.inserts)
    ? previewData.inserts
    : [];
  const updateRows = Array.isArray(previewData.updates)
    ? previewData.updates
    : [];
  const deleteRows = Array.isArray(previewData.deletes)
    ? previewData.deletes
    : [];

  const selectedInsert = new Set(
    (ops?.selectedInsertPks || []).map((v) => String(v)),
  );
  const selectedUpdate = new Set(
    (ops?.selectedUpdatePks || []).map((v) => String(v)),
  );
  const selectedDelete = new Set(
    (ops?.selectedDeletePks || []).map((v) => String(v)),
  );

  const buildWhereExpr = (rowWrap: any, fallbackPk: string): string => {
    const locator = {
      ...(rowWrap?.source || {}),
      ...(rowWrap?.target || {}),
      ...(rowWrap?.row || {}),
    } as Record<string, unknown>;
    const conditions: string[] = [];
    for (const column of pkColumns) {
      let value = locator[column];
      if (
        value === undefined &&
        pkColumns.length === 1 &&
        fallbackPk !== ""
      ) {
        value = fallbackPk;
      }
      if (value === undefined) return "";
      conditions.push(
        `${quoteSqlIdent(dbType, column)} = ${toTypedSqlLiteral(value, dbType, columnTypesByLowerName[column.toLowerCase()])}`,
      );
    }
    return conditions.join(" AND ");
  };

  if (ops?.insert !== false) {
    insertRows.forEach((rowWrap: any) => {
      const pk = String(rowWrap?.pk ?? "");
      if (selectedInsert.size > 0 && !selectedInsert.has(pk)) return;
      const row = rowWrap?.row || {};
      const columns = Object.keys(row);
      if (columns.length === 0) return;
      const colExpr = columns.map((c) => quoteSqlIdent(dbType, c)).join(", ");
      const valExpr = columns
        .map((c) =>
          toTypedSqlLiteral(
            row[c],
            dbType,
            columnTypesByLowerName[String(c).toLowerCase()],
          ),
        )
        .join(", ");
      statements.push(
        `INSERT INTO ${tableExpr} (${colExpr}) VALUES (${valExpr});`,
      );
    });
  }

  if (ops?.update !== false) {
    updateRows.forEach((rowWrap: any) => {
      const pk = String(rowWrap?.pk ?? "");
      if (selectedUpdate.size > 0 && !selectedUpdate.has(pk)) return;
      const source = rowWrap?.source || {};
      const changedColumns = Array.isArray(rowWrap?.changedColumns)
        ? rowWrap.changedColumns
        : Object.keys(source).filter((k) => !pkColumnSet.has(k));
      const setCols = changedColumns.filter(
        (c: string) => !pkColumnSet.has(String(c)),
      );
      if (setCols.length === 0) return;
      const setExpr = setCols
        .map(
          (c: string) =>
            `${quoteSqlIdent(dbType, c)} = ${toTypedSqlLiteral(source[c], dbType, columnTypesByLowerName[String(c).toLowerCase()])}`,
        )
        .join(", ");
      const whereExpr = buildWhereExpr(rowWrap, pk);
      if (whereExpr === "") return;
      statements.push(`UPDATE ${tableExpr} SET ${setExpr} WHERE ${whereExpr};`);
    });
  }

  if (ops?.delete) {
    deleteRows.forEach((rowWrap: any) => {
      const pk = String(rowWrap?.pk ?? "");
      if (selectedDelete.size > 0 && !selectedDelete.has(pk)) return;
      const whereExpr = buildWhereExpr(rowWrap, pk);
      if (whereExpr === "") return;
      statements.push(`DELETE FROM ${tableExpr} WHERE ${whereExpr};`);
    });
  }

  return {
    sqlText: statements.join("\n"),
    statementCount: statements.length,
  };
};

const DataSyncModal: React.FC<{
  open: boolean;
  onClose: () => void;
  onBack?: () => void;
  entryMode?: DataSyncEntryMode;
  embedded?: boolean;
  taskKey?: string;
}> = ({
  open,
  onClose,
  onBack,
  entryMode = "sync",
  embedded = false,
  taskKey,
}) => {
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
  const sourceDatabaseRequestSeqRef = useRef(0);
  const targetDatabaseRequestSeqRef = useRef(0);
  const tableMetadataRequestSeqRef = useRef(0);
  const logBoxRef = useRef<HTMLDivElement>(null);
  const autoScrollRef = useRef(true);

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
        targetTableStrategy,
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
      targetTableStrategy,
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

  useEffect(() => {
    if (isSchemaCompareEntry) {
      if (workflowType !== "sync") {
        setWorkflowType("sync");
      }
      if (sourceDatasetMode !== "table") {
        setSourceDatasetMode("table");
      }
      if (syncContent !== "schema") {
        setSyncContent("schema");
      }
      if (syncMode !== "insert_update") {
        setSyncMode("insert_update");
      }
      if (targetTableStrategy !== "existing_only") {
        setTargetTableStrategy("existing_only");
      }
      if (createIndexes) {
        setCreateIndexes(false);
      }
      return;
    }
    if (isDataCompareEntry) {
      if (workflowType !== "sync") {
        setWorkflowType("sync");
      }
      if (syncContent !== "data") {
        setSyncContent("data");
      }
      if (syncMode !== "insert_update") {
        setSyncMode("insert_update");
      }
      if (targetTableStrategy !== "existing_only") {
        setTargetTableStrategy("existing_only");
      }
      if (createIndexes) {
        setCreateIndexes(false);
      }
      return;
    }
    if (workflowType === "migration") {
      const supportsAutoCreate = migrationCapability?.supportsAutoCreate === true;
      if (syncMode === "insert_update") {
        setSyncMode("insert_only");
      }
      if (syncContent === "schema") {
        setSyncContent("both");
      }
      if (supportsAutoCreate && targetTableStrategy === "existing_only") {
        setTargetTableStrategy("smart");
      } else if (!supportsAutoCreate && targetTableStrategy !== "existing_only") {
        setTargetTableStrategy("existing_only");
      }
      if (supportsAutoCreate && !createIndexes) {
        setCreateIndexes(true);
      } else if (!supportsAutoCreate && createIndexes) {
        setCreateIndexes(false);
      }
    } else {
      if (targetTableStrategy !== "existing_only") {
        setTargetTableStrategy("existing_only");
      }
      if (createIndexes) {
        setCreateIndexes(false);
      }
    }
  }, [
    isSchemaCompareEntry,
    isDataCompareEntry,
    workflowType,
    sourceDatasetMode,
    syncContent,
    syncMode,
    targetTableStrategy,
    createIndexes,
    migrationCapability?.supportsAutoCreate,
  ]);

  useEffect(() => {
    if (syncContent === "data" && autoAddColumns) {
      setAutoAddColumns(false);
    }
  }, [syncContent, autoAddColumns]);

  useEffect(() => {
    if (migrationCapability?.supportsAutoAddColumns === false && autoAddColumns) {
      setAutoAddColumns(false);
    }
  }, [migrationCapability?.supportsAutoAddColumns, autoAddColumns]);

  useEffect(() => {
    if (sourceDatasetMode !== "query") return;
    if (workflowType !== "sync") {
      setWorkflowType("sync");
    }
    if (syncContent !== "data") {
      setSyncContent("data");
    }
    if (targetTableStrategy !== "existing_only") {
      setTargetTableStrategy("existing_only");
    }
    if (createIndexes) {
      setCreateIndexes(false);
    }
    if (autoAddColumns) {
      setAutoAddColumns(false);
    }
    if (selectedTables.length > 1) {
      setSelectedTables(selectedTables.slice(0, 1));
    }
  }, [
    sourceDatasetMode,
    workflowType,
    syncContent,
    targetTableStrategy,
    createIndexes,
    autoAddColumns,
    selectedTables,
  ]);

  const handleSourceConnChange = async (connId: string) => {
    const requestSeq = ++sourceDatabaseRequestSeqRef.current;
    setSourceConnId(connId);
    setSourceDb("");
    setSourceDbs([]);
    setDiffTables([]);
    setAnalyzedFingerprint("");
    setTableOptions({});
    const conn = connections.find((c) => c.id === connId);
    if (conn) {
      setLoading(true);
      try {
        const res = await DBGetDatabases(normalizeConnConfig(conn) as any);
        if (requestSeq !== sourceDatabaseRequestSeqRef.current) return;
        const selection = resolveDataSyncDatabaseSelection(
          conn.config,
          res.success && Array.isArray(res.data) ? res.data : [],
        );
        setSourceDbs(selection.options);
        setSourceDb(selection.preferred);
      } catch (e: any) {
        if (requestSeq !== sourceDatabaseRequestSeqRef.current) return;
        const selection = resolveDataSyncDatabaseSelection(conn.config, []);
        setSourceDbs(selection.options);
        setSourceDb(selection.preferred);
        message.error(
          tr("data_sync.message.fetch_source_databases_failed_detail", {
            detail: e?.message || String(e),
          }),
        );
      } finally {
        if (requestSeq === sourceDatabaseRequestSeqRef.current) {
          setLoading(false);
        }
      }
    }
  };

  const handleTargetConnChange = async (connId: string) => {
    const requestSeq = ++targetDatabaseRequestSeqRef.current;
    setTargetConnId(connId);
    setTargetDb("");
    setTargetDbs([]);
    setTargetSchema("");
    setTargetSchemas([]);
    setTargetSchemaLoading(false);
    setDiffTables([]);
    setAnalyzedFingerprint("");
    setTableOptions({});
    const conn = connections.find((c) => c.id === connId);
    if (conn) {
      setLoading(true);
      try {
        const res = await DBGetDatabases(normalizeConnConfig(conn) as any);
        if (requestSeq !== targetDatabaseRequestSeqRef.current) return;
        const selection = resolveDataSyncDatabaseSelection(
          conn.config,
          res.success && Array.isArray(res.data) ? res.data : [],
        );
        setTargetDbs(selection.options);
        setTargetDb(selection.preferred);
      } catch (e: any) {
        if (requestSeq !== targetDatabaseRequestSeqRef.current) return;
        const selection = resolveDataSyncDatabaseSelection(conn.config, []);
        setTargetDbs(selection.options);
        setTargetDb(selection.preferred);
        message.error(
          tr("data_sync.message.fetch_target_databases_failed_detail", {
            detail: e?.message || String(e),
          }),
        );
      } finally {
        if (requestSeq === targetDatabaseRequestSeqRef.current) {
          setLoading(false);
        }
      }
    }
  };

  const ensureTargetSchemaSelected = (): boolean => {
    if (targetSupportsSchemaSelection && !String(targetSchema || "").trim()) {
      message.error(tr("data_sync.message.select_target_schema"));
      return false;
    }
    return true;
  };

  const nextToTables = async () => {
    if (!sourceConnId || !targetConnId) return message.error(tr('data_sync.message.select_connections_first'));
    if (!isSourceQueryMode && migrationCapabilityStatus === "loading") {
      return message.info(tr("data_sync.capability.loading"));
    }
    if (!isSourceQueryMode && migrationCapabilityStatus === "error") {
      return message.error(tr("data_sync.capability.load_failed"));
    }
    if (
      !isSourceQueryMode &&
      migrationCapability &&
      !migrationCapability.canExecute
    ) {
      return message.error(
        resolveDataSyncCapabilityPresentation(migrationCapability, tr).message,
      );
    }
    if (!sourceDb) return message.error(tr('data_sync.message.select_source_database'));
    if (!targetDb) return message.error(tr('data_sync.message.select_target_database'));
    if (!ensureTargetSchemaSelected()) return;

    setLoading(true);
    const requestSeq = ++tableMetadataRequestSeqRef.current;
    const requestFingerprint = currentTableEndpointFingerprint;
    try {
      const connId = isSourceQueryMode ? targetConnId : sourceConnId;
      const dbName = isSourceQueryMode ? targetDb : sourceDb;
      const conn = connections.find((c) => c.id === connId);
      if (conn) {
        const config = normalizeConnConfig(conn, dbName);
        const res = await DBGetTables(config as any, dbName);
        if (
          requestSeq !== tableMetadataRequestSeqRef.current ||
          requestFingerprint !== currentTableEndpointFingerprintRef.current
        ) {
          return;
        }
        if (res.success && !isTableMetadataIncomplete(res)) {
          const tables = normalizeTableNamesFromMetadataRows(res.data);
          const nextTables = (
            isSourceQueryMode && targetSupportsSchemaSelection && targetSchema
              ? filterTablesBySchema(tables as string[], targetSchema)
              : tables
          ) as string[];
          setAllTables(nextTables);
          setSelectedTables((prev) => {
            const existing = prev.filter((name) => nextTables.includes(name));
            if (isSourceQueryMode) {
              return existing.slice(0, 1);
            }
            return existing;
          });
          setCurrentStep(1);
        } else {
          const detail = getTableMetadataIssueDetail(res);
          const notify = res.success ? message.warning : message.error;
          notify(
            detail
              ? tr("data_sync.message.fetch_tables_failed_detail", {
                  detail,
                })
              : tr("data_sync.message.fetch_tables_failed"),
          );
        }
      }
    } catch (e: any) {
      if (
        requestSeq !== tableMetadataRequestSeqRef.current ||
        requestFingerprint !== currentTableEndpointFingerprintRef.current
      ) {
        return;
      }
      message.error(
        tr("data_sync.message.fetch_tables_failed_detail", {
          detail: e?.message || String(e),
        }),
      );
    } finally {
      if (requestSeq === tableMetadataRequestSeqRef.current) {
        setLoading(false);
      }
    }
  };

  const updateTableOption = (
    table: string,
    key: keyof TableOps,
    value: any,
  ) => {
    setTableOptions((prev) => ({
      ...prev,
      [table]: {
        ...(prev[table] || { insert: true, update: true, delete: false }),
        [key]: value,
      },
    }));
  };

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
      targetTableStrategy,
      createIndexes,
      mongoCollectionName,
      jobId,
    });

    try {
      const res = await DataSyncAnalyze(config as any);
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
      setAnalyzedFingerprint("");
      message.error(
        tr("data_sync.message.analysis_failed_detail", {
          detail: e?.message || String(e),
        }),
      );
    } finally {
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
      targetTableStrategy,
      createIndexes,
      mongoCollectionName,
    });

    try {
      const res = await DataSyncPreview(config as any, table, 200);
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
      message.error(
        tr("data_sync.message.preview_load_failed_detail", {
          detail: e?.message || String(e),
        }),
      );
    }

    setPreviewLoading(false);
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
        targetTableStrategy,
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

  const isSourceQueryMode = sourceDatasetMode === "query";
  const isMigrationWorkflow = !isCompareEntry && workflowType === "migration";
  const sourceConn = useMemo(
    () => connections.find((c) => c.id === sourceConnId),
    [connections, sourceConnId],
  );
  const targetConn = useMemo(
    () => connections.find((c) => c.id === targetConnId),
    [connections, targetConnId],
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
  const sourceType = String(sourceConn?.config?.type || "").toLowerCase();
  const targetType = String(targetConn?.config?.type || "").toLowerCase();
  const isRedisMongoKeyspaceMigration =
    isMigrationWorkflow &&
    ((sourceType === "redis" && targetType === "mongodb") ||
      (sourceType === "mongodb" && targetType === "redis"));

  useEffect(() => {
    if (!sourceConn || !targetConn) {
      setMigrationCapability(null);
      setMigrationCapabilityStatus("idle");
      return;
    }

    let cancelled = false;
    setMigrationCapability(null);
    setMigrationCapabilityStatus("loading");
    void DataSyncCapability(
      {
        type: String(sourceConn.config?.type || ""),
        driver: String(sourceConn.config?.driver || ""),
        oceanBaseProtocol: String(sourceConn.config?.oceanBaseProtocol || ""),
      } as any,
      {
        type: String(targetConn.config?.type || ""),
        driver: String(targetConn.config?.driver || ""),
        oceanBaseProtocol: String(targetConn.config?.oceanBaseProtocol || ""),
      } as any,
    )
      .then((capability) => {
        if (!cancelled) {
          setMigrationCapability(capability as DataSyncCapabilitySnapshot);
          setMigrationCapabilityStatus("ready");
        }
      })
      .catch(() => {
        if (!cancelled) {
          setMigrationCapability(null);
          setMigrationCapabilityStatus("error");
        }
      });

    return () => {
      cancelled = true;
    };
  }, [sourceConn, targetConn]);
  const defaultMongoCollectionName = useMemo(() => {
    if (sourceType === "redis" && targetType === "mongodb") {
      return `redis_db_${resolveRedisDbIndex(sourceDb || sourceConn?.config?.database)}_keys`;
    }
    if (sourceType === "mongodb" && targetType === "redis") {
      return (
        selectedTables[0] ||
        `redis_db_${resolveRedisDbIndex(targetDb || targetConn?.config?.database)}_keys`
      );
    }
    return "";
  }, [
    sourceType,
    targetType,
    sourceDb,
    targetDb,
    sourceConn,
    targetConn,
    selectedTables,
  ]);

  useEffect(() => {
    if (!targetConn || !targetDb || !targetSupportsSchemaSelection) {
      setTargetSchemas([]);
      setTargetSchema("");
      setTargetSchemaLoading(false);
      return;
    }

    let cancelled = false;
    setTargetSchema("");
    setTargetSchemas([]);
    setTargetSchemaLoading(true);

    (async () => {
      try {
        const result = await loadSchemas(targetConn, targetDb);
        if (cancelled) return;
        const normalizedSchemas = Array.from(
          new Map(
            (Array.isArray(result.schemas) ? result.schemas : [])
              .map((item) => String(item || "").trim())
              .filter((item) => item !== "")
              .map((item) => [item.toLowerCase(), item] as const),
          ).values(),
        );
        setTargetSchemas(normalizedSchemas);
        setTargetSchema(
          resolvePreferredTargetSchema(targetDialect, normalizedSchemas),
        );
      } catch (e: any) {
        if (cancelled) return;
        setTargetSchemas([]);
        setTargetSchema("");
        message.error(
          t(
            "data_sync.message.fetch_target_schemas_failed_detail",
            { detail: e?.message || String(e) },
            i18nLanguage,
          ),
        );
      } finally {
        if (!cancelled) {
          setTargetSchemaLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [targetConn, targetDb, targetDialect, targetSupportsSchemaSelection]);

  const modalPanelStyle = useMemo(
    () => ({
      background: darkMode
        ? "linear-gradient(180deg, rgba(16,22,34,0.96) 0%, rgba(10,14,24,0.98) 100%)"
        : "linear-gradient(180deg, rgba(255,255,255,0.98) 0%, rgba(246,248,252,0.98) 100%)",
      border: darkMode
        ? "1px solid rgba(255,255,255,0.08)"
        : "1px solid rgba(16,24,40,0.08)",
      boxShadow: darkMode
        ? "0 24px 56px rgba(0,0,0,0.36)"
        : "0 18px 44px rgba(15,23,42,0.14)",
      backdropFilter: resolveTextInputSafeBackdropFilter(
        darkMode ? "blur(18px)" : "none",
        disableLocalBackdropFilter,
      ),
    }),
    [darkMode, disableLocalBackdropFilter],
  );

  const shellCardStyle = useMemo<React.CSSProperties>(
    () => ({
      borderRadius: 18,
      border: darkMode
        ? "1px solid rgba(255,255,255,0.08)"
        : "1px solid rgba(15,23,42,0.08)",
      background: darkMode
        ? "rgba(255,255,255,0.03)"
        : `rgba(255,255,255,${Math.max(effectiveOpacity, 0.88)})`,
      boxShadow: darkMode
        ? "0 12px 32px rgba(0,0,0,0.22)"
        : "0 10px 24px rgba(15,23,42,0.08)",
      overflow: "hidden",
    }),
    [darkMode, effectiveOpacity],
  );

  const heroPanelStyle = useMemo<React.CSSProperties>(
    () => ({
      padding: 18,
      borderRadius: 18,
      border: darkMode
        ? "1px solid rgba(255,214,102,0.12)"
        : "1px solid rgba(24,144,255,0.12)",
      background: darkMode
        ? "linear-gradient(135deg, rgba(255,214,102,0.10) 0%, rgba(255,255,255,0.03) 100%)"
        : "linear-gradient(135deg, rgba(24,144,255,0.10) 0%, rgba(255,255,255,0.95) 100%)",
      marginBottom: 18,
    }),
    [darkMode],
  );

  const badgeStyle = useMemo<React.CSSProperties>(
    () => ({
      display: "inline-flex",
      alignItems: "center",
      gap: 6,
      padding: "6px 10px",
      borderRadius: 999,
      border: darkMode
        ? "1px solid rgba(255,255,255,0.10)"
        : "1px solid rgba(15,23,42,0.08)",
      background: darkMode
        ? "rgba(255,255,255,0.04)"
        : "rgba(255,255,255,0.86)",
      color: darkMode ? "rgba(255,255,255,0.88)" : "#334155",
      fontSize: 12,
      fontWeight: 600,
    }),
    [darkMode],
  );

  const quietPanelStyle = useMemo<React.CSSProperties>(
    () => ({
      padding: 14,
      borderRadius: 16,
      border: darkMode
        ? "1px solid rgba(255,255,255,0.08)"
        : "1px solid rgba(15,23,42,0.08)",
      background: darkMode
        ? "rgba(255,255,255,0.025)"
        : "rgba(248,250,252,0.92)",
    }),
    [darkMode],
  );

  const modalWorkspaceStyle = useMemo<React.CSSProperties>(
    () => ({
      display: "flex",
      flexDirection: "column",
      height: "100%",
      minHeight: 0,
    }),
    [],
  );

  const modalScrollableContentStyle = useMemo<React.CSSProperties>(
    () => ({
      flex: 1,
      minHeight: 0,
      overflowY: "auto",
      overflowX: "hidden",
      paddingRight: 4,
      overscrollBehavior: "contain",
    }),
    [],
  );

  const modalFooterBarStyle = useMemo<React.CSSProperties>(
    () => ({
      marginTop: 18,
      display: "flex",
      justifyContent: "flex-end",
      gap: 8,
      paddingTop: 12,
      borderTop: darkMode
        ? "1px solid rgba(255,255,255,0.06)"
        : "1px solid rgba(15,23,42,0.06)",
      flex: "0 0 auto",
    }),
    [darkMode],
  );

  const renderModalTitle = (title: string, description: string) => (
    <div
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 12,
        minWidth: 0,
      }}
    >
      <div
        style={{
          width: 38,
          height: 38,
          borderRadius: 14,
          display: "grid",
          placeItems: "center",
          background: darkMode
            ? "rgba(255,214,102,0.12)"
            : "rgba(24,144,255,0.10)",
          color: darkMode ? "#ffd666" : token.colorPrimary,
          flexShrink: 0,
        }}
      >
        {isMigrationWorkflow ? <RocketOutlined /> : <SwapOutlined />}
      </div>
      <div style={{ minWidth: 0 }}>
        <div
          style={{
            fontSize: 16,
            fontWeight: 700,
            color: darkMode ? "#f8fafc" : "#0f172a",
          }}
        >
          {title}
        </div>
        <div
          style={{
            marginTop: 4,
            fontSize: 12,
            lineHeight: 1.6,
            color: darkMode ? "rgba(255,255,255,0.56)" : "rgba(15,23,42,0.58)",
          }}
        >
          {description}
        </div>
      </div>
    </div>
  );

  const handleReturnToPrevious = () => {
    if (syncing) {
      message.warning(tr("data_sync.message.close_blocked_running"));
      return;
    }
    onBack?.();
  };

  const dataSyncContent = (
    <div style={modalWorkspaceStyle}>
      <div style={{ flex: "0 0 auto" }}>
        {!embedded && (
          <div style={heroPanelStyle}>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                gap: 12,
                alignItems: "flex-start",
                flexWrap: "wrap",
              }}
            >
              <div style={{ minWidth: 0 }}>
                <div
                  style={{
                    fontSize: 18,
                    fontWeight: 700,
                    color: darkMode ? "#f8fafc" : "#0f172a",
                  }}
                >
                  {isMigrationWorkflow
                    ? tr("data_sync.title.migration")
                    : isCompareEntry
                      ? entryPresentation.heroTitle
                      : tr("data_sync.title.sync")}
                </div>
                <div
                  style={{
                    marginTop: 6,
                    fontSize: 13,
                    lineHeight: 1.7,
                    color: darkMode
                      ? "rgba(255,255,255,0.62)"
                      : "rgba(15,23,42,0.62)",
                  }}
                >
                  {isMigrationWorkflow
                    ? tr("data_sync.title.migration_description")
                    : isCompareEntry
                      ? entryPresentation.heroDescription
                      : tr("data_sync.title.sync_description")}
                </div>
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                <span style={badgeStyle}>
                  {isMigrationWorkflow ? <RocketOutlined /> : <SwapOutlined />}{" "}
                  {isMigrationWorkflow
                    ? tr("data_sync.badge.migration_mode")
                    : isCompareEntry
                      ? entryPresentation.badgeText
                      : tr("data_sync.badge.sync_mode")}
                </span>
                <span style={badgeStyle}>
                  <DatabaseOutlined />{" "}
                  {sourceConnId
                    ? tr("data_sync.badge.source_selected")
                    : tr("data_sync.badge.source_pending")}
                </span>
                <span style={badgeStyle}>
                  <TableOutlined />{" "}
                  {tr("data_sync.badge.table_count", {
                    count: selectedTables.length || 0,
                  })}
                </span>
              </div>
            </div>
          </div>
        )}
        <Steps current={currentStep} style={{ marginBottom: 24 }}>
          <Step title={tr("data_sync.step.configure")} />
          <Step title={tr("data_sync.step.select_tables")} />
          <Step
            title={
              isCompareEntry
                ? entryPresentation.resultTitle
                : tr("data_sync.step.result")
            }
          />
        </Steps>
      </div>

      <div style={modalScrollableContentStyle}>
        {/* STEP 1: CONFIG */}
        {currentStep === 0 && (
          <div>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "minmax(0, 1fr) 44px minmax(0, 1fr)",
                gap: 18,
                alignItems: "stretch",
              }}
            >
              <Card
                title={tr("data_sync.title.source_database")}
                style={shellCardStyle}
                styles={{
                  header: {
                    borderBottom: darkMode
                      ? "1px solid rgba(255,255,255,0.08)"
                      : "1px solid rgba(15,23,42,0.06)",
                    fontWeight: 700,
                  },
                  body: { padding: 18 },
                }}
              >
                <Form layout="vertical">
                  <Form.Item label={tr("data_sync.field.connection")}>
                    <Select
                      value={sourceConnId}
                      onChange={handleSourceConnChange}
                    >
                      {connections.map((c) => (
                        <Option key={c.id} value={c.id}>
                          {c.name} ({c.config.type})
                        </Option>
                      ))}
                    </Select>
                  </Form.Item>
                  <Form.Item label={tr("data_sync.field.database")}>
                    {sourceDbs.length > 0 ? (
                      <Select value={sourceDb} onChange={setSourceDb} showSearch>
                        {sourceDbs.map((d) => (
                          <Option key={d} value={d}>
                            {d}
                          </Option>
                        ))}
                      </Select>
                    ) : (
                      <Input
                        value={sourceDb}
                        onChange={(event) => setSourceDb(event.target.value)}
                        placeholder={tr("data_sync.placeholder.database_manual")}
                      />
                    )}
                  </Form.Item>
                </Form>
              </Card>
              <div style={{ display: "grid", placeItems: "center" }}>
                <div
                  style={{
                    ...badgeStyle,
                    width: 44,
                    height: 44,
                    borderRadius: 14,
                    justifyContent: "center",
                    padding: 0,
                  }}
                >
                  <SwapOutlined />
                </div>
              </div>
              <Card
                title={tr("data_sync.title.target_database")}
                style={shellCardStyle}
                styles={{
                  header: {
                    borderBottom: darkMode
                      ? "1px solid rgba(255,255,255,0.08)"
                      : "1px solid rgba(15,23,42,0.06)",
                    fontWeight: 700,
                  },
                  body: { padding: 18 },
                }}
              >
                <Form layout="vertical">
                  <Form.Item label={tr("data_sync.field.connection")}>
                    <Select
                      value={targetConnId}
                      onChange={handleTargetConnChange}
                    >
                      {connections.map((c) => (
                        <Option key={c.id} value={c.id}>
                          {c.name} ({c.config.type})
                        </Option>
                      ))}
                    </Select>
                  </Form.Item>
                  <Form.Item label={tr("data_sync.field.database")}>
                    {targetDbs.length > 0 ? (
                      <Select value={targetDb} onChange={setTargetDb} showSearch>
                        {targetDbs.map((d) => (
                          <Option key={d} value={d}>
                            {d}
                          </Option>
                        ))}
                      </Select>
                    ) : (
                      <Input
                        value={targetDb}
                        onChange={(event) => setTargetDb(event.target.value)}
                        placeholder={tr("data_sync.placeholder.database_manual")}
                      />
                    )}
                  </Form.Item>
                  {targetSupportsSchemaSelection && (
                    <Form.Item label={tr("data_sync.field.schema")}>
                      <Select
                        value={targetSchema || undefined}
                        onChange={(value) =>
                          setTargetSchema(String(value || ""))
                        }
                        showSearch
                        allowClear
                        loading={targetSchemaLoading}
                        disabled={!targetDb}
                      >
                        {targetSchemas.map((schemaName) => (
                          <Option key={schemaName} value={schemaName}>
                            {schemaName}
                          </Option>
                        ))}
                      </Select>
                    </Form.Item>
                  )}
                </Form>
              </Card>
            </div>

            <Card
              title={
                isMigrationWorkflow
                  ? tr("data_sync.title.migration_options")
                  : isCompareEntry
                    ? entryPresentation.optionTitle
                    : tr("data_sync.title.sync_options")
              }
              style={{ ...shellCardStyle, marginTop: 18 }}
              styles={{
                header: {
                  borderBottom: darkMode
                    ? "1px solid rgba(255,255,255,0.08)"
                    : "1px solid rgba(15,23,42,0.06)",
                  fontWeight: 700,
                },
                body: { padding: 18 },
              }}
            >
              <div style={{ ...quietPanelStyle, marginBottom: 14 }}>
                <Text
                  style={{
                    color: darkMode
                      ? "rgba(255,255,255,0.72)"
                      : "rgba(15,23,42,0.68)",
                    lineHeight: 1.7,
                  }}
                >
                  {isCompareEntry
                    ? tr("data_sync.compare_entry.workflow_help")
                    : tr("data_sync.help.workflow_type")}
                </Text>
              </div>
              <Form layout="vertical">
                {!isCompareEntry && (
                  <Form.Item label={tr("data_sync.field.workflow_type")}>
                    <Select value={workflowType} onChange={setWorkflowType}>
                      <Option value="sync">
                        {tr("data_sync.option.workflow.sync")}
                      </Option>
                      <Option value="migration" disabled={isSourceQueryMode}>
                        {tr("data_sync.option.workflow.migration")}
                      </Option>
                    </Select>
                  </Form.Item>
                )}
                {!isSchemaCompareEntry && (
                  <Form.Item label={tr("data_sync.field.source_dataset_mode")}>
                    <Select
                      value={sourceDatasetMode}
                      onChange={setSourceDatasetMode}
                    >
                      <Option value="table">
                        {isCompareEntry
                          ? tr(
                              "data_sync.compare_entry.option.source_dataset.table",
                            )
                          : tr("data_sync.option.source_dataset.table")}
                      </Option>
                      <Option value="query">
                        {isCompareEntry
                          ? tr(
                              "data_sync.compare_entry.option.source_dataset.query",
                            )
                          : tr("data_sync.option.source_dataset.query")}
                      </Option>
                    </Select>
                  </Form.Item>
                )}
                <Alert
                  type={
                    isMigrationWorkflow || isCompareEntry ? "info" : "success"
                  }
                  showIcon
                  style={{ marginBottom: 12 }}
                  message={
                    isMigrationWorkflow
                      ? tr("data_sync.alert.migration_mode")
                      : isSchemaCompareEntry
                        ? tr("data_sync.compare_entry.alert.schema")
                        : isDataCompareEntry
                          ? tr("data_sync.compare_entry.alert.data")
                          : tr("data_sync.alert.sync_mode")
                  }
                />
                {isSourceQueryMode && (
                  <Alert
                    type="info"
                    showIcon
                    style={{ marginBottom: 12 }}
                    message={tr("data_sync.alert.query_mode")}
                  />
                )}
                {!isCompareEntry && (
                  <Form.Item
                    label={
                      isMigrationWorkflow
                        ? tr("data_sync.field.migration_content")
                        : tr("data_sync.field.sync_content")
                    }
                  >
                    <Select value={syncContent} onChange={setSyncContent}>
                      <Option value="data">
                        {tr("data_sync.option.content.data")}
                      </Option>
                      <Option value="schema" disabled={isSourceQueryMode}>
                        {tr("data_sync.option.content.schema")}
                      </Option>
                      <Option value="both" disabled={isSourceQueryMode}>
                        {tr("data_sync.option.content.both")}
                      </Option>
                    </Select>
                  </Form.Item>
                )}
                {!isCompareEntry && (
                  <Form.Item
                    label={
                      isMigrationWorkflow
                        ? tr("data_sync.field.migration_mode")
                        : tr("data_sync.field.sync_mode")
                    }
                  >
                    <Select
                      value={syncMode}
                      onChange={setSyncMode}
                      disabled={syncContent === "schema"}
                    >
                      <Option value="insert_update">
                        {tr("data_sync.option.sync_mode.insert_update")}
                      </Option>
                      <Option value="insert_only">
                        {tr("data_sync.option.sync_mode.insert_only")}
                      </Option>
                      <Option value="full_overwrite">
                        {tr("data_sync.option.sync_mode.full_overwrite")}
                      </Option>
                    </Select>
                  </Form.Item>
                )}
                {!isCompareEntry && (
                  <Form.Item
                    label={
                      isMigrationWorkflow
                        ? tr("data_sync.field.target_table_strategy")
                        : tr("data_sync.field.target_table_requirement")
                    }
                  >
                    <Select
                      value={targetTableStrategy}
                      onChange={setTargetTableStrategy}
                      disabled={
                        !isMigrationWorkflow ||
                        isSourceQueryMode ||
                        migrationCapabilityStatus !== "ready" ||
                        capabilityPresentation?.forceExistingTarget === true
                      }
                    >
                      <Option value="existing_only">
                        {tr("data_sync.option.target_strategy.existing_only")}
                      </Option>
                      <Option
                        value="auto_create_if_missing"
                        disabled={migrationCapability?.supportsAutoCreate !== true}
                      >
                        {tr(
                          "data_sync.option.target_strategy.auto_create_if_missing",
                        )}
                      </Option>
                      <Option
                        value="smart"
                        disabled={migrationCapability?.supportsAutoCreate !== true}
                      >
                        {tr("data_sync.option.target_strategy.smart")}
                      </Option>
                    </Select>
                  </Form.Item>
                )}
                {isRedisMongoKeyspaceMigration && (
                  <Form.Item
                    label={tr("data_sync.field.mongo_collection_name")}
                    extra={
                      sourceType === "redis"
                        ? tr("data_sync.help.mongo_collection_redis_to_mongo")
                        : tr("data_sync.help.mongo_collection_mongo_to_redis")
                    }
                  >
                    <Input
                      value={mongoCollectionName}
                      onChange={(e) => setMongoCollectionName(e.target.value)}
                      placeholder={
                        defaultMongoCollectionName ||
                        tr("data_sync.placeholder.mongo_collection_name")
                      }
                      allowClear
                      maxLength={128}
                    />
                  </Form.Item>
                )}
                {(!isCompareEntry || isSchemaCompareEntry) && (
                  <Form.Item>
                    <Checkbox
                      checked={autoAddColumns}
                      onChange={(e) => setAutoAddColumns(e.target.checked)}
                      disabled={
                        isSourceQueryMode ||
                        syncContent === "data" ||
                        migrationCapability?.supportsAutoAddColumns !== true
                      }
                    >
                      {isSchemaCompareEntry
                        ? tr("data_sync.compare_entry.option.auto_add_columns")
                        : tr("data_sync.option.auto_add_columns")}
                    </Checkbox>
                  </Form.Item>
                )}
                {!isCompareEntry && (
                  <Form.Item>
                    <Checkbox
                      checked={createIndexes}
                      onChange={(e) => setCreateIndexes(e.target.checked)}
                      disabled={
                        !isMigrationWorkflow ||
                        targetTableStrategy === "existing_only" ||
                        isSourceQueryMode ||
                        migrationCapability?.supportsAutoCreate !== true
                      }
                    >
                      {tr("data_sync.option.create_indexes")}
                    </Checkbox>
                  </Form.Item>
                )}
                {!isSourceQueryMode && capabilityStatusPresentation && (
                  <Alert
                    type={capabilityStatusPresentation.alertType}
                    showIcon
                    message={capabilityStatusPresentation.message}
                    style={{ marginBottom: 12 }}
                  />
                )}
                {!isSourceQueryMode &&
                  capabilityPresentation &&
                  (isMigrationWorkflow ||
                    capabilityPresentation.blocksExecution) && (
                    <Alert
                      type={capabilityPresentation.alertType}
                      showIcon
                      message={capabilityPresentation.message}
                      style={{ marginBottom: 12 }}
                    />
                  )}
                {isMigrationWorkflow &&
                  !capabilityPresentation &&
                  targetTableStrategy !== "existing_only" && (
                    <Alert
                      type="info"
                      showIcon
                      message={tr("data_sync.alert.auto_create_planner_scope")}
                      style={{ marginBottom: 12 }}
                    />
                  )}
                {!isCompareEntry &&
                  !isMigrationWorkflow &&
                  !capabilityPresentation?.blocksExecution && (
                    <Alert
                      type="info"
                      showIcon
                      message={tr("data_sync.alert.existing_target_only")}
                      style={{ marginBottom: 12 }}
                    />
                  )}
                {syncContent !== "schema" && syncMode === "full_overwrite" && (
                  <Alert
                    type="warning"
                    showIcon
                    message={tr("data_sync.alert.full_overwrite")}
                  />
                )}
              </Form>
            </Card>
          </div>
        )}

        {/* STEP 2: TABLES */}
        {currentStep === 1 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div style={quietPanelStyle}>
              {!isSourceQueryMode && (
                <>
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      marginBottom: 10,
                    }}
                  >
                    <Text type="secondary">
                      {isCompareEntry
                        ? entryPresentation.tableSelectLabel
                        : tr("data_sync.help.select_tables")}
                    </Text>
                    <Checkbox
                      checked={showSameTables}
                      onChange={(e) => setShowSameTables(e.target.checked)}
                    >
                      {tr("data_sync.option.show_same_tables")}
                    </Checkbox>
                  </div>
                  <Transfer
                    dataSource={allTables.map((t) => ({ key: t, title: t }))}
                    titles={[
                      tr("data_sync.transfer.source_tables"),
                      tr("data_sync.transfer.selected_tables"),
                    ]}
                    targetKeys={selectedTables}
                    onChange={(keys) => setSelectedTables(keys as string[])}
                    render={(item) => item.title}
                    listStyle={{
                      width: 390,
                      height: 320,
                      marginTop: 0,
                      borderRadius: 14,
                      overflow: "hidden",
                    }}
                    locale={{
                      itemUnit: tr("data_sync.transfer.item_unit"),
                      itemsUnit: tr("data_sync.transfer.items_unit"),
                      searchPlaceholder: tr(
                        "data_sync.transfer.search_placeholder",
                      ),
                      notFoundContent: tr("data_sync.transfer.empty"),
                    }}
                  />
                </>
              )}
              {isSourceQueryMode && (
                <Form layout="vertical">
                  <Alert
                    type="info"
                    showIcon
                    style={{ marginBottom: 12 }}
                    message={tr("data_sync.help.source_query_mode")}
                  />
                  <Form.Item label={tr("data_sync.field.source_query_sql")}>
                    <TextArea
                      value={sourceQuery}
                      onChange={(e) => setSourceQuery(e.target.value)}
                      rows={8}
                      placeholder={tr("data_sync.placeholder.source_query_sql")}
                      spellCheck={false}
                    />
                  </Form.Item>
                  <Form.Item label={tr("data_sync.field.target_table")}>
                    <Select
                      value={selectedTables[0]}
                      onChange={(value) =>
                        setSelectedTables(value ? [value] : [])
                      }
                      showSearch
                      allowClear
                      placeholder={tr("data_sync.placeholder.target_table")}
                      optionFilterProp="children"
                    >
                      {allTables.map((table) => (
                        <Option key={table} value={table}>
                          {table}
                        </Option>
                      ))}
                    </Select>
                  </Form.Item>
                </Form>
              )}
            </div>

            {diffTables.length > 0 && (
              <div style={quietPanelStyle}>
                <Divider orientation="left" style={{ marginTop: 0 }}>
                  {tr("data_sync.title.compare_result")}
                </Divider>
                {analysisWarnings.length > 0 && (
                  <Alert
                    type="warning"
                    showIcon
                    message={tr("data_sync.message.precheck_warnings")}
                    description={
                      <ul style={{ margin: 0, paddingLeft: 18 }}>
                        {analysisWarnings.slice(0, 8).map((item) => (
                          <li key={item}>{item}</li>
                        ))}
                        {analysisWarnings.length > 8 && (
                          <li>
                            {tr("data_sync.message.more_items_collapsed", {
                              count: analysisWarnings.length - 8,
                            })}
                          </li>
                        )}
                      </ul>
                    }
                    style={{ marginBottom: 12 }}
                  />
                )}
                <Table
                  size="small"
                  pagination={false}
                  rowKey={(r: any) => r.table}
                  dataSource={diffTables.filter((t) => {
                    const ins = Number(t.inserts || 0);
                    const upd = Number(t.updates || 0);
                    const del = Number(t.deletes || 0);
                    const same = Number(t.same || 0);
                    const msg = String(t.message || "").trim();
                    const can = !!t.canSync;
                    const warns = Array.isArray(t.warnings)
                      ? t.warnings.length
                      : 0;
                    const unsupported = Array.isArray(t.unsupportedObjects)
                      ? t.unsupportedObjects.length
                      : 0;
                    if (showSameTables) return true;
                    if (!can) return true;
                    if (msg || warns > 0 || unsupported > 0) return true;
                    return ins > 0 || upd > 0 || del > 0 || same === 0;
                  })}
                  columns={[
                    {
                      title: tr("data_sync.table.table_name"),
                      dataIndex: "table",
                      key: "table",
                      ellipsis: true,
                    },
                    {
                      title: tr("data_sync.table.target_table"),
                      key: "targetTableExists",
                      width: 90,
                      render: (_: any, r: any) =>
                        r.targetTableExists
                          ? tr("data_sync.table.target_exists")
                          : tr("data_sync.table.target_missing"),
                    },
                    {
                      title: tr("data_sync.table.plan"),
                      dataIndex: "plannedAction",
                      key: "plannedAction",
                      width: 220,
                      ellipsis: true,
                      render: (v: any) => String(v || ""),
                    },
                    {
                      title: tr("data_sync.table.insert"),
                      key: "inserts",
                      width: 90,
                      render: (_: any, r: any) => {
                        const ops = tableOptions[r.table] || {
                          insert: true,
                          update: true,
                          delete: false,
                        };
                        const disabled =
                          !r.canSync ||
                          analyzing ||
                          Number(r.inserts || 0) === 0;
                        return (
                          <Checkbox
                            checked={!!ops.insert}
                            disabled={disabled}
                            onChange={(e) =>
                              updateTableOption(
                                r.table,
                                "insert",
                                e.target.checked,
                              )
                            }
                          >
                            {Number(r.inserts || 0)}
                          </Checkbox>
                        );
                      },
                    },
                    {
                      title: tr("data_sync.table.update"),
                      key: "updates",
                      width: 90,
                      render: (_: any, r: any) => {
                        const ops = tableOptions[r.table] || {
                          insert: true,
                          update: true,
                          delete: false,
                        };
                        const disabled =
                          !r.canSync ||
                          analyzing ||
                          Number(r.updates || 0) === 0;
                        return (
                          <Checkbox
                            checked={!!ops.update}
                            disabled={disabled}
                            onChange={(e) =>
                              updateTableOption(
                                r.table,
                                "update",
                                e.target.checked,
                              )
                            }
                          >
                            {Number(r.updates || 0)}
                          </Checkbox>
                        );
                      },
                    },
                    {
                      title: tr("data_sync.table.delete"),
                      key: "deletes",
                      width: 90,
                      render: (_: any, r: any) => {
                        const ops = tableOptions[r.table] || {
                          insert: true,
                          update: true,
                          delete: false,
                        };
                        const disabled =
                          !r.canSync ||
                          analyzing ||
                          Number(r.deletes || 0) === 0;
                        return (
                          <Checkbox
                            checked={!!ops.delete}
                            disabled={disabled}
                            onChange={(e) =>
                              updateTableOption(
                                r.table,
                                "delete",
                                e.target.checked,
                              )
                            }
                          >
                            {Number(r.deletes || 0)}
                          </Checkbox>
                        );
                      },
                    },
                    {
                      title: tr("data_sync.table.same"),
                      dataIndex: "same",
                      key: "same",
                      width: 70,
                      render: (v: any) => Number(v || 0),
                    },
                    {
                      title: tr("data_sync.table.risk"),
                      key: "warnings",
                      width: 220,
                      render: (_: any, r: any) => {
                        const warns = [
                          ...(Array.isArray(r.warnings) ? r.warnings : []),
                          ...(Array.isArray(r.unsupportedObjects)
                            ? r.unsupportedObjects
                            : []),
                        ];
                        if (warns.length === 0) return "-";
                        return (
                          <div
                            style={{
                              color: "#d48806",
                              fontSize: 12,
                              lineHeight: 1.5,
                            }}
                          >
                            {warns.slice(0, 2).map((item: string) => (
                              <div key={item}>{item}</div>
                            ))}
                            {warns.length > 2 && (
                              <div>
                                {tr("data_sync.message.more_items_collapsed", {
                                  count: warns.length - 2,
                                })}
                              </div>
                            )}
                          </div>
                        );
                      },
                    },
                    {
                      title: tr("data_sync.table.preview"),
                      key: "preview",
                      width: 80,
                      render: (_: any, r: any) => {
                        const can = !!r.canSync;
                        const hasDiff =
                          Number(r.inserts || 0) +
                            Number(r.updates || 0) +
                            Number(r.deletes || 0) >
                          0;
                        const hasSchemaDiff =
                          Number(r.schemaDiffCount || 0) > 0;
                        return (
                          <Button
                            size="small"
                            disabled={
                              !can || !(hasDiff || hasSchemaDiff) || analyzing
                            }
                            onClick={() => openPreview(r.table)}
                          >
                            {tr("data_sync.action.view")}
                          </Button>
                        );
                      },
                    },
                  ]}
                />
              </div>
            )}
          </div>
        )}

        {/* STEP 3: RESULT */}
        {currentStep === 2 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div style={quietPanelStyle}>
              <Alert
                message={
                  syncing
                    ? isCompareEntry
                      ? tr("data_sync.compare_entry.result.running")
                      : tr("data_sync.result.running")
                    : syncResult?.success
                      ? isCompareEntry
                        ? tr("data_sync.compare_entry.result.completed")
                        : tr("data_sync.result.completed")
                      : isCompareEntry
                        ? tr("data_sync.compare_entry.result.failed")
                        : tr("data_sync.result.failed")
                }
                description={
                  syncing
                    ? isCompareEntry
                      ? tr(
                          "data_sync.compare_entry.result.running_description",
                          {
                            stage:
                              syncProgress.stage ||
                              tr(
                                "data_sync.compare_entry.result.stage_fallback",
                              ),
                            table: syncProgress.table
                              ? tr(
                                  "data_sync.compare_entry.result.table_suffix",
                                  { table: syncProgress.table },
                                )
                              : "",
                          },
                        )
                      : tr("data_sync.result.running_description", {
                          stage:
                            syncProgress.stage ||
                            tr("data_sync.progress.stage.executing"),
                          table: syncProgress.table
                            ? tr("data_sync.result.table_suffix", {
                                table: syncProgress.table,
                              })
                            : "",
                        })
                    : syncResult?.message ||
                      (isCompareEntry
                        ? tr("data_sync.compare_entry.result.success_summary", {
                            tables:
                              diffTables.length ||
                              syncResult?.tablesSynced ||
                              0,
                          })
                        : tr("data_sync.result.success_summary", {
                            tables: syncResult?.tablesSynced || 0,
                            inserted: syncResult?.rowsInserted || 0,
                            updated: syncResult?.rowsUpdated || 0,
                          }))
                }
                type={
                  syncing ? "info" : syncResult?.success ? "success" : "error"
                }
                showIcon
              />

              <div style={{ marginTop: 14 }}>
                <Progress
                  percent={syncProgress.percent}
                  status={
                    syncing
                      ? "active"
                      : syncResult?.success
                        ? "success"
                        : "exception"
                  }
                  format={() => `${syncProgress.current}/${syncProgress.total}`}
                />
              </div>
            </div>
            <div style={quietPanelStyle}>
              <Divider orientation="left" style={{ marginTop: 0 }}>
                {isCompareEntry
                  ? tr("data_sync.compare_entry.title.analysis_log")
                  : tr("data_sync.title.execution_log")}
              </Divider>
              <div
                ref={logBoxRef}
                onScroll={() => {
                  const el = logBoxRef.current;
                  if (!el) return;
                  const nearBottom =
                    el.scrollHeight - el.scrollTop - el.clientHeight < 40;
                  autoScrollRef.current = nearBottom;
                }}
                style={{
                  background: darkMode
                    ? "rgba(255,255,255,0.03)"
                    : "rgba(248,250,252,0.92)",
                  border: darkMode
                    ? "1px solid rgba(255,255,255,0.08)"
                    : "1px solid rgba(15,23,42,0.06)",
                  borderRadius: 14,
                  padding: 12,
                  height: 300,
                  overflowY: "auto",
                  fontFamily: "var(--gn-font-mono)",
                }}
              >
                {syncLogs.map((item, i: number) => (
                  <div key={i}>{renderSyncLogItem(item)}</div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>

      <div style={modalFooterBarStyle}>
        {currentStep === 0 && (
          <Button
            type="primary"
            onClick={nextToTables}
            loading={loading}
            disabled={
              !isSourceQueryMode &&
              (migrationCapabilityStatus === "loading" ||
                migrationCapabilityStatus === "error" ||
                capabilityPresentation?.blocksExecution === true)
            }
          >
            {tr("data_sync.action.next")}
          </Button>
        )}
        {currentStep === 1 && (
          <>
            <Button
              onClick={() => setCurrentStep(0)}
              style={{ marginRight: 8 }}
            >
              {tr("data_sync.action.previous")}
            </Button>
            <Button
              onClick={analyzeDiff}
              loading={loading}
              disabled={
                (isCompareEntry ? false : syncContent === "schema") ||
                selectedTables.length === 0 ||
                analyzing ||
                (!isSourceQueryMode && migrationCapabilityStatus !== "ready") ||
                (!isSourceQueryMode && capabilityPresentation?.blocksExecution === true) ||
                (isSourceQueryMode && !sourceQuery.trim())
              }
              style={{ marginRight: 8 }}
            >
              {isCompareEntry
                ? entryPresentation.analyzeButtonText
                : tr("data_sync.action.analyze_diff")}
            </Button>
            {isCompareEntry && (
              <Button onClick={onClose}>
                {entryPresentation.closeButtonText}
              </Button>
            )}
            {!isCompareEntry && (
              <Button
                type="primary"
                onClick={runSync}
                loading={loading}
                disabled={
                  selectedTables.length === 0 ||
                  (isSourceQueryMode && !sourceQuery.trim()) ||
                  (!isSourceQueryMode && migrationCapabilityStatus !== "ready") ||
                  (!isSourceQueryMode && capabilityPresentation?.blocksExecution === true) ||
                  !executionReadiness.ready
                }
              >
                {tr("data_sync.action.start_sync")}
              </Button>
            )}
          </>
        )}
        {currentStep === 2 && (
          <>
            <Button
              disabled={syncing}
              onClick={() => setCurrentStep(1)}
              style={{ marginRight: 8 }}
            >
              {isCompareEntry
                ? tr("data_sync.compare_entry.action.return_to_compare")
                : tr("data_sync.action.continue_sync")}
            </Button>
            <Button type="primary" disabled={syncing} onClick={onClose}>
              {isCompareEntry
                ? entryPresentation.closeButtonText
                : tr("data_sync.action.close")}
            </Button>
          </>
        )}
        {onBack ? (
          <Button onClick={handleReturnToPrevious}>
            {tr("common.back_to_previous")}
          </Button>
        ) : null}
      </div>
    </div>
  );

  return (
    <>
      {embedded ? (
        dataSyncContent
      ) : (
        <Modal
          title={renderModalTitle(
            isMigrationWorkflow
              ? tr("data_sync.title.migration_workbench")
              : isCompareEntry
                ? entryPresentation.title
                : tr("data_sync.title.sync_workbench"),
            isMigrationWorkflow
              ? tr("data_sync.title.migration_description")
              : isCompareEntry
                ? entryPresentation.description
                : tr("data_sync.title.sync_description"),
          )}
          open={open}
          onCancel={() => {
            if (syncing) {
              message.warning(tr("data_sync.message.close_blocked_running"));
              return;
            }
            onClose();
          }}
          width={920}
          footer={null}
          destroyOnHidden
          closable={!syncing}
          maskClosable={!syncing}
          styles={{
            content: modalPanelStyle,
            header: {
              background: "transparent",
              borderBottom: "none",
              paddingBottom: 10,
            },
            body: {
              paddingTop: 8,
              height: 760,
              maxHeight: "calc(100vh - 120px)",
              overflow: "hidden",
              display: "flex",
              flexDirection: "column",
            },
            footer: {
              background: "transparent",
              borderTop: "none",
              paddingTop: 12,
            },
          }}
        >
          {dataSyncContent}
        </Modal>
      )}
      <Drawer
        title={tr("data_sync.preview.title", { table: previewTable })}
        styles={{
          body: { background: darkMode ? "rgba(9,13,20,0.98)" : "#f8fafc" },
        }}
        open={previewOpen}
        onClose={() => {
          setPreviewOpen(false);
          setPreviewTable("");
          setPreviewData(null);
        }}
        width={900}
      >
        {previewLoading && (
          <Alert
            type="info"
            showIcon
            message={tr("data_sync.preview.loading")}
          />
        )}
        {!previewLoading && previewData && (
          <div>
            <Alert
              type="info"
              showIcon
              message={
                previewHasDataDiff
                  ? tr("data_sync.preview.data_summary", {
                      inserts: previewData.totalInserts || 0,
                      updates: previewData.totalUpdates || 0,
                      deletes: previewData.totalDeletes || 0,
                    })
                  : previewData.schemaSummary ||
                    tr("data_sync.preview.schema_statement_count", {
                      count: previewSql.statementCount,
                    })
              }
            />
            {previewSchemaWarnings.length > 0 && (
              <Alert
                style={{ marginTop: 12 }}
                type="warning"
                showIcon
                message={tr("data_sync.preview.schema_warning_title")}
                description={
                  <ul style={{ margin: 0, paddingLeft: 18 }}>
                    {previewSchemaWarnings.slice(0, 8).map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                    {previewSchemaWarnings.length > 8 && (
                      <li>
                        {tr("data_sync.message.more_items_collapsed", {
                          count: previewSchemaWarnings.length - 8,
                        })}
                      </li>
                    )}
                  </ul>
                }
              />
            )}
            <Divider />
            <Tabs
              items={[
                ...(previewHasSchemaStatements
                  ? [
                      {
                        key: "schema",
                        label: tr("data_sync.preview.tab.schema", {
                          count: Array.isArray(previewData.schemaStatements)
                            ? previewData.schemaStatements.length
                            : 0,
                        }),
                        children: (
                          <div>
                            <Text type="secondary">
                              {previewData.schemaSummary ||
                                tr("data_sync.preview.schema_plan_help")}
                            </Text>
                            <pre
                              style={{
                                marginTop: 8,
                                marginBottom: 0,
                                padding: 10,
                                border: "1px solid #f0f0f0",
                                borderRadius: 6,
                                background: "#fafafa",
                                maxHeight: 420,
                                overflow: "auto",
                                whiteSpace: "pre-wrap",
                                wordBreak: "break-word",
                              }}
                            >
                              {Array.isArray(previewData.schemaStatements) &&
                              previewData.schemaStatements.length > 0
                                ? previewData.schemaStatements.join("\n")
                                : tr("data_sync.preview.sql.no_schema_changes")}
                            </pre>
                          </div>
                        ),
                      },
                    ]
                  : []),
                ...(previewHasDataDiff
                  ? [
                      {
                        key: "insert",
                        label: tr("data_sync.preview.tab.insert", {
                          count: previewData.totalInserts || 0,
                        }),
                        children: (
                          <div>
                            <Text type="secondary">
                              {isCompareEntry
                                ? tr(
                                    "data_sync.compare_entry.preview.selection_hint",
                                  )
                                : tr("data_sync.preview.selection_hint.insert")}
                            </Text>
                            <Table
                              size="small"
                              style={{ marginTop: 8 }}
                              rowKey={(r: any) => r.pk}
                              dataSource={(previewData.inserts || []).map(
                                (r: any) => ({ ...r, key: r.pk }),
                              )}
                              pagination={false}
                              rowSelection={{
                                selectedRowKeys: (tableOptions[previewTable]
                                  ?.selectedInsertPks || []) as any,
                                onChange: (keys) =>
                                  updateTableOption(
                                    previewTable,
                                    "selectedInsertPks",
                                    keys as string[],
                                  ),
                                getCheckboxProps: () => ({
                                  disabled: !tableOptions[previewTable]?.insert,
                                }),
                              }}
                              columns={[
                                {
                                  title:
                                    previewData.pkColumn ||
                                    tr("data_sync.preview.column.primary_key"),
                                  dataIndex: "pk",
                                  key: "pk",
                                  width: 200,
                                  ellipsis: true,
                                },
                                {
                                  title: tr("data_sync.preview.column.data"),
                                  dataIndex: "row",
                                  key: "row",
                                  render: (v: any) => (
                                    <pre
                                      style={{
                                        margin: 0,
                                        maxHeight: 140,
                                        overflow: "auto",
                                      }}
                                    >
                                      {JSON.stringify(v, null, 2)}
                                    </pre>
                                  ),
                                },
                              ]}
                            />
                          </div>
                        ),
                      },
                      {
                        key: "update",
                        label: tr("data_sync.preview.tab.update", {
                          count: previewData.totalUpdates || 0,
                        }),
                        children: (
                          <div>
                            <Text type="secondary">
                              {isCompareEntry
                                ? tr(
                                    "data_sync.compare_entry.preview.selection_hint",
                                  )
                                : tr("data_sync.preview.selection_hint.update")}
                            </Text>
                            <Table
                              size="small"
                              style={{ marginTop: 8 }}
                              rowKey={(r: any) => r.pk}
                              dataSource={(previewData.updates || []).map(
                                (r: any) => ({ ...r, key: r.pk }),
                              )}
                              pagination={false}
                              rowSelection={{
                                selectedRowKeys: (tableOptions[previewTable]
                                  ?.selectedUpdatePks || []) as any,
                                onChange: (keys) =>
                                  updateTableOption(
                                    previewTable,
                                    "selectedUpdatePks",
                                    keys as string[],
                                  ),
                                getCheckboxProps: () => ({
                                  disabled: !tableOptions[previewTable]?.update,
                                }),
                              }}
                              columns={[
                                {
                                  title:
                                    previewData.pkColumn ||
                                    tr("data_sync.preview.column.primary_key"),
                                  dataIndex: "pk",
                                  key: "pk",
                                  width: 200,
                                  ellipsis: true,
                                },
                                {
                                  title: tr(
                                    "data_sync.preview.column.changed_columns",
                                  ),
                                  dataIndex: "changedColumns",
                                  key: "changedColumns",
                                  render: (v: any) =>
                                    Array.isArray(v) ? v.join(", ") : "",
                                },
                                {
                                  title: tr("data_sync.preview.column.detail"),
                                  key: "detail",
                                  width: 80,
                                  render: (_: any, r: any) => (
                                    <Button
                                      size="small"
                                      onClick={() => {
                                        Modal.info({
                                          title: tr(
                                            "data_sync.preview.update_detail_title",
                                            { table: previewTable, pk: r.pk },
                                          ),
                                          width: 900,
                                          content: (
                                            <div
                                              style={{
                                                display: "flex",
                                                gap: 12,
                                              }}
                                            >
                                              <div style={{ flex: 1 }}>
                                                <Title level={5}>
                                                  {tr(
                                                    "data_sync.preview.side.source",
                                                  )}
                                                </Title>
                                                <pre
                                                  style={{
                                                    maxHeight: 360,
                                                    overflow: "auto",
                                                    background: "#f5f5f5",
                                                    padding: 8,
                                                  }}
                                                >
                                                  {JSON.stringify(
                                                    r.source,
                                                    null,
                                                    2,
                                                  )}
                                                </pre>
                                              </div>
                                              <div style={{ flex: 1 }}>
                                                <Title level={5}>
                                                  {tr(
                                                    "data_sync.preview.side.target",
                                                  )}
                                                </Title>
                                                <pre
                                                  style={{
                                                    maxHeight: 360,
                                                    overflow: "auto",
                                                    background: "#f5f5f5",
                                                    padding: 8,
                                                  }}
                                                >
                                                  {JSON.stringify(
                                                    r.target,
                                                    null,
                                                    2,
                                                  )}
                                                </pre>
                                              </div>
                                            </div>
                                          ),
                                        });
                                      }}
                                    >
                                      {tr("data_sync.action.view")}
                                    </Button>
                                  ),
                                },
                              ]}
                            />
                          </div>
                        ),
                      },
                      {
                        key: "delete",
                        label: tr("data_sync.preview.tab.delete", {
                          count: previewData.totalDeletes || 0,
                        }),
                        children: (
                          <div>
                            <Alert
                              type="warning"
                              showIcon
                              message={tr("data_sync.preview.delete_warning")}
                            />
                            <Text type="secondary">
                              {isCompareEntry
                                ? tr(
                                    "data_sync.compare_entry.preview.selection_hint",
                                  )
                                : tr("data_sync.preview.selection_hint.delete")}
                            </Text>
                            <Table
                              size="small"
                              style={{ marginTop: 8 }}
                              rowKey={(r: any) => r.pk}
                              dataSource={(previewData.deletes || []).map(
                                (r: any) => ({ ...r, key: r.pk }),
                              )}
                              pagination={false}
                              rowSelection={{
                                selectedRowKeys: (tableOptions[previewTable]
                                  ?.selectedDeletePks || []) as any,
                                onChange: (keys) =>
                                  updateTableOption(
                                    previewTable,
                                    "selectedDeletePks",
                                    keys as string[],
                                  ),
                                getCheckboxProps: () => ({
                                  disabled: !tableOptions[previewTable]?.delete,
                                }),
                              }}
                              columns={[
                                {
                                  title:
                                    previewData.pkColumn ||
                                    tr("data_sync.preview.column.primary_key"),
                                  dataIndex: "pk",
                                  key: "pk",
                                  width: 200,
                                  ellipsis: true,
                                },
                                {
                                  title: tr("data_sync.preview.column.data"),
                                  dataIndex: "row",
                                  key: "row",
                                  render: (v: any) => (
                                    <pre
                                      style={{
                                        margin: 0,
                                        maxHeight: 140,
                                        overflow: "auto",
                                      }}
                                    >
                                      {JSON.stringify(v, null, 2)}
                                    </pre>
                                  ),
                                },
                              ]}
                            />
                          </div>
                        ),
                      },
                    ]
                  : []),
                {
                  key: "sql",
                  label: tr("data_sync.preview.tab.sql", {
                    count: previewSql.statementCount,
                  }),
                  children: (
                    <div>
                      <Alert
                        type="info"
                        showIcon
                        message={
                          previewHasDataDiff
                            ? isCompareEntry
                              ? tr(
                                  "data_sync.compare_entry.preview.sql.data_help",
                                )
                              : tr("data_sync.preview.sql.data_help")
                            : isCompareEntry
                              ? tr(
                                  "data_sync.compare_entry.preview.sql.schema_help",
                                )
                              : tr("data_sync.preview.sql.schema_help")
                        }
                      />
                      <div
                        style={{
                          marginTop: 8,
                          marginBottom: 8,
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                        }}
                      >
                        <Text type="secondary">
                          {previewHasDataDiff
                            ? tr("data_sync.preview.sql.statement_count", {
                                count: previewSql.statementCount,
                              })
                            : tr(
                                "data_sync.preview.sql.schema_statement_count",
                                { count: previewSql.statementCount },
                              )}
                        </Text>
                        <Button
                          size="small"
                          disabled={!previewSql.sqlText}
                          onClick={async () => {
                            try {
                              await navigator.clipboard.writeText(
                                previewSql.sqlText || "",
                              );
                              message.success(
                                tr("data_sync.preview.message.sql_copied"),
                              );
                            } catch {
                              message.error(
                                tr("data_sync.preview.message.copy_failed"),
                              );
                            }
                          }}
                        >
                          {tr("data_sync.preview.action.copy_sql")}
                        </Button>
                      </div>
                      <pre
                        style={{
                          margin: 0,
                          padding: 10,
                          border: "1px solid #f0f0f0",
                          borderRadius: 6,
                          background: "#fafafa",
                          maxHeight: 420,
                          overflow: "auto",
                          whiteSpace: "pre-wrap",
                          wordBreak: "break-word",
                        }}
                      >
                        {previewSql.sqlText ||
                          (previewHasDataDiff
                            ? tr("data_sync.preview.sql.no_data_sql")
                            : tr("data_sync.preview.sql.no_schema_changes"))}
                      </pre>
                    </div>
                  ),
                },
              ]}
            />
          </div>
        )}
      </Drawer>
    </>
  );
};

export default DataSyncModal;
