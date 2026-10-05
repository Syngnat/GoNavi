import { t } from "../../i18n";
import { CodeOutlined, FileTextOutlined, ApiOutlined } from "@ant-design/icons";
import { Form, Input, Alert, Tag } from "antd";
import { getCustomConnectionDriverHelp } from "../../utils/driverImportGuidance";
import { noAutoCapInputProps } from "../../utils/inputAutoCap";
import { ConnectionStep2JvmModeCards } from "./ConnectionStep2JvmModeCards";
import { ConnectionStep2JvmDetailCards } from "./ConnectionStep2JvmDetailCards";
import { ConnectionStep2HostFields } from "./ConnectionStep2HostFields";
import { ConnectionStep2AuthFields } from "./ConnectionStep2AuthFields";
import { ConnectionModalDriverVariantField } from "./ConnectionModalDriverVariantField";
import { ConnectionModalRegistryParamFields } from "./ConnectionModalRegistryParamFields";
import { ConnectionStep2ModeFields } from "./ConnectionStep2ModeFields";
import { ConnectionStep2MongoRedisFields } from "./ConnectionStep2MongoRedisFields";
import { ConnectionStep2ProtectionFields } from "./ConnectionStep2ProtectionFields";
import { getConnectionConfigLayoutKindLabel } from "../../utils/connectionModalPresentation";
import { DEFAULT_CONNECTION_ENVIRONMENT } from "../../utils/connectionEnvironment";
import ConnectionEnvironmentSelect from "../ConnectionEnvironmentSelect";
import { ConnectionModalAdditionalParams } from "./ConnectionModalKafkaAuth";
import { getConnectionParamsPlaceholder } from "./connectionModalUri";
import ConnectionModalNetworkSecuritySection from "./ConnectionModalNetworkSecuritySection";
import type { ConnectionStep2StateApi } from "./useConnectionStep2State";
import type { ConnectionStep2UriBlockApi } from "./connectionStep2UriBlock";
import type { ConnectionStep2DenseRowsApi } from "./connectionStep2DenseRows";
import type { ConnectionStep2ProtectionApi } from "./connectionStep2Protection";
import type { ConnectionModalStep2Props } from "./ConnectionModalStep2";

