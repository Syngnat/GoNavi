import { Alert, Space, Button, Input } from "antd";
import { t } from "../../i18n";
import { SearchOutlined, PushpinOutlined } from "@ant-design/icons";
import { noAutoCapInputProps } from "../../utils/inputAutoCap";
import { isMacLikePlatform } from "../../utils/appearance";
import {
  getDbIconLabel,
  hasDbIconAsset,
  getDbIconContainerBg,
  getDbIconAssetSrc,
  getDbIcon,
} from "../DatabaseIcons";
import { supportsSSLForType } from "../../utils/connectionTypeCapabilities";
import { getConnectionTypeHint } from "../../utils/connectionTypeCatalog";
import ConnectionModalStep2 from "./ConnectionModalStep2";
import { buildRedisDatabaseList, normalizeRedisDatabaseSelection } from "./connectionModalHelpers";
import type { ConnectionModalStateApi } from "./useConnectionModalState";
import type { ConnectionModalTypeCatalogApi } from "./useConnectionModalTypeCatalog";
import type { ConnectionModalTypeSelectApi } from "./useConnectionModalTypeSelect";
import type { ConnectionModalChoicesApi } from "./useConnectionModalChoices";
import type { ConnectionModalUriActionsApi } from "./useConnectionModalUriActions";
import type { ConnectionModalSectionRenderersApi } from "./useConnectionModalSectionRenderers";
import type { ConnectionModalSshAndMongoApi } from "./useConnectionModalSshAndMongo";
import type { ConnectionModalLifecycleApi } from "./useConnectionModalLifecycle";
import type { ConnectionModalProps } from "../ConnectionModal";

