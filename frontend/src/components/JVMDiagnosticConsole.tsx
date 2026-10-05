import React from "react";
import {
  Alert,
  Button,
  Card,
  Empty,
  Input,
  message,
  Space,
  Tag,
  Typography,
} from "antd";
import {
  ClearOutlined,
  HistoryOutlined,
  PauseCircleOutlined,
  PlayCircleOutlined,
  ReloadOutlined,
  RocketOutlined,
  ToolOutlined,
} from "@ant-design/icons";
import Editor from "./MonacoEditor";
import type { TabData } from "../types";
import { formatJVMDiagnosticTransportLabel } from "../utils/jvmDiagnosticPresentation";
import JVMCommandPresetBar from "./jvm/JVMCommandPresetBar";
import JVMDiagnosticHistory from "./jvm/JVMDiagnosticHistory";
import JVMDiagnosticOutput from "./jvm/JVMDiagnosticOutput";
import {
    Text,
    Paragraph,
    DIAGNOSTIC_WORKFLOW_STEPS,
    commandEditorShellStyle,
    JVM_DIAGNOSTIC_EDITOR_LANGUAGE,
} from "./jvm/diagnosticConsole/jvmDiagnosticConsoleSupport";
import {
  useJVMDiagnosticConsoleState,
} from "./jvm/diagnosticConsole/hooks/useJVMDiagnosticConsoleState";
import {
  useJVMDiagnosticConsoleCommands,
} from "./jvm/diagnosticConsole/hooks/useJVMDiagnosticConsoleCommands";
export {
  isJVMDiagnosticTerminalPhase,
  createJVMDiagnosticLocalPendingChunk,
  createJVMDiagnosticRunningRecord,
} from "./jvm/diagnosticConsole/jvmDiagnosticConsoleSupport";

export type JVMDiagnosticConsoleProps = {
  tab: TabData;
};

