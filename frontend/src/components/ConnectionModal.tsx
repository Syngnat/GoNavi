import React from "react";
import Modal from './common/ResizableDraggableModal';
import { Button } from "antd";
import { SafetyCertificateOutlined } from "@ant-design/icons";
import { t } from "../i18n";
import {
  APP_FOREGROUND_MODAL_Z_INDEX,
  APP_NESTED_MODAL_Z_INDEX,
} from '../utils/overlayZIndex';
import { SavedConnection } from "../types";
import SSHConnectionProgressPanel from "./connectionModal/SSHConnectionProgressPanel";
import {
  CONNECTION_MODAL_BODY_HEIGHT,
  CONNECTION_MODAL_WIDTH_STEP2,
  CONNECTION_MODAL_WIDTH_STEP1,
} from "./connectionModal/connectionModalHelpers";
import { useConnectionModalState } from "./connectionModal/useConnectionModalState";
import { useConnectionModalLifecycle } from "./connectionModal/useConnectionModalLifecycle";
import { useConnectionModalSectionRenderers } from "./connectionModal/useConnectionModalSectionRenderers";
import { useConnectionModalChoices } from "./connectionModal/useConnectionModalChoices";
import { useConnectionModalDriverStatus } from "./connectionModal/useConnectionModalDriverStatus";
import { useConnectionModalUriActions } from "./connectionModal/useConnectionModalUriActions";
import { useConnectionModalFormSync } from "./connectionModal/useConnectionModalFormSync";
import { useConnectionModalSaveAndTest } from "./connectionModal/useConnectionModalSaveAndTest";
import { useConnectionModalSshAndMongo } from "./connectionModal/useConnectionModalSshAndMongo";
import { useConnectionModalTypeSelect } from "./connectionModal/useConnectionModalTypeSelect";
import { useConnectionModalTypeCatalog } from "./connectionModal/useConnectionModalTypeCatalog";
import { useConnectionModalSteps } from "./connectionModal/useConnectionModalSteps";
import { useConnectionModalChrome } from "./connectionModal/useConnectionModalChrome";
import { ConnectionModalSSHHostKeyTrustDialog } from "./connectionModal/ConnectionModalSSHHostKeyTrustDialog";
import { ConnectionModalTestFailureLogModal } from "./connectionModal/ConnectionModalTestFailureLogModal";

export interface ConnectionModalProps {
  open: boolean;
  onClose: () => void;
  initialValues?: SavedConnection | null;
  modalZIndex?: number;
  onOpenDriverManager?: () => void;
  onSaved?: (savedConnection: SavedConnection) => void | Promise<void>;
  onOpenConnectionHealth?: (savedConnection: SavedConnection) => void;
}

