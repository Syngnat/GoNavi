import React, { type ReactNode } from "react";
import {
  Alert,
  Button,
  Checkbox,
  Form,
  Input,
  InputNumber,
  Radio,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
} from "antd";
import {
  ApiOutlined,
  CheckCircleFilled,
  ClusterOutlined,
  CloseCircleFilled,
  CodeOutlined,
  DatabaseOutlined,
  FileTextOutlined,
  GatewayOutlined,
  SafetyCertificateOutlined,
  ThunderboltOutlined,
} from "@ant-design/icons";

import {
  DB_ICON_TYPES,
  PRESET_ICON_COLORS,
  getDbDefaultColor,
  getDbIcon,
  getDbIconLabel,
} from "../DatabaseIcons";
import ConnectionModalMongoSections from "../ConnectionModalMongoSections";
import { t } from "../../i18n";
import {
  supportsConnectionReadOnlyMode,
} from "../../utils/connectionReadOnly";
import {
  getConnectionConfigLayoutKindLabel,
  getStoredSecretPlaceholder,
} from "../../utils/connectionModalPresentation";
import { getCustomConnectionDriverHelp } from "../../utils/driverImportGuidance";
import { noAutoCapInputProps } from "../../utils/inputAutoCap";
import {
  JVM_EDITABLE_MODES,
  normalizeEditableJVMModes,
} from "../../utils/jvmConnectionConfig";
import { resolveJVMModeMeta } from "../../utils/jvmRuntimePresentation";
import {
  getConnectionParamsPlaceholder,
  getUriPlaceholder,
} from "./connectionModalUri";
import ConnectionModalNetworkSecuritySection from "./ConnectionModalNetworkSecuritySection";
import type { MongoMemberInfo } from "../../types";
import ConnectionEnvironmentSelect from "../ConnectionEnvironmentSelect";
import { DEFAULT_CONNECTION_ENVIRONMENT } from "../../utils/connectionEnvironment";
import { supportsRedisSshTunnel } from "../../utils/redisTopologySsh";

const { Text } = Typography;

const CLICKHOUSE_PROTOCOL_OPTIONS: Array<{
  value: "auto" | "http" | "native";
  label?: string;
  labelKey?: string;
}> = [
  { value: "auto", labelKey: "connection.modal.field.clickHouseProtocol.auto" },
  { value: "http", label: "HTTP" },
  { value: "native", label: "Native" },
];

const OCEANBASE_PROTOCOL_OPTIONS: Array<{
  value: "mysql" | "oracle";
  label: string;
}> = [
  { value: "mysql", label: "MySQL" },
  { value: "oracle", label: "Oracle" },
];

const PRIMARY_USERNAME_OPTIONAL_TYPES = new Set([
  "mongodb",
  "elasticsearch",
  "chroma",
  "qdrant",
  "milvus",
  "rocketmq",
  "mqtt",
  "kafka",
  "rabbitmq",
  "nacos",
]);

// URI 操作反馈统一保留 4 秒，便于用户读取后自动回收空间。
const URI_FEEDBACK_AUTO_DISMISS_MS = 4000;

type ConnectionModalStep2Props = Record<string, any>;