export interface UseConnectionModalStepsInput {
  onOpenDriverManager: ConnectionModalProps['onOpenDriverManager'];
  typeSelectWarning: ConnectionModalStateApi['typeSelectWarning'];
  setTypeSelectWarning: ConnectionModalStateApi['setTypeSelectWarning'];
  dbTypeQuery: ConnectionModalStateApi['dbTypeQuery'];
  handleDbTypeQueryChange: ConnectionModalTypeCatalogApi['handleDbTypeQueryChange'];
  recentConnectionChips: ConnectionModalTypeCatalogApi['recentConnectionChips'];
  handleTypeSelect: ConnectionModalTypeSelectApi['handleTypeSelect'];
  dbTypeGroups: ConnectionModalTypeCatalogApi['dbTypeGroups'];
  activeGroup: ConnectionModalStateApi['activeGroup'];
  normalizedDbTypeQuery: ConnectionModalTypeCatalogApi['normalizedDbTypeQuery'];
  handleDbTypeGroupSelect: ConnectionModalTypeCatalogApi['handleDbTypeGroupSelect'];
  activeGroupLabel: ConnectionModalTypeCatalogApi['activeGroupLabel'];
  visibleDbTypeItems: ConnectionModalTypeCatalogApi['visibleDbTypeItems'];
  pinnedConnectionTypeSet: ConnectionModalTypeCatalogApi['pinnedConnectionTypeSet'];
  localizedDbTypeGroups: ConnectionModalTypeCatalogApi['localizedDbTypeGroups'];
  darkMode: ConnectionModalStateApi['darkMode'];
  setConnectionTypePinned: ConnectionModalStateApi['setConnectionTypePinned'];
  initialValues: ConnectionModalProps['initialValues'];
  activeConfigSection: ConnectionModalStateApi['activeConfigSection'];
  setActiveConfigSection: ConnectionModalStateApi['setActiveConfigSection'];
  activeNetworkConfig: ConnectionModalStateApi['activeNetworkConfig'];
  setActiveNetworkConfig: ConnectionModalStateApi['setActiveNetworkConfig'];
  clearConnectionTestResultForChoice: ConnectionModalChoicesApi['clearConnectionTestResultForChoice'];
  connectionConfigLayout: ConnectionModalTypeCatalogApi['connectionConfigLayout'];
  createCustomDsnRule: ConnectionModalUriActionsApi['createCustomDsnRule'];
  createUriAwareRequiredRule: ConnectionModalUriActionsApi['createUriAwareRequiredRule'];
  currentDriverSnapshot: ConnectionModalTypeCatalogApi['currentDriverSnapshot'];
  currentDriverUnavailableReason: ConnectionModalTypeCatalogApi['currentDriverUnavailableReason'];
  currentDriverUpdateReason: ConnectionModalTypeCatalogApi['currentDriverUpdateReason'];
  customIconColor: ConnectionModalStateApi['customIconColor'];
  setCustomIconColor: ConnectionModalStateApi['setCustomIconColor'];
  customIconType: ConnectionModalStateApi['customIconType'];
  setCustomIconType: ConnectionModalStateApi['setCustomIconType'];
  dbList: ConnectionModalStateApi['dbList'];
  dbType: ConnectionModalStateApi['dbType'];
  setDbType: ConnectionModalStateApi['setDbType'];
  discoveringMembers: ConnectionModalStateApi['discoveringMembers'];
  form: ConnectionModalStateApi['form'];
  getConnectionOptionCardStyle: ConnectionModalSectionRenderersApi['getConnectionOptionCardStyle'];
  handleCopyURI: ConnectionModalUriActionsApi['handleCopyURI'];
  handleDiscoverMongoMembers: ConnectionModalSshAndMongoApi['handleDiscoverMongoMembers'];
  handleGenerateURI: ConnectionModalUriActionsApi['handleGenerateURI'];
  handleJvmModeCardSelect: ConnectionModalChoicesApi['handleJvmModeCardSelect'];
  handleJvmModeToggle: ConnectionModalChoicesApi['handleJvmModeToggle'];
  oracleModeTouchedRef: ConnectionModalStateApi['oracleModeTouchedRef'];
  handleParseURI: ConnectionModalUriActionsApi['handleParseURI'];
  handleSelectCertificateFile: ConnectionModalUriActionsApi['handleSelectCertificateFile'];
  handleSelectDatabaseFile: ConnectionModalUriActionsApi['handleSelectDatabaseFile'];
  handleSelectSSHKeyFile: ConnectionModalUriActionsApi['handleSelectSSHKeyFile'];
  isCustom: ConnectionModalTypeCatalogApi['isCustom'];
  isFileDb: ConnectionModalTypeCatalogApi['isFileDb'];
  isJVM: ConnectionModalTypeCatalogApi['isJVM'];
  isKafka: ConnectionModalStateApi['isKafka'];
  isMQTT: ConnectionModalStateApi['isMQTT'];
  isMySQLLike: ConnectionModalStateApi['isMySQLLike'];
  isOceanBaseOracle: ConnectionModalStateApi['isOceanBaseOracle'];
  isRedis: ConnectionModalTypeCatalogApi['isRedis'];
  isRocketMQ: ConnectionModalStateApi['isRocketMQ'];
  isPulsar: ConnectionModalStateApi['isPulsar'];
  isSSLType: ConnectionModalStateApi['isSSLType'];
  jvmDiagnosticEnabled: ConnectionModalStateApi['jvmDiagnosticEnabled'];
  jvmDiagnosticTransport: ConnectionModalStateApi['jvmDiagnosticTransport'];
  jvmEnvironment: ConnectionModalStateApi['jvmEnvironment'];
  jvmPreferredMode: ConnectionModalStateApi['jvmPreferredMode'];
  jvmSectionCardStyle: ConnectionModalSectionRenderersApi['jvmSectionCardStyle'];
  kafkaTopology: ConnectionModalStateApi['kafkaTopology'];
  modalInnerSectionStyle: ConnectionModalLifecycleApi['modalInnerSectionStyle'];
  modalMutedTextStyle: ConnectionModalLifecycleApi['modalMutedTextStyle'];
  mongoAuthMechanism: ConnectionModalStateApi['mongoAuthMechanism'];
  mongoMembers: ConnectionModalStateApi['mongoMembers'];
  setMongoMembers: ConnectionModalStateApi['setMongoMembers'];
  mongoReadPreference: ConnectionModalStateApi['mongoReadPreference'];
  mongoSrv: ConnectionModalStateApi['mongoSrv'];
  mongoTopology: ConnectionModalStateApi['mongoTopology'];
  mqttTopology: ConnectionModalStateApi['mqttTopology'];
  mysqlTopology: ConnectionModalStateApi['mysqlTopology'];
  normalizedJvmAllowedModes: ConnectionModalStateApi['normalizedJvmAllowedModes'];
  oceanBaseProtocol: ConnectionModalStateApi['oceanBaseProtocol'];
  oracleMode: ConnectionModalStateApi['oracleMode'];
  primaryPasswordVisible: ConnectionModalStateApi['primaryPasswordVisible'];
  handlePrimaryPasswordVisibleChange: ConnectionModalUriActionsApi['handlePrimaryPasswordVisibleChange'];
  proxyType: ConnectionModalStateApi['proxyType'];
  redisDbList: ConnectionModalStateApi['redisDbList'];
  setRedisDbList: ConnectionModalStateApi['setRedisDbList'];
  redisTopology: ConnectionModalStateApi['redisTopology'];
  renderChoiceCards: ConnectionModalChoicesApi['renderChoiceCards'];
  renderConfigSectionCard: ConnectionModalSectionRenderersApi['renderConfigSectionCard'];
  renderJvmSectionHeader: ConnectionModalSectionRenderersApi['renderJvmSectionHeader'];
  renderStoredSecretControls: ConnectionModalSectionRenderersApi['renderStoredSecretControls'];
  resolvedUriFeedbackMessage: ConnectionModalStateApi['resolvedUriFeedbackMessage'];
  resolvedTestResultMessage: ConnectionModalStateApi['resolvedTestResultMessage'];
  rocketmqTopology: ConnectionModalStateApi['rocketmqTopology'];
  selectingCertificateField: ConnectionModalStateApi['selectingCertificateField'];
  selectingDbFile: ConnectionModalStateApi['selectingDbFile'];
  selectingSSHKey: ConnectionModalStateApi['selectingSSHKey'];
  setChoiceFieldValue: ConnectionModalChoicesApi['setChoiceFieldValue'];
  setTestErrorLogOpen: ConnectionModalStateApi['setTestErrorLogOpen'];
  setTestResult: ConnectionModalStateApi['setTestResult'];
  testResult: ConnectionModalStateApi['testResult'];
  setUriFeedback: ConnectionModalStateApi['setUriFeedback'];
  uriFeedback: ConnectionModalStateApi['uriFeedback'];
  setUseHttpTunnel: ConnectionModalStateApi['setUseHttpTunnel'];
  useHttpTunnel: ConnectionModalStateApi['useHttpTunnel'];
  setUseProxy: ConnectionModalStateApi['setUseProxy'];
  useProxy: ConnectionModalStateApi['useProxy'];
  setUseSSH: ConnectionModalStateApi['setUseSSH'];
  useSSH: ConnectionModalStateApi['useSSH'];
  setUseSSL: ConnectionModalStateApi['setUseSSL'];
  useSSL: ConnectionModalStateApi['useSSL'];
  sslHintText: ConnectionModalStateApi['sslHintText'];
  sslMode: ConnectionModalStateApi['sslMode'];
  supportsConnectionParams: ConnectionModalStateApi['supportsConnectionParams'];
  supportsSSLCAPath: ConnectionModalStateApi['supportsSSLCAPath'];
  supportsSSLClientCertificate: ConnectionModalStateApi['supportsSSLClientCertificate'];
  tunnelSectionStyle: ConnectionModalStateApi['tunnelSectionStyle'];
  unsupportedJvmModeMessage: ConnectionModalTypeCatalogApi['unsupportedJvmModeMessage'];
}

