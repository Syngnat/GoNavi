import { Button } from "antd";
import type { DataSyncModalPresentationApi } from "./hooks/useDataSyncModalPresentation";
import type { DataSyncModalStateApi } from "./hooks/useDataSyncModalState";
import type { DataSyncModalTableSelectionApi } from "./hooks/useDataSyncModalTableSelection";
import type { DataSyncModalSyncActionsApi } from "./hooks/useDataSyncModalSyncActions";
import type { DataSyncModalProps } from "../DataSyncModal";

export interface DataSyncModalFooterProps {
  modalFooterBarStyle: DataSyncModalPresentationApi['modalFooterBarStyle'];
  currentStep: DataSyncModalStateApi['currentStep'];
  nextToTables: DataSyncModalTableSelectionApi['nextToTables'];
  loading: DataSyncModalStateApi['loading'];
  isSourceQueryMode: DataSyncModalStateApi['isSourceQueryMode'];
  migrationCapabilityStatus: DataSyncModalStateApi['migrationCapabilityStatus'];
  capabilityPresentation: DataSyncModalSyncActionsApi['capabilityPresentation'];
  tr: DataSyncModalStateApi['tr'];
  setCurrentStep: DataSyncModalStateApi['setCurrentStep'];
  analyzeDiff: DataSyncModalSyncActionsApi['analyzeDiff'];
  isCompareEntry: DataSyncModalStateApi['isCompareEntry'];
  syncContent: DataSyncModalStateApi['syncContent'];
  selectedTables: DataSyncModalStateApi['selectedTables'];
  analyzing: DataSyncModalStateApi['analyzing'];
  sourceQuery: DataSyncModalStateApi['sourceQuery'];
  entryPresentation: DataSyncModalStateApi['entryPresentation'];
  onClose: DataSyncModalProps['onClose'];
  runSync: DataSyncModalSyncActionsApi['runSync'];
  executionReadiness: DataSyncModalStateApi['executionReadiness'];
  syncing: DataSyncModalStateApi['syncing'];
  onBack: DataSyncModalProps['onBack'];
  handleReturnToPrevious: DataSyncModalPresentationApi['handleReturnToPrevious'];
}

export const DataSyncModalFooter = ({
  modalFooterBarStyle, currentStep, nextToTables, loading, isSourceQueryMode,
  migrationCapabilityStatus, capabilityPresentation, tr, setCurrentStep, analyzeDiff,
  isCompareEntry, syncContent, selectedTables, analyzing, sourceQuery, entryPresentation, onClose,
  runSync, executionReadiness, syncing, onBack, handleReturnToPrevious,
}: DataSyncModalFooterProps) => (
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
);
