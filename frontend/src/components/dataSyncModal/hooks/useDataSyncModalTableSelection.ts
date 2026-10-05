import { useEffect } from "react";
import { message } from "antd";
import { isTargetTableCreationAllowed } from "../../dataSyncTableCreation";
import { DBGetDatabases, DBGetTables } from "../../../../wailsjs/go/app/App";
import { resolveDataSyncDatabaseSelection } from "../../dataSyncDatabaseSelection";
import { resolveDataSyncCapabilityPresentation } from "../../dataSyncCapability";
import {
    isTableMetadataIncomplete,
    getTableMetadataIssueDetail,
} from "../../../utils/tableMetadataResult";
import { normalizeTableNamesFromMetadataRows } from "../../../utils/tableMetadataRows";
import { filterTablesBySchema } from "../dataSyncSqlPreview";
import type { TableOps } from "../dataSyncModalTypes";
import type { DataSyncModalStateApi } from "./useDataSyncModalState";

export interface UseDataSyncModalTableSelectionInput {
    isSchemaCompareEntry: DataSyncModalStateApi['isSchemaCompareEntry'];
    workflowType: DataSyncModalStateApi['workflowType'];
    setWorkflowType: DataSyncModalStateApi['setWorkflowType'];
    sourceDatasetMode: DataSyncModalStateApi['sourceDatasetMode'];
    setSourceDatasetMode: DataSyncModalStateApi['setSourceDatasetMode'];
    syncContent: DataSyncModalStateApi['syncContent'];
    setSyncContent: DataSyncModalStateApi['setSyncContent'];
    syncMode: DataSyncModalStateApi['syncMode'];
    setSyncMode: DataSyncModalStateApi['setSyncMode'];
    targetTableStrategy: DataSyncModalStateApi['targetTableStrategy'];
    setTargetTableStrategy: DataSyncModalStateApi['setTargetTableStrategy'];
    createIndexes: DataSyncModalStateApi['createIndexes'];
    setCreateIndexes: DataSyncModalStateApi['setCreateIndexes'];
    isDataCompareEntry: DataSyncModalStateApi['isDataCompareEntry'];
    migrationCapability: DataSyncModalStateApi['migrationCapability'];
    targetTableStrategyTouchedRef: DataSyncModalStateApi['targetTableStrategyTouchedRef'];
    autoAddColumns: DataSyncModalStateApi['autoAddColumns'];
    setAutoAddColumns: DataSyncModalStateApi['setAutoAddColumns'];
    selectedTables: DataSyncModalStateApi['selectedTables'];
    setSelectedTables: DataSyncModalStateApi['setSelectedTables'];
    sourceDatabaseRequestSeqRef: DataSyncModalStateApi['sourceDatabaseRequestSeqRef'];
    setSourceConnId: DataSyncModalStateApi['setSourceConnId'];
    setSourceDb: DataSyncModalStateApi['setSourceDb'];
    setSourceDbs: DataSyncModalStateApi['setSourceDbs'];
    setDiffTables: DataSyncModalStateApi['setDiffTables'];
    setAnalyzedFingerprint: DataSyncModalStateApi['setAnalyzedFingerprint'];
    setTableOptions: DataSyncModalStateApi['setTableOptions'];
    connections: DataSyncModalStateApi['connections'];
    setLoading: DataSyncModalStateApi['setLoading'];
    normalizeConnConfig: DataSyncModalStateApi['normalizeConnConfig'];
    tr: DataSyncModalStateApi['tr'];
    targetDatabaseRequestSeqRef: DataSyncModalStateApi['targetDatabaseRequestSeqRef'];
    setTargetConnId: DataSyncModalStateApi['setTargetConnId'];
    setTargetDb: DataSyncModalStateApi['setTargetDb'];
    setTargetDbs: DataSyncModalStateApi['setTargetDbs'];
    setTargetSchema: DataSyncModalStateApi['setTargetSchema'];
    setTargetSchemas: DataSyncModalStateApi['setTargetSchemas'];
    setTargetSchemaLoading: DataSyncModalStateApi['setTargetSchemaLoading'];
    targetSupportsSchemaSelection: DataSyncModalStateApi['targetSupportsSchemaSelection'];
    targetSchema: DataSyncModalStateApi['targetSchema'];
    sourceConnId: DataSyncModalStateApi['sourceConnId'];
    targetConnId: DataSyncModalStateApi['targetConnId'];
    isSourceQueryMode: DataSyncModalStateApi['isSourceQueryMode'];
    migrationCapabilityStatus: DataSyncModalStateApi['migrationCapabilityStatus'];
    sourceDb: DataSyncModalStateApi['sourceDb'];
    targetDb: DataSyncModalStateApi['targetDb'];
    tableMetadataRequestSeqRef: DataSyncModalStateApi['tableMetadataRequestSeqRef'];
    currentTableEndpointFingerprint: DataSyncModalStateApi['currentTableEndpointFingerprint'];
    currentTableEndpointFingerprintRef: DataSyncModalStateApi['currentTableEndpointFingerprintRef'];
    setAllTables: DataSyncModalStateApi['setAllTables'];
    setCurrentStep: DataSyncModalStateApi['setCurrentStep'];
}