const JVMDiagnosticConsole: React.FC<JVMDiagnosticConsoleProps> = ({ tab }) => {
  const {
    t, connection, draft, chunks, setDraft, appendOutput, clearOutput, darkMode, capabilities,
    records, setRecords, loading, setLoading, historyLoading, commandRunning, setCommandRunning,
    activeCommandId, setActiveCommandId, error, setError, activeCommandIdRef, terminalCommandIdsRef,
    redactDiagnosticContent, redactDiagnosticChunk, finishActiveCommand, diagnosticTransport,
    rpcConnectionConfig, effectiveSession, hasSession, loadAuditRecords, handleProbe,
    handleStartSession,
  } = useJVMDiagnosticConsoleState({ tab });

  const {
    handleExecuteCommand, handleCancelCommand, handleCommandEditorBeforeMount,
    handleCommandEditorMount,
  } = useJVMDiagnosticConsoleCommands({
    tab, rpcConnectionConfig, setError, t, effectiveSession, draft, activeCommandIdRef,
    terminalCommandIdsRef, setCommandRunning, setActiveCommandId, appendOutput, setRecords,
    connection, diagnosticTransport, redactDiagnosticContent, redactDiagnosticChunk,
    finishActiveCommand, loadAuditRecords, activeCommandId, setLoading, darkMode,
  });

  if (!connection) {
    return (
      <Empty
        description={t("jvm_diagnostic.connection_missing.message")}
        style={{ marginTop: 64 }}
      />
    );
  }

  const pageBackground = darkMode
    ? "radial-gradient(circle at top left, rgba(22,119,255,0.20), transparent 34%), linear-gradient(135deg, #101820 0%, #141414 54%, #1d2228 100%)"
    : "radial-gradient(circle at top left, rgba(22,119,255,0.16), transparent 32%), linear-gradient(135deg, #f4f8ff 0%, #f8fbff 48%, #ffffff 100%)";
  const heroBackground = darkMode
    ? "linear-gradient(135deg, rgba(22,119,255,0.18), rgba(82,196,26,0.07))"
    : "linear-gradient(135deg, rgba(22,119,255,0.12), rgba(19,194,194,0.06))";
  const panelBg = darkMode ? "rgba(18,24,32,0.86)" : "rgba(255,255,255,0.92)";
  const panelBorder = darkMode
    ? "1px solid rgba(255,255,255,0.08)"
    : "1px solid rgba(22,119,255,0.10)";
  const mutedPanelBg = darkMode
    ? "rgba(255,255,255,0.045)"
    : "rgba(22,119,255,0.045)";
  const cardStyle: React.CSSProperties = {
    borderRadius: 18,
    border: panelBorder,
    background: panelBg,
    boxShadow: darkMode
      ? "0 18px 42px rgba(0, 0, 0, 0.24)"
      : "0 16px 38px rgba(24, 54, 96, 0.07)",
  };
  const compactCardStyles = {
    header: {
      borderBottom: darkMode
        ? "1px solid rgba(255,255,255,0.07)"
        : "1px solid rgba(15,23,42,0.06)",
      padding: "14px 18px",
    },
    body: { padding: 18 },
  };
  const actionButtonStyle: React.CSSProperties = {
    height: 36,
    borderRadius: 12,
    paddingInline: 14,
    fontWeight: 600,
  };
  const renderCardTitle = (
    icon: React.ReactNode,
    title: string,
    description?: string,
  ) => (
    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
      <span
        style={{
          width: 30,
          height: 30,
          borderRadius: 10,
          display: "grid",
          placeItems: "center",
          color: darkMode ? "#91caff" : "#1677ff",
          background: darkMode
            ? "rgba(22,119,255,0.18)"
            : "rgba(22,119,255,0.10)",
          flexShrink: 0,
        }}
      >
        {icon}
      </span>
      <span style={{ display: "grid", gap: 2, minWidth: 0 }}>
        <Text strong>{title}</Text>
        {description ? (
          <Text type="secondary" style={{ fontSize: 12, fontWeight: 400 }}>
            {description}
          </Text>
        ) : null}
      </span>
    </div>
  );
  const renderCapabilityContent = () =>
    capabilities.length ? (
      <div style={{ display: "grid", gap: 10 }}>
        <Text strong>{t("jvm_diagnostic.capability_result.title")}</Text>
        <div style={{ display: "grid", gap: 8 }}>
          {capabilities.map((item) => (
            <div
              key={item.transport}
              style={{
                padding: 12,
                borderRadius: 14,
                border: darkMode
                  ? "1px solid rgba(255,255,255,0.08)"
                  : "1px solid rgba(22,119,255,0.12)",
                background: mutedPanelBg,
              }}
            >
              <Space size={6} wrap>
                <Tag color="processing">
                  {formatJVMDiagnosticTransportLabel(item.transport)}
                </Tag>
                <Tag color={item.canOpenSession ? "green" : "red"}>
                  {item.canOpenSession
                    ? t("jvm_diagnostic.capability_result.session_allowed")
                    : t("jvm_diagnostic.capability_result.session_denied")}
                </Tag>
                <Tag color={item.canStream ? "green" : "red"}>
                  {item.canStream
                    ? t("jvm_diagnostic.capability_result.streaming_supported")
                    : t("jvm_diagnostic.capability_result.streaming_unsupported")}
                </Tag>
                <Tag color={item.allowObserveCommands ? "green" : "red"}>
                  {item.allowObserveCommands
                    ? t("jvm_diagnostic.capability_result.observe_allowed")
                    : t("jvm_diagnostic.capability_result.observe_denied")}
                </Tag>
                {item.allowTraceCommands ? (
                  <Tag color="gold">
                    {t("jvm_diagnostic.capability_result.trace_allowed")}
                  </Tag>
                ) : null}
                {item.allowMutatingCommands ? (
                  <Tag color="red">
                    {t("jvm_diagnostic.capability_result.mutating_allowed")}
                  </Tag>
                ) : null}
              </Space>
            </div>
          ))}
        </div>
      </div>
    ) : (
      <Alert
        type="info"
        showIcon
        message={t("jvm_diagnostic.capability.empty.title")}
        description={t("jvm_diagnostic.capability.empty.description")}
      />
    );

  return (
    <div
      style={{
        padding: 18,
        display: "grid",
        gap: 16,
        height: "100%",
        minHeight: 0,
        overflow: "auto",
        alignContent: "start",
        background: pageBackground,
      }}
      data-jvm-diagnostic-console="true"
    >
      <Card
        variant="borderless"
        styles={{ body: { padding: 18 } }}
        style={{
          ...cardStyle,
          background: heroBackground,
        }}
      >
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "minmax(0, 1fr) auto",
            gap: 18,
            alignItems: "center",
          }}
        >
          <div style={{ minWidth: 0 }}>
            <Text type="secondary">{t("jvm_diagnostic.workbench.eyebrow")}</Text>
            <Typography.Title level={3} style={{ margin: "2px 0 6px" }}>
              {t("jvm_diagnostic.workbench.title")}
            </Typography.Title>
            <Paragraph type="secondary" style={{ marginBottom: 0 }}>
              <Text strong>{connection.name}</Text>
              <Text type="secondary">
                {" "}· {connection.config.host || "unknown"}:{connection.config.port || 0}
                {" "}· {formatJVMDiagnosticTransportLabel(diagnosticTransport)}
              </Text>
            </Paragraph>
          </div>

          <Space wrap size={8} style={{ justifyContent: "flex-end" }}>
            <Tag color={hasSession ? "green" : "default"}>
              {hasSession
                ? t("jvm_diagnostic.workbench.status.session_established")
                : t("jvm_diagnostic.workbench.status.no_session")}
            </Tag>
            {commandRunning ? (
              <Tag color="processing">
                {t("jvm_diagnostic.workbench.status.command_running")}
              </Tag>
            ) : null}
            <Button
              icon={<ToolOutlined />}
              style={actionButtonStyle}
              onClick={() => void handleProbe()}
              loading={loading}
            >
              {t("jvm_diagnostic.workbench.action.probe")}
            </Button>
            <Button
              icon={<RocketOutlined />}
              type={hasSession ? "default" : "primary"}
              style={actionButtonStyle}
              onClick={() => void handleStartSession()}
              loading={loading}
            >
              {hasSession
                ? t("jvm_diagnostic.workbench.action.restart_session")
                : t("jvm_diagnostic.workbench.action.start_session")}
            </Button>
            {hasSession ? (
              <Button
                icon={<PlayCircleOutlined />}
                type="primary"
                style={actionButtonStyle}
                onClick={() => void handleExecuteCommand()}
                loading={commandRunning}
              >
                {t("jvm_diagnostic.workbench.action.execute_command")}
              </Button>
            ) : null}
            {hasSession ? (
              <Button
                danger
                icon={<PauseCircleOutlined />}
                style={actionButtonStyle}
                disabled={!commandRunning || !effectiveSession?.sessionId || !activeCommandId}
                onClick={() => void handleCancelCommand()}
                loading={loading && commandRunning}
              >
                {t("jvm_diagnostic.workbench.action.cancel_command")}
              </Button>
            ) : null}
          </Space>
        </div>
        {error ? <Alert type="error" showIcon message={error} style={{ marginTop: 16 }} /> : null}
      </Card>

      <div
        style={{
          display: "grid",
          gap: 16,
          gridTemplateColumns:
            "minmax(min(100%, 520px), 1.16fr) minmax(min(100%, 340px), 0.84fr)",
          alignItems: "start",
        }}
      >
        <div style={{ display: "grid", gap: 16, minWidth: 0 }}>
          {!hasSession ? (
            <Card
              title={renderCardTitle(
                <RocketOutlined />,
                t("jvm_diagnostic.no_session.title"),
                t("jvm_diagnostic.no_session.description"),
              )}
              variant="borderless"
              style={cardStyle}
              styles={compactCardStyles}
            >
              <div style={{ display: "grid", gap: 16 }}>
                <Alert
                  type="info"
                  showIcon
                  message={t("jvm_diagnostic.no_session.alert.title")}
                  description={t("jvm_diagnostic.no_session.alert.description")}
                />
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns:
                      "repeat(auto-fit, minmax(min(100%, 180px), 1fr))",
                    gap: 10,
                  }}
                >
                  {DIAGNOSTIC_WORKFLOW_STEPS.map((step) => (
                    <div
                      key={step.index}
                      style={{
                        padding: 14,
                        borderRadius: 16,
                        border: darkMode
                          ? "1px solid rgba(255,255,255,0.08)"
                          : "1px solid rgba(22,119,255,0.12)",
                        background: mutedPanelBg,
                      }}
                    >
                      <Text
                        strong
                        style={{
                          color: darkMode ? "#91caff" : "#1677ff",
                          fontSize: 12,
                        }}
                      >
                        {step.index}
                      </Text>
                      <div style={{ marginTop: 6 }}>
                        <Text strong>{t(step.titleKey)}</Text>
                      </div>
                      <Paragraph type="secondary" style={{ margin: "6px 0 0" }}>
                        {t(step.descriptionKey)}
                      </Paragraph>
                    </div>
                  ))}
                </div>
                <Space wrap>
                  <Button
                    type="primary"
                    icon={<RocketOutlined />}
                    style={actionButtonStyle}
                    loading={loading}
                    onClick={() => void handleStartSession()}
                  >
                    {t("jvm_diagnostic.no_session.action.start")}
                  </Button>
                  <Button
                    icon={<ToolOutlined />}
                    style={actionButtonStyle}
                    loading={loading}
                    onClick={() => void handleProbe()}
                  >
                    {t("jvm_diagnostic.no_session.action.probe")}
                  </Button>
                </Space>
              </div>
            </Card>
          ) : (
            <>
              <Card
                title={renderCardTitle(
                  <PlayCircleOutlined />,
                  t("jvm_diagnostic.command_input.title"),
                  t("jvm_diagnostic.command_input.description"),
                )}
                variant="borderless"
                style={cardStyle}
                styles={compactCardStyles}
              >
                <div style={{ display: "grid", gap: 14 }}>
                  <div style={{ display: "grid", gap: 6 }}>
                    <Text strong>
                      {t("jvm_diagnostic.command_input.command_label")}
                    </Text>
                    <Paragraph type="secondary" style={{ marginBottom: 0 }}>
                      {t("jvm_diagnostic.command_input.command_description")}
                    </Paragraph>
                    <div
                      data-jvm-diagnostic-command-editor-shell="true"
                      style={commandEditorShellStyle(darkMode)}
                    >
                      <Editor
                        beforeMount={handleCommandEditorBeforeMount}
                        height={180}
                        language={JVM_DIAGNOSTIC_EDITOR_LANGUAGE}
                        theme={
                          darkMode ? "transparent-dark" : "transparent-light"
                        }
                        value={draft.command}
                        onMount={handleCommandEditorMount}
                        options={{
                          minimap: { enabled: false },
                          fontSize: 13,
                          automaticLayout: true,
                          scrollBeyondLastLine: false,
                          wordWrap: "on",
                          quickSuggestions: {
                            other: true,
                            comments: false,
                            strings: true,
                          },
                          suggestOnTriggerCharacters: true,
                          lineNumbers: "off",
                          folding: false,
                          glyphMargin: false,
                          renderLineHighlight: "all",
                          roundedSelection: true,
                        }}
                        onChange={(value) =>
                          setDraft(tab.id, {
                            command: value || "",
                            source: "manual",
                          })
                        }
                      />
                    </div>
                  </div>
                  <div style={{ display: "grid", gap: 6 }}>
                    <Text strong>
                      {t("jvm_diagnostic.command_input.reason_label")}
                    </Text>
                    <Input
                      value={draft.reason || ""}
                      placeholder={t(
                        "jvm_diagnostic.command_input.reason_placeholder",
                      )}
                      onChange={(event) =>
                        setDraft(tab.id, { reason: event.target.value })
                      }
                    />
                    <Text type="secondary">
                      {t("jvm_diagnostic.command_input.reason_help")}
                    </Text>
                  </div>
                </div>
              </Card>

              <Card
                title={renderCardTitle(
                  <ToolOutlined />,
                  t("jvm_diagnostic.command_templates.title"),
                )}
                variant="borderless"
                style={cardStyle}
                styles={compactCardStyles}
              >
                <JVMCommandPresetBar
                  onSelectPreset={(preset) =>
                    setDraft(tab.id, {
                      command: preset.command,
                      reason: preset.description,
                      source: "manual",
                    })
                  }
                />
              </Card>
            </>
          )}

          {hasSession || chunks.length ? (
            <Card
              title={renderCardTitle(
                <PlayCircleOutlined />,
                t("jvm_diagnostic.output.title"),
                t("jvm_diagnostic.output.description"),
              )}
              variant="borderless"
              style={cardStyle}
              styles={compactCardStyles}
            >
              <JVMDiagnosticOutput chunks={chunks} maxHeight={320} />
            </Card>
          ) : null}
        </div>

        <div style={{ display: "grid", gap: 16, minWidth: 0 }}>
          <Card
            title={renderCardTitle(
              <ToolOutlined />,
              t("jvm_diagnostic.session_capability.title"),
              t("jvm_diagnostic.session_capability.description"),
            )}
            variant="borderless"
            style={cardStyle}
            styles={compactCardStyles}
          >
            <Space direction="vertical" size={14} style={{ width: "100%" }}>
              <div
                style={{
                  display: "grid",
                  gap: 10,
                  padding: 14,
                  borderRadius: 16,
                  background: mutedPanelBg,
                }}
              >
                <Space size={6} wrap>
                  <Tag color={hasSession ? "green" : "default"}>
                    {hasSession
                      ? t("jvm_diagnostic.session_capability.status.session_established")
                      : t("jvm_diagnostic.session_capability.status.no_session")}
                  </Tag>
                  <Tag>{formatJVMDiagnosticTransportLabel(diagnosticTransport)}</Tag>
                  <Tag color={commandRunning ? "processing" : "green"}>
                    {commandRunning
                      ? t("jvm_diagnostic.session_capability.status.command_running")
                      : t("jvm_diagnostic.session_capability.status.idle")}
                  </Tag>
                </Space>
                {effectiveSession?.sessionId ? (
                  <Text
                    code
                    copyable
                    style={{ whiteSpace: "normal", wordBreak: "break-all" }}
                  >
                    {effectiveSession.sessionId}
                  </Text>
                ) : (
                  <Text type="secondary">
                    {t("jvm_diagnostic.session_capability.session_id_hint")}
                  </Text>
                )}
              </div>
              <Paragraph type="secondary" style={{ marginBottom: 0 }}>
                {t("jvm_diagnostic.session_capability.note")}
              </Paragraph>
              <Space wrap>
                <Button
                  size="small"
                  icon={<ClearOutlined />}
                  onClick={() => clearOutput(tab.id)}
                >
                  {t("jvm_diagnostic.session_capability.action.clear_output")}
                </Button>
                <Button
                  size="small"
                  icon={<ReloadOutlined />}
                  onClick={() => void loadAuditRecords()}
                  loading={historyLoading}
                >
                  {t("jvm_diagnostic.session_capability.action.refresh_history")}
                </Button>
              </Space>
              {renderCapabilityContent()}
            </Space>
          </Card>

          <Card
            title={renderCardTitle(
              <HistoryOutlined />,
              t("jvm_diagnostic.history.title"),
              t("jvm_diagnostic.history.description"),
            )}
            variant="borderless"
            style={cardStyle}
            styles={compactCardStyles}
          >
            <JVMDiagnosticHistory
              session={effectiveSession}
              records={records}
              showSession={false}
              maxHeight={340}
            />
          </Card>
        </div>
      </div>
    </div>
  );
};

export default JVMDiagnosticConsole;
