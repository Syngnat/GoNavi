import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  FolderOpenOutlined,
  SafetyCertificateOutlined,
} from "@ant-design/icons";
import { Alert, Button, Input, Modal, Spin, message } from "antd";

import {
  AIApplyAgentDataDirectory,
  AIClearAgentData,
  AIGetAgentDataDirectoryInfo,
  AIOpenAgentDataDirectory,
  AIOptimizeAgentData,
  AISelectAgentDataDirectory,
} from "../../../wailsjs/go/aiservice/Service";
import type { aiservice, runharness } from "../../../wailsjs/go/models";
import { useI18n } from "../../i18n/provider";
import { useStore } from "../../store";
import {
  DataDirectoryPage,
  DirectoryChoice,
  DirectoryMetaGrid,
  DirectoryNote,
  DirectoryPathDisplay,
  DirectorySectionHeading,
} from "../settings/DataDirectorySettings";
import { notifyAIAgentDataCleared } from "./aiAgentDataEvents";

interface AgentDataSettingsPanelProps {
  readOnly?: boolean;
}

const emptyStats = (): runharness.LedgerStorageStats => ({
  fileBytes: 0,
  walBytes: 0,
  allocatedBytes: 0,
  freeBytes: 0,
  sessionCount: 0,
  runCount: 0,
  snapshotCount: 0,
  activeRunCount: 0,
});