export const useConnectionModalSteps = ({
  onOpenDriverManager,
  typeSelectWarning,
  setTypeSelectWarning,
  dbTypeQuery,
  handleDbTypeQueryChange,
  recentConnectionChips,
  handleTypeSelect,
  dbTypeGroups,
  activeGroup,
  normalizedDbTypeQuery,
  handleDbTypeGroupSelect,
  activeGroupLabel,
  visibleDbTypeItems,
  pinnedConnectionTypeSet,
  localizedDbTypeGroups,
  darkMode,
  setConnectionTypePinned,
  initialValues,
  activeConfigSection,
  setActiveConfigSection,
  activeNetworkConfig,
  setActiveNetworkConfig,
  clearConnectionTestResultForChoice,
  connectionConfigLayout,
  createCustomDsnRule,
  createUriAwareRequiredRule,
  currentDriverSnapshot,
  currentDriverUnavailableReason,
  currentDriverUpdateReason,
  customIconColor,
  setCustomIconColor,
  customIconType,
  setCustomIconType,
  dbList,
  dbType,
  setDbType,
  discoveringMembers,
  form,
  getConnectionOptionCardStyle,
  handleCopyURI,
  handleDiscoverMongoMembers,
  handleGenerateURI,
  handleJvmModeCardSelect,
  handleJvmModeToggle,
  oracleModeTouchedRef,
  handleParseURI,
  handleSelectCertificateFile,
  handleSelectDatabaseFile,
  handleSelectSSHKeyFile,
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
  setMongoMembers,
  mongoReadPreference,
  mongoSrv,
  mongoTopology,
  mqttTopology,
  mysqlTopology,
  normalizedJvmAllowedModes,
  oceanBaseProtocol,
  oracleMode,
  primaryPasswordVisible,
  handlePrimaryPasswordVisibleChange,
  proxyType,
  redisDbList,
  setRedisDbList,
  redisTopology,
  renderChoiceCards,
  renderConfigSectionCard,
  renderJvmSectionHeader,
  renderStoredSecretControls,
  resolvedUriFeedbackMessage,
  resolvedTestResultMessage,
  rocketmqTopology,
  selectingCertificateField,
  selectingDbFile,
  selectingSSHKey,
  setChoiceFieldValue,
  setTestErrorLogOpen,
  setTestResult,
  testResult,
  setUriFeedback,
  uriFeedback,
  setUseHttpTunnel,
  useHttpTunnel,
  setUseProxy,
  useProxy,
  setUseSSH,
  useSSH,
  setUseSSL,
  useSSL,
  sslHintText,
  sslMode,
  supportsConnectionParams,
  supportsSSLCAPath,
  supportsSSLClientCertificate,
  tunnelSectionStyle,
  unsupportedJvmModeMessage,
}: UseConnectionModalStepsInput) => {
  const renderStep1 = () => (
    <div className="gn-conn-picker" data-connection-step="1">
      {typeSelectWarning && (
        <Alert
          type="warning"
          showIcon
          closable
          style={{ margin: "0 0 10px" }}
          message={t("connection.modal.typeWarning.unavailable", {
            name: typeSelectWarning.driverName,
          })}
          description={
            <Space size={8}>
              <span>{typeSelectWarning.reason}</span>
              <Button
                type="link"
                size="small"
                onClick={() => onOpenDriverManager?.()}
              >
                {t("connection.modal.driver.installAction")}
              </Button>
            </Space>
          }
          onClose={() => setTypeSelectWarning(null)}
        />
      )}
      <div className="gn-conn-picker-body">
        <aside
          className="gn-conn-picker-side"
          role="navigation"
          aria-label={t("connection.modal.step1.sectionTitle")}
        >
          <div className="gn-conn-picker-search">
            <SearchOutlined className="gn-conn-picker-search-ico" />
            <Input
              allowClear
              variant="borderless"
              aria-label={t("connection.modal.step1.search.placeholder")}
              value={dbTypeQuery}
              onChange={(event) => handleDbTypeQueryChange(event.target.value)}
              placeholder={t("connection.modal.step1.search.placeholder")}
              className="gn-conn-picker-search-input"
              data-connection-type-search="true"
              {...noAutoCapInputProps}
            />
            <kbd className="gn-conn-picker-search-shortcut">
              {isMacLikePlatform() ? "Cmd K" : "Ctrl K"}
            </kbd>
          </div>

          {recentConnectionChips.length > 0 ? (
            <div className="gn-conn-picker-block">
              <div className="gn-conn-picker-sec-label">
                {t("connection.modal.step1.recent")}
              </div>
              <div className="gn-conn-picker-recent">
                {recentConnectionChips.map((chip) => (
                  <button
                    key={chip.type}
                    type="button"
                    className="gn-conn-picker-chip"
                    title={getDbIconLabel(chip.type)}
                    onClick={() => {
                      void handleTypeSelect(chip.type);
                    }}
                  >
                    <span className="gn-conn-picker-chip-text">
                      {getDbIconLabel(chip.type)}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          <div className="gn-conn-picker-block gn-conn-picker-block-grow">
            <div className="gn-conn-picker-sec-label">
              {t("connection.modal.step1.categories")}
            </div>
            <div className="gn-conn-picker-nav">
              {dbTypeGroups.map((group, idx) => {
                // 搜索时强制落到「全部」分组，aria-pressed 与可见结果一致。
                const active =
                  activeGroup === idx ||
                  (!!normalizedDbTypeQuery && idx === 0);
                return (
                  <button
                    key={group.labelKey}
                    type="button"
                    className="gn-conn-picker-nav-item"
                    data-connection-group-key={group.labelKey}
                    aria-pressed={active}
                    onClick={() => handleDbTypeGroupSelect(idx)}
                  >
                    <span className="gn-conn-picker-nav-label">
                      {group.label}
                    </span>
                    <span className="gn-conn-picker-nav-count" aria-hidden="true">
                      {group.items.length}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </aside>

        <main className="gn-conn-picker-main">
          <div className="gn-conn-picker-main-h">
            <h3>
              {normalizedDbTypeQuery
                ? t("connection.modal.step1.search.placeholder")
                : activeGroupLabel}
            </h3>
            <span>{t("connection.modal.step1.clickToConfigure")}</span>
          </div>
          <div className="gn-conn-picker-grid">
            {visibleDbTypeItems.map((item) => {
              const pinned = pinnedConnectionTypeSet.has(item.key);
              // 卡片所属的数据源分类展示标签。
              const categoryLabel = localizedDbTypeGroups.find((group) =>
                group.items.some((groupItem) => groupItem.key === item.key),
              )?.label;
              // Studio 卡片底部展示标签，不参与连接逻辑。
              const studioTags = [
                categoryLabel,
                supportsSSLForType(item.key) ? "SSL" : null,
              ].filter((tag): tag is string => Boolean(tag));
              return (
                <div
                  key={item.key}
                  className="gn-conn-type-card"
                  data-connection-type-card-key={item.key}
                  data-connection-type-pinned={pinned ? "true" : "false"}
                >
                  <button
                    type="button"
                    data-connection-type-key={item.key}
                    aria-label={item.name}
                    onClick={() => {
                      void handleTypeSelect(item.key);
                    }}
                    className="gn-conn-type-card-select"
                  >
                    <div className="gn-conn-type-card-top">
                      <div
                        className="gn-conn-type-card-logo"
                        style={{
                          background: hasDbIconAsset(item.key)
                            ? getDbIconContainerBg(item.key)
                            : (darkMode
                                ? "rgba(255,255,255,0.05)"
                                : "rgba(22,119,255,0.08)"),
                        }}
                      >
                        {hasDbIconAsset(item.key) ? (
                          <img
                            src={getDbIconAssetSrc(item.key)}
                            alt={item.name}
                            width={34}
                            height={34}
                            style={{ display: "block", objectFit: "contain" }}
                          />
                        ) : (
                          getDbIcon(item.key, undefined, 34)
                        )}
                      </div>
                      <div className="gn-conn-type-card-meta">
                        <div className="gn-conn-type-card-name">{item.name}</div>
                        <div className="gn-conn-type-card-hint">
                          {getConnectionTypeHint(item.key, t)}
                        </div>
                      </div>
                    </div>
                    {studioTags.length > 0 ? (
                      <div className="gn-conn-type-card-tags" aria-hidden="true">
                        {studioTags.map((tag) => (
                          <span key={tag} className="gn-conn-type-card-tag">
                            {tag}
                          </span>
                        ))}
                      </div>
                    ) : null}
                  </button>
                  <button
                    type="button"
                    className="gn-conn-type-card-pin"
                    data-connection-type-pin={item.key}
                    aria-label={t(
                      pinned
                        ? "connection.modal.step1.unpin"
                        : "connection.modal.step1.pin",
                      { name: item.name },
                    )}
                    aria-pressed={pinned}
                    title={t(
                      pinned
                        ? "connection.modal.step1.unpin"
                        : "connection.modal.step1.pin",
                      { name: item.name },
                    )}
                    onClick={() => {
                      setConnectionTypePinned(item.key, !pinned);
                    }}
                  >
                    <PushpinOutlined aria-hidden="true" />
                  </button>
                </div>
              );
            })}
          </div>
          {normalizedDbTypeQuery && visibleDbTypeItems.length === 0 ? (
            <div role="status" className="gn-conn-picker-empty">
              {t("connection.modal.step1.search.empty")}
            </div>
          ) : null}
        </main>
      </div>
    </div>
  );

  const renderStep2 = () => (
    <ConnectionModalStep2
      {...{
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
        handleOracleModeChange: () => {
          oracleModeTouchedRef.current = true;
        },
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
        resolvedUriFeedbackMessage,
        resolvedTestResultMessage,
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
      }}
    />
  );
  return { renderStep1, renderStep2 };
};

export type ConnectionModalStepsApi = ReturnType<typeof useConnectionModalSteps>;
