import React from "react";
import { Alert, Button, Input, Space, Spin } from "antd";
import {
  CheckCircleFilled,
  CloseCircleFilled,
  ExclamationCircleFilled,
  ReloadOutlined,
} from "@ant-design/icons";
import {
  SessionAgentAdd,
  SessionAgentDetect,
  SessionAgentListIntegrations,
  SessionAgentRemove,
} from "../../../wailsjs/go/app/App";
import { t } from "../../i18n";
import { useStore } from "../../store";
import type { AgentDetectionView } from "../../utils/agentConnectionTypes";
import { ProviderIcon } from "../sessionAgent/SessionAgentListPage";
import "./AgentSetupPanel.css";

interface AgentSetupPanelProps {
  kind: string;
  onClose: () => void;
}

const STATUS_ICON_MAP: Record<string, React.ReactNode> = {
  ready: <CheckCircleFilled className="gn-agent-setup-status-icon ok" />,
  not_installed: <CloseCircleFilled className="gn-agent-setup-status-icon bad" />,
  not_initialized: <ExclamationCircleFilled className="gn-agent-setup-status-icon warn" />,
  data_unreadable: <CloseCircleFilled className="gn-agent-setup-status-icon bad" />,
  unsupported_kind: <ExclamationCircleFilled className="gn-agent-setup-status-icon warn" />,
};

const STATUS_KEY_MAP: Record<string, string> = {
  ready: "session_agent.setup.status.ready",
  not_installed: "session_agent.setup.status.not_installed",
  not_initialized: "session_agent.setup.status.not_initialized",
  data_unreadable: "session_agent.setup.status.data_unreadable",
  unsupported_kind: "session_agent.setup.status.unsupported",
};

const toErrorMessage = (result: { message?: string } | null | undefined): string =>
  result?.message || t("session_agent.setup.error.generic");

/**
 * 智能体检测/添加页：替代数据库连接表单。挂载自动检测，未通过时支持
 * 手动定位数据目录重新检测；ready 后需二次确认才添加（同 kind 已添加
 * 时报错）。添加成功只关面板，不自动打开工作台——会话管理的唯一入口
 * 是侧边栏的智能体节点。
 */