export const formatAgentDataBytes = (
  value: number,
  locale = "en-US",
): string => {
  const bytes = Math.max(0, Number(value) || 0);
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let size = bytes / 1024;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: size >= 10 ? 1 : 2 }).format(size)} ${units[unitIndex]}`;
};

const AgentDataSettingsPanel: React.FC<AgentDataSettingsPanelProps> = ({
  readOnly = false,
}) => {
  const { language, t } = useI18n();
  const [info, setInfo] = useState<aiservice.AgentDataDirectoryInfo | null>(
    null,
  );
  const [selectedDirectory, setSelectedDirectory] = useState("");
  const [loading, setLoading] = useState(true);
  const [operation, setOperation] = useState<
    "select" | "apply" | "optimize" | "clear" | null
  >(null);
  const [modal, modalContextHolder] = Modal.useModal();
  const busy = loading || operation !== null;

  const loadInfo = useCallback(async () => {
    setLoading(true);
    try {
      const next = await AIGetAgentDataDirectoryInfo();
      setInfo(next);
      setSelectedDirectory(next.directory || next.defaultDirectory || "");
    } catch (error) {
      const detail =
        error instanceof Error
          ? error.message
          : String(error || t("common.unknown"));
      void message.error(
        t("app.data_root.agent_data.message.load_failed", { error: detail }),
      );
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void loadInfo();
  }, [loadInfo]);

  const stats = info?.stats || emptyStats();
  const diskUsage =
    Math.max(0, Number(stats.fileBytes) || 0) +
    Math.max(0, Number(stats.walBytes) || 0);
  const reclaimableBytes = Math.min(
    Math.max(0, Number(stats.freeBytes) || 0),
    Math.max(0, Number(stats.fileBytes) || 0),
  );
  const ledgerBytes = Math.max(
    0,
    Math.max(0, Number(stats.fileBytes) || 0) - reclaimableBytes,
  );
  const walBytes = Math.max(0, Number(stats.walBytes) || 0);
  const ledgerPercent = diskUsage > 0 ? (ledgerBytes / diskUsage) * 100 : 0;
  const reclaimablePercent =
    diskUsage > 0 ? (reclaimableBytes / diskUsage) * 100 : 0;
  const usageGradient = diskUsage > 0
    ? `conic-gradient(
        var(--gn-storage-chart-ledger) 0% ${ledgerPercent}%,
        var(--gn-storage-chart-reclaimable) ${ledgerPercent}% ${ledgerPercent + reclaimablePercent}%,
        var(--gn-storage-chart-wal) ${ledgerPercent + reclaimablePercent}% 100%
      )`
    : undefined;
  const recordStatItems = useMemo(
    () => [
      [t("app.data_root.agent_data.sessions"), String(stats.sessionCount || 0)],
      [t("app.data_root.agent_data.runs"), String(stats.runCount || 0)],
      [
        t("app.data_root.agent_data.snapshots"),
        String(stats.snapshotCount || 0),
      ],
      [
        t("app.data_root.agent_data.active_runs"),
        String(stats.activeRunCount || 0),
      ],
    ],
    [stats, t],
  );

  const selectDirectory = useCallback(async () => {
    setOperation("select");
    try {
      const selected = await AISelectAgentDataDirectory(
        selectedDirectory || info?.directory || "",
      );
      if (selected) setSelectedDirectory(selected);
    } catch (error) {
      const detail =
        error instanceof Error
          ? error.message
          : String(error || t("common.unknown"));
      void message.error(
        t("app.data_root.agent_data.message.select_failed", { error: detail }),
      );
    } finally {
      setOperation(null);
    }
  }, [info?.directory, selectedDirectory, t]);

  const applyDirectory = useCallback(
    async (migrate: boolean, directory = selectedDirectory) => {
      const target = String(directory || "").trim();
      if (!target) {
        void message.warning(
          t("app.data_root.agent_data.message.select_valid_first"),
        );
        return;
      }
      setOperation("apply");
      try {
        const next = await AIApplyAgentDataDirectory(target, migrate);
        setInfo(next);
        setSelectedDirectory(next.directory || target);
        void message.success(
          t(
            migrate
              ? "app.data_root.agent_data.message.migrated"
              : "app.data_root.agent_data.message.switched",
          ),
        );
      } catch (error) {
        const detail =
          error instanceof Error
            ? error.message
            : String(error || t("common.unknown"));
        void message.error(
          t("app.data_root.agent_data.message.apply_failed", { error: detail }),
        );
      } finally {
        setOperation(null);
      }
    },
    [selectedDirectory, t],
  );

  const openDirectory = useCallback(async () => {
    try {
      await AIOpenAgentDataDirectory();
    } catch (error) {
      const detail =
        error instanceof Error
          ? error.message
          : String(error || t("common.unknown"));
      void message.error(
        t("app.data_root.agent_data.message.open_failed", { error: detail }),
      );
    }
  }, [t]);

  const optimize = useCallback(async () => {
    setOperation("optimize");
    try {
      const result = await AIOptimizeAgentData();
      setInfo(result.info);
      setSelectedDirectory(result.info.directory || selectedDirectory);
      void message.success(
        t("app.data_root.agent_data.message.optimized", {
          count: result.maintenance.removedSnapshots || 0,
          size: formatAgentDataBytes(
            Math.max(
              0,
              (result.maintenance.before.fileBytes || 0) +
                (result.maintenance.before.walBytes || 0) -
                (result.maintenance.after.fileBytes || 0) -
                (result.maintenance.after.walBytes || 0),
            ),
            language,
          ),
        }),
      );
    } catch (error) {
      const detail =
        error instanceof Error
          ? error.message
          : String(error || t("common.unknown"));
      void message.error(
        t("app.data_root.agent_data.message.optimize_failed", {
          error: detail,
        }),
      );
    } finally {
      setOperation(null);
    }
  }, [language, selectedDirectory, t]);

  const clearAll = useCallback(() => {
    modal.confirm({
      title: t("app.data_root.agent_data.clear_confirm.title"),
      content: t("app.data_root.agent_data.clear_confirm.content"),
      okText: t("app.data_root.agent_data.clear_confirm.ok"),
      okButtonProps: { danger: true },
      cancelText: t("common.cancel"),
      onOk: async () => {
        setOperation("clear");
        try {
          const result = await AIClearAgentData();
          setInfo(result.info);
          setSelectedDirectory(result.info.directory || selectedDirectory);
          useStore.setState({
            aiChatSessions: [],
            aiChatHistory: {},
            aiActiveSessionId: null,
          });
          notifyAIAgentDataCleared();
          void message.success(
            t("app.data_root.agent_data.message.cleared", {
              count: result.maintenance.removedSessions || 0,
            }),
          );
        } catch (error) {
          const detail =
            error instanceof Error
              ? error.message
              : String(error || t("common.unknown"));
          void message.error(
            t("app.data_root.agent_data.message.clear_failed", {
              error: detail,
            }),
          );
          throw error;
        } finally {
          setOperation(null);
        }
      },
    });
  }, [modal, selectedDirectory, t]);

  return (
    <>
      {modalContextHolder}
      <div data-agent-data-settings="true">
        <DataDirectoryPage testId="agent">
        {loading ? (
          <section className="gn-storage-panel">
            <div className="gn-storage-loading"><Spin size="small" /></div>
          </section>
        ) : (
          <>
            <section className="gn-storage-panel gn-storage-panel--current">
              <div className="gn-storage-panel__body">
                <DirectorySectionHeading
                  title={t("app.data_root.current_location")}
                  description={t("app.data_root.agent_data.current_description")}
                />
                <DirectoryPathDisplay
                  label={t("app.data_root.agent_data.current_directory")}
                  path={info?.directory || ""}
                  action={!readOnly ? (
                    <Button
                      data-agent-data-action="open"
                      disabled={busy}
                      onClick={() => void openDirectory()}
                    >
                      {t("app.data_root.action.open_current")}
                    </Button>
                  ) : undefined}
                />
                <div
                  className="gn-storage-usage-overview"
                  data-agent-data-usage-summary="true"
                >
                  <div className="gn-storage-usage-card">
                    <div
                      className={`gn-storage-usage-chart${diskUsage === 0 ? " gn-storage-usage-chart--empty" : ""}`}
                      data-agent-data-usage-chart="true"
                      role="img"
                      aria-label={`${t("app.data_root.agent_data.disk_usage")}: ${formatAgentDataBytes(diskUsage, language)}`}
                      style={usageGradient ? { background: usageGradient } : undefined}
                    >
                      <div className="gn-storage-usage-chart__center">
                        <span>{t("app.data_root.agent_data.disk_usage")}</span>
                        <strong>{formatAgentDataBytes(diskUsage, language)}</strong>
                      </div>
                    </div>
                    <div className="gn-storage-usage-legend">
                      {[
                        ["ledger", t("app.data_root.agent_data.ledger_data"), ledgerBytes],
                        ["reclaimable", t("app.data_root.agent_data.reclaimable"), reclaimableBytes],
                        ["wal", t("app.data_root.agent_data.write_log"), walBytes],
                      ].map(([tone, label, bytes]) => (
                        <div className="gn-storage-usage-legend__item" key={String(tone)}>
                          <span className={`gn-storage-usage-legend__dot gn-storage-usage-legend__dot--${tone}`} />
                          <span className="gn-storage-usage-legend__label">{label}</span>
                          <strong>{formatAgentDataBytes(Number(bytes), language)}</strong>
                        </div>
                      ))}
                    </div>
                  </div>
                  <div className="gn-storage-usage-details">
                    <DirectoryMetaGrid items={[{
                      label: t("app.data_root.agent_data.default_directory"),
                      value: info?.defaultDirectory || "-",
                    }]} />
                    <div className="gn-storage-ledger-index">
                      {recordStatItems.map(([label, value]) => (
                        <div className="gn-storage-ledger-index__item" key={label}>
                          <span className="gn-storage-meta__label">{label}</span>
                          <span className="gn-storage-ledger-index__value">{value}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
                {readOnly && (
                  <Alert
                    type="info"
                    showIcon
                    message={t("app.data_root.agent_data.read_only_hint")}
                  />
                )}
              </div>
            </section>

            {!readOnly && (
              <>
                <section
                  className="gn-storage-panel"
                  data-agent-data-section="location"
                >
                  <div className="gn-storage-panel__body">
                    <DirectorySectionHeading
                      title={t("app.data_root.change_location")}
                      description={t("app.data_root.agent_data.change_description")}
                    />
                    <div className="gn-storage-path-editor">
                      <Input
                        readOnly
                        value={selectedDirectory}
                        placeholder={t("app.data_root.agent_data.placeholder")}
                        aria-label={t("app.data_root.agent_data.switch_target")}
                      />
                      <div className="gn-storage-path-editor__actions">
                        <Button
                          data-agent-data-action="select"
                          icon={<FolderOpenOutlined />}
                          disabled={busy}
                          loading={operation === "select"}
                          onClick={() => void selectDirectory()}
                        >
                          {t("app.data_root.action.select")}
                        </Button>
                        <Button
                          data-agent-data-action="restore-default"
                          disabled={busy || !info?.defaultDirectory}
                          loading={operation === "apply"}
                          onClick={() =>
                            void applyDirectory(false, info?.defaultDirectory || "")
                          }
                        >
                          {t("app.data_root.action.restore_default_directory")}
                        </Button>
                      </div>
                    </div>
                    <div className="gn-storage-choice-grid">
                      <DirectoryChoice
                        title={t("app.data_root.action.switch_now")}
                        description={t("app.data_root.agent_data.switch_only_hint")}
                        action={(
                          <Button
                            data-agent-data-action="switch"
                            disabled={busy}
                            loading={operation === "apply"}
                            onClick={() => void applyDirectory(false)}
                          >
                            {t("app.data_root.action.switch_now")}
                          </Button>
                        )}
                      />
                      <DirectoryChoice
                        recommended
                        badge={t("app.data_root.recommended")}
                        title={t("app.data_root.action.migrate_now")}
                        description={t("app.data_root.agent_data.migrate_hint")}
                        action={(
                          <Button
                            data-agent-data-action="migrate"
                            type="primary"
                            disabled={busy}
                            loading={operation === "apply"}
                            onClick={() => void applyDirectory(true)}
                          >
                            {t("app.data_root.action.migrate_now")}
                          </Button>
                        )}
                      />
                    </div>
                    <DirectoryNote>{t("app.data_root.agent_data.security_boundary")}</DirectoryNote>
                    {info?.restartRequired && (
                      <Alert
                        type="warning"
                        showIcon
                        message={t("app.data_root.agent_data.restart_hint")}
                      />
                    )}
                  </div>
                </section>

                <div
                  className="gn-storage-maintenance-grid"
                  data-agent-data-section="maintenance"
                >
                  <section className="gn-storage-panel">
                    <div className="gn-storage-panel__body">
                      <DirectorySectionHeading
                        title={t("app.data_root.agent_data.maintenance")}
                        description={t("app.data_root.agent_data.maintenance_description")}
                      />
                      <DirectoryMetaGrid items={[{
                        label: t("app.data_root.agent_data.reclaimable"),
                        value: formatAgentDataBytes(stats.freeBytes, language),
                      }]} />
                      <Button
                        data-agent-data-action="optimize"
                        disabled={busy || stats.activeRunCount > 0}
                        loading={operation === "optimize"}
                        onClick={() => void optimize()}
                      >
                        {t("app.data_root.agent_data.action.optimize")}
                      </Button>
                      <DirectoryNote>{t("app.data_root.agent_data.optimize_description")}</DirectoryNote>
                    </div>
                  </section>

                  <section className="gn-storage-panel gn-storage-danger-panel">
                    <div className="gn-storage-panel__body">
                      <DirectorySectionHeading
                        title={t("app.data_root.agent_data.danger_title")}
                        description={t("app.data_root.agent_data.clear_description")}
                      />
                      <Button
                        data-agent-data-action="clear"
                        danger
                        disabled={busy || stats.activeRunCount > 0}
                        loading={operation === "clear"}
                        onClick={clearAll}
                      >
                        {t("app.data_root.agent_data.action.clear")}
                      </Button>
                      {stats.activeRunCount > 0 && (
                        <DirectoryNote>{t("app.data_root.agent_data.active_run_hint")}</DirectoryNote>
                      )}
                      <div className="gn-storage-security-mark">
                        <SafetyCertificateOutlined aria-hidden="true" />
                        <span>{t("app.data_root.agent_data.security_boundary")}</span>
                      </div>
                    </div>
                  </section>
                </div>
              </>
            )}
          </>
        )}
        </DataDirectoryPage>
      </div>
    </>
  );
};

export default AgentDataSettingsPanel;
