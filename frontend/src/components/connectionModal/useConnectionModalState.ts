import { Form } from "antd";
import React, { useState, useRef, useMemo } from "react";
import type { TestResultState, UriFeedbackState } from "./connectionModalHelpers";
import type { SSHConnectionProgress } from "./sshConnectionProgress";
import type { SSHHostKeyTrustDetails } from "./sshHostKeyTrust";
import { MongoMemberInfo } from "../../types";
import type { DriverStatusSnapshot } from "../../utils/connectionDriverType";
import {
  type ConnectionSecretClearState,
  createEmptyConnectionSecretClearState,
} from "./connectionModalConfig";
import { useStore } from "../../store";
import {
  resolveAppearanceValues,
  normalizeOpacityForPlatform,
  isMacLikePlatform,
} from "../../utils/appearance";
import { normalizeOceanBaseProtocolValue } from "./connectionModalUri";
import {
  normalizeEditableJVMModes,
  hasUnsupportedJVMEditableModes,
} from "../../utils/jvmConnectionConfig";
import {
  isMySQLCompatibleType,
  supportsConnectionParamsForType,
  supportsSSLForType,
  supportsSSLCAPathForType,
  supportsSSLClientCertificateForType,
} from "../../utils/connectionTypeCapabilities";
import { t } from "../../i18n";
import { normalizeConnectionSecretErrorMessage } from "../../utils/connectionModalPresentation";
import { buildOverlayWorkbenchTheme } from "../../utils/overlayWorkbenchTheme";