const AgentSetupPanel: React.FC<AgentSetupPanelProps> = ({ kind, onClose }) => {
  const [view, setView] = React.useState<AgentDetectionView | null>(null);
  const [alreadyAdded, setAlreadyAdded] = React.useState(false);
  const [detecting, setDetecting] = React.useState(false);
  const [adding, setAdding] = React.useState(false);
  const [removing, setRemoving] = React.useState(false);
  const [manualDataDir, setManualDataDir] = React.useState("");
  const [errorText, setErrorText] = React.useState("");
  const refreshAgentIntegrations = useStore((state) => state.refreshAgentIntegrations);

  const displayName = kind === "claude" ? "Claude Code" : "ChatGPT";

  // 已添加检测：打开面板时检查该 kind 是否已在列表里。
  React.useEffect(() => {
    void (async () => {
      const result = await SessionAgentListIntegrations();
      if (result?.success && Array.isArray(result.data)) {
        const found = (result.data as Array<{ kind: string }>).some((item) => item.kind === kind);
        setAlreadyAdded(found);
      }
    })();
  }, [kind]);

  const runDetect = React.useCallback(
    async (dataDirOverride?: string) => {
      setDetecting(true);
      setErrorText("");
      try {
        const result = await SessionAgentDetect(kind, dataDirOverride || "");
        if (result?.success) {
          setView(result.data as AgentDetectionView);
          if (dataDirOverride) setManualDataDir(dataDirOverride);
        } else {
          setErrorText(toErrorMessage(result));
        }
      } catch (err) {
        setErrorText(String(err));
      } finally {
        setDetecting(false);
      }
    },
    [kind],
  );

  React.useEffect(() => {
    void runDetect();
  }, [runDetect]);

  const handleAdd = React.useCallback(async () => {
    if (!view || view.status !== "ready") return;
    setAdding(true);
    setErrorText("");
    try {
      const result = await SessionAgentAdd(kind, view.dataDir);
      if (result?.success) {
        setAlreadyAdded(true);
        void refreshAgentIntegrations();
        // 添加后不自动打开工作台：集成列表刷新完成前挂载页签，会被
        // 「绑定不在已加载列表」的重置逻辑清成「全部」，页签从此混入
        // 其他工具的会话。入口统一收敛到侧边栏。
        onClose();
        return;
      }
      setErrorText(toErrorMessage(result));
    } catch (err) {
      setErrorText(String(err));
    } finally {
      setAdding(false);
    }
  }, [kind, view, onClose, refreshAgentIntegrations]);

  const handleRemove = React.useCallback(async () => {
    setRemoving(true);
    setErrorText("");
    try {
      const result = await SessionAgentRemove(kind);
      if (result?.success) {
        setAlreadyAdded(false);
        void refreshAgentIntegrations();
        void runDetect();
      } else {
        setErrorText(toErrorMessage(result));
      }
    } catch (err) {
      setErrorText(String(err));
    } finally {
      setRemoving(false);
    }
  }, [kind, runDetect, refreshAgentIntegrations]);

  const detectionRows: Array<{ label: string; value: string }> = [];
  if (view) {
    if (view.commandPath) detectionRows.push({ label: t("session_agent.setup.command"), value: view.commandPath });
    if (view.version) detectionRows.push({ label: t("session_agent.setup.version"), value: view.version });
    if (view.dataDir) detectionRows.push({ label: t("session_agent.setup.data_dir"), value: view.dataDir });
  }

  return (
    <div className="gn-agent-setup" data-agent-setup-panel="true">
      <div className="gn-agent-setup-head">
        <span className={`gn-agent-setup-ico ${kind === "claude" ? "is-claude" : "is-codex"}`} aria-hidden="true">
          <ProviderIcon providerId={kind} />
        </span>
        <div className="gn-agent-setup-head-text">
          <div className="gn-agent-setup-title">{displayName}</div>
          <div className="gn-agent-setup-subtitle">
            {t("session_agent.setup.subtitle")}
          </div>
        </div>
      </div>

      {errorText ? (
        <Alert type="error" showIcon message={errorText} className="gn-agent-setup-alert" />
      ) : null}

      {detecting ? (
        <div className="gn-agent-setup-loading"><Spin /></div>
      ) : view ? (
        <>
          <Alert
            type={view.status === "ready" ? "success" : view.status === "not_installed" ? "error" : "warning"}
            showIcon
            icon={STATUS_ICON_MAP[view.status]}
            message={t(STATUS_KEY_MAP[view.status] || "session_agent.setup.status.unknown")}
            className="gn-agent-setup-alert"
          />
          {detectionRows.length > 0 && (
            <dl className="gn-agent-setup-facts">
              {detectionRows.map(({ label, value }) => (
                <div className="gn-agent-setup-fact" key={label}>
                  <dt className="gn-agent-setup-fact-label">{label}</dt>
                  <dd className="gn-agent-setup-fact-value" title={value}>{value}</dd>
                </div>
              ))}
            </dl>
          )}
          {view.status !== "ready" && (
            <div className="gn-agent-setup-manual">
              <div className="gn-agent-setup-manual-label">
                {t("session_agent.setup.manual_locate")}
              </div>
              <Space.Compact style={{ width: "100%" }}>
                <Input
                  value={manualDataDir}
                  onChange={(e) => setManualDataDir(e.target.value)}
                  placeholder={t("session_agent.setup.manual_locate_hint")}
                />
                <Button icon={<ReloadOutlined />} onClick={() => void runDetect(manualDataDir)}>
                  {t("session_agent.setup.recheck")}
                </Button>
              </Space.Compact>
            </div>
          )}
        </>
      ) : null}

      <div className="gn-agent-setup-actions">
        {alreadyAdded ? (
          <Button danger loading={removing} onClick={() => void handleRemove()}>
            {t("session_agent.setup.remove")}
          </Button>
        ) : (
          <Button
            type="primary"
            disabled={!view || view.status !== "ready"}
            loading={adding}
            onClick={() => void handleAdd()}
          >
            {t("session_agent.setup.add")}
          </Button>
        )}
        {alreadyAdded ? (
          <span className="gn-agent-setup-hint">{t("session_agent.setup.already_added_hint")}</span>
        ) : view?.status === "ready" ? (
          <span className="gn-agent-setup-hint">{t("session_agent.setup.ready_hint")}</span>
        ) : null}
      </div>
    </div>
  );
};

export default AgentSetupPanel;
