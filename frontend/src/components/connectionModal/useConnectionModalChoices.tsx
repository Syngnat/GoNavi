import React, { useEffect } from "react";
import { EventsOn } from "../../../wailsjs/runtime";
import { applySSHConnectionProgressEvent } from "./sshConnectionProgress";
import {
  buildRedisDatabaseList,
  normalizeRedisDatabaseSelection,
  type ChoiceCardOption,
  Text,
  type EditableJVMMode,
} from "./connectionModalHelpers";
import { supportsRedisSshTunnel } from "../../utils/redisTopologySsh";
import { Form, Input, Space, Tag } from "antd";
import { noAutoCapInputProps } from "../../utils/inputAutoCap";
import { t } from "../../i18n";
import { normalizeEditableJVMModes } from "../../utils/jvmConnectionConfig";
import type { ConnectionModalStateApi } from "./useConnectionModalState";
import type { ConnectionModalLifecycleApi } from "./useConnectionModalLifecycle";

export interface UseConnectionModalChoicesInput {
  testResult: ConnectionModalStateApi['testResult'];
  setTestResult: ConnectionModalStateApi['setTestResult'];
  setTestErrorLogOpen: ConnectionModalStateApi['setTestErrorLogOpen'];
  setSSHConnectionProgress: ConnectionModalStateApi['setSSHConnectionProgress'];
  setSSHProgressPanelOpen: ConnectionModalStateApi['setSSHProgressPanelOpen'];
  setSSHHostKeyTrust: ConnectionModalStateApi['setSSHHostKeyTrust'];
  form: ConnectionModalStateApi['form'];
  setMongoMembers: ConnectionModalStateApi['setMongoMembers'];
  setRedisDbList: ConnectionModalStateApi['setRedisDbList'];
  darkMode: ConnectionModalStateApi['darkMode'];
  modalMutedTextStyle: ConnectionModalLifecycleApi['modalMutedTextStyle'];
  jvmPreferredMode: ConnectionModalStateApi['jvmPreferredMode'];
  normalizedJvmAllowedModes: ConnectionModalStateApi['normalizedJvmAllowedModes'];
}

