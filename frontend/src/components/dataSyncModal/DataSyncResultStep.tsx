import { Alert, Progress, Divider } from "antd";
import type { DataSyncModalPresentationApi } from "./hooks/useDataSyncModalPresentation";
import type { DataSyncModalStateApi } from "./hooks/useDataSyncModalState";
import type { DataSyncModalSyncActionsApi } from "./hooks/useDataSyncModalSyncActions";

export interface DataSyncResultStepProps {
  quietPanelStyle: DataSyncModalPresentationApi['quietPanelStyle'];
  syncing: DataSyncModalStateApi['syncing'];
  isCompareEntry: DataSyncModalStateApi['isCompareEntry'];
  tr: DataSyncModalStateApi['tr'];
  syncResult: DataSyncModalStateApi['syncResult'];
  syncProgress: DataSyncModalStateApi['syncProgress'];
  diffTables: DataSyncModalStateApi['diffTables'];
  logBoxRef: DataSyncModalStateApi['logBoxRef'];
  autoScrollRef: DataSyncModalStateApi['autoScrollRef'];
  darkMode: DataSyncModalStateApi['darkMode'];
  syncLogs: DataSyncModalStateApi['syncLogs'];
  renderSyncLogItem: DataSyncModalSyncActionsApi['renderSyncLogItem'];
}

export const DataSyncResultStep = ({
  quietPanelStyle, syncing, isCompareEntry, tr, syncResult, syncProgress, diffTables, logBoxRef,
  autoScrollRef, darkMode, syncLogs, renderSyncLogItem,
}: DataSyncResultStepProps) => (
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
);