export const useDataSyncModalTableSelection = ({
    isSchemaCompareEntry, workflowType, setWorkflowType, sourceDatasetMode, setSourceDatasetMode,
    syncContent, setSyncContent, syncMode, setSyncMode, targetTableStrategy, setTargetTableStrategy,
    createIndexes, setCreateIndexes, isDataCompareEntry, migrationCapability,
    targetTableStrategyTouchedRef, autoAddColumns, setAutoAddColumns, selectedTables,
    setSelectedTables, sourceDatabaseRequestSeqRef, setSourceConnId, setSourceDb, setSourceDbs,
    setDiffTables, setAnalyzedFingerprint, setTableOptions, connections, setLoading,
    normalizeConnConfig, tr, targetDatabaseRequestSeqRef, setTargetConnId, setTargetDb,
    setTargetDbs, setTargetSchema, setTargetSchemas, setTargetSchemaLoading,
    targetSupportsSchemaSelection, targetSchema, sourceConnId, targetConnId, isSourceQueryMode,
    migrationCapabilityStatus, sourceDb, targetDb, tableMetadataRequestSeqRef,
    currentTableEndpointFingerprint, currentTableEndpointFingerprintRef, setAllTables,
    setCurrentStep,
}: UseDataSyncModalTableSelectionInput) => {
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
      if (isTargetTableCreationAllowed(workflowType, syncContent, sourceDatasetMode)) {
        const supportsAutoCreate = migrationCapability?.supportsAutoCreate === true;
        // 迁移保持默认 insert_update：目标表已存在且补列时，必须走按主键差异
        // 更新才能把新增字段的值回填到已有数据行；强制 insert_only 会让这些
        // 行永远留 NULL（issue #1014）。全新建表场景下目标为空表，
        // insert_update 的差异比对等价于全量插入，无额外开销。
        // 无主键的已存在表会由引擎明确报错提示，而不是静默漏数据。
        if (workflowType === "migration" && syncContent === "schema") {
          setSyncContent("both");
        }
        if (
          supportsAutoCreate &&
          targetTableStrategy === "existing_only" &&
          !targetTableStrategyTouchedRef.current
        ) {
          setTargetTableStrategy("smart");
        } else if (!supportsAutoCreate && targetTableStrategy !== "existing_only") {
          setTargetTableStrategy("existing_only");
        }
        // 支持自动建表时默认同时建索引，不支持时必须关掉。
        if (createIndexes !== supportsAutoCreate) setCreateIndexes(supportsAutoCreate);
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
      targetTableStrategyTouchedRef.current = false;
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
      targetTableStrategyTouchedRef.current = false;
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
    return {
        handleSourceConnChange, handleTargetConnChange, ensureTargetSchemaSelected, nextToTables,
        updateTableOption,
    };
};

export type DataSyncModalTableSelectionApi = ReturnType<typeof useDataSyncModalTableSelection>;