const ConnectionModalStep2: React.FC<ConnectionModalStep2Props> = (props) => {
  const {
    activeConfigSection,
    activeNetworkConfig,
    buildRedisDatabaseList,
    clearConnectionTestResultForChoice,
    connectionConfigLayout,
    createCustomDsnRule,
    createUriAwareRequiredRule,
    currentDriverSnapshot,
    currentDriverUnavailableReason,
    currentDriverUpdateReason,
    customIconColor,
    customIconType,
    darkMode,
    dbList,
    dbType,
    discoveringMembers,
    form,
    getConnectionOptionCardStyle,
    handleCopyURI,
    handleDiscoverMongoMembers,
    handleGenerateURI,
    handleJvmModeCardSelect,
    handleJvmModeToggle,
    handleOracleModeChange,
    handleParseURI,
    handleSelectCertificateFile,
    handleSelectDatabaseFile,
    handleSelectSSHKeyFile,
    initialValues,
    isCustom,
    isFileDb,
    isJVM,
    isKafka,
    isMQTT,
    isMySQLLike,
    isOceanBaseOracle,
    isRedis,
    isRocketMQ,
    isSSLType,
    jvmDiagnosticEnabled,
    jvmDiagnosticTransport,
    jvmEnvironment,
    jvmPreferredMode,
    jvmSectionCardStyle,
    kafkaTopology,
    modalInnerSectionStyle,
    modalMutedTextStyle,
    mongoAuthMechanism,
    mongoMembers,
    mongoReadPreference,
    mongoSrv,
    mongoTopology,
    mqttTopology,
    mysqlTopology,
    normalizeRedisDatabaseSelection,
    normalizedJvmAllowedModes,
    oceanBaseProtocol,
    onOpenDriverManager,
    oracleMode,
    primaryPasswordVisible,
    handlePrimaryPasswordVisibleChange,
    proxyType,
    redisDbList,
    redisTopology,
    renderChoiceCards,
    renderConfigSectionCard,
    renderJvmSectionHeader,
    renderStoredSecretControls,
    resolvedTestResultMessage,
    resolvedUriFeedbackMessage,
    rocketmqTopology,
    selectingCertificateField,
    selectingDbFile,
    selectingSSHKey,
    setActiveConfigSection,
    setActiveNetworkConfig,
    setChoiceFieldValue,
    setCustomIconColor,
    setCustomIconType,
    setDbType,
    setMongoMembers,
    setRedisDbList,
    setTestErrorLogOpen,
    setTestResult,
    setUriFeedback,
    setUseHttpTunnel,
    setUseProxy,
    setUseSSH,
    setUseSSL,
    sslHintText,
    sslMode,
    supportsConnectionParams,
    supportsSSLCAPath,
    supportsSSLClientCertificate,
    testResult,
    tunnelSectionStyle,
    unsupportedJvmModeMessage,
    uriFeedback,
    useHttpTunnel,
    useProxy,
    useSSH,
    useSSL,
  } = props;

  // 默认折叠生产保护，避免默认表单内容溢出触发滚动条；保留用户按需展开的交互。
  const [readOnlyProtectionExpanded, setReadOnlyProtectionExpanded] =
    React.useState(false);

  React.useEffect(() => {
    setReadOnlyProtectionExpanded(false);
  }, [dbType]);

  React.useEffect(() => {
    if (!uriFeedback) return undefined;
    const dismissTimer = window.setTimeout(() => {
      setUriFeedback(null);
    }, URI_FEEDBACK_AUTO_DISMISS_MS);
    return () => window.clearTimeout(dismissTimer);
  }, [setUriFeedback, uriFeedback]);

  const renderStep2 = () => {
  const showConnectionReadOnlyField = supportsConnectionReadOnlyMode({
    type: dbType,
    driver: form.getFieldValue("driver"),
    oceanBaseProtocol,
  });
  const restrictDataEdit = Form.useWatch("restrictDataEdit", form) === true;
  const restrictStructureEdit =
    Form.useWatch("restrictStructureEdit", form) === true;
  const restrictScriptExecution =
    Form.useWatch("restrictScriptExecution", form) === true;
  const restrictDataImport =
    Form.useWatch("restrictDataImport", form) === true;
  const isNacosProtection =
    String(dbType || "").trim().toLowerCase() === "nacos";
  const supportsScriptExecutionProtection = !isNacosProtection;
  const connectionProtectionEnabledCount = [
    restrictDataEdit,
    restrictStructureEdit,
    supportsScriptExecutionProtection && restrictScriptExecution,
    restrictDataImport,
  ].filter(Boolean).length;

  const uriQuickBlock =
    !isCustom && !isJVM ? (
      <div className="gn-conn-uri-block">
        <div className="gn-conn-uri-block-top">
          <div>
            <span className="ttl">{t("connection.modal.config_section.uri.title")}</span>
            <span className="hint">{t("connection.modal.uri.optionalHint")}</span>
          </div>
        </div>
        <Form.Item name="uri" style={{ marginBottom: 8 }}>
          <Input.TextArea
            {...noAutoCapInputProps}
            rows={2}
            placeholder={getUriPlaceholder(dbType)}
          />
        </Form.Item>
        <Space
          size={8}
          className="gn-conn-uri-actions"
          style={{ marginBottom: uriFeedback ? 8 : 0 }}
          wrap
        >
          <Button size="small" onClick={handleParseURI}>
            {t("connection.modal.uri.action.parse")}
          </Button>
          <Button size="small" onClick={handleGenerateURI}>
            {t("connection.modal.uri.action.generate")}
          </Button>
          <Button size="small" onClick={handleCopyURI}>
            {t("connection.modal.uri.action.copy")}
          </Button>
        </Space>
        {uriFeedback && (
          <Alert
            showIcon
            closable
            type={uriFeedback.type}
            message={resolvedUriFeedbackMessage}
            onClose={() => setUriFeedback(null)}
            style={{ marginTop: 8, marginBottom: 0 }}
          />
        )}
        {renderStoredSecretControls({
          fieldName: "uri",
          clearKey: "opaqueURI",
          hasStoredSecret: initialValues?.hasOpaqueURI,
          clearLabel: t("connection.modal.uri.stored.clear"),
          description: t("connection.modal.uri.stored.description"),
        })}
      </div>
    ) : null;

  /** Demo 短标签；完整文案放 title，避免窄列换行 */
  const denseLabel = (shortText: string, fullTitle?: string) => (
    <span className="gn-conn-f-label" title={fullTitle || shortText}>
      {shortText}
    </span>
  );

  /** 集群模式附加节点 · 扁平面板（Demo: .mode-extra .el/.eh + 全宽输入） */
  const renderClusterHostsExtra = ({
    fieldName,
    labelKey,
    helpKey,
    placeholderKey,
  }: {
    fieldName: string;
    labelKey: string;
    helpKey: string;
    placeholderKey: string;
  }) => (
    <div className="gn-conn-mode-extra">
      <div className="gn-conn-el">{t(labelKey)}</div>
      <div className="gn-conn-eh">{t(helpKey)}</div>
      <Form.Item name={fieldName} style={{ marginBottom: 0 }}>
        <Select
          mode="tags"
          placeholder={t(placeholderKey)}
          tokenSeparators={[",", ";", " "]}
        />
      </Form.Item>
    </div>
  );

  const denseIdentityRows = (
    <div className="gn-conn-f-row">
      {denseLabel(
        t("connection.modal.dense.name"),
        t("connection.modal.field.name.label"),
      )}
      <div className="gn-conn-f-ctrl gn-conn-f-inline">
        <div className="gn-conn-w gn-conn-w-name">
          <Form.Item name="name" style={{ marginBottom: 0 }}>
            <Input
              {...noAutoCapInputProps}
              placeholder={
                isJVM
                  ? t("connection.modal.field.name.placeholder.jvm")
                  : t("connection.modal.field.name.placeholder.default")
              }
            />
          </Form.Item>
        </div>
        <div className="gn-conn-w gn-conn-w-env">
          <Form.Item
            name="environmentType"
            initialValue={DEFAULT_CONNECTION_ENVIRONMENT}
            style={{ marginBottom: 0 }}
          >
            <ConnectionEnvironmentSelect style={{ width: "100%" }} />
          </Form.Item>
        </div>
      </div>
    </div>
  );

  const baseInfoSection = (
    <div className="gn-conn-dense" style={{ display: "grid", gap: 4 }}>
      {uriQuickBlock}
      {uriQuickBlock ? (
        <div className="gn-conn-uri-divider">
          {t("connection.modal.uri.orManual")}
        </div>
      ) : null}

      <div style={{ display: "grid", gap: isCustom || isJVM ? 16 : 4 }}>

        {isCustom ? (
          <>
            {renderConfigSectionCard({
              sectionKey: "customDriver",
              icon: <CodeOutlined />,
              children: (
                <Form.Item
                  name="driver"
                  label={t("connection.modal.field.driver.label")}
                  rules={[
                    {
                      required: true,
                      message: t("connection.modal.field.driver.required"),
                    },
                  ]}
                  help={getCustomConnectionDriverHelp()}
                  style={{ marginBottom: 0 }}
                >
                  <Input
                    {...noAutoCapInputProps}
                    placeholder={t("connection.modal.field.driver.placeholder")}
                  />
                </Form.Item>
              ),
            })}
            {renderConfigSectionCard({
              sectionKey: "customDsn",
              icon: <FileTextOutlined />,
              children: (
                <>
                  <Form.Item
                    name="dsn"
                    label={t("connection.modal.field.dsn.label")}
                    rules={[createCustomDsnRule()]}
                  >
                    <Input.TextArea
                      {...noAutoCapInputProps}
                      rows={4}
                      placeholder={t("connection.modal.field.dsn.placeholder")}
                    />
                  </Form.Item>
                  {renderStoredSecretControls({
                    fieldName: "dsn",
                    clearKey: "opaqueDSN",
                    hasStoredSecret: initialValues?.hasOpaqueDSN,
                    clearLabel: t("connection.modal.field.dsn.clearSaved"),
                    description: t(
                      "connection.modal.field.dsn.savedDescription",
                    ),
                  })}
                </>
              ),
            })}
          </>
        ) : isJVM ? (
        <>
          {unsupportedJvmModeMessage && (
            <Alert
              type="warning"
              showIcon
              style={{ marginBottom: 16 }}
              message={t("connection.modal.jvm.unsupportedMode.alert")}
              description={unsupportedJvmModeMessage}
            />
          )}
          <div style={{ display: "grid", gap: 16 }}>
            <div style={jvmSectionCardStyle()}>
              {renderJvmSectionHeader(
                <GatewayOutlined />,
                t("connection.modal.jvm.target.title"),
                t("connection.modal.jvm.target.description"),
              )}
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "minmax(0, 1fr) 120px",
                  gap: 16,
                  alignItems: "start",
                }}
              >
                <Form.Item
                  name="host"
                  label={t("connection.modal.jvm.host.label")}
                  rules={[
                    {
                      required: true,
                      message: t("connection.modal.jvm.host.required"),
                    },
                  ]}
                  style={{ marginBottom: 0 }}
                >
                  <Input
                    {...noAutoCapInputProps}
                    placeholder={t("connection.modal.example", {
                      value: "localhost",
                    })}
                  />
                </Form.Item>
                <Form.Item
                  name="port"
                  label={t("connection.modal.jvm.port.label")}
                  rules={[
                    {
                      required: true,
                      message: t("connection.modal.jvm.port.required"),
                    },
                  ]}
                  style={{ marginBottom: 0 }}
                >
                  <InputNumber style={{ width: "100%" }} min={1} max={65535} />
                </Form.Item>
              </div>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
                  gap: 16,
                  marginTop: 16,
                }}
              >
                <div style={{ display: "grid", gap: 8 }}>
                  <Text strong>
                    {t("connection.modal.jvm.environment.title")}
                  </Text>
                  {renderChoiceCards({
                    fieldName: "jvmEnvironment",
                    value: String(jvmEnvironment),
                    minWidth: 120,
                    options: [
                      {
                        value: "dev",
                        label: t(
                          "connection.modal.jvm.environment.dev.label",
                        ),
                        description: t(
                          "connection.modal.jvm.environment.dev.description",
                        ),
                      },
                      {
                        value: "uat",
                        label: t(
                          "connection.modal.jvm.environment.staging.label",
                        ),
                        description: t(
                          "connection.modal.jvm.environment.staging.description",
                        ),
                      },
                      {
                        value: "prod",
                        label: t(
                          "connection.modal.jvm.environment.prod.label",
                        ),
                        description: t(
                          "connection.modal.jvm.environment.prod.description",
                        ),
                      },
                    ],
                  })}
                </div>
                <Form.Item
                  name="timeout"
                  label={t("connection.modal.network.timeout.label")}
                  rules={[
                    {
                      type: "number",
                      min: 1,
                      max: 300,
                      message: t("connection.modal.network.timeout.range"),
                    },
                  ]}
                  style={{ marginBottom: 0 }}
                >
                  <InputNumber
                    style={{ width: "100%" }}
                    min={1}
                    max={300}
                    placeholder={t("connection.modal.example", {
                      value: "30",
                    })}
                  />
                </Form.Item>
                <Form.Item
                  name="jvmReadOnly"
                  label={t("connection.modal.jvm.securityPolicy.label")}
                  valuePropName="checked"
                  style={{ marginBottom: 0 }}
                >
                  <Checkbox>{t("connection.modal.jvm.readonlyPreferred")}</Checkbox>
                </Form.Item>
              </div>
            </div>

            <div style={jvmSectionCardStyle()}>
              {renderJvmSectionHeader(
                <ClusterOutlined />,
                t("connection.modal.jvm.accessMode.title"),
                t("connection.modal.jvm.accessMode.description"),
              )}
              <Form.Item
                name="jvmAllowedModes"
                hidden
                rules={[
                  {
                    required: true,
                    message: t("connection.modal.jvm.accessMode.required"),
                  },
                ]}
              >
                <Select mode="multiple" />
              </Form.Item>
              <Form.Item
                name="jvmPreferredMode"
                hidden
                rules={[
                  {
                    required: true,
                    message: t("connection.modal.jvm.preferredMode.required"),
                  },
                ]}
              >
                <Input {...noAutoCapInputProps} />
              </Form.Item>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
                  gap: 14,
                }}
              >
                {JVM_EDITABLE_MODES.map((mode) => {
                  const meta = resolveJVMModeMeta(mode);
                  const enabled = normalizedJvmAllowedModes.includes(mode);
                  const preferred = jvmPreferredMode === mode;
                  return (
                    <div
                      key={mode}
                      role="button"
                      tabIndex={0}
                      onClick={() => handleJvmModeCardSelect(mode)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          handleJvmModeCardSelect(mode);
                        }
                      }}
                      aria-pressed={enabled}
                      style={{
                        textAlign: "left",
                        padding: 14,
                        borderRadius: 16,
                        border: enabled
                          ? darkMode
                            ? "1px solid rgba(255,214,102,0.36)"
                            : "1px solid rgba(22,119,255,0.34)"
                          : darkMode
                            ? "1px solid rgba(255,255,255,0.08)"
                            : "1px solid rgba(16,24,40,0.08)",
                        background: enabled
                          ? darkMode
                            ? "rgba(255,214,102,0.08)"
                            : "rgba(22,119,255,0.06)"
                          : darkMode
                            ? "rgba(255,255,255,0.03)"
                            : "rgba(16,24,40,0.03)",
                        boxShadow: preferred
                          ? darkMode
                            ? "0 0 0 2px rgba(255,214,102,0.12)"
                            : "0 0 0 2px rgba(22,119,255,0.10)"
                          : "none",
                        color: darkMode ? "#f5f7ff" : "#162033",
                        cursor: "pointer",
                        transition: "all 120ms ease",
                      }}
                    >
                      <Space size={8} wrap>
                        <Tag color={enabled ? "blue" : "default"}>
                          {meta.label}
                        </Tag>
                        {preferred ? (
                          <Tag color="green">
                            {t("connection.modal.jvm.tag.preferred")}
                          </Tag>
                        ) : null}
                        {!enabled ? (
                          <Tag>{t("connection.modal.jvm.tag.notEnabled")}</Tag>
                        ) : null}
                      </Space>
                      <div style={{ ...modalMutedTextStyle, marginTop: 8 }}>
                        {mode === "jmx"
                          ? t("connection.modal.jvm.mode.jmx.description")
                          : mode === "endpoint"
                            ? t(
                                "connection.modal.jvm.mode.endpoint.description",
                              )
                            : t("connection.modal.jvm.mode.agent.description")}
                      </div>
                      <Button
                        size="small"
                        type={enabled ? "default" : "primary"}
                        disabled={enabled && normalizedJvmAllowedModes.length <= 1}
                        onClick={(event) => handleJvmModeToggle(mode, event)}
                        style={{ marginTop: 12, borderRadius: 999 }}
                      >
                        {enabled
                          ? t("connection.modal.jvm.mode.disable")
                          : t("connection.modal.jvm.mode.enablePreferred")}
                      </Button>
                    </div>
                  );
                })}
              </div>
              <div style={{ ...modalMutedTextStyle, marginTop: 12 }}>
                {t("connection.modal.jvm.preferredSummary", {
                  mode: resolveJVMModeMeta(String(jvmPreferredMode || "jmx"))
                    .label,
                })}
              </div>
            </div>

            <div style={jvmSectionCardStyle()}>
              {renderJvmSectionHeader(
                <ApiOutlined />,
                "JMX",
                t("connection.modal.jvm.jmx.description"),
                <Tag color={normalizedJvmAllowedModes.includes("jmx") ? "green" : "default"}>
                  {normalizedJvmAllowedModes.includes("jmx")
                    ? t("connection.modal.jvm.tag.enabled")
                    : t("connection.modal.jvm.tag.notEnabled")}
                </Tag>,
              )}
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "minmax(0, 1fr) 120px",
                  gap: 16,
                }}
              >
                <Form.Item
                  name="jvmJmxHost"
                  label={t("connection.modal.jvm.jmx.host.label")}
                  style={{ marginBottom: 0 }}
                >
                  <Input
                    {...noAutoCapInputProps}
                    disabled={!normalizedJvmAllowedModes.includes("jmx")}
                    placeholder={t("connection.modal.jvm.jmx.host.placeholder")}
                  />
                </Form.Item>
                <Form.Item
                  name="jvmJmxPort"
                  label={t("connection.modal.jvm.jmx.port.label")}
                  style={{ marginBottom: 0 }}
                >
                  <InputNumber
                    style={{ width: "100%" }}
                    min={1}
                    max={65535}
                    disabled={!normalizedJvmAllowedModes.includes("jmx")}
                    placeholder={t("connection.modal.jvm.jmx.port.placeholder")}
                  />
                </Form.Item>
              </div>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
                  gap: 16,
                  marginTop: 16,
                }}
              >
                <Form.Item
                  name="jvmJmxUsername"
                  label={t("connection.modal.jvm.jmx.username.label")}
                  style={{ marginBottom: 0 }}
                >
                  <Input
                    {...noAutoCapInputProps}
                    disabled={!normalizedJvmAllowedModes.includes("jmx")}
                    placeholder={t(
                      "connection.modal.jvm.jmx.username.placeholder",
                    )}
                  />
                </Form.Item>
                <Form.Item
                  name="jvmJmxPassword"
                  label={t("connection.modal.jvm.jmx.password.label")}
                  style={{ marginBottom: 0 }}
                >
                  <Input.Password
                    {...noAutoCapInputProps}
                    disabled={!normalizedJvmAllowedModes.includes("jmx")}
                    placeholder={t(
                      "connection.modal.jvm.jmx.password.placeholder",
                    )}
                  />
                </Form.Item>
              </div>
            </div>

            <div style={jvmSectionCardStyle()}>
              {renderJvmSectionHeader(
                <CodeOutlined />,
                "Endpoint",
                t("connection.modal.jvm.endpoint.description"),
                <Tag
                  color={
                    normalizedJvmAllowedModes.includes("endpoint")
                      ? "green"
                      : "default"
                  }
                >
                  {normalizedJvmAllowedModes.includes("endpoint")
                    ? t("connection.modal.jvm.tag.enabled")
                    : t("connection.modal.jvm.tag.notEnabled")}
                </Tag>,
              )}
              <Form.Item
                name="jvmEndpointBaseUrl"
                label={t("connection.modal.jvm.endpoint.address.label")}
                rules={[
                  {
                    required: jvmPreferredMode === "endpoint",
                    message: t(
                      "connection.modal.jvm.endpoint.address.required",
                    ),
                  },
                ]}
                help={t("connection.modal.jvm.endpoint.address.help")}
              >
                <Input
                  {...noAutoCapInputProps}
                  disabled={!normalizedJvmAllowedModes.includes("endpoint")}
                  placeholder={t(
                    "connection.modal.jvm.endpoint.address.placeholder",
                  )}
                />
              </Form.Item>
              <Form.Item
                name="jvmEndpointApiKey"
                label={t("connection.modal.jvm.endpoint.apiKey.label")}
                style={{ marginBottom: 0 }}
              >
                <Input.Password
                  {...noAutoCapInputProps}
                  disabled={!normalizedJvmAllowedModes.includes("endpoint")}
                  placeholder={t(
                    "connection.modal.jvm.endpoint.apiKey.placeholder",
                  )}
                />
              </Form.Item>
            </div>

            <div style={jvmSectionCardStyle()}>
              {renderJvmSectionHeader(
                <ThunderboltOutlined />,
                "Agent",
                t("connection.modal.jvm.agent.description"),
                <Tag color={normalizedJvmAllowedModes.includes("agent") ? "green" : "default"}>
                  {normalizedJvmAllowedModes.includes("agent")
                    ? t("connection.modal.jvm.tag.enabled")
                    : t("connection.modal.jvm.tag.notEnabled")}
                </Tag>,
              )}
              <Form.Item
                name="jvmAgentBaseUrl"
                label={t("connection.modal.jvm.agent.address.label")}
                rules={[
                  {
                    required: jvmPreferredMode === "agent",
                    message: t("connection.modal.jvm.agent.address.required"),
                  },
                ]}
                help={t("connection.modal.jvm.agent.address.help")}
              >
                <Input
                  {...noAutoCapInputProps}
                  disabled={!normalizedJvmAllowedModes.includes("agent")}
                  placeholder={t(
                    "connection.modal.jvm.agent.address.placeholder",
                  )}
                />
              </Form.Item>
              <Form.Item
                name="jvmAgentApiKey"
                label={t("connection.modal.jvm.agent.apiKey.label")}
                style={{ marginBottom: 0 }}
              >
                <Input.Password
                  {...noAutoCapInputProps}
                  disabled={!normalizedJvmAllowedModes.includes("agent")}
                  placeholder={t(
                    "connection.modal.jvm.agent.apiKey.placeholder",
                  )}
                />
              </Form.Item>
            </div>

            <div style={jvmSectionCardStyle()}>
              {renderJvmSectionHeader(
                <SafetyCertificateOutlined />,
                t("connection.modal.jvm.diagnostic.title"),
                t("connection.modal.jvm.diagnostic.description"),
                <Form.Item
                  name="jvmDiagnosticEnabled"
                  valuePropName="checked"
                  style={{ marginBottom: 0 }}
                >
                  <Switch
                    checkedChildren={t("connection.modal.jvm.switch.on")}
                    unCheckedChildren={t("connection.modal.jvm.switch.off")}
                  />
                </Form.Item>,
              )}
              {jvmDiagnosticEnabled ? (
                <>
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "220px minmax(0, 1fr)",
                      gap: 16,
                    }}
                  >
                    <div style={{ display: "grid", gap: 8 }}>
                      <Text strong>
                        {t("connection.modal.jvm.diagnostic.transport.label")}
                      </Text>
                      {renderChoiceCards({
                        fieldName: "jvmDiagnosticTransport",
                        value: String(jvmDiagnosticTransport),
                        options: [
                          {
                            value: "agent-bridge",
                            label: t(
                              "connection.modal.jvm.diagnostic.transport.agent_bridge",
                            ),
                            description: t(
                              "connection.modal.jvm.diagnostic.transport.agentBridge.description",
                            ),
                          },
                          {
                            value: "arthas-tunnel",
                            label: t(
                              "connection.modal.jvm.diagnostic.transport.arthas_tunnel",
                            ),
                            description: t(
                              "connection.modal.jvm.diagnostic.transport.arthasTunnel.description",
                            ),
                          },
                        ],
                      })}
                    </div>
                    <Form.Item
                      name="jvmDiagnosticBaseUrl"
                      label={
                        jvmDiagnosticTransport === "arthas-tunnel"
                          ? t(
                              "connection.modal.jvm.diagnostic.arthasTunnelAddress.label",
                            )
                          : t(
                              "connection.modal.jvm.diagnostic.bridgeAddress.label",
                            )
                      }
                      rules={[
                        {
                          required: true,
                          message:
                            jvmDiagnosticTransport === "arthas-tunnel"
                              ? t(
                                  "connection.modal.jvm.diagnostic.arthasTunnelAddress.required",
                                )
                              : t(
                                  "connection.modal.jvm.diagnostic.bridgeAddress.required",
                                ),
                        },
                      ]}
                      help={
                        jvmDiagnosticTransport === "arthas-tunnel"
                          ? t(
                              "connection.modal.jvm.diagnostic.arthasTunnelAddress.help",
                            )
                          : t(
                              "connection.modal.jvm.diagnostic.bridgeAddress.help",
                            )
                      }
                    >
                      <Input
                        {...noAutoCapInputProps}
                        placeholder={
                          jvmDiagnosticTransport === "arthas-tunnel"
                            ? "http://127.0.0.1:7777"
                            : "http://127.0.0.1:19091/gonavi/diag"
                        }
                      />
                    </Form.Item>
                  </div>
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "minmax(0, 1fr) 220px",
                      gap: 16,
                    }}
                  >
                    <Form.Item
                      name="jvmDiagnosticTargetId"
                      label={
                        jvmDiagnosticTransport === "arthas-tunnel"
                          ? t(
                              "connection.modal.jvm.diagnostic.targetId.agentId.label",
                            )
                          : t(
                              "connection.modal.jvm.diagnostic.targetId.label",
                            )
                      }
                      rules={
                        jvmDiagnosticTransport === "arthas-tunnel"
                          ? [
                              {
                                required: true,
                                message: t(
                                  "connection.modal.jvm.diagnostic.targetId.required",
                                ),
                              },
                            ]
                          : undefined
                      }
                      help={
                        jvmDiagnosticTransport === "arthas-tunnel"
                          ? t(
                              "connection.modal.jvm.diagnostic.targetId.arthasHelp",
                            )
                          : t(
                              "connection.modal.jvm.diagnostic.targetId.bridgeHelp",
                            )
                      }
                    >
                      <Input
                        {...noAutoCapInputProps}
                        placeholder={
                          jvmDiagnosticTransport === "arthas-tunnel"
                            ? t("connection.modal.example", {
                                value: "orders-app_A1B2C3D4E5",
                              })
                            : t("connection.modal.example", {
                                value: "orders-prod-01",
                              })
                        }
                      />
                    </Form.Item>
                    <Form.Item
                      name="jvmDiagnosticTimeoutSeconds"
                      label={t(
                        "connection.modal.jvm.diagnostic.timeout.label",
                      )}
                      rules={[
                        {
                          type: "number",
                          min: 1,
                          max: 300,
                          message: t(
                            "connection.modal.jvm.diagnostic.timeout.range",
                          ),
                        },
                      ]}
                    >
                      <InputNumber style={{ width: "100%" }} min={1} max={300} />
                    </Form.Item>
                  </div>
                  <Form.Item
                    name="jvmDiagnosticApiKey"
                    label={t("connection.modal.jvm.diagnostic.apiKey.label")}
                  >
                    <Input.Password
                      {...noAutoCapInputProps}
                      placeholder={t(
                        "connection.modal.jvm.diagnostic.apiKey.placeholder",
                      )}
                    />
                  </Form.Item>
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns:
                        "repeat(auto-fit, minmax(180px, 1fr))",
                      gap: 10,
                    }}
                  >
                    {[
                      {
                        name: "jvmDiagnosticAllowObserveCommands",
                        label: t(
                          "connection.modal.jvm.diagnostic.command.observe.label",
                        ),
                        description: t(
                          "connection.modal.jvm.diagnostic.command.observe.description",
                        ),
                      },
                      {
                        name: "jvmDiagnosticAllowTraceCommands",
                        label: t(
                          "connection.modal.jvm.diagnostic.command.trace.label",
                        ),
                        description: t(
                          "connection.modal.jvm.diagnostic.command.trace.description",
                        ),
                      },
                      {
                        name: "jvmDiagnosticAllowMutatingCommands",
                        label: t(
                          "connection.modal.jvm.diagnostic.command.mutating.label",
                        ),
                        description: t(
                          "connection.modal.jvm.diagnostic.command.mutating.description",
                        ),
                      },
                    ].map((item) => (
                      <div
                        key={item.name}
                        style={{
                          padding: 12,
                          borderRadius: 14,
                          background: darkMode
                            ? "rgba(255,255,255,0.04)"
                            : "rgba(16,24,40,0.04)",
                        }}
                      >
                        <Form.Item
                          name={item.name}
                          valuePropName="checked"
                          style={{ marginBottom: 6 }}
                        >
                          <Checkbox>{item.label}</Checkbox>
                        </Form.Item>
                        <div style={modalMutedTextStyle}>
                          {item.description}
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              ) : (
                <div
                  style={{
                    ...modalMutedTextStyle,
                    padding: "10px 12px",
                    borderRadius: 12,
                    background: darkMode
                      ? "rgba(255,255,255,0.04)"
                      : "rgba(16,24,40,0.04)",
                  }}
                >
                  {t("connection.modal.jvm.diagnostic.disabledHint")}
                </div>
              )}
            </div>
          </div>
        </>
        ) : (
          <>
            {denseIdentityRows}

            {/* 主机 / 文件 · 密排 */}
            <div className="gn-conn-f-row">
              {denseLabel(
                isFileDb
                  ? t("connection.modal.dense.file")
                  : t("connection.modal.dense.host"),
                isFileDb
                  ? t("connection.modal.field.filePath.label")
                  : t("connection.modal.field.host.label"),
              )}
              <div className="gn-conn-f-ctrl gn-conn-f-inline">
                <div
                  className={`gn-conn-w ${isFileDb ? "gn-conn-w-grow" : "gn-conn-w-host"}`}
                >
                  <Form.Item
                    name="host"
                    rules={[
                      createUriAwareRequiredRule(
                        t("connection.modal.field.addressPath.required"),
                      ),
                    ]}
                    style={{ marginBottom: 0 }}
                  >
                    <Input
                      {...noAutoCapInputProps}
                      placeholder={
                        isFileDb
                          ? dbType === "duckdb"
                            ? "/path/to/db.duckdb"
                            : "/path/to/db.sqlite"
                          : "localhost"
                      }
                    />
                  </Form.Item>
                </div>
                {isFileDb ? (
                  <Button
                    onClick={handleSelectDatabaseFile}
                    loading={selectingDbFile}
                  >
                    {t("connection.modal.action.browse")}
                  </Button>
                ) : (
                  <div className="gn-conn-w gn-conn-w-port">
                    <Form.Item
                      name="port"
                      rules={[
                        createUriAwareRequiredRule(
                          t("connection.modal.field.port.required"),
                          (value: unknown) => Number(value) > 0,
                        ),
                      ]}
                      style={{ marginBottom: 0 }}
                    >
                      <InputNumber
                        style={{ width: "100%" }}
                        controls={false}
                      />
                    </Form.Item>
                  </div>
                )}
                {!isFileDb &&
                  (isMySQLLike ||
                    dbType === "postgres" ||
                    dbType === "kingbase" ||
                    dbType === "highgo" ||
                    dbType === "vastbase" ||
                    dbType === "opengauss" ||
                    dbType === "gaussdb" ||
                    dbType === "trino" ||
                    dbType === "mongodb") && (
                    <div className="gn-conn-w gn-conn-w-db">
                      <Form.Item name="database" style={{ marginBottom: 0 }}>
                        <Input
                          {...noAutoCapInputProps}
                          aria-label={t(
                            "connection.modal.field.defaultDatabase.label",
                          )}
                          placeholder={t("connection.modal.dense.db")}
                        />
                      </Form.Item>
                    </div>
                  )}
              </div>
            </div>

            {dbType === "nacos" && (
              <div className="gn-conn-f-row" data-align="start">
                {denseLabel(
                  t("connection.modal.field.nacosNamespaceId.label"),
                )}
                <div className="gn-conn-f-ctrl">
                  <Form.Item
                    name="nacosNamespaceId"
                    style={{ marginBottom: 0 }}
                  >
                    <Input
                      {...noAutoCapInputProps}
                      maxLength={256}
                      placeholder={t(
                        "connection.modal.field.nacosNamespaceId.placeholder",
                      )}
                    />
                  </Form.Item>
                  <div className="gn-conn-mode-hint">
                    {t("connection.modal.field.nacosNamespaceId.help")}
                  </div>
                </div>
              </div>
            )}

            {dbType === "clickhouse" && (
              <div className="gn-conn-f-row">
                {denseLabel(
                  t("connection.modal.dense.protocol"),
                  t("connection.modal.field.protocol.label"),
                )}
                <div className="gn-conn-f-ctrl gn-conn-f-inline">
                  <Form.Item
                    name="clickHouseProtocol"
                    style={{ marginBottom: 0, minWidth: 140 }}
                  >
                    <Select
                      style={{ minWidth: 140 }}
                      options={CLICKHOUSE_PROTOCOL_OPTIONS.map((option) => ({
                        ...option,
                        label: option.labelKey
                          ? t(option.labelKey)
                          : option.label,
                      }))}
                      onChange={() => clearConnectionTestResultForChoice()}
                    />
                  </Form.Item>
                </div>
              </div>
            )}

            {dbType === "oceanbase" && (
              <div className="gn-conn-f-row" data-align="start">
                {denseLabel(
                  t("connection.modal.dense.protocol"),
                  t("connection.modal.field.oceanBaseProtocol.label"),
                )}
                <div className="gn-conn-f-ctrl">
                  <Form.Item
                    name="oceanBaseProtocol"
                    style={{ marginBottom: 0, minWidth: 140 }}
                  >
                    <Select
                      style={{ minWidth: 140 }}
                      options={OCEANBASE_PROTOCOL_OPTIONS}
                      onChange={() => {
                        form.setFieldsValue({ mysqlTopology: "single" });
                        clearConnectionTestResultForChoice();
                      }}
                    />
                  </Form.Item>
                  <div className="gn-conn-mode-hint">
                    {t("connection.modal.field.oceanBaseProtocol.help.primary")}
                  </div>
                </div>
              </div>
            )}

            {dbType === "kafka" && (
              <div className="gn-conn-f-row">
                {denseLabel(
                  t("connection.modal.dense.topic"),
                  t("connection.modal.messageQueue.kafka.defaultTopic.label"),
                )}
                <div className="gn-conn-f-ctrl">
                  <Form.Item name="database" style={{ marginBottom: 0 }}>
                    <Input
                      {...noAutoCapInputProps}
                      placeholder={t(
                        "connection.modal.messageQueue.kafka.defaultTopic.placeholder",
                      )}
                    />
                  </Form.Item>
                </div>
              </div>
            )}

            {dbType === "rocketmq" && (
              <div className="gn-conn-f-row">
                {denseLabel(
                  t("connection.modal.dense.topic"),
                  t(
                    "connection.modal.messageQueue.rocketmq.defaultTopic.label",
                  ),
                )}
                <div className="gn-conn-f-ctrl">
                  <Form.Item name="database" style={{ marginBottom: 0 }}>
                    <Input
                      {...noAutoCapInputProps}
                      placeholder={t(
                        "connection.modal.messageQueue.rocketmq.defaultTopic.placeholder",
                      )}
                    />
                  </Form.Item>
                </div>
              </div>
            )}

            {dbType === "mqtt" && (
              <div className="gn-conn-f-row">
                {denseLabel(
                  t("connection.modal.dense.topic"),
                  t(
                    "connection.modal.messageQueue.mqtt.defaultTopicFilter.label",
                  ),
                )}
                <div className="gn-conn-f-ctrl">
                  <Form.Item name="database" style={{ marginBottom: 0 }}>
                    <Input
                      {...noAutoCapInputProps}
                      placeholder={t(
                        "connection.modal.messageQueue.mqtt.defaultTopicFilter.placeholder",
                      )}
                    />
                  </Form.Item>
                </div>
              </div>
            )}

            {dbType === "rabbitmq" && (
              <div className="gn-conn-f-row">
                {denseLabel(
                  t("connection.modal.dense.vhost"),
                  t(
                    "connection.modal.messageQueue.rabbitmq.defaultVirtualHost.label",
                  ),
                )}
                <div className="gn-conn-f-ctrl">
                  <Form.Item name="database" style={{ marginBottom: 0 }}>
                    <Input
                      {...noAutoCapInputProps}
                      placeholder={t(
                        "connection.modal.messageQueue.rabbitmq.defaultVirtualHost.placeholder",
                      )}
                    />
                  </Form.Item>
                </div>
              </div>
            )}

            {dbType === "oracle" && (
              <div className="gn-conn-f-row">
                {denseLabel(
                  t("connection.modal.dense.mode"),
                  t("connection.modal.field.oracleMode.label"),
                )}
                <div className="gn-conn-f-ctrl">
                  <Form.Item name="oracleMode" style={{ marginBottom: 0 }}>
                    <Radio.Group onChange={handleOracleModeChange}>
                      <Radio value="service">
                        {t("connection.modal.field.oracleMode.service")}
                      </Radio>
                      <Radio value="sid">
                        {t("connection.modal.field.oracleMode.sid")}
                      </Radio>
                    </Radio.Group>
                  </Form.Item>
                </div>
              </div>
            )}

            {(dbType === "oracle" || isOceanBaseOracle) && (
              <div className="gn-conn-f-row">
                {denseLabel(
                  t("connection.modal.dense.service"),
                  dbType === "oracle" && oracleMode === "sid"
                    ? t("connection.modal.field.sid.label")
                    : isOceanBaseOracle
                      ? t("connection.modal.field.oceanBaseServiceName.label")
                      : t("connection.modal.field.serviceName.label"),
                )}
                <div className="gn-conn-f-ctrl">
                  <Form.Item
                    name="database"
                    rules={
                      isOceanBaseOracle
                        ? []
                        : [
                            createUriAwareRequiredRule(
                              dbType === "oracle" && oracleMode === "sid"
                                ? t("connection.modal.field.sid.required")
                                : t(
                                    "connection.modal.field.serviceName.required",
                                  ),
                            ),
                          ]
                    }
                    style={{ marginBottom: 0 }}
                  >
                    <Input
                      {...noAutoCapInputProps}
                      placeholder={
                        dbType === "oracle" && oracleMode === "sid"
                          ? t("connection.modal.field.sid.placeholder")
                          : t(
                              "connection.modal.field.serviceName.placeholder",
                            )
                      }
                    />
                  </Form.Item>
                </div>
              </div>
            )}

            {/* 认证 · 密排（Demo：认证行 → 库范围 → 勾选 → 模式 → 生产保护） */}
            {!isFileDb && !isRedis && (
              <>
                <div className="gn-conn-f-row">
                  {denseLabel(
                    t("connection.modal.dense.auth"),
                    t("connection.modal.field.username.label"),
                  )}
                  <div className="gn-conn-f-ctrl gn-conn-f-inline">
                    <div className="gn-conn-w gn-conn-w-user">
                      <Form.Item
                        name="user"
                        rules={
                          PRIMARY_USERNAME_OPTIONAL_TYPES.has(dbType)
                            ? []
                            : [
                                createUriAwareRequiredRule(
                                  t("connection.modal.field.username.required"),
                                ),
                              ]
                        }
                        style={{ marginBottom: 0 }}
                      >
                        <Input
                          {...noAutoCapInputProps}
                          placeholder={
                            PRIMARY_USERNAME_OPTIONAL_TYPES.has(dbType)
                              ? t(
                                  "connection.modal.field.username.optional_placeholder",
                                )
                              : t("connection.modal.field.username.label")
                          }
                        />
                      </Form.Item>
                    </div>
                    <div className="gn-conn-w gn-conn-w-pass">
                      <Form.Item name="password" style={{ marginBottom: 0 }}>
                        <Input.Password
                          {...noAutoCapInputProps}
                          visibilityToggle={{
                            visible: primaryPasswordVisible,
                            onVisibleChange: handlePrimaryPasswordVisibleChange,
                          }}
                          placeholder={getStoredSecretPlaceholder({
                            hasStoredSecret: initialValues?.hasPrimaryPassword,
                            emptyPlaceholder: t(
                              "connection.modal.field.password.placeholder",
                            ),
                            retainedLabel: t(
                              "connection.modal.field.password.retained",
                            ),
                          })}
                        />
                      </Form.Item>
                    </div>
                  </div>
                </div>
                {initialValues?.hasPrimaryPassword
                  ? renderStoredSecretControls({
                      fieldName: "password",
                      clearKey: "primaryPassword",
                      hasStoredSecret: initialValues?.hasPrimaryPassword,
                      clearLabel: t(
                        "connection.modal.secret.clear_saved_password",
                      ),
                      description: t("connection.modal.secret.saved_password"),
                    })
                  : null}
              </>
            )}

            {isRedis && (
              <>
                <div className="gn-conn-f-row">
                  {denseLabel(
                    t("connection.modal.dense.auth"),
                    t("connection.modal.field.username.label"),
                  )}
                  <div className="gn-conn-f-ctrl gn-conn-f-inline">
                    <div className="gn-conn-w gn-conn-w-user">
                      <Form.Item name="user" style={{ marginBottom: 0 }}>
                        <Input
                          {...noAutoCapInputProps}
                          placeholder={t(
                            "connection.modal.field.username.optional_placeholder",
                          )}
                        />
                      </Form.Item>
                    </div>
                    <div className="gn-conn-w gn-conn-w-pass">
                      <Form.Item name="password" style={{ marginBottom: 0 }}>
                        <Input.Password
                          {...noAutoCapInputProps}
                          visibilityToggle={{
                            visible: primaryPasswordVisible,
                            onVisibleChange: handlePrimaryPasswordVisibleChange,
                          }}
                          placeholder={getStoredSecretPlaceholder({
                            hasStoredSecret: initialValues?.hasPrimaryPassword,
                            emptyPlaceholder: t(
                              "connection.modal.field.redisPassword.placeholder",
                            ),
                            retainedLabel: t(
                              "connection.modal.field.redisPassword.retained",
                            ),
                          })}
                        />
                      </Form.Item>
                    </div>
                  </div>
                </div>
                {initialValues?.hasPrimaryPassword
                  ? renderStoredSecretControls({
                      fieldName: "password",
                      clearKey: "primaryPassword",
                      hasStoredSecret: initialValues?.hasPrimaryPassword,
                      clearLabel: t(
                        "connection.modal.secret.clear_saved_password",
                      ),
                      description: t(
                        "connection.modal.secret.saved_redis_password",
                      ),
                    })
                  : null}
              </>
            )}

            {isRedis && redisTopology === "sentinel" && (
              <>
                <div className="gn-conn-f-row">
                  {denseLabel(
                    t("connection.modal.dense.auth"),
                    t("connection.modal.redis.credentials.sentinelUser.label"),
                  )}
                  <div className="gn-conn-f-ctrl gn-conn-f-inline">
                    <div className="gn-conn-w gn-conn-w-user">
                      <Form.Item
                        name="redisSentinelUser"
                        style={{ marginBottom: 0 }}
                      >
                        <Input
                          {...noAutoCapInputProps}
                          placeholder={t(
                            "connection.modal.redis.credentials.sentinelUser.placeholder",
                          )}
                        />
                      </Form.Item>
                    </div>
                    <div className="gn-conn-w gn-conn-w-pass">
                      <Form.Item
                        name="redisSentinelPassword"
                        style={{ marginBottom: 0 }}
                      >
                        <Input.Password
                          {...noAutoCapInputProps}
                          placeholder={getStoredSecretPlaceholder({
                            hasStoredSecret:
                              initialValues?.hasRedisSentinelPassword,
                            emptyPlaceholder: t(
                              "connection.modal.redis.credentials.sentinelPassword.placeholder.empty",
                            ),
                            retainedLabel: t(
                              "connection.modal.redis.credentials.sentinelPassword.placeholder.retained",
                            ),
                          })}
                        />
                      </Form.Item>
                    </div>
                  </div>
                </div>
                {initialValues?.hasRedisSentinelPassword
                  ? renderStoredSecretControls({
                      fieldName: "redisSentinelPassword",
                      clearKey: "redisSentinelPassword",
                      hasStoredSecret: initialValues?.hasRedisSentinelPassword,
                      clearLabel: t(
                        "connection.modal.redis.credentials.sentinelPassword.clear",
                      ),
                      description: t(
                        "connection.modal.redis.credentials.sentinelPassword.description",
                      ),
                    })
                  : null}
              </>
            )}

            {/* 固定库范围保留精确匹配语义，避免历史下划线库名被通配符规则放宽。 */}
            {!isFileDb && !isRedis && !isKafka && (
              <>
                <div className="gn-conn-f-row">
                  {denseLabel(
                    t("connection.modal.dense.scopeExact"),
                    t("connection.modal.field.displayDatabases.help"),
                  )}
                  <div className="gn-conn-f-ctrl">
                    <Form.Item
                      name="includeDatabases"
                      style={{ marginBottom: 0, width: "100%" }}
                    >
                      <Select
                        className="gn-conn-scope-select"
                        mode="tags"
                        style={{ width: "100%", minWidth: "100%" }}
                        popupMatchSelectWidth
                        tokenSeparators={[",", ";", " "]}
                        placeholder={t(
                          "connection.modal.dense.scopePlaceholder",
                        )}
                        allowClear
                        maxTagCount="responsive"
                        options={dbList.map((db: string) => ({
                          value: db,
                          label: db,
                        }))}
                      />
                    </Form.Item>
                  </div>
                </div>

                {!isNacosProtection && (
                  <>
                    <div className="gn-conn-f-row">
                      {denseLabel(
                        t("connection.modal.dense.scopeIncludePattern"),
                        t("connection.modal.field.includeDatabasePatterns.help"),
                      )}
                      <div className="gn-conn-f-ctrl">
                        <Form.Item
                          name="includeDatabasePatterns"
                          style={{ marginBottom: 0, width: "100%" }}
                        >
                          <Select
                            className="gn-conn-scope-select"
                            mode="tags"
                            style={{ width: "100%", minWidth: "100%" }}
                            tokenSeparators={[",", ";"]}
                            placeholder={t(
                              "connection.modal.field.includeDatabasePatterns.placeholder",
                            )}
                            allowClear
                            maxTagCount="responsive"
                          />
                        </Form.Item>
                      </div>
                    </div>

                    <div className="gn-conn-f-row" data-align="start">
                      {denseLabel(
                        t("connection.modal.dense.scopeExcludePattern"),
                        t("connection.modal.field.excludeDatabasePatterns.help"),
                      )}
                      <div className="gn-conn-f-ctrl">
                        <Form.Item
                          name="excludeDatabasePatterns"
                          style={{ marginBottom: 0, width: "100%" }}
                        >
                          <Select
                            className="gn-conn-scope-select"
                            mode="tags"
                            style={{ width: "100%", minWidth: "100%" }}
                            tokenSeparators={[",", ";"]}
                            placeholder={t(
                              "connection.modal.field.excludeDatabasePatterns.placeholder",
                            )}
                            allowClear
                            maxTagCount="responsive"
                          />
                        </Form.Item>
                        <Text type="secondary" style={{ display: "block", marginTop: 4, fontSize: 12 }}>
                          {t("connection.modal.field.databasePatterns.help")}
                        </Text>
                      </div>
                    </div>
                  </>
                )}
              </>
            )}

            {/* demo .check-line：保存密码 + 保存后连接并展开（后者 UI 对齐；连接/展开由 onSaved 侧既有流程处理时可再接线） */}
            {!isFileDb && (
              <div className="gn-conn-check-line">
                <Form.Item
                  name="savePassword"
                  valuePropName="checked"
                  style={{ marginBottom: 0 }}
                >
                  <Checkbox>
                    {t("connection.modal.field.savePassword")}
                  </Checkbox>
                </Form.Item>
                <Form.Item
                  name="connectAndExpandAfterSave"
                  valuePropName="checked"
                  initialValue={true}
                  style={{ marginBottom: 0 }}
                >
                  <Checkbox>
                    {t("connection.modal.dense.connectAndExpand")}
                  </Checkbox>
                </Form.Item>
              </div>
            )}

            {/* 模式分段 · 对齐 Demo mode-seg */}
            {isMySQLLike && (
              <div className="gn-conn-f-row" data-align="start">
                {denseLabel(
                  t("connection.modal.dense.mode"),
                  t("connection.modal.config_section.connectionMode.title"),
                )}
                <div className="gn-conn-f-ctrl">
                  {renderChoiceCards({
                    fieldName: "mysqlTopology",
                    value: String(mysqlTopology),
                    variant: "segment",
                    options: [
                      {
                        value: "single",
                        label: t("connection.modal.topology.single.label"),
                        description: t(
                          "connection.modal.topology.mysql.single.description",
                        ),
                      },
                      {
                        value: "replica",
                        label: t(
                          "connection.modal.topology.mysql.replica.label",
                        ),
                        description: t(
                          "connection.modal.topology.mysql.replica.description",
                        ),
                      },
                    ],
                  })}
                </div>
              </div>
            )}

            {isKafka && (
              <div className="gn-conn-f-row" data-align="start">
                {denseLabel(
                  t("connection.modal.dense.mode"),
                  t("connection.modal.config_section.connectionMode.title"),
                )}
                <div className="gn-conn-f-ctrl">
                  {renderChoiceCards({
                    fieldName: "kafkaTopology",
                    value: String(kafkaTopology),
                    variant: "segment",
                    options: [
                      {
                        value: "single",
                        label: t(
                          "connection.modal.messageQueue.kafka.topology.single.label",
                        ),
                        description: t(
                          "connection.modal.messageQueue.kafka.topology.single.description",
                        ),
                      },
                      {
                        value: "cluster",
                        label: t(
                          "connection.modal.messageQueue.topology.cluster.label",
                        ),
                        description: t(
                          "connection.modal.messageQueue.kafka.topology.cluster.description",
                        ),
                      },
                    ],
                  })}
                </div>
              </div>
            )}

            {isRocketMQ && (
              <div className="gn-conn-f-row" data-align="start">
                {denseLabel(
                  t("connection.modal.dense.mode"),
                  t("connection.modal.config_section.connectionMode.title"),
                )}
                <div className="gn-conn-f-ctrl">
                  {renderChoiceCards({
                    fieldName: "rocketmqTopology",
                    value: String(rocketmqTopology),
                    variant: "segment",
                    options: [
                      {
                        value: "single",
                        label: t(
                          "connection.modal.messageQueue.rocketmq.topology.single.label",
                        ),
                        description: t(
                          "connection.modal.messageQueue.rocketmq.topology.single.description",
                        ),
                      },
                      {
                        value: "cluster",
                        label: t(
                          "connection.modal.messageQueue.topology.cluster.label",
                        ),
                        description: t(
                          "connection.modal.messageQueue.rocketmq.topology.cluster.description",
                        ),
                      },
                    ],
                  })}
                </div>
              </div>
            )}

            {isMQTT && (
              <div className="gn-conn-f-row" data-align="start">
                {denseLabel(
                  t("connection.modal.dense.mode"),
                  t("connection.modal.config_section.connectionMode.title"),
                )}
                <div className="gn-conn-f-ctrl">
                  {renderChoiceCards({
                    fieldName: "mqttTopology",
                    value: String(mqttTopology),
                    variant: "segment",
                    options: [
                      {
                        value: "single",
                        label: t(
                          "connection.modal.messageQueue.mqtt.topology.single.label",
                        ),
                        description: t(
                          "connection.modal.messageQueue.mqtt.topology.single.description",
                        ),
                      },
                      {
                        value: "cluster",
                        label: t(
                          "connection.modal.messageQueue.topology.cluster.label",
                        ),
                        description: t(
                          "connection.modal.messageQueue.mqtt.topology.cluster.description",
                        ),
                      },
                    ],
                  })}
                </div>
              </div>
            )}

            {isKafka &&
              kafkaTopology === "cluster" &&
              renderClusterHostsExtra({
                fieldName: "kafkaHosts",
                labelKey: "connection.modal.messageQueue.kafka.extraBrokers.label",
                helpKey: "connection.modal.messageQueue.kafka.extraBrokers.help",
                placeholderKey:
                  "connection.modal.messageQueue.kafka.extraBrokers.placeholder",
              })}

            {isRocketMQ &&
              rocketmqTopology === "cluster" &&
              renderClusterHostsExtra({
                fieldName: "rocketmqHosts",
                labelKey:
                  "connection.modal.messageQueue.rocketmq.extraNameServers.label",
                helpKey:
                  "connection.modal.messageQueue.rocketmq.extraNameServers.help",
                placeholderKey:
                  "connection.modal.messageQueue.rocketmq.extraNameServers.placeholder",
              })}

            {isMQTT &&
              mqttTopology === "cluster" &&
              renderClusterHostsExtra({
                fieldName: "mqttHosts",
                labelKey: "connection.modal.messageQueue.mqtt.extraBrokers.label",
                helpKey: "connection.modal.messageQueue.mqtt.extraBrokers.help",
                placeholderKey:
                  "connection.modal.messageQueue.mqtt.extraBrokers.placeholder",
              })}

            {isMySQLLike && mysqlTopology === "replica" && (
              <div className="gn-conn-mode-extra">
                <div className="gn-conn-el">
                  {t("connection.modal.field.mysqlReplicaHosts.label")}
                </div>
                <div className="gn-conn-eh">
                  {t("connection.modal.field.mysqlReplicaHosts.help")}
                </div>
                <Form.Item name="mysqlReplicaHosts" style={{ marginBottom: 8 }}>
                  <Select
                    mode="tags"
                    placeholder={t(
                      "connection.modal.field.mysqlReplicaHosts.placeholder",
                    )}
                    tokenSeparators={[",", ";", " "]}
                  />
                </Form.Item>
                <div className="gn-conn-f-row">
                  {denseLabel(
                    t("connection.modal.dense.auth"),
                    t("connection.modal.field.mysqlReplicaUser.label"),
                  )}
                  <div className="gn-conn-f-ctrl gn-conn-f-inline">
                    <div className="gn-conn-w gn-conn-w-user">
                      <Form.Item name="mysqlReplicaUser" style={{ marginBottom: 0 }}>
                        <Input
                          {...noAutoCapInputProps}
                          placeholder={t(
                            "connection.modal.field.mysqlReplicaUser.placeholder",
                          )}
                        />
                      </Form.Item>
                    </div>
                    <div className="gn-conn-w gn-conn-w-pass">
                      <Form.Item name="mysqlReplicaPassword" style={{ marginBottom: 0 }}>
                        <Input.Password
                          {...noAutoCapInputProps}
                          placeholder={getStoredSecretPlaceholder({
                            hasStoredSecret:
                              initialValues?.hasMySQLReplicaPassword,
                            emptyPlaceholder: t(
                              "connection.modal.field.mysqlReplicaPassword.placeholder",
                            ),
                            retainedLabel: t(
                              "connection.modal.field.mysqlReplicaPassword.retained",
                            ),
                          })}
                        />
                      </Form.Item>
                    </div>
                  </div>
                </div>
                {renderStoredSecretControls({
                  fieldName: "mysqlReplicaPassword",
                  clearKey: "mysqlReplicaPassword",
                  hasStoredSecret: initialValues?.hasMySQLReplicaPassword,
                  clearLabel: t(
                    "connection.modal.field.mysqlReplicaPassword.clear",
                  ),
                  description: t(
                    "connection.modal.field.mysqlReplicaPassword.savedDescription",
                  ),
                })}
              </div>
            )}

            {dbType === "mongodb" && (
              <div className="gn-conn-f-row" data-align="start">
                {denseLabel(
                  t("connection.modal.dense.mode"),
                  t("connection.modal.config_section.connectionMode.title"),
                )}
                <div className="gn-conn-f-ctrl">
                  {renderChoiceCards({
                    fieldName: "mongoTopology",
                    value: String(mongoTopology),
                    variant: "segment",
                    options: [
                      {
                        value: "single",
                        label: t("connection.modal.topology.single.label"),
                        description: t(
                          "connection.modal.topology.mongodb.single.description",
                        ),
                      },
                      {
                        value: "replica",
                        label: t(
                          "connection.modal.topology.mongodb.replica.label",
                        ),
                        description: t(
                          "connection.modal.topology.mongodb.replica.description",
                        ),
                      },
                    ],
                  })}
                </div>
              </div>
            )}

            {dbType === "mongodb" && (
              <div className="gn-conn-f-row" data-align="start">
                {denseLabel(
                  t("connection.modal.dense.address"),
                  t("connection.modal.config_section.mongoDiscovery.title"),
                )}
                <div className="gn-conn-f-ctrl">
                  {renderChoiceCards({
                    fieldName: "mongoSrv",
                    value: mongoSrv ? "true" : "false",
                    variant: "segment",
                    onSelect: (value: string) =>
                      setChoiceFieldValue("mongoSrv", value === "true"),
                    options: [
                      {
                        value: "false",
                        label: t(
                          "connection.modal.mongo.discovery.standard.label",
                        ),
                        description: t(
                          "connection.modal.mongo.discovery.standard.description",
                        ),
                      },
                      {
                        value: "true",
                        label: t(
                          "connection.modal.mongo.discovery.srv.label",
                        ),
                        description: t(
                          "connection.modal.mongo.discovery.srv.description",
                        ),
                      },
                    ],
                  })}
                  {mongoSrv && useSSH && (
                    <Alert
                      type="warning"
                      showIcon
                      style={{ marginTop: 8 }}
                      message={t(
                        "connection.modal.mongo.discovery.srvSshWarning",
                      )}
                    />
                  )}
                </div>
              </div>
            )}

            {dbType === "mongodb" && mongoTopology === "replica" && (
              <div className="gn-conn-mode-extra">
                <div className="gn-conn-el">
                  {mongoSrv
                    ? t("connection.modal.field.mongoSrvHosts.label")
                    : t("connection.modal.field.mongoHosts.label")}
                </div>
                <div className="gn-conn-eh">
                  {mongoSrv
                    ? t("connection.modal.field.mongoSrvHosts.help")
                    : t("connection.modal.field.mongoHosts.help")}
                </div>
                <Form.Item name="mongoHosts" style={{ marginBottom: 8 }}>
                  <Select
                    mode="tags"
                    placeholder={
                      mongoSrv
                        ? t("connection.modal.field.mongoSrvHosts.placeholder")
                        : t("connection.modal.field.mongoHosts.placeholder")
                    }
                    tokenSeparators={[",", ";", " "]}
                  />
                </Form.Item>

                <div className="gn-conn-f-row">
                  {denseLabel(
                    t("connection.modal.dense.name"),
                    t("connection.modal.field.mongoReplicaSet.label"),
                  )}
                  <div className="gn-conn-f-ctrl">
                    <div className="gn-conn-w gn-conn-w-name">
                      <Form.Item
                        name="mongoReplicaSet"
                        style={{ marginBottom: 0 }}
                      >
                        <Input
                          {...noAutoCapInputProps}
                          placeholder={t(
                            "connection.modal.field.mongoReplicaSet.placeholder",
                          )}
                        />
                      </Form.Item>
                    </div>
                  </div>
                </div>

                <div className="gn-conn-f-row">
                  {denseLabel(
                    t("connection.modal.dense.auth"),
                    t("connection.modal.field.mongoReplicaUser.label"),
                  )}
                  <div className="gn-conn-f-ctrl gn-conn-f-inline">
                    <div className="gn-conn-w gn-conn-w-user">
                      <Form.Item
                        name="mongoReplicaUser"
                        style={{ marginBottom: 0 }}
                      >
                        <Input
                          {...noAutoCapInputProps}
                          placeholder={t(
                            "connection.modal.field.mongoReplicaUser.placeholder",
                          )}
                        />
                      </Form.Item>
                    </div>
                    <div className="gn-conn-w gn-conn-w-pass">
                      <Form.Item
                        name="mongoReplicaPassword"
                        style={{ marginBottom: 0 }}
                      >
                        <Input.Password
                          {...noAutoCapInputProps}
                          placeholder={getStoredSecretPlaceholder({
                            hasStoredSecret:
                              initialValues?.hasMongoReplicaPassword,
                            emptyPlaceholder: t(
                              "connection.modal.field.mongoReplicaPassword.placeholder",
                            ),
                            retainedLabel: t(
                              "connection.modal.field.mongoReplicaPassword.retained",
                            ),
                          })}
                        />
                      </Form.Item>
                    </div>
                  </div>
                </div>
                {renderStoredSecretControls({
                  fieldName: "mongoReplicaPassword",
                  clearKey: "mongoReplicaPassword",
                  hasStoredSecret: initialValues?.hasMongoReplicaPassword,
                  clearLabel: t(
                    "connection.modal.field.mongoReplicaPassword.clear",
                  ),
                  description: t(
                    "connection.modal.field.mongoReplicaPassword.savedDescription",
                  ),
                })}

                <Space size={8} style={{ marginTop: 12, marginBottom: 12 }}>
                  <Button
                    onClick={handleDiscoverMongoMembers}
                    loading={discoveringMembers}
                  >
                    {t("connection.modal.mongo.discoverMembers")}
                  </Button>
                </Space>
                {mongoMembers.length > 0 && (
                  <Table
                    size="small"
                    rowKey={(record) => record.host}
                    pagination={false}
                    dataSource={mongoMembers}
                    style={{ marginBottom: 12 }}
                    columns={[
                      {
                        title: t("connection.modal.field.host.label"),
                        dataIndex: "host",
                        width: "48%",
                      },
                      {
                        title: t("connection.modal.mongo.member.role"),
                        dataIndex: "role",
                        width: "32%",
                        render: (value: string, record: MongoMemberInfo) => (
                          <Tag color={record.isSelf ? "blue" : "default"}>
                            {value || record.state || t("common.unknown")}
                          </Tag>
                        ),
                      },
                      {
                        title: t("connection.modal.mongo.member.health"),
                        dataIndex: "healthy",
                        width: "20%",
                        render: (value: boolean) => (
                          <Tag color={value ? "success" : "error"}>
                            {value
                              ? t("connection.modal.mongo.member.healthy")
                              : t("connection.modal.mongo.member.unhealthy")}
                          </Tag>
                        ),
                      },
                    ]}
                  />
                )}
              </div>
            )}

            {dbType === "mongodb" && (
              <div className="gn-conn-f-row" data-align="start">
                {denseLabel(
                  t("connection.modal.dense.auth"),
                  t("connection.modal.field.mongoAuthSource.label"),
                )}
                <div className="gn-conn-f-ctrl gn-conn-f-inline">
                  <div className="gn-conn-w gn-conn-w-name">
                    <Form.Item name="mongoAuthSource" style={{ marginBottom: 0 }}>
                      <Input
                        {...noAutoCapInputProps}
                        placeholder={t(
                          "connection.modal.field.mongoAuthSource.placeholder",
                        )}
                      />
                    </Form.Item>
                  </div>
                </div>
              </div>
            )}

            {dbType === "mongodb" && (
              <div className="gn-conn-f-row" data-align="start">
                {denseLabel(
                  t("connection.modal.dense.mode"),
                  t("connection.modal.mongo.readPreference.label"),
                )}
                <div className="gn-conn-f-ctrl">
                  {renderChoiceCards({
                    fieldName: "mongoReadPreference",
                    value: String(mongoReadPreference),
                    variant: "segment",
                    options: [
                      {
                        value: "primary",
                        label: "primary",
                        description: t(
                          "connection.modal.mongo.readPreference.primary.description",
                        ),
                      },
                      {
                        value: "primaryPreferred",
                        label: "primaryPreferred",
                        description: t(
                          "connection.modal.mongo.readPreference.primaryPreferred.description",
                        ),
                      },
                      {
                        value: "secondary",
                        label: "secondary",
                        description: t(
                          "connection.modal.mongo.readPreference.secondary.description",
                        ),
                      },
                      {
                        value: "secondaryPreferred",
                        label: "secondaryPreferred",
                        description: t(
                          "connection.modal.mongo.readPreference.secondaryPreferred.description",
                        ),
                      },
                      {
                        value: "nearest",
                        label: "nearest",
                        description: t(
                          "connection.modal.mongo.readPreference.nearest.description",
                        ),
                      },
                    ],
                  })}
                </div>
              </div>
            )}

            {isRedis && (
              <div className="gn-conn-f-row" data-align="start">
                {denseLabel(
                  t("connection.modal.dense.mode"),
                  t("connection.modal.config_section.connectionMode.title"),
                )}
                <div className="gn-conn-f-ctrl">
                  {renderChoiceCards({
                    fieldName: "redisTopology",
                    value: String(redisTopology),
                    variant: "segment",
                    options: [
                      {
                        value: "single",
                        label: t("connection.modal.topology.single.label"),
                        description: t(
                          "connection.modal.topology.redis.single.description",
                        ),
                      },
                      {
                        value: "cluster",
                        label: t(
                          "connection.modal.topology.redis.cluster.label",
                        ),
                        description: t(
                          "connection.modal.topology.redis.cluster.description",
                        ),
                      },
                      {
                        value: "sentinel",
                        label: t(
                          "connection.modal.redis.topology.sentinel.label",
                        ),
                        description: t(
                          "connection.modal.redis.topology.sentinel.description",
                        ),
                      },
                    ],
                  })}
                  {redisTopology === "cluster" && (
                    <div
                      className="gn-conn-mode-extra"
                      style={{ width: "100%" }}
                    >
                      <div className="gn-conn-el">
                        {t("connection.modal.field.redisHosts.label")}
                      </div>
                      <div className="gn-conn-eh">
                        {t("connection.modal.field.redisHosts.help")}
                      </div>
                      <Form.Item name="redisHosts" style={{ marginBottom: 0 }}>
                        <Select
                          mode="tags"
                          placeholder={t(
                            "connection.modal.field.redisHosts.placeholder",
                          )}
                          tokenSeparators={[",", ";", " "]}
                        />
                      </Form.Item>
                    </div>
                  )}
                  {redisTopology === "sentinel" && (
                    <div
                      className="gn-conn-mode-extra"
                      style={{ width: "100%" }}
                    >
                      <div className="gn-conn-el">
                        {t("connection.modal.redis.hosts.sentinel.label")}
                      </div>
                      <div className="gn-conn-eh">
                        {t("connection.modal.redis.hosts.sentinel.help")}
                      </div>
                      <Form.Item
                        name="redisHosts"
                        style={{ marginBottom: 8 }}
                      >
                        <Select
                          mode="tags"
                          placeholder={t(
                            "connection.modal.redis.hosts.sentinel.placeholder",
                          )}
                          tokenSeparators={[",", ";", " "]}
                        />
                      </Form.Item>
                      <div className="gn-conn-el">
                        {t("connection.modal.redis.sentinel.master.label")}
                      </div>
                      <div className="gn-conn-eh">
                        {t("connection.modal.redis.sentinel.master.help")}
                      </div>
                      <Form.Item
                        name="redisSentinelMaster"
                        style={{ marginBottom: 0 }}
                        rules={[
                          createUriAwareRequiredRule(
                            t(
                              "connection.modal.redis.sentinel.master.required",
                            ),
                          ),
                        ]}
                      >
                        <Input
                          {...noAutoCapInputProps}
                          placeholder={t(
                            "connection.modal.redis.sentinel.master.placeholder",
                          )}
                        />
                      </Form.Item>
                    </div>
                  )}
                </div>
              </div>
            )}

            {isRedis && (
              <div className="gn-conn-f-row">
                {denseLabel(
                  t("connection.modal.dense.scope"),
                  t("connection.modal.field.displayDatabases.label"),
                )}
                <div className="gn-conn-f-ctrl">
                  <Form.Item
                    name="includeRedisDatabases"
                    style={{ marginBottom: 0 }}
                  >
                    <Select
                      mode="multiple"
                      placeholder={t(
                        "connection.modal.field.displayRedisDatabases.placeholder",
                      )}
                      allowClear
                    >
                      {redisDbList.map((db: number) => (
                        <Select.Option key={db} value={db}>
                          db{db}
                        </Select.Option>
                      ))}
                    </Select>
                  </Form.Item>
                </div>
              </div>
            )}

            {/* Mongo 认证机制 · 紧凑分段 */}
            {dbType === "mongodb" && (
              <div className="gn-conn-f-row" data-align="start">
                {denseLabel(
                  t("connection.modal.dense.auth"),
                  t("connection.modal.mongo.authMechanism.label"),
                )}
                <div className="gn-conn-f-ctrl">
                  {renderChoiceCards({
                    fieldName: "mongoAuthMechanism",
                    value: String(mongoAuthMechanism),
                    variant: "segment",
                    options: [
                      {
                        value: "",
                        label: t(
                          "connection.modal.mongo.authMechanism.auto.label",
                        ),
                        description: t(
                          "connection.modal.mongo.authMechanism.auto.description",
                        ),
                      },
                      {
                        value: "NONE",
                        label: t(
                          "connection.modal.mongo.authMechanism.none.label",
                        ),
                        description: t(
                          "connection.modal.mongo.authMechanism.none.description",
                        ),
                      },
                      {
                        value: "SCRAM-SHA-1",
                        label: "SCRAM-SHA-1",
                        description: t(
                          "connection.modal.mongo.authMechanism.scramSha1.description",
                        ),
                      },
                      {
                        value: "SCRAM-SHA-256",
                        label: "SCRAM-SHA-256",
                        description: t(
                          "connection.modal.mongo.authMechanism.scramSha256.description",
                        ),
                      },
                      {
                        value: "MONGODB-AWS",
                        label: "MONGODB-AWS",
                        description: t(
                          "connection.modal.mongo.authMechanism.aws.description",
                        ),
                      },
                    ],
                  })}
                </div>
              </div>
            )}

            {/* 生产连接保护 · Demo：紧挨模式下方；默认展开；扁平列表 */}
            {showConnectionReadOnlyField && (
              <div
                className="gn-conn-prot"
                data-open={readOnlyProtectionExpanded ? "1" : "0"}
                data-connection-config-section="readOnly"
              >
                <button
                  type="button"
                  className="gn-conn-prot-head"
                  data-connection-config-section-toggle="readOnly"
                  aria-expanded={readOnlyProtectionExpanded}
                  onClick={() =>
                    setReadOnlyProtectionExpanded((expanded) => !expanded)
                  }
                >
                  <span className="gn-conn-prot-chev" aria-hidden="true" />
                  <span className="gn-conn-prot-title">
                    {t("connection.modal.section.readOnly.title")}
                  </span>
                  <span
                    className={`gn-conn-prot-tag${
                      connectionProtectionEnabledCount > 0 ? " on" : ""
                    }`}
                  >
                    {connectionProtectionEnabledCount > 0
                      ? t(
                          "connection.modal.field.readOnly.status.enabledCount",
                          { count: connectionProtectionEnabledCount },
                        )
                      : t("connection.modal.field.readOnly.status.disabled")}
                  </span>
                </button>
                {readOnlyProtectionExpanded ? (
                  <div className="gn-conn-prot-body">
                    {[
                      {
                        field: "restrictDataEdit",
                        checked: restrictDataEdit,
                        label: t(
                          "connection.modal.field.readOnly.option.dataEdit.label",
                        ),
                        help: t(
                          isNacosProtection
                            ? "connection.modal.field.readOnly.option.nacos.dataEdit.help"
                            : "connection.modal.field.readOnly.option.dataEdit.help",
                        ),
                      },
                      {
                        field: "restrictStructureEdit",
                        checked: restrictStructureEdit,
                        label: t(
                          "connection.modal.field.readOnly.option.structureEdit.label",
                        ),
                        help: t(
                          isNacosProtection
                            ? "connection.modal.field.readOnly.option.nacos.structureEdit.help"
                            : "connection.modal.field.readOnly.option.structureEdit.help",
                        ),
                      },
                      ...(supportsScriptExecutionProtection
                        ? [
                            {
                              field: "restrictScriptExecution",
                              checked: restrictScriptExecution,
                              label: t(
                                "connection.modal.field.readOnly.option.scriptExecution.label",
                              ),
                              help: t(
                                "connection.modal.field.readOnly.option.scriptExecution.help",
                              ),
                            },
                          ]
                        : []),
                      {
                        field: "restrictDataImport",
                        checked: restrictDataImport,
                        label: t(
                          "connection.modal.field.readOnly.option.dataImport.label",
                        ),
                        help: t(
                          isNacosProtection
                            ? "connection.modal.field.readOnly.option.nacos.dataImport.help"
                            : "connection.modal.field.readOnly.option.dataImport.help",
                        ),
                      },
                    ].map((item) => (
                      <button
                        key={item.field}
                        type="button"
                        className="gn-conn-prot-opt"
                        onClick={() =>
                          setChoiceFieldValue(item.field, !item.checked)
                        }
                      >
                        <span
                          onClick={(event) => event.stopPropagation()}
                          style={{ justifySelf: "center", marginTop: 2 }}
                        >
                          <Form.Item
                            name={item.field}
                            valuePropName="checked"
                            noStyle
                          >
                            <Checkbox
                              onChange={() =>
                                clearConnectionTestResultForChoice()
                              }
                            />
                          </Form.Item>
                        </span>
                        <div>
                          <div className="n">{item.label}</div>
                          <div className="h">{item.help}</div>
                        </div>
                      </button>
                    ))}
                    <div className="gn-conn-prot-sum">
                      {t("connection.modal.field.readOnly.summary.title")}
                      {": "}
                      {connectionProtectionEnabledCount > 0
                        ? t(
                            "connection.modal.field.readOnly.summary.selected",
                            { count: connectionProtectionEnabledCount },
                          )
                        : t("connection.modal.field.readOnly.status.disabled")}
                    </div>
                  </div>
                ) : null}
              </div>
            )}
          </>
        )}

        {/* custom / jvm 仍使用分区卡片身份信息；标准类型已在上方密排 */}
        {(isCustom || isJVM) &&
          renderConfigSectionCard({
            sectionKey: "identity",
            icon: <ApiOutlined />,
            badge: (
              <Tag>
                {getConnectionConfigLayoutKindLabel(
                  connectionConfigLayout.kind,
                )}
              </Tag>
            ),
            children: (
              <>
                <Form.Item
                  name="name"
                  label={t("connection.modal.field.name.label")}
                >
                  <Input
                    {...noAutoCapInputProps}
                    placeholder={
                      isJVM
                        ? t("connection.modal.field.name.placeholder.jvm")
                        : t("connection.modal.field.name.placeholder.default")
                    }
                  />
                </Form.Item>
                <Form.Item
                  name="environmentType"
                  label={t("connection.modal.field.environment_type.label")}
                  initialValue={DEFAULT_CONNECTION_ENVIRONMENT}
                  style={{ marginBottom: 0 }}
                >
                  <ConnectionEnvironmentSelect />
                </Form.Item>
              </>
            ),
          })}
      </div>
    </div>
  );

  const advancedSection = (
    <div style={{ display: "grid", gap: 14 }}>
      {supportsConnectionParams ? (
        <Form.Item
          name="connectionParams"
          label={t("connection.modal.connectionParams.label")}
          help={t("connection.modal.connectionParams.help")}
          style={{ marginBottom: 0 }}
        >
          <Input.TextArea
            {...noAutoCapInputProps}
            rows={3}
            placeholder={getConnectionParamsPlaceholder(
              dbType,
              oceanBaseProtocol,
            )}
          />
        </Form.Item>
      ) : (
        <div style={{ ...modalMutedTextStyle, padding: "8px 2px" }}>
          {t("connection.modal.config.advanced.empty")}
        </div>
      )}
    </div>
  );

  const networkSecuritySection = (
    <ConnectionModalNetworkSecuritySection
      activeNetworkConfig={activeNetworkConfig}
      darkMode={darkMode}
      dbType={dbType}
      form={form}
      getConnectionOptionCardStyle={getConnectionOptionCardStyle}
      handleSelectCertificateFile={handleSelectCertificateFile}
      handleSelectSSHKeyFile={handleSelectSSHKeyFile}
      initialValues={initialValues}
      isFileDb={isFileDb}
      isJVM={isJVM}
      isSSLType={isSSLType}
      modalInnerSectionStyle={modalInnerSectionStyle}
      modalMutedTextStyle={modalMutedTextStyle}
      renderChoiceCards={renderChoiceCards}
      renderStoredSecretControls={renderStoredSecretControls}
      proxyType={proxyType}
      selectingCertificateField={selectingCertificateField}
      selectingSSHKey={selectingSSHKey}
      setActiveNetworkConfig={setActiveNetworkConfig}
      sslHintText={sslHintText}
      sslMode={sslMode}
      supportsSSLCAPath={supportsSSLCAPath}
      supportsSSLClientCertificate={supportsSSLClientCertificate}
      tunnelSectionStyle={tunnelSectionStyle}
      useHttpTunnel={useHttpTunnel}
      useProxy={useProxy}
      useSSH={useSSH}
      useSSL={useSSL}
    />
  );

  return (
    <Form
      form={form}
      layout="vertical"
      className="gn-conn-studio-form"
      initialValues={{
        type: "mysql",
        host: "localhost",
        port: 3306,
        database: "",
        user: "root",
        useSSL: false,
        sslMode: "preferred",
        sslCAPath: "",
        sslCertPath: "",
        sslKeyPath: "",
        useSSH: false,
        sshPort: 22,
        sshKnownHostsPath: "",
        sshHostKeyFingerprint: "",
        useProxy: false,
        proxyType: "socks5",
        proxyPort: 1080,
        useHttpTunnel: false,
        httpTunnelPort: 8080,
        timeout: 30,
        keepAliveEnabled: false,
        keepAliveIntervalMinutes: 240,
        keepAliveSQL: "",
        uri: "",
        connectionParams: "",
        restrictDataEdit: false,
        restrictStructureEdit: false,
        restrictScriptExecution: false,
        restrictDataImport: false,
        oceanBaseProtocol: "mysql",
        oracleMode: "service",
        mysqlTopology: "single",
        rocketmqTopology: "single",
        mqttTopology: "single",
        kafkaTopology: "single",
        redisTopology: "single",
        mongoTopology: "single",
        mongoSrv: false,
        mongoReadPreference: "primary",
        mongoAuthMechanism: "",
        savePassword: true,
        connectAndExpandAfterSave: true,
        mysqlReplicaHosts: [],
        rocketmqHosts: [],
        mqttHosts: [],
        kafkaHosts: [],
        redisHosts: [],
        redisSentinelMaster: "",
        redisSentinelUser: "",
        redisSentinelPassword: "",
        mongoHosts: [],
        mysqlReplicaUser: "",
        mysqlReplicaPassword: "",
        mongoReplicaUser: "",
        mongoReplicaPassword: "",
        redisDB: 0,
        jvmReadOnly: true,
        jvmAllowedModes: ["jmx"],
        jvmPreferredMode: "jmx",
        jvmEnvironment: "dev",
        jvmEndpointEnabled: false,
        jvmEndpointBaseUrl: "",
        jvmEndpointApiKey: "",
        jvmAgentEnabled: false,
        jvmAgentBaseUrl: "",
        jvmAgentApiKey: "",
        jvmDiagnosticEnabled: false,
        jvmDiagnosticTransport: "agent-bridge",
        jvmDiagnosticBaseUrl: "",
        jvmDiagnosticTargetId: "",
        jvmDiagnosticApiKey: "",
        jvmDiagnosticAllowObserveCommands: true,
        jvmDiagnosticAllowTraceCommands: false,
        jvmDiagnosticAllowMutatingCommands: false,
        jvmDiagnosticTimeoutSeconds: 15,
        jvmEndpointTimeoutSeconds: 30,
        jvmJmxHost: "",
        jvmJmxPort: undefined,
        jvmJmxUsername: "",
        jvmJmxPassword: "",
      }}
      onValuesChange={(changed) => {
        if (testResult) {
          setTestResult(null);
          setTestErrorLogOpen(false);
        }
        if (
          changed.uri !== undefined ||
          changed.connectionParams !== undefined ||
          changed.type !== undefined ||
          changed.oceanBaseProtocol !== undefined
        ) {
          setUriFeedback(null);
        }
        if (changed.useSSL !== undefined) {
          setUseSSL(changed.useSSL);
          if (changed.useSSL) setActiveNetworkConfig("ssl");
        }
        if (changed.useSSH !== undefined) {
          setUseSSH(changed.useSSH);
          if (changed.useSSH) setActiveNetworkConfig("ssh");
        }
        if (changed.useProxy !== undefined) {
          const enabledProxy = !!changed.useProxy;
          setUseProxy(enabledProxy);
          if (enabledProxy) setActiveNetworkConfig("proxy");
          if (enabledProxy && form.getFieldValue("useHttpTunnel")) {
            form.setFieldValue("useHttpTunnel", false);
            setUseHttpTunnel(false);
          }
        }
        if (changed.proxyType !== undefined) {
          const nextType = String(
            changed.proxyType || "socks5",
          ).toLowerCase();
          if (nextType === "http") {
            const currentPort = Number(form.getFieldValue("proxyPort") || 0);
            if (!currentPort || currentPort === 1080) {
              form.setFieldValue("proxyPort", 8080);
            }
          } else {
            const currentPort = Number(form.getFieldValue("proxyPort") || 0);
            if (!currentPort || currentPort === 8080) {
              form.setFieldValue("proxyPort", 1080);
            }
          }
        }
        if (changed.useHttpTunnel !== undefined) {
          const enabledHttpTunnel = !!changed.useHttpTunnel;
          setUseHttpTunnel(enabledHttpTunnel);
          if (enabledHttpTunnel) setActiveNetworkConfig("httpTunnel");
          if (enabledHttpTunnel && form.getFieldValue("useProxy")) {
            form.setFieldValue("useProxy", false);
            setUseProxy(false);
          }
          if (enabledHttpTunnel) {
            const currentPort = Number(
              form.getFieldValue("httpTunnelPort") || 0,
            );
            if (!currentPort || currentPort <= 0) {
              form.setFieldValue("httpTunnelPort", 8080);
            }
          }
        }
        if (changed.type !== undefined) setDbType(changed.type);
        if (changed.jvmAllowedModes !== undefined) {
          const resolvedModes = normalizeEditableJVMModes(
            changed.jvmAllowedModes,
          );
          const currentPreferredMode = String(
            form.getFieldValue("jvmPreferredMode") || "",
          )
            .trim()
            .toLowerCase();
          const resolvedPreferredMode =
            resolvedModes.find((mode) => mode === currentPreferredMode) ||
            resolvedModes[0];
          form.setFieldValue("jvmAllowedModes", resolvedModes);
          form.setFieldValue("jvmPreferredMode", resolvedPreferredMode);
          form.setFieldValue(
            "jvmEndpointEnabled",
            resolvedModes.includes("endpoint"),
          );
          form.setFieldValue(
            "jvmAgentEnabled",
            resolvedModes.includes("agent"),
          );
        }
        if (changed.redisTopology !== undefined) {
          const nextRedisTopology = String(
            changed.redisTopology || "single",
          ).toLowerCase();
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
        if (
          changed.type !== undefined ||
          changed.host !== undefined ||
          changed.port !== undefined ||
          changed.mongoHosts !== undefined ||
          changed.mongoTopology !== undefined ||
          changed.mongoSrv !== undefined
        ) {
          setMongoMembers([]);
        }
      }}
    >
      <Form.Item name="type" hidden>
        <Input {...noAutoCapInputProps} />
      </Form.Item>
      {currentDriverUnavailableReason && (
        <Alert
          showIcon
          type="warning"
          style={{ marginBottom: 12 }}
          message={t("connection.modal.driver.unavailableTitle", {
            name: currentDriverSnapshot?.name || dbType,
          })}
          description={
            <Space size={8}>
              <span>{currentDriverUnavailableReason}</span>
              <Button
                type="link"
                size="small"
                onClick={() => onOpenDriverManager?.()}
              >
                {t("connection.modal.driver.installAction")}
              </Button>
            </Space>
          }
        />
      )}
      {currentDriverUpdateReason && (
        <Alert
          showIcon
          type="warning"
          style={{ marginBottom: 12 }}
          message={t("connection.modal.driver.updateFallback", {
            name: currentDriverSnapshot?.name || dbType,
          })}
          description={
            <Space size={8}>
              <span>{currentDriverUpdateReason}</span>
              <Button
                type="link"
                size="small"
                onClick={() => onOpenDriverManager?.()}
              >
                {t("connection.modal.driver.reinstallAction")}
              </Button>
            </Space>
          }
        />
      )}
      {(() => {
        const sectionItems: Array<{
          key: "basic" | "network" | "appearance" | "advanced";
          title: string;
        }> = [
          {
            key: "basic",
            title: t("connection.modal.config.basic.title"),
          },
          ...(!isCustom && !isFileDb && !isJVM
            ? [
                {
                  key: "network" as const,
                  title: t("connection.modal.network.title"),
                },
              ]
            : []),
          {
            key: "appearance",
            title: t("connection.modal.appearance.title"),
          },
          {
            key: "advanced",
            title: t("connection.modal.config.advanced.title"),
          },
        ];
        const resolvedSection = sectionItems.some(
          (item) => item.key === activeConfigSection,
        )
          ? activeConfigSection
          : sectionItems[0]?.key || "basic";

        const effectiveIconType = customIconType || dbType;
        const effectiveIconColor =
          customIconColor || getDbDefaultColor(effectiveIconType);

        const appearanceSection = (
          <div className="gn-conn-appearance">
            <div>
              <div className="gn-conn-appearance-label">
                {t("connection.modal.appearance.icon")}
                <span>
                  {t("connection.modal.appearance.current", {
                    name: getDbIconLabel(effectiveIconType),
                  })}
                </span>
              </div>
              <div className="gn-conn-appearance-icon-grid">
                {DB_ICON_TYPES.map((iconKey) => {
                  const isActive = effectiveIconType === iconKey;
                  return (
                    <button
                      key={iconKey}
                      type="button"
                      title={getDbIconLabel(iconKey)}
                      className="gn-conn-appearance-icon"
                      data-active={isActive ? "true" : undefined}
                      onClick={() =>
                        setCustomIconType(
                          iconKey === dbType ? undefined : iconKey,
                        )
                      }
                    >
                      {getDbIcon(
                        iconKey,
                        isActive ? effectiveIconColor : undefined,
                        20,
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
            <div>
              <div className="gn-conn-appearance-label">
                {t("connection.modal.appearance.color")}
              </div>
              <div className="gn-conn-appearance-colors">
                {PRESET_ICON_COLORS.map((presetColor) => {
                  const isActive = effectiveIconColor === presetColor;
                  return (
                    <button
                      key={presetColor}
                      type="button"
                      className="gn-conn-appearance-color"
                      data-active={isActive ? "true" : undefined}
                      aria-label={presetColor}
                      onClick={() =>
                        setCustomIconColor(
                          presetColor === getDbDefaultColor(effectiveIconType)
                            ? undefined
                            : presetColor,
                        )
                      }
                      style={{
                        background: presetColor,
                      }}
                    />
                  );
                })}
                <input
                  type="color"
                  value={effectiveIconColor}
                  onChange={(e) =>
                    setCustomIconColor(
                      e.target.value === getDbDefaultColor(effectiveIconType)
                        ? undefined
                        : e.target.value,
                    )
                  }
                  title={t("connection.modal.appearance.customColor")}
                  className="gn-conn-appearance-custom-color"
                />
              </div>
            </div>
            <div className="gn-conn-appearance-preview">
              <div className="gn-conn-appearance-preview-main">
                <div className="gn-conn-appearance-preview-icon">
                  {getDbIcon(effectiveIconType, effectiveIconColor, 18)}
                </div>
                <div className="gn-conn-appearance-preview-copy">
                  <div className="gn-conn-appearance-preview-name">
                    {form.getFieldValue("name") ||
                      t("connection.modal.appearance.previewName")}
                  </div>
                  <div className="gn-conn-appearance-preview-meta">
                    {t("connection.modal.appearance.preview")}
                  </div>
                </div>
              </div>
              {(customIconType || customIconColor) && (
                <Button
                  size="small"
                  type="link"
                  className="gn-conn-appearance-reset"
                  onClick={() => {
                    setCustomIconType(undefined);
                    setCustomIconColor(undefined);
                  }}
                >
                  {t("connection.modal.appearance.reset")}
                </Button>
              )}
            </div>
          </div>
        );

        const currentSectionContent =
          resolvedSection === "basic"
            ? baseInfoSection
            : resolvedSection === "appearance"
              ? appearanceSection
              : resolvedSection === "advanced"
                ? advancedSection
                : networkSecuritySection;

        return (
          <div className="gn-conn-form-layout">
            <nav className="gn-conn-form-nav" aria-label={t("connection.modal.config.sections")}>
              {sectionItems.map((item) => {
                const active = item.key === resolvedSection;
                return (
                  <button
                    key={item.key}
                    type="button"
                    className="gn-conn-form-nav-item"
                    aria-selected={active}
                    onClick={() => setActiveConfigSection(item.key)}
                  >
                    {item.title}
                  </button>
                );
              })}
            </nav>
            <div className="gn-conn-form-main">
              {testResult ? (
                <div
                  className="gn-conn-studio-test-banner"
                  data-status={testResult.type === "success" ? "success" : "error"}
                  role="status"
                >
                  {testResult.type === "success" ? (
                    <CheckCircleFilled aria-hidden="true" />
                  ) : (
                    <CloseCircleFilled aria-hidden="true" />
                  )}
                  <span>{resolvedTestResultMessage}</span>
                  {testResult.type !== "success" ? (
                    <Button
                      type="link"
                      size="small"
                      icon={<FileTextOutlined />}
                      onClick={() => setTestErrorLogOpen(true)}
                    >
                      {t("connection.action.viewDetails")}
                    </Button>
                  ) : null}
                </div>
              ) : null}
              {currentSectionContent}
            </div>
          </div>
        );
      })()}
    </Form>
  );
};

  return renderStep2();
};

export default ConnectionModalStep2;