export const useConnectionModalChoices = ({
  testResult,
  setTestResult,
  setTestErrorLogOpen,
  setSSHConnectionProgress,
  setSSHProgressPanelOpen,
  setSSHHostKeyTrust,
  form,
  setMongoMembers,
  setRedisDbList,
  darkMode,
  modalMutedTextStyle,
  jvmPreferredMode,
  normalizedJvmAllowedModes,
}: UseConnectionModalChoicesInput) => {
  const clearConnectionTestResultForChoice = () => {
    if (testResult) {
      setTestResult(null);
      setTestErrorLogOpen(false);
    }
    setSSHConnectionProgress(null);
    setSSHProgressPanelOpen(false);
    setSSHHostKeyTrust(null);
  };

  useEffect(() => {
    let unsubscribe: (() => void) | undefined;
    try {
      unsubscribe = EventsOn("connection:test-progress", (event: any) => {
        setSSHConnectionProgress((current) =>
          current ? applySSHConnectionProgressEvent(current, event) : current,
        );
      });
    } catch {
      // The browser/web-server client has no Wails event bridge. It still
      // receives the final test result and the progress panel resolves then.
    }
    return () => unsubscribe?.();
  }, []);

  const setChoiceFieldValue = (fieldName: string, value: string | boolean) => {
    clearConnectionTestResultForChoice();
    form.setFieldValue(fieldName, value);
    if (
      fieldName === "mongoTopology" ||
      fieldName === "mongoSrv" ||
      fieldName === "host" ||
      fieldName === "port"
    ) {
      setMongoMembers([]);
    }
    if (fieldName === "redisTopology") {
      const nextRedisTopology = String(value || "single").toLowerCase();
      const currentRedisPort = Number(form.getFieldValue("port") || 0);
      if (
        nextRedisTopology === "sentinel" &&
        (!currentRedisPort || currentRedisPort === 6379)
      ) {
        form.setFieldValue("port", 26379);
      } else if (
        nextRedisTopology !== "sentinel" &&
        currentRedisPort === 26379
      ) {
        form.setFieldValue("port", 6379);
      }
      const supportedDbs = buildRedisDatabaseList(
        form.getFieldValue("redisDB"),
        form.getFieldValue("includeRedisDatabases"),
      );
      setRedisDbList(supportedDbs);
      form.setFieldValue(
        "includeRedisDatabases",
        normalizeRedisDatabaseSelection(
          form.getFieldValue("includeRedisDatabases"),
          supportedDbs,
        ),
      );
      // Cluster/Sentinel 与 SSH 组合后端不支持：切换拓扑时关闭 SSH 开关，
      // 已填写的隧道字段保留在表单中，切回单机拓扑可恢复。
      if (
        !supportsRedisSshTunnel(nextRedisTopology) &&
        form.getFieldValue("useSSH")
      ) {
        form.setFieldValue("useSSH", false);
      }
    }
    if (fieldName === "proxyType") {
      const nextType = String(value || "socks5").toLowerCase();
      const currentPort = Number(form.getFieldValue("proxyPort") || 0);
      if (nextType === "http") {
        if (!currentPort || currentPort === 1080) {
          form.setFieldValue("proxyPort", 8080);
        }
      } else if (!currentPort || currentPort === 8080) {
        form.setFieldValue("proxyPort", 1080);
      }
    }
  };

  const renderChoiceCards = ({
    fieldName,
    value,
    options,
    minWidth = 180,
    onSelect,
    variant = "cards",
  }: {
    fieldName: string;
    value: string;
    options: ChoiceCardOption[];
    minWidth?: number;
    onSelect?: (value: string) => void;
    /** cards = 大卡片；segment = Demo 分段控件 */
    variant?: "cards" | "segment";
  }) => {
    const activeOption = options.find(
      (option) => String(value ?? "") === option.value,
    );
    if (variant === "segment") {
      return (
        <div className="gn-conn-mode-block">
          <Form.Item name={fieldName} hidden>
            <Input {...noAutoCapInputProps} />
          </Form.Item>
          <div className="gn-conn-mode-seg" role="group">
            {options.map((option) => {
              const active = String(value ?? "") === option.value;
              return (
                <button
                  key={option.value || "empty"}
                  type="button"
                  className="gn-conn-mode-seg-item"
                  aria-pressed={active}
                  onClick={() =>
                    onSelect
                      ? onSelect(option.value)
                      : setChoiceFieldValue(fieldName, option.value)
                  }
                >
                  {option.label}
                </button>
              );
            })}
          </div>
          {activeOption?.description ? (
            <div className="gn-conn-mode-hint">{activeOption.description}</div>
          ) : null}
        </div>
      );
    }
    return (
      <>
        <Form.Item name={fieldName} hidden>
          <Input {...noAutoCapInputProps} />
        </Form.Item>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: `repeat(auto-fit, minmax(${minWidth}px, 1fr))`,
            gap: 10,
          }}
        >
          {options.map((option) => {
            const active = String(value ?? "") === option.value;
            return (
              <button
                key={option.value || "empty"}
                type="button"
                aria-pressed={active}
                onClick={() =>
                  onSelect
                    ? onSelect(option.value)
                    : setChoiceFieldValue(fieldName, option.value)
                }
                style={{
                  textAlign: "left",
                  padding: "12px 14px",
                  borderRadius: 14,
                  border: active
                    ? darkMode
                      ? "1px solid rgba(255,214,102,0.42)"
                      : "1px solid rgba(22,119,255,0.36)"
                    : darkMode
                      ? "1px solid rgba(255,255,255,0.08)"
                      : "1px solid rgba(16,24,40,0.08)",
                  background: active
                    ? darkMode
                      ? "rgba(255,214,102,0.10)"
                      : "rgba(22,119,255,0.07)"
                    : darkMode
                      ? "rgba(255,255,255,0.03)"
                      : "rgba(16,24,40,0.03)",
                  color: darkMode ? "#f5f7ff" : "#162033",
                  cursor: "pointer",
                  transition: "all 120ms ease",
                  boxShadow: active
                    ? darkMode
                      ? "0 0 0 2px rgba(255,214,102,0.10)"
                      : "0 0 0 2px rgba(22,119,255,0.08)"
                    : "none",
                }}
              >
                <Space size={8} wrap>
                  <Text strong>{option.label}</Text>
                  {active ? (
                    <Tag color="blue">{t("connection.modal.choice.current")}</Tag>
                  ) : null}
                </Space>
                {option.description ? (
                  <div style={{ ...modalMutedTextStyle, marginTop: 6 }}>
                    {option.description}
                  </div>
                ) : null}
              </button>
            );
          })}
        </div>
      </>
    );
  };

  const applyJvmModeSelection = (
    nextModes: EditableJVMMode[],
    preferredMode?: EditableJVMMode,
  ) => {
    const normalizedModes = normalizeEditableJVMModes(nextModes);
    const resolvedModes = normalizedModes.length ? normalizedModes : ["jmx"];
    const resolvedPreferred =
      preferredMode && resolvedModes.includes(preferredMode)
        ? preferredMode
        : resolvedModes.includes(jvmPreferredMode as EditableJVMMode)
          ? (jvmPreferredMode as EditableJVMMode)
          : resolvedModes[0];
    form.setFieldsValue({
      jvmAllowedModes: resolvedModes,
      jvmPreferredMode: resolvedPreferred,
      jvmEndpointEnabled: resolvedModes.includes("endpoint"),
      jvmAgentEnabled: resolvedModes.includes("agent"),
    });
  };

  const handleJvmModeCardSelect = (mode: EditableJVMMode) => {
    const enabled = normalizedJvmAllowedModes.includes(mode);
    applyJvmModeSelection(
      enabled ? normalizedJvmAllowedModes : [...normalizedJvmAllowedModes, mode],
      mode,
    );
  };

  const handleJvmModeToggle = (
    mode: EditableJVMMode,
    event: React.MouseEvent<HTMLElement>,
  ) => {
    event.stopPropagation();
    const enabled = normalizedJvmAllowedModes.includes(mode);
    if (!enabled) {
      applyJvmModeSelection([...normalizedJvmAllowedModes, mode], mode);
      return;
    }
    if (normalizedJvmAllowedModes.length <= 1) {
      return;
    }
    const nextModes = normalizedJvmAllowedModes.filter((item) => item !== mode);
    applyJvmModeSelection(nextModes, nextModes[0]);
  };
  return {
    clearConnectionTestResultForChoice,
    setChoiceFieldValue,
    renderChoiceCards,
    handleJvmModeCardSelect,
    handleJvmModeToggle,
  };
};

export type ConnectionModalChoicesApi = ReturnType<typeof useConnectionModalChoices>;
