import React from "react";
import {
  Alert,
  Button,
  Form,
  Input,
  Space,
} from "antd";
import {
  CheckCircleFilled,
  CloseCircleFilled,
  FileTextOutlined,
} from "@ant-design/icons";

import {
  DB_ICON_TYPES,
  PRESET_ICON_COLORS,
  getDbDefaultColor,
  getDbIcon,
  getDbIconLabel,
} from "../DatabaseIcons";
import { t } from "../../i18n";
import { noAutoCapInputProps } from "../../utils/inputAutoCap";
import { createConnectionStep2Protection } from "./connectionStep2Protection";
import { createConnectionStep2UriBlock } from "./connectionStep2UriBlock";
import { createConnectionStep2DenseRows } from "./connectionStep2DenseRows";
import { useConnectionStep2State } from "./useConnectionStep2State";
import { createConnectionStep2Sections } from "./connectionStep2Sections";
import { createConnectionStep2FormHandlers } from "./connectionStep2FormHandlers";

export type ConnectionModalStep2Props = Record<string, any>;

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
    isPulsar,
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
  const {
    pulsarPortEditedRef,
    readOnlyProtectionExpanded,
    setReadOnlyProtectionExpanded,
  } = useConnectionStep2State({
    form,
    isKafka,
    setUseSSL,
    dbType,
    initialValues,
    isPulsar,
    setUseSSH,
    setUseProxy,
    setUseHttpTunnel,
    uriFeedback,
    setUriFeedback,
  });

  const renderStep2 = () => {
  const {
    showConnectionReadOnlyField,
    restrictDataEdit,
    restrictStructureEdit,
    restrictScriptExecution,
    restrictDataImport,
    isNacosProtection,
    supportsScriptExecutionProtection,
    connectionProtectionEnabledCount,
    allReadOnlyChecked,
    toggleAllReadOnlyProtection,
  } = createConnectionStep2Protection({ dbType, form, oceanBaseProtocol, setChoiceFieldValue });

  const { uriQuickBlock, denseLabel } = createConnectionStep2UriBlock({
    isCustom,
    isJVM,
    dbType,
    uriFeedback,
    handleParseURI,
    handleGenerateURI,
    handleCopyURI,
    resolvedUriFeedbackMessage,
    setUriFeedback,
    renderStoredSecretControls,
    initialValues,
  });

  const { renderClusterHostsExtra, denseIdentityRows } = createConnectionStep2DenseRows({ isJVM, denseLabel });

  const { baseInfoSection, advancedSection, networkSecuritySection } = createConnectionStep2Sections({
    isCustom,
    isJVM,
    renderConfigSectionCard,
    createCustomDsnRule,
    renderStoredSecretControls,
    initialValues,
    unsupportedJvmModeMessage,
    jvmSectionCardStyle,
    renderJvmSectionHeader,
    renderChoiceCards,
    jvmEnvironment,
    normalizedJvmAllowedModes,
    jvmPreferredMode,
    handleJvmModeCardSelect,
    darkMode,
    modalMutedTextStyle,
    handleJvmModeToggle,
    jvmDiagnosticEnabled,
    jvmDiagnosticTransport,
    isFileDb,
    createUriAwareRequiredRule,
    dbType,
    handleSelectDatabaseFile,
    selectingDbFile,
    isMySQLLike,
    clearConnectionTestResultForChoice,
    form,
    isPulsar,
    handleOracleModeChange,
    isOceanBaseOracle,
    oracleMode,
    isKafka,
    setUseSSL,
    setTestResult,
    setTestErrorLogOpen,
    setUriFeedback,
    isRedis,
    primaryPasswordVisible,
    handlePrimaryPasswordVisibleChange,
    redisTopology,
    dbList,
    mysqlTopology,
    kafkaTopology,
    isRocketMQ,
    rocketmqTopology,
    isMQTT,
    mqttTopology,
    mongoTopology,
    mongoSrv,
    setChoiceFieldValue,
    useSSH,
    handleDiscoverMongoMembers,
    discoveringMembers,
    mongoMembers,
    mongoReadPreference,
    redisDbList,
    mongoAuthMechanism,
    readOnlyProtectionExpanded,
    setReadOnlyProtectionExpanded,
    connectionConfigLayout,
    uriQuickBlock,
    denseLabel,
    denseIdentityRows,
    renderClusterHostsExtra,
    isNacosProtection,
    showConnectionReadOnlyField,
    connectionProtectionEnabledCount,
    allReadOnlyChecked,
    toggleAllReadOnlyProtection,
    restrictDataEdit,
    restrictStructureEdit,
    supportsScriptExecutionProtection,
    restrictScriptExecution,
    restrictDataImport,
    supportsConnectionParams,
    oceanBaseProtocol,
    activeNetworkConfig,
    getConnectionOptionCardStyle,
    handleSelectCertificateFile,
    handleSelectSSHKeyFile,
    isSSLType,
    modalInnerSectionStyle,
    proxyType,
    selectingCertificateField,
    selectingSSHKey,
    setActiveNetworkConfig,
    sslHintText,
    sslMode,
    supportsSSLCAPath,
    supportsSSLClientCertificate,
    tunnelSectionStyle,
    useHttpTunnel,
    useProxy,
    useSSL,
  });

  const { handleStep2ValuesChange, step2InitialValues } = createConnectionStep2FormHandlers({
    isPulsar,
    pulsarPortEditedRef,
    testResult,
    setTestResult,
    setTestErrorLogOpen,
    setUriFeedback,
    form,
    isKafka,
    setUseSSL,
    setActiveNetworkConfig,
    setUseSSH,
    setUseProxy,
    setUseHttpTunnel,
    setDbType,
    buildRedisDatabaseList,
    setRedisDbList,
    normalizeRedisDatabaseSelection,
    setMongoMembers,
  });

  return (
    <Form
      form={form}
      layout="vertical"
      className="gn-conn-studio-form"
      initialValues={step2InitialValues}
      onValuesChange={handleStep2ValuesChange}
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