export const useConnectionModalState = () => {
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);
  const [testingConnection, setTestingConnection] = useState(false);
  const [useSSL, setUseSSL] = useState(false);
  const [useSSH, setUseSSH] = useState(false);
  const [useProxy, setUseProxy] = useState(false);
  const [useHttpTunnel, setUseHttpTunnel] = useState(false);
  const [dbType, setDbType] = useState("mysql");
  const [step, setStep] = useState(1); // 1: Select Type, 2: Configure
  const [activeGroup, setActiveGroup] = useState(0); // Active category index in step 1
  const [dbTypeQuery, setDbTypeQuery] = useState("");
  const [activeConfigSection, setActiveConfigSection] = useState<
    "basic" | "network" | "appearance" | "advanced"
  >("basic");
  const [customIconType, setCustomIconType] = useState<string | undefined>(
    undefined,
  );
  const [customIconColor, setCustomIconColor] = useState<string | undefined>(
    undefined,
  );
  const [activeNetworkConfig, setActiveNetworkConfig] = useState<
    "ssl" | "ssh" | "proxy" | "httpTunnel"
  >("ssl");
  const [testResult, setTestResult] = useState<TestResultState | null>(null);
  const [testErrorLogOpen, setTestErrorLogOpen] = useState(false);
  const [sshConnectionProgress, setSSHConnectionProgress] =
    useState<SSHConnectionProgress | null>(null);
  const [sshProgressPanelOpen, setSSHProgressPanelOpen] = useState(false);
  const [sshHostKeyTrust, setSSHHostKeyTrust] =
    useState<SSHHostKeyTrustDetails | null>(null);
  const [trustingSSHHostKey, setTrustingSSHHostKey] = useState(false);
  const [dbList, setDbList] = useState<string[]>([]);
  const [redisDbList, setRedisDbList] = useState<number[]>([]);
  const [mongoMembers, setMongoMembers] = useState<MongoMemberInfo[]>([]);
  const [discoveringMembers, setDiscoveringMembers] = useState(false);
  const [uriFeedback, setUriFeedback] = useState<UriFeedbackState | null>(null);
  const [typeSelectWarning, setTypeSelectWarning] = useState<{
    driverName: string;
    reason: string;
  } | null>(null);
  const [driverStatusMap, setDriverStatusMap] = useState<
    Record<string, DriverStatusSnapshot>
  >({});
  const [driverStatusLoaded, setDriverStatusLoaded] = useState(false);
  const [selectingDbFile, setSelectingDbFile] = useState(false);
  const [selectingSSHKey, setSelectingSSHKey] = useState(false);
  const [selectingCertificateField, setSelectingCertificateField] = useState<
    "sslCAPath" | "sslCertPath" | "sslKeyPath" | null
  >(null);
  const [clearSecrets, setClearSecrets] = useState<ConnectionSecretClearState>(
    createEmptyConnectionSecretClearState,
  );
  const [primaryPasswordVisible, setPrimaryPasswordVisible] = useState(false);
  const [, setPrimaryPasswordVisibilityRevision] = useState(0);
  const testInFlightRef = useRef(false);
  const testTimerRef = useRef<number | null>(null);
  const testRunIdRef = useRef(0);
  const activeTestCancellationRef = useRef<(() => void) | null>(null);
  const activeNacosTestRunIdRef = useRef("");
  const primaryPasswordRevealRequestRef = useRef(0);
  const revealedPrimaryPasswordRef = useRef("");
  const clearSecretsRef = useRef(clearSecrets);
  const oracleModeTouchedRef = useRef(false);
  const connectionModalPanelRef = useRef<HTMLDivElement | null>(null);
  const addConnection = useStore((state) => state.addConnection);
  const updateConnection = useStore((state) => state.updateConnection);
  const savedConnections = useStore((state) => state.connections) ?? [];
  const recentConnectionTargets = useStore((state) => state.recentConnectionTargets) ?? [];
  const pinnedConnectionTypes = useStore((state) => state.pinnedConnectionTypes) ?? [];
  const setConnectionTypePinned = useStore(
    (state) => state.setConnectionTypePinned,
  );
  const theme = useStore((state) => state.theme);
  const appearance = useStore((state) => state.appearance);
  const languagePreference = useStore((state) => state.languagePreference);
  void languagePreference;
  const darkMode = theme === "dark";
  const resolvedAppearance = resolveAppearanceValues(appearance);
  const effectiveOpacity = normalizeOpacityForPlatform(
    resolvedAppearance.opacity,
  );
  const disableLocalBackdropFilter = isMacLikePlatform();
  const mysqlTopology = Form.useWatch("mysqlTopology", form) || "single";
  const oracleMode = Form.useWatch("oracleMode", form) || "service";
  const rocketmqTopology = Form.useWatch("rocketmqTopology", form) || "single";
  const mqttTopology = Form.useWatch("mqttTopology", form) || "single";
  const kafkaTopology = Form.useWatch("kafkaTopology", form) || "single";
  const mongoTopology = Form.useWatch("mongoTopology", form) || "single";
  const mongoSrv = Form.useWatch("mongoSrv", form) || false;
  const redisTopology = Form.useWatch("redisTopology", form) || "single";
  const oceanBaseProtocol = normalizeOceanBaseProtocolValue(
    Form.useWatch("oceanBaseProtocol", form),
  );
  const sslMode = Form.useWatch("sslMode", form) || "preferred";
  const proxyType = Form.useWatch("proxyType", form) || "socks5";
  const customDriver = Form.useWatch("driver", form) || "";
  const mongoReadPreference =
    Form.useWatch("mongoReadPreference", form) || "primary";
  const mongoAuthMechanism = Form.useWatch("mongoAuthMechanism", form) || "";
  const jvmEnvironment = Form.useWatch("jvmEnvironment", form) || "dev";
  const jvmAllowedModes = Form.useWatch("jvmAllowedModes", form);
  const jvmPreferredMode = Form.useWatch("jvmPreferredMode", form) || "jmx";
  const jvmDiagnosticEnabled =
    Form.useWatch("jvmDiagnosticEnabled", form) || false;
  const jvmDiagnosticTransport =
    Form.useWatch("jvmDiagnosticTransport", form) || "agent-bridge";
  const normalizedJvmAllowedModes = useMemo(
    () => normalizeEditableJVMModes(jvmAllowedModes),
    [jvmAllowedModes],
  );
  const hasUnsupportedJvmModeSelection = useMemo(
    () =>
      hasUnsupportedJVMEditableModes({
        allowedModes: jvmAllowedModes,
        preferredMode: jvmPreferredMode,
      }),
    [jvmAllowedModes, jvmPreferredMode],
  );
  const isOceanBaseOracle = dbType === "oceanbase" && oceanBaseProtocol === "oracle";
  const isMySQLLike = isMySQLCompatibleType(dbType) && !isOceanBaseOracle;
  const isRocketMQ = dbType === "rocketmq";
  const isMQTT = dbType === "mqtt";
  const isKafka = dbType === "kafka";
  const isRabbitMQ = dbType === "rabbitmq";
  const isPulsar = dbType === "pulsar";
  const supportsConnectionParams = supportsConnectionParamsForType(dbType);
  const isSSLType = supportsSSLForType(dbType);
  const supportsSSLCAPath = supportsSSLCAPathForType(dbType);
  const supportsSSLClientCertificate =
    supportsSSLClientCertificateForType(dbType);
  const sslHintText = isMySQLLike
    ? t("connection.modal.network.ssl.hint.mysqlCompatible")
    : isOceanBaseOracle
      ? t("connection.modal.network.ssl.hint.oceanBaseOracle")
      : dbType === "dameng"
      ? t("connection.modal.network.ssl.hint.dameng")
      : dbType === "sqlserver"
        ? t("connection.modal.network.ssl.hint.sqlserver")
        : dbType === "mongodb"
          ? t("connection.modal.network.ssl.hint.mongodb")
          : dbType === "oracle"
            ? t("connection.modal.network.ssl.hint.oracle")
            : dbType === "tdengine"
              ? t("connection.modal.network.ssl.hint.tdengine")
              : t("connection.modal.network.ssl.hint.default");
  const resolvedUriFeedbackMessage = uriFeedback
    ? t(uriFeedback.messageKey)
    : "";
  const resolvedTestResultMessage = !testResult
    ? ""
    : testResult.type === "success"
      ? String(testResult.message || "")
      : testResult.kind === "validation"
        ? t("connection.modal.test.validation")
        : t("connection.modal.test.failure", {
            reason: normalizeConnectionSecretErrorMessage(
              testResult.reason,
              t(testResult.fallbackKey),
            ),
          });

  const getSectionBg = (darkHex: string) => {
    if (!darkMode) {
      return `rgba(245, 245, 245, ${Math.max(effectiveOpacity, 0.92)})`;
    }
    const hex = darkHex.replace("#", "");
    const r = parseInt(hex.substring(0, 2), 16);
    const g = parseInt(hex.substring(2, 4), 16);
    const b = parseInt(hex.substring(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${Math.max(effectiveOpacity, 0.82)})`;
  };

  const overlayTheme = useMemo(
    () =>
      buildOverlayWorkbenchTheme(darkMode, {
        disableBackdropFilter: disableLocalBackdropFilter,
      }),
    [darkMode, disableLocalBackdropFilter],
  );

  const tunnelSectionStyle: React.CSSProperties = {
    padding: "12px",
    background: getSectionBg("#2a2a2a"),
    borderRadius: 6,
    marginTop: 12,
    border: darkMode
      ? "1px solid rgba(255, 255, 255, 0.16)"
      : "1px solid rgba(0, 0, 0, 0.06)",
  };
  return {
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
  };
};

export type ConnectionModalStateApi = ReturnType<typeof useConnectionModalState>;
