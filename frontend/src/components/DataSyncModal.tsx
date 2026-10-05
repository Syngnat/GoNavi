import Modal from "./common/ResizableDraggableModal";
import React from "react";
import { message } from "antd";
import { type DataSyncEntryModeAlias } from "./dataSyncEntryMode";
import { useDataSyncModalState } from "./dataSyncModal/hooks/useDataSyncModalState";
import {
    useDataSyncModalTableSelection,
} from "./dataSyncModal/hooks/useDataSyncModalTableSelection";
import { useDataSyncModalSyncActions } from "./dataSyncModal/hooks/useDataSyncModalSyncActions";
import { useDataSyncModalPresentation } from "./dataSyncModal/hooks/useDataSyncModalPresentation";
import { DataSyncModalHeader } from "./dataSyncModal/DataSyncModalHeader";
import { DataSyncEndpointsStep } from "./dataSyncModal/DataSyncEndpointsStep";
import { DataSyncOptionsCard } from "./dataSyncModal/DataSyncOptionsCard";
import { DataSyncCompareStep } from "./dataSyncModal/DataSyncCompareStep";
import { DataSyncResultStep } from "./dataSyncModal/DataSyncResultStep";
import { DataSyncModalFooter } from "./dataSyncModal/DataSyncModalFooter";
import { DataSyncPreviewDrawer } from "./dataSyncModal/DataSyncPreviewDrawer";
export { buildSqlPreview } from "./dataSyncModal/dataSyncSqlPreview";

export interface DataSyncModalProps {
  open: boolean;
  onClose: () => void;
  onBack?: () => void;
  entryMode?: DataSyncEntryModeAlias;
  embedded?: boolean;
  taskKey?: string;
}