export interface CreateConnectionStep2SectionsInput {
  isCustom: ConnectionModalStep2Props['isCustom'];
  isJVM: ConnectionModalStep2Props['isJVM'];
  renderConfigSectionCard: ConnectionModalStep2Props['renderConfigSectionCard'];
  createCustomDsnRule: ConnectionModalStep2Props['createCustomDsnRule'];
  renderStoredSecretControls: ConnectionModalStep2Props['renderStoredSecretControls'];
  initialValues: ConnectionModalStep2Props['initialValues'];
  unsupportedJvmModeMessage: ConnectionModalStep2Props['unsupportedJvmModeMessage'];
  jvmSectionCardStyle: ConnectionModalStep2Props['jvmSectionCardStyle'];
  renderJvmSectionHeader: ConnectionModalStep2Props['renderJvmSectionHeader'];
  renderChoiceCards: ConnectionModalStep2Props['renderChoiceCards'];
  jvmEnvironment: ConnectionModalStep2Props['jvmEnvironment'];
  normalizedJvmAllowedModes: ConnectionModalStep2Props['normalizedJvmAllowedModes'];
  jvmPreferredMode: ConnectionModalStep2Props['jvmPreferredMode'];
  handleJvmModeCardSelect: ConnectionModalStep2Props['handleJvmModeCardSelect'];
  darkMode: ConnectionModalStep2Props['darkMode'];
  modalMutedTextStyle: ConnectionModalStep2Props['modalMutedTextStyle'];
  handleJvmModeToggle: ConnectionModalStep2Props['handleJvmModeToggle'];
  jvmDiagnosticEnabled: ConnectionModalStep2Props['jvmDiagnosticEnabled'];
  jvmDiagnosticTransport: ConnectionModalStep2Props['jvmDiagnosticTransport'];
  isFileDb: ConnectionModalStep2Props['isFileDb'];
  createUriAwareRequiredRule: ConnectionModalStep2Props['createUriAwareRequiredRule'];
  dbType: ConnectionModalStep2Props['dbType'];
  handleSelectDatabaseFile: ConnectionModalStep2Props['handleSelectDatabaseFile'];
  selectingDbFile: ConnectionModalStep2Props['selectingDbFile'];
  isMySQLLike: ConnectionModalStep2Props['isMySQLLike'];
  clearConnectionTestResultForChoice: ConnectionModalStep2Props['clearConnectionTestResultForChoice'];
  form: ConnectionModalStep2Props['form'];
  isPulsar: ConnectionModalStep2Props['isPulsar'];
  handleOracleModeChange: ConnectionModalStep2Props['handleOracleModeChange'];
  isOceanBaseOracle: ConnectionModalStep2Props['isOceanBaseOracle'];
  oracleMode: ConnectionModalStep2Props['oracleMode'];
  isKafka: ConnectionModalStep2Props['isKafka'];
  setUseSSL: ConnectionModalStep2Props['setUseSSL'];
  setTestResult: ConnectionModalStep2Props['setTestResult'];
  setTestErrorLogOpen: ConnectionModalStep2Props['setTestErrorLogOpen'];
  setUriFeedback: ConnectionModalStep2Props['setUriFeedback'];
  isRedis: ConnectionModalStep2Props['isRedis'];
  primaryPasswordVisible: ConnectionModalStep2Props['primaryPasswordVisible'];
  handlePrimaryPasswordVisibleChange: ConnectionModalStep2Props['handlePrimaryPasswordVisibleChange'];
  redisTopology: ConnectionModalStep2Props['redisTopology'];
  dbList: ConnectionModalStep2Props['dbList'];
  mysqlTopology: ConnectionModalStep2Props['mysqlTopology'];
  kafkaTopology: ConnectionModalStep2Props['kafkaTopology'];
  isRocketMQ: ConnectionModalStep2Props['isRocketMQ'];
  rocketmqTopology: ConnectionModalStep2Props['rocketmqTopology'];
  isMQTT: ConnectionModalStep2Props['isMQTT'];
  mqttTopology: ConnectionModalStep2Props['mqttTopology'];
  mongoTopology: ConnectionModalStep2Props['mongoTopology'];
  mongoSrv: ConnectionModalStep2Props['mongoSrv'];
  setChoiceFieldValue: ConnectionModalStep2Props['setChoiceFieldValue'];
  useSSH: ConnectionModalStep2Props['useSSH'];
  handleDiscoverMongoMembers: ConnectionModalStep2Props['handleDiscoverMongoMembers'];
  discoveringMembers: ConnectionModalStep2Props['discoveringMembers'];
  mongoMembers: ConnectionModalStep2Props['mongoMembers'];
  mongoReadPreference: ConnectionModalStep2Props['mongoReadPreference'];
  redisDbList: ConnectionModalStep2Props['redisDbList'];
  mongoAuthMechanism: ConnectionModalStep2Props['mongoAuthMechanism'];
  readOnlyProtectionExpanded: ConnectionStep2StateApi['readOnlyProtectionExpanded'];
  setReadOnlyProtectionExpanded: ConnectionStep2StateApi['setReadOnlyProtectionExpanded'];
  connectionConfigLayout: ConnectionModalStep2Props['connectionConfigLayout'];
  uriQuickBlock: ConnectionStep2UriBlockApi['uriQuickBlock'];
  denseLabel: ConnectionStep2UriBlockApi['denseLabel'];
  denseIdentityRows: ConnectionStep2DenseRowsApi['denseIdentityRows'];
  renderClusterHostsExtra: ConnectionStep2DenseRowsApi['renderClusterHostsExtra'];
  isNacosProtection: ConnectionStep2ProtectionApi['isNacosProtection'];
  showConnectionReadOnlyField: ConnectionStep2ProtectionApi['showConnectionReadOnlyField'];
  connectionProtectionEnabledCount: ConnectionStep2ProtectionApi['connectionProtectionEnabledCount'];
  allReadOnlyChecked: ConnectionStep2ProtectionApi['allReadOnlyChecked'];
  toggleAllReadOnlyProtection: ConnectionStep2ProtectionApi['toggleAllReadOnlyProtection'];
  restrictDataEdit: ConnectionStep2ProtectionApi['restrictDataEdit'];
  restrictStructureEdit: ConnectionStep2ProtectionApi['restrictStructureEdit'];
  supportsScriptExecutionProtection: ConnectionStep2ProtectionApi['supportsScriptExecutionProtection'];
  restrictScriptExecution: ConnectionStep2ProtectionApi['restrictScriptExecution'];
  restrictDataImport: ConnectionStep2ProtectionApi['restrictDataImport'];
  supportsConnectionParams: ConnectionModalStep2Props['supportsConnectionParams'];
  oceanBaseProtocol: ConnectionModalStep2Props['oceanBaseProtocol'];
  activeNetworkConfig: ConnectionModalStep2Props['activeNetworkConfig'];
  getConnectionOptionCardStyle: ConnectionModalStep2Props['getConnectionOptionCardStyle'];
  handleSelectCertificateFile: ConnectionModalStep2Props['handleSelectCertificateFile'];
  handleSelectSSHKeyFile: ConnectionModalStep2Props['handleSelectSSHKeyFile'];
  isSSLType: ConnectionModalStep2Props['isSSLType'];
  modalInnerSectionStyle: ConnectionModalStep2Props['modalInnerSectionStyle'];
  proxyType: ConnectionModalStep2Props['proxyType'];
  selectingCertificateField: ConnectionModalStep2Props['selectingCertificateField'];
  selectingSSHKey: ConnectionModalStep2Props['selectingSSHKey'];
  setActiveNetworkConfig: ConnectionModalStep2Props['setActiveNetworkConfig'];
  sslHintText: ConnectionModalStep2Props['sslHintText'];
  sslMode: ConnectionModalStep2Props['sslMode'];
  supportsSSLCAPath: ConnectionModalStep2Props['supportsSSLCAPath'];
  supportsSSLClientCertificate: ConnectionModalStep2Props['supportsSSLClientCertificate'];
  tunnelSectionStyle: ConnectionModalStep2Props['tunnelSectionStyle'];
  useHttpTunnel: ConnectionModalStep2Props['useHttpTunnel'];
  useProxy: ConnectionModalStep2Props['useProxy'];
  useSSL: ConnectionModalStep2Props['useSSL'];
}

