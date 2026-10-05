import { RocketOutlined, SwapOutlined, DatabaseOutlined, TableOutlined } from "@ant-design/icons";
import { Steps } from "antd";
import { Step } from "./dataSyncModalUiParts";
import type { DataSyncModalPresentationApi } from "./hooks/useDataSyncModalPresentation";
import type { DataSyncModalStateApi } from "./hooks/useDataSyncModalState";
import type { DataSyncModalSyncActionsApi } from "./hooks/useDataSyncModalSyncActions";
import type { DataSyncModalProps } from "../DataSyncModal";

export interface DataSyncModalHeaderProps {
  embedded: Exclude<DataSyncModalProps['embedded'], undefined>;
  heroPanelStyle: DataSyncModalPresentationApi['heroPanelStyle'];
  darkMode: DataSyncModalStateApi['darkMode'];
  isMigrationWorkflow: DataSyncModalSyncActionsApi['isMigrationWorkflow'];
  tr: DataSyncModalStateApi['tr'];
  isCompareEntry: DataSyncModalStateApi['isCompareEntry'];
  entryPresentation: DataSyncModalStateApi['entryPresentation'];
  badgeStyle: DataSyncModalPresentationApi['badgeStyle'];
  sourceConnId: DataSyncModalStateApi['sourceConnId'];
  selectedTables: DataSyncModalStateApi['selectedTables'];
  currentStep: DataSyncModalStateApi['currentStep'];
}

export const DataSyncModalHeader = ({
  embedded, heroPanelStyle, darkMode, isMigrationWorkflow, tr, isCompareEntry, entryPresentation,
  badgeStyle, sourceConnId, selectedTables, currentStep,
}: DataSyncModalHeaderProps) => (
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
);