const ConnectionModal: React.FC<ConnectionModalProps> = ({ open, onClose, initialValues, modalZIndex = APP_FOREGROUND_MODAL_Z_INDEX, onOpenDriverManager, onSaved, onOpenConnectionHealth }) => {
  const {
    form,
    saving,
    setSaving,
    testingConnection,
    setTestingConnection,
    useSSL,
    setUseSSL,
    useSSH,
    setUseSSH,
    useProxy,
    setUseProxy,
    useHttpTunnel,
    setUseHttpTunnel,
    dbType,
    setDbType,
    step,
    setStep,
    activeGroup,
    setActiveGroup,
    dbTypeQuery,
    setDbTypeQuery,
    activeConfigSection,
    setActiveConfigSection,
    customIconType,
    setCustomIconType,
    customIconColor,
    setCustomIconColor,
    activeNetworkConfig,
    setActiveNetworkConfig,
    testResult,
    setTestResult,
    testErrorLogOpen,
    setTestErrorLogOpen,
    sshConnectionProgress,
    setSSHConnectionProgress,
    sshProgressPanelOpen,
    setSSHProgressPanelOpen,
    sshHostKeyTrust,
    setSSHHostKeyTrust,
    trustingSSHHostKey,
    setTrustingSSHHostKey,
    dbList,
    setDbList,
    redisDbList,
    setRedisDbList,
    mongoMembers,
    setMongoMembers,
    discoveringMembers,
    setDiscoveringMembers,
    uriFeedback,
    setUriFeedback,
    typeSelectWarning,
    setTypeSelectWarning,
    driverStatusMap,
    setDriverStatusMap,
    driverStatusLoaded,
    setDriverStatusLoaded,
    selectingDbFile,
    setSelectingDbFile,
    selectingSSHKey,
    setSelectingSSHKey,
    selectingCertificateField,
    setSelectingCertificateField,
    clearSecrets,
    setClearSecrets,
    primaryPasswordVisible,
    setPrimaryPasswordVisible,
    setPrimaryPasswordVisibilityRevision,
    testInFlightRef,
    testTimerRef,
    testRunIdRef,
    activeTestCancellationRef,
    activeNacosTestRunIdRef,
    primaryPasswordRevealRequestRef,
    revealedPrimaryPasswordRef,
    clearSecretsRef,
    oracleModeTouchedRef,
    connectionModalPanelRef,
    addConnection,
    updateConnection,
    savedConnections,
    recentConnectionTargets,
    pinnedConnectionTypes,
    setConnectionTypePinned,
    darkMode,
    mysqlTopology,
    oracleMode,
    rocketmqTopology,
    mqttTopology,
    kafkaTopology,
    mongoTopology,
    mongoSrv,
    redisTopology,
    oceanBaseProtocol,
    sslMode,
    proxyType,
    customDriver,
    mongoReadPreference,
    mongoAuthMechanism,
    jvmEnvironment,
    jvmPreferredMode,
    jvmDiagnosticEnabled,
    jvmDiagnosticTransport,
    normalizedJvmAllowedModes,
    hasUnsupportedJvmModeSelection,
    isOceanBaseOracle,
    isMySQLLike,
    isRocketMQ,
    isMQTT,
    isKafka,
    isPulsar,
    supportsConnectionParams,
    isSSLType,
    supportsSSLCAPath,
    supportsSSLClientCertificate,
    sslHintText,
    resolvedUriFeedbackMessage,
    resolvedTestResultMessage,
    overlayTheme,
    tunnelSectionStyle,
  } = useConnectionModalState();

  const {
    modalShellStyle,
    modalInnerSectionStyle,
    modalMutedTextStyle,
    cancelActiveConnectionTest,
    handleModalClose,
  } = useConnectionModalLifecycle({
    open,
    overlayTheme,
    primaryPasswordRevealRequestRef,
    revealedPrimaryPasswordRef,
    form,
    setPrimaryPasswordVisible,
    activeNacosTestRunIdRef,
    testRunIdRef,
    activeTestCancellationRef,
    testTimerRef,
    testInFlightRef,
    setTestingConnection,
    setTestResult,
    setSSHConnectionProgress,
    setSSHProgressPanelOpen,
    setSSHHostKeyTrust,
    onClose,
    setTrustingSSHHostKey,
    sshHostKeyTrust,
    sshProgressPanelOpen,
    sshConnectionProgress,
    testErrorLogOpen,
    step,
    connectionModalPanelRef,
    initialValues,
  });

  const {
    renderStoredSecretControls,
    renderConnectionModalTitle,
    getConnectionOptionCardStyle,
    jvmSectionCardStyle,
    renderJvmSectionHeader,
    renderConfigSectionCard,
  } = useConnectionModalSectionRenderers({
    initialValues,
    revealedPrimaryPasswordRef,
    darkMode,
    clearSecrets,
    setClearSecrets,
    overlayTheme,
    form,
    clearSecretsRef,
    modalInnerSectionStyle,
    modalMutedTextStyle,
  });

  const {
    clearConnectionTestResultForChoice,
    setChoiceFieldValue,
    renderChoiceCards,
    handleJvmModeCardSelect,
    handleJvmModeToggle,
  } = useConnectionModalChoices({
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
  });

  const {
    refreshDriverStatus,
    resolveDriverUnavailableReason,
    promptInstallDriver,
  } = useConnectionModalDriverStatus({
    setDriverStatusMap,
    setDriverStatusLoaded,
    driverStatusMap,
    onOpenDriverManager,
  });

  const {
    createUriAwareRequiredRule,
    createCustomDsnRule,
    handleGenerateURI,
    handleParseURI,
    handleCopyURI,
    handleSelectSSHKeyFile,
    handleSelectCertificateFile,
    handleSelectDatabaseFile,
    handlePrimaryPasswordVisibleChange,
  } = useConnectionModalUriActions({
    dbType,
    initialValues,
    clearSecrets,
    form,
    setUriFeedback,
    testResult,
    setTestResult,
    selectingSSHKey,
    setSelectingSSHKey,
    selectingCertificateField,
    setSelectingCertificateField,
    selectingDbFile,
    setSelectingDbFile,
    primaryPasswordRevealRequestRef,
    setPrimaryPasswordVisible,
    setPrimaryPasswordVisibilityRevision,
    clearSecretsRef,
    revealedPrimaryPasswordRef,
  });

  useConnectionModalFormSync({
    open,
    initialValues,
    cancelActiveConnectionTest,
    testRunIdRef,
    oracleModeTouchedRef,
    setSaving,
    setTestingConnection,
    testInFlightRef,
    testTimerRef,
    setTestResult,
    setTestErrorLogOpen,
    setSSHConnectionProgress,
    setSSHProgressPanelOpen,
    setSSHHostKeyTrust,
    setTrustingSSHHostKey,
    setDbList,
    setRedisDbList,
    setMongoMembers,
    setUriFeedback,
    setCustomIconType,
    setCustomIconColor,
    clearSecretsRef,
    setClearSecrets,
    setTypeSelectWarning,
    setDriverStatusLoaded,
    refreshDriverStatus,
    setStep,
    form,
    setPrimaryPasswordVisible,
    setUseSSL,
    setUseSSH,
    setUseProxy,
    setUseHttpTunnel,
    setDbType,
    setActiveNetworkConfig,
    setActiveConfigSection,
    setActiveGroup,
    setDbTypeQuery,
    primaryPasswordRevealRequestRef,
    revealedPrimaryPasswordRef,
  });

  const { handleOk, requestTest, handleTest } = useConnectionModalSaveAndTest({
    initialValues,
    onSaved,
    form,
    dbType,
    setDbType,
    revealedPrimaryPasswordRef,
    resolveDriverUnavailableReason,
    promptInstallDriver,
    setSaving,
    oracleModeTouchedRef,
    clearSecretsRef,
    customIconType,
    customIconColor,
    updateConnection,
    addConnection,
    setUseSSL,
    setUseSSH,
    setUseProxy,
    setUseHttpTunnel,
    setStep,
    setClearSecrets,
    handleModalClose,
    saving,
    testingConnection,
    testTimerRef,
    activeTestCancellationRef,
    setTestResult,
    testInFlightRef,
    testRunIdRef,
    clearSecrets,
    setTestingConnection,
    setSSHConnectionProgress,
    setSSHProgressPanelOpen,
    activeNacosTestRunIdRef,
    setSSHHostKeyTrust,
    setRedisDbList,
    setDbList,
  });

  const {
    handleContinueSSHHostKeyOnce,
    handleTrustAndSaveSSHHostKey,
    handleDiscoverMongoMembers,
  } = useConnectionModalSshAndMongo({
    sshHostKeyTrust,
    setSSHHostKeyTrust,
    trustingSSHHostKey,
    handleTest,
    initialValues,
    setTrustingSSHHostKey,
    form,
    dbType,
    oracleModeTouchedRef,
    discoveringMembers,
    setDiscoveringMembers,
    clearSecrets,
    setMongoMembers,
  });

  const { handleTypeSelect } = useConnectionModalTypeSelect({
    driverStatusMap,
    setTypeSelectWarning,
    setDbType,
    form,
    setUseSSL,
    setUseSSH,
    setUseProxy,
    setUseHttpTunnel,
    setMongoMembers,
    setActiveConfigSection,
    setStep,
    driverStatusLoaded,
    refreshDriverStatus,
  });

  const {
    isFileDb,
    isCustom,
    isRedis,
    isJVM,
    connectionConfigLayout,
    unsupportedJvmModeMessage,
    currentDriverSnapshot,
    currentDriverUnavailableReason,
    currentDriverUpdateReason,
    driverStatusChecking,
    localizedDbTypeGroups,
    dbTypeGroups,
    normalizedDbTypeQuery,
    visibleDbTypeItems,
    pinnedConnectionTypeSet,
    handleDbTypeQueryChange,
    handleDbTypeGroupSelect,
    dbTypes,
    recentConnectionChips,
    activeGroupLabel,
  } = useConnectionModalTypeCatalog({
    dbType,
    hasUnsupportedJvmModeSelection,
    customDriver,
    driverStatusMap,
    driverStatusLoaded,
    step,
    dbTypeQuery,
    activeGroup,
    pinnedConnectionTypes,
    setDbTypeQuery,
    setActiveGroup,
    open,
    savedConnections,
    recentConnectionTargets,
  });

  const { renderStep1, renderStep2 } = useConnectionModalSteps({
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
  });

  const { getFooter, getStudioTitle } = useConnectionModalChrome({
    initialValues,
    onOpenConnectionHealth,
    step,
    setStep,
    dbTypes,
    dbType,
    testResult,
    resolvedTestResultMessage,
    currentDriverUnavailableReason,
    driverStatusChecking,
    unsupportedJvmModeMessage,
    setTestErrorLogOpen,
    saving,
    testingConnection,
    requestTest,
    cancelActiveConnectionTest,
    handleModalClose,
    handleOk,
  });

  const isFormStep = step !== 1;
  // Step2 对齐 demo `.frame-form { height: fit-content }`，避免固定 620 撑出大片空白
  const modalBodyStyle = {
    padding: 0,
    height: isFormStep ? "auto" : CONNECTION_MODAL_BODY_HEIGHT,
    maxHeight: isFormStep ? "min(780px, calc(100vh - 132px))" : undefined,
    minHeight: isFormStep ? 0 : CONNECTION_MODAL_BODY_HEIGHT,
    overflowY: "hidden" as const,
    overflowX: "hidden" as const,
  };

  return (
    <>
      <Modal
        title={getStudioTitle()}
        open={open}
        panelRef={connectionModalPanelRef}
        onCancel={handleModalClose}
        footer={getFooter()}
        closable={false}
        centered
        wrapClassName={
          isFormStep
            ? "connection-modal-wrap connection-modal-form"
            : "connection-modal-wrap"
        }
        width={isFormStep ? CONNECTION_MODAL_WIDTH_STEP2 : CONNECTION_MODAL_WIDTH_STEP1}
        zIndex={modalZIndex}
        destroyOnHidden
        maskClosable={false}
        styles={{
          content: modalShellStyle,
          header: { background: "transparent" },
          body: modalBodyStyle,
          footer: { background: "transparent" },
        }}
      >
        {step === 1 ? renderStep1() : renderStep2()}
      </Modal>
      <Modal
        title={
          sshHostKeyTrust
            ? renderConnectionModalTitle(
                <SafetyCertificateOutlined />,
                t(
                  sshHostKeyTrust.state === "changed"
                    ? "connection.modal.network.ssh.hostKeyDialog.changedTitle"
                    : "connection.modal.network.ssh.hostKeyDialog.unknownTitle",
                ),
                t(
                  sshHostKeyTrust.state === "changed"
                    ? "connection.modal.network.ssh.hostKeyDialog.changedMessage"
                    : "connection.modal.network.ssh.hostKeyDialog.unknownMessage",
                ),
              )
            : null
        }
        open={!!sshHostKeyTrust}
        onCancel={() => {
          if (!trustingSSHHostKey) setSSHHostKeyTrust(null);
        }}
        centered
        width={620}
        zIndex={APP_NESTED_MODAL_Z_INDEX + 1}
        destroyOnHidden
        maskClosable={!trustingSSHHostKey}
        styles={{
          content: modalShellStyle,
          header: {
            background: "transparent",
            borderBottom: "none",
            paddingBottom: 8,
          },
          body: { paddingTop: 8 },
          footer: {
            background: "transparent",
            borderTop: "none",
            paddingTop: 10,
          },
        }}
        footer={[
          <Button
            key="cancel"
            disabled={trustingSSHHostKey}
            onClick={() => setSSHHostKeyTrust(null)}
          >
            {t("common.action.cancel")}
          </Button>,
          <Button
            key="once"
            disabled={trustingSSHHostKey}
            onClick={handleContinueSSHHostKeyOnce}
          >
            {t("connection.modal.network.ssh.hostKeyDialog.continueOnce")}
          </Button>,
          <Button
            key="trust"
            type="primary"
            danger={sshHostKeyTrust?.state === "changed"}
            loading={trustingSSHHostKey}
            onClick={handleTrustAndSaveSSHHostKey}
          >
            {t(
              sshHostKeyTrust?.state === "changed"
                ? "connection.modal.network.ssh.hostKeyDialog.replaceAndTrust"
                : "connection.modal.network.ssh.hostKeyDialog.trustAndSave",
            )}
          </Button>,
        ]}
      >
        {sshHostKeyTrust ? (
          <ConnectionModalSSHHostKeyTrustDialog sshHostKeyTrust={sshHostKeyTrust} />
        ) : null}
      </Modal>
      <Modal
        open={sshProgressPanelOpen && !!sshConnectionProgress}
        onCancel={
          sshConnectionProgress?.status === "running"
            ? cancelActiveConnectionTest
            : () => setSSHProgressPanelOpen(false)
        }
        centered
        width={720}
        footer={null}
        zIndex={APP_NESTED_MODAL_Z_INDEX}
        destroyOnHidden
        styles={{
          content: modalShellStyle,
          header: { display: "none" },
          body: { padding: 0 },
        }}
      >
        {sshConnectionProgress ? (
          <SSHConnectionProgressPanel
            progress={sshConnectionProgress}
            onClose={() => setSSHProgressPanelOpen(false)}
            onCancelTest={cancelActiveConnectionTest}
          />
        ) : null}
      </Modal>
      <ConnectionModalTestFailureLogModal
        renderConnectionModalTitle={renderConnectionModalTitle}
        testErrorLogOpen={testErrorLogOpen}
        setTestErrorLogOpen={setTestErrorLogOpen}
        modalShellStyle={modalShellStyle}
        resolvedTestResultMessage={resolvedTestResultMessage}
      />
    </>
  );
};

export default ConnectionModal;