export const createConnectionStep2Sections = ({
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
}: CreateConnectionStep2SectionsInput) => {
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
                  <div className="gn-conn-multiline-field">
                    <div className="gn-conn-el">
                      {t("connection.modal.field.dsn.label")}
                    </div>
                    <Form.Item name="dsn" noStyle rules={[createCustomDsnRule()]}>
                      <Input.TextArea
                        {...noAutoCapInputProps}
                        rows={4}
                        placeholder={t("connection.modal.field.dsn.placeholder")}
                      />
                    </Form.Item>
                  </div>
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
            <ConnectionStep2JvmModeCards
              jvmSectionCardStyle={jvmSectionCardStyle}
              renderJvmSectionHeader={renderJvmSectionHeader}
              renderChoiceCards={renderChoiceCards}
              jvmEnvironment={jvmEnvironment}
              normalizedJvmAllowedModes={normalizedJvmAllowedModes}
              jvmPreferredMode={jvmPreferredMode}
              handleJvmModeCardSelect={handleJvmModeCardSelect}
              darkMode={darkMode}
              modalMutedTextStyle={modalMutedTextStyle}
              handleJvmModeToggle={handleJvmModeToggle}
            />

            <ConnectionStep2JvmDetailCards
              jvmSectionCardStyle={jvmSectionCardStyle}
              renderJvmSectionHeader={renderJvmSectionHeader}
              normalizedJvmAllowedModes={normalizedJvmAllowedModes}
              jvmPreferredMode={jvmPreferredMode}
              jvmDiagnosticEnabled={jvmDiagnosticEnabled}
              renderChoiceCards={renderChoiceCards}
              jvmDiagnosticTransport={jvmDiagnosticTransport}
              darkMode={darkMode}
              modalMutedTextStyle={modalMutedTextStyle}
            />
          </div>
        </>
        ) : (
          <>
            <ConnectionStep2HostFields
              denseIdentityRows={denseIdentityRows}
              denseLabel={denseLabel}
              isFileDb={isFileDb}
              createUriAwareRequiredRule={createUriAwareRequiredRule}
              dbType={dbType}
              handleSelectDatabaseFile={handleSelectDatabaseFile}
              selectingDbFile={selectingDbFile}
              isMySQLLike={isMySQLLike}
              clearConnectionTestResultForChoice={clearConnectionTestResultForChoice}
              form={form}
              isPulsar={isPulsar}
              handleOracleModeChange={handleOracleModeChange}
              isOceanBaseOracle={isOceanBaseOracle}
              oracleMode={oracleMode}
            />

            <ConnectionModalDriverVariantField
              dbType={dbType}
              form={form}
              onChange={clearConnectionTestResultForChoice}
            />

            <ConnectionModalRegistryParamFields dbType={dbType} onChange={clearConnectionTestResultForChoice} />

            <ConnectionStep2AuthFields
              isKafka={isKafka}
              setUseSSL={setUseSSL}
              setTestResult={setTestResult}
              setTestErrorLogOpen={setTestErrorLogOpen}
              setUriFeedback={setUriFeedback}
              isFileDb={isFileDb}
              isRedis={isRedis}
              denseLabel={denseLabel}
              dbType={dbType}
              createUriAwareRequiredRule={createUriAwareRequiredRule}
              primaryPasswordVisible={primaryPasswordVisible}
              handlePrimaryPasswordVisibleChange={handlePrimaryPasswordVisibleChange}
              initialValues={initialValues}
              renderStoredSecretControls={renderStoredSecretControls}
              redisTopology={redisTopology}
              isPulsar={isPulsar}
              dbList={dbList}
              isNacosProtection={isNacosProtection}
            />

            <ConnectionStep2ModeFields
              isMySQLLike={isMySQLLike}
              denseLabel={denseLabel}
              renderChoiceCards={renderChoiceCards}
              mysqlTopology={mysqlTopology}
              isKafka={isKafka}
              kafkaTopology={kafkaTopology}
              isRocketMQ={isRocketMQ}
              rocketmqTopology={rocketmqTopology}
              isMQTT={isMQTT}
              mqttTopology={mqttTopology}
              renderClusterHostsExtra={renderClusterHostsExtra}
              initialValues={initialValues}
              renderStoredSecretControls={renderStoredSecretControls}
              dbType={dbType}
              mongoTopology={mongoTopology}
            />

            <ConnectionStep2MongoRedisFields
              dbType={dbType}
              denseLabel={denseLabel}
              renderChoiceCards={renderChoiceCards}
              mongoSrv={mongoSrv}
              setChoiceFieldValue={setChoiceFieldValue}
              useSSH={useSSH}
              mongoTopology={mongoTopology}
              initialValues={initialValues}
              renderStoredSecretControls={renderStoredSecretControls}
              handleDiscoverMongoMembers={handleDiscoverMongoMembers}
              discoveringMembers={discoveringMembers}
              mongoMembers={mongoMembers}
              mongoReadPreference={mongoReadPreference}
              isRedis={isRedis}
              redisTopology={redisTopology}
              createUriAwareRequiredRule={createUriAwareRequiredRule}
              redisDbList={redisDbList}
              mongoAuthMechanism={mongoAuthMechanism}
            />

            <ConnectionStep2ProtectionFields
              showConnectionReadOnlyField={showConnectionReadOnlyField}
              readOnlyProtectionExpanded={readOnlyProtectionExpanded}
              setReadOnlyProtectionExpanded={setReadOnlyProtectionExpanded}
              connectionProtectionEnabledCount={connectionProtectionEnabledCount}
              allReadOnlyChecked={allReadOnlyChecked}
              toggleAllReadOnlyProtection={toggleAllReadOnlyProtection}
              restrictDataEdit={restrictDataEdit}
              isNacosProtection={isNacosProtection}
              restrictStructureEdit={restrictStructureEdit}
              supportsScriptExecutionProtection={supportsScriptExecutionProtection}
              restrictScriptExecution={restrictScriptExecution}
              restrictDataImport={restrictDataImport}
              setChoiceFieldValue={setChoiceFieldValue}
              clearConnectionTestResultForChoice={clearConnectionTestResultForChoice}
            />
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
        <ConnectionModalAdditionalParams placeholder={getConnectionParamsPlaceholder(dbType, oceanBaseProtocol)} />
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
  return { baseInfoSection, advancedSection, networkSecuritySection };
};

export type ConnectionStep2SectionsApi = ReturnType<typeof createConnectionStep2Sections>;