const DataSyncModal: React.FC<DataSyncModalProps> = ({
  open,
  onClose,
  onBack,
  entryMode = "sync",
  embedded = false,
  taskKey,
}) => {
  const {
      i18nLanguage, tr, entryPresentation, isSchemaCompareEntry, isDataCompareEntry, isCompareEntry,
      resolvedTaskKey, connections, currentStep, setCurrentStep, loading, setLoading, token,
      darkMode, effectiveOpacity, disableLocalBackdropFilter, sourceConnId, setSourceConnId,
      targetConnId, setTargetConnId, sourceDb, setSourceDb, targetDb, setTargetDb, sourceDbs,
      setSourceDbs, targetDbs, setTargetDbs, targetSchemas, setTargetSchemas, targetSchema,
      setTargetSchema, targetSchemaLoading, setTargetSchemaLoading, migrationCapability,
      setMigrationCapability, migrationCapabilityStatus, setMigrationCapabilityStatus, allTables,
      setAllTables, selectedTables, setSelectedTables, sourceDatasetMode, setSourceDatasetMode,
      sourceQuery, setSourceQuery, workflowType, setWorkflowType, syncContent, setSyncContent,
      syncMode, setSyncMode, autoAddColumns, setAutoAddColumns, targetTableStrategy,
      setTargetTableStrategy, createIndexes, setCreateIndexes, mongoCollectionName,
      setMongoCollectionName, showSameTables, setShowSameTables, analyzing, setAnalyzing,
      diffTables, setDiffTables, setAnalyzedFingerprint, tableOptions, setTableOptions, previewOpen,
      setPreviewOpen, previewTable, setPreviewTable, previewLoading, setPreviewLoading, previewData,
      setPreviewData, syncResult, setSyncResult, syncing, setSyncing, syncLogs, setSyncLogs,
      syncProgress, setSyncProgress, jobIdRef, runSyncGuardRef, analysisRequestSeqRef,
      previewRequestSeqRef, analysisAbortRef, previewAbortRef, sourceDatabaseRequestSeqRef,
      targetDatabaseRequestSeqRef, tableMetadataRequestSeqRef, targetTableStrategyTouchedRef,
      logBoxRef, autoScrollRef, effectiveTargetTableStrategy, currentAnalysisFingerprint,
      currentAnalysisFingerprintRef, currentTableEndpointFingerprint,
      currentTableEndpointFingerprintRef, executionReadiness, normalizeConnConfig,
      isSourceQueryMode, targetConn, targetDialect, targetSupportsSchemaSelection,
  } = useDataSyncModalState({ entryMode, taskKey, open });

  const {
      handleSourceConnChange, handleTargetConnChange, ensureTargetSchemaSelected, nextToTables,
      updateTableOption,
  } = useDataSyncModalTableSelection({
      isSchemaCompareEntry, workflowType, setWorkflowType, sourceDatasetMode, setSourceDatasetMode,
      syncContent, setSyncContent, syncMode, setSyncMode, targetTableStrategy,
      setTargetTableStrategy, createIndexes, setCreateIndexes, isDataCompareEntry,
      migrationCapability, targetTableStrategyTouchedRef, autoAddColumns, setAutoAddColumns,
      selectedTables, setSelectedTables, sourceDatabaseRequestSeqRef, setSourceConnId, setSourceDb,
      setSourceDbs, setDiffTables, setAnalyzedFingerprint, setTableOptions, connections, setLoading,
      normalizeConnConfig, tr, targetDatabaseRequestSeqRef, setTargetConnId, setTargetDb,
      setTargetDbs, setTargetSchema, setTargetSchemas, setTargetSchemaLoading,
      targetSupportsSchemaSelection, targetSchema, sourceConnId, targetConnId, isSourceQueryMode,
      migrationCapabilityStatus, sourceDb, targetDb, tableMetadataRequestSeqRef,
      currentTableEndpointFingerprint, currentTableEndpointFingerprintRef, setAllTables,
      setCurrentStep,
  });

  const {
      analyzeDiff, openPreview, runSync, renderSyncLogItem, previewSql,
      previewRowSelectionSupported, previewHasSchemaStatements, previewSchemaWarnings,
      previewHasDataDiff, analysisWarnings, isMigrationWorkflow, tableCreationAllowed, sourceConn,
      capabilityPresentation, capabilityStatusPresentation, sourceType, targetType,
  } = useDataSyncModalSyncActions({
      sourceDatasetMode, selectedTables, sourceQuery, syncContent, tr, sourceConnId, targetConnId,
      sourceDb, targetDb, ensureTargetSchemaSelected, setLoading, setAnalyzing, setDiffTables,
      setAnalyzedFingerprint, setTableOptions, setSyncLogs, analysisRequestSeqRef,
      currentAnalysisFingerprint, analysisAbortRef, connections, jobIdRef, autoScrollRef,
      setSyncProgress, normalizeConnConfig, targetSchema, syncMode, autoAddColumns,
      effectiveTargetTableStrategy, createIndexes, mongoCollectionName,
      currentAnalysisFingerprintRef, setPreviewOpen, setPreviewTable, setPreviewLoading,
      setPreviewData, previewRequestSeqRef, previewAbortRef, executionReadiness, runSyncGuardRef,
      setSyncing, setCurrentStep, setSyncResult, resolvedTaskKey, tableOptions, i18nLanguage,
      previewData, previewTable, diffTables, isCompareEntry, workflowType, migrationCapability,
      migrationCapabilityStatus, targetConn,
  });
  const {
      isRedisMongoKeyspaceMigration, defaultMongoCollectionName, modalPanelStyle, shellCardStyle,
      heroPanelStyle, badgeStyle, quietPanelStyle, modalWorkspaceStyle, modalScrollableContentStyle,
      modalFooterBarStyle, renderModalTitle, handleReturnToPrevious,
  } = useDataSyncModalPresentation({
      isMigrationWorkflow, sourceType, targetType, sourceConn, targetConn, setMigrationCapability,
      setMigrationCapabilityStatus, sourceDb, selectedTables, targetDb,
      targetSupportsSchemaSelection, setTargetSchemas, setTargetSchema, setTargetSchemaLoading,
      targetDialect, i18nLanguage, darkMode, disableLocalBackdropFilter, effectiveOpacity, token,
      onBack, syncing, tr,
  });

  const dataSyncContent = (
    <div style={modalWorkspaceStyle}>
      <DataSyncModalHeader
        embedded={embedded} heroPanelStyle={heroPanelStyle} darkMode={darkMode}
        isMigrationWorkflow={isMigrationWorkflow} tr={tr} isCompareEntry={isCompareEntry}
        entryPresentation={entryPresentation} badgeStyle={badgeStyle} sourceConnId={sourceConnId}
        selectedTables={selectedTables} currentStep={currentStep}
      />

      <div style={modalScrollableContentStyle}>
        {/* STEP 1: CONFIG */}
        {currentStep === 0 && (
          <div>
            <DataSyncEndpointsStep
              tr={tr} shellCardStyle={shellCardStyle} darkMode={darkMode}
              sourceConnId={sourceConnId} handleSourceConnChange={handleSourceConnChange}
              connections={connections} sourceDbs={sourceDbs} sourceDb={sourceDb}
              setSourceDb={setSourceDb} badgeStyle={badgeStyle} targetConnId={targetConnId}
              handleTargetConnChange={handleTargetConnChange} targetDbs={targetDbs}
              targetDb={targetDb} setTargetDb={setTargetDb}
              targetSupportsSchemaSelection={targetSupportsSchemaSelection}
              targetSchema={targetSchema} setTargetSchema={setTargetSchema}
              targetSchemaLoading={targetSchemaLoading} targetSchemas={targetSchemas}
            />

            <DataSyncOptionsCard
              isMigrationWorkflow={isMigrationWorkflow} tr={tr} isCompareEntry={isCompareEntry}
              entryPresentation={entryPresentation} shellCardStyle={shellCardStyle}
              darkMode={darkMode} quietPanelStyle={quietPanelStyle} workflowType={workflowType}
              targetTableStrategyTouchedRef={targetTableStrategyTouchedRef}
              setWorkflowType={setWorkflowType} isSourceQueryMode={isSourceQueryMode}
              isSchemaCompareEntry={isSchemaCompareEntry} sourceDatasetMode={sourceDatasetMode}
              setSourceDatasetMode={setSourceDatasetMode} isDataCompareEntry={isDataCompareEntry}
              syncContent={syncContent} setSyncContent={setSyncContent} syncMode={syncMode}
              setSyncMode={setSyncMode} tableCreationAllowed={tableCreationAllowed}
              targetTableStrategy={targetTableStrategy}
              setTargetTableStrategy={setTargetTableStrategy}
              migrationCapabilityStatus={migrationCapabilityStatus}
              capabilityPresentation={capabilityPresentation}
              migrationCapability={migrationCapability}
              isRedisMongoKeyspaceMigration={isRedisMongoKeyspaceMigration}
              sourceType={sourceType} mongoCollectionName={mongoCollectionName}
              setMongoCollectionName={setMongoCollectionName}
              defaultMongoCollectionName={defaultMongoCollectionName}
              autoAddColumns={autoAddColumns} setAutoAddColumns={setAutoAddColumns}
              createIndexes={createIndexes} setCreateIndexes={setCreateIndexes}
              capabilityStatusPresentation={capabilityStatusPresentation}
            />
          </div>
        )}

        {/* STEP 2: TABLES */}
        {currentStep === 1 && (
          <DataSyncCompareStep
            quietPanelStyle={quietPanelStyle} isSourceQueryMode={isSourceQueryMode}
            isCompareEntry={isCompareEntry} entryPresentation={entryPresentation} tr={tr}
            showSameTables={showSameTables} setShowSameTables={setShowSameTables}
            allTables={allTables} selectedTables={selectedTables}
            setSelectedTables={setSelectedTables} sourceQuery={sourceQuery}
            setSourceQuery={setSourceQuery} diffTables={diffTables}
            analysisWarnings={analysisWarnings} tableOptions={tableOptions} analyzing={analyzing}
            updateTableOption={updateTableOption} openPreview={openPreview}
          />
        )}

        {/* STEP 3: RESULT */}
        {currentStep === 2 && (
          <DataSyncResultStep
            quietPanelStyle={quietPanelStyle} syncing={syncing} isCompareEntry={isCompareEntry}
            tr={tr} syncResult={syncResult} syncProgress={syncProgress} diffTables={diffTables}
            logBoxRef={logBoxRef} autoScrollRef={autoScrollRef} darkMode={darkMode}
            syncLogs={syncLogs} renderSyncLogItem={renderSyncLogItem}
          />
        )}
      </div>

      <DataSyncModalFooter
        modalFooterBarStyle={modalFooterBarStyle} currentStep={currentStep}
        nextToTables={nextToTables} loading={loading} isSourceQueryMode={isSourceQueryMode}
        migrationCapabilityStatus={migrationCapabilityStatus}
        capabilityPresentation={capabilityPresentation} tr={tr} setCurrentStep={setCurrentStep}
        analyzeDiff={analyzeDiff} isCompareEntry={isCompareEntry} syncContent={syncContent}
        selectedTables={selectedTables} analyzing={analyzing} sourceQuery={sourceQuery}
        entryPresentation={entryPresentation} onClose={onClose} runSync={runSync}
        executionReadiness={executionReadiness} syncing={syncing} onBack={onBack}
        handleReturnToPrevious={handleReturnToPrevious}
      />
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
      <DataSyncPreviewDrawer
        tr={tr} previewTable={previewTable} darkMode={darkMode} previewOpen={previewOpen}
        previewRequestSeqRef={previewRequestSeqRef} previewAbortRef={previewAbortRef}
        setPreviewOpen={setPreviewOpen} setPreviewTable={setPreviewTable}
        setPreviewData={setPreviewData} previewLoading={previewLoading} previewData={previewData}
        previewHasDataDiff={previewHasDataDiff} previewSql={previewSql}
        previewSchemaWarnings={previewSchemaWarnings}
        previewHasSchemaStatements={previewHasSchemaStatements}
        previewRowSelectionSupported={previewRowSelectionSupported}
        isCompareEntry={isCompareEntry} tableOptions={tableOptions}
        updateTableOption={updateTableOption}
      />
    </>
  );
};

export default DataSyncModal;
