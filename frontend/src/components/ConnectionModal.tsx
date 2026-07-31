import React, { useState, useEffect, useRef, useMemo } from "react";
import Modal from './common/ResizableDraggableModal';
import {
  Form,
  Input,
  InputNumber,
  Button,
  message,
  Checkbox,
  Select,
  Alert,
  Typography,
  Space,
  Table,
  Tag,
  Switch,
} from "antd";
import {
  DatabaseOutlined,
  FileTextOutlined,
  CheckCircleFilled,
  CloseCircleFilled,
  ArrowLeftOutlined,
  CloseOutlined,
  PlusOutlined,
  ApiOutlined,
  ClusterOutlined,
  CodeOutlined,
  GatewayOutlined,
  SafetyCertificateOutlined,
  ThunderboltOutlined,
  DownOutlined,
  RightOutlined,
  SearchOutlined,
} from "@ant-design/icons";
import {
  getDbIcon,
  getDbDefaultColor,
  getDbIconLabel,
  getDbIconAssetSrc,
  getDbIconContainerBg,
  hasDbIconAsset,
  DB_ICON_TYPES,
  PRESET_ICON_COLORS,
} from "./DatabaseIcons";
import { useStore } from "../store";
import { buildOverlayWorkbenchTheme } from "../utils/overlayWorkbenchTheme";
import {
  isMacLikePlatform,
  normalizeOpacityForPlatform,
  resolveAppearanceValues,
} from "../utils/appearance";
import { t } from "../i18n";
import {
  getConnectionConfigLayoutKindLabel,
  getConnectionConfigSectionCopy,
  getStoredSecretPlaceholder,
  normalizeConnectionSecretErrorMessage,
  resolveConnectionConfigLayout,
  summarizeConnectionTestFailureMessage,
  type ConnectionConfigSectionKey,
} from "../utils/connectionModalPresentation";
import { getCustomConnectionDsnValidationMessage } from "../utils/customConnectionDsn";
import { mergeParsedUriValuesForForm } from "../utils/connectionUriMerge";
import { buildRpcConnectionConfig } from "../utils/connectionRpcConfig";
import {
  DEFAULT_CONNECTION_ENVIRONMENT,
  normalizeConnectionEnvironmentType,
} from "../utils/connectionEnvironment";
import { resolveConnectionProtectionConfig } from "../utils/connectionReadOnly";
import { getCustomConnectionDriverHelp } from "../utils/driverImportGuidance";
import { isBackendCancelledResult } from "../utils/connectionExport";
import {
  APP_FOREGROUND_MODAL_Z_INDEX,
  APP_NESTED_MODAL_Z_INDEX,
} from '../utils/overlayZIndex';
import {
  buildUriFromValues,
  getConnectionParamsPlaceholder,
  getUriPlaceholder,
  normalizeAddressList,
  normalizeClickHouseProtocolValue,
  normalizeConnectionParamsText,
  normalizeFileDbPath,
  normalizeMongoSrvHostList,
  normalizeOceanBaseConnectionParamsText,
  normalizeOceanBaseProtocolValue,
  parseClickHouseHTTPUriToValues,
  parseHostPort,
  parseUriToValues,
  toAddress,
  type ClickHouseProtocolChoice,
  type OceanBaseProtocolChoice,
} from "./connectionModal/connectionModalUri";
import {
  buildConnectionConfig,
  buildSavedConnectionInput,
  createEmptyConnectionSecretClearState,
  getBlockingSecretClearMessage,
  type ConnectionSecretClearState,
  type ConnectionSecretKey,
} from "./connectionModal/connectionModalConfig";
import ConnectionModalStep2 from "./connectionModal/ConnectionModalStep2";
import {
  buildConnectionTypeGroups,
  getAllConnectionTypeCatalogItems,
  getConnectionTypeDefaultPort as getDefaultPortByType,
  getConnectionTypeHint,
} from "../utils/connectionTypeCatalog";
import {
  isFileDatabaseType,
  isMySQLCompatibleType,
  supportsConnectionParamsForType,
  supportsSSLCAPathForType,
  supportsSSLClientCertificateForType,
  supportsSSLForType,
} from "../utils/connectionTypeCapabilities";
import {
  normalizeDriverType,
  resolveConnectionDriverType,
  type DriverStatusSnapshot,
} from "../utils/connectionDriverType";
import {
  normalizeOceanBaseProtocol,
  resolveOceanBaseProtocolFromQueryText as resolveOceanBaseProtocolQueryText,
} from "../utils/oceanBaseProtocol";
import {
  applyNoAutoCapAttributes,
  noAutoCapInputProps,
} from "../utils/inputAutoCap";
import { extractNacosConnectionScope } from "../utils/nacosConnectionScope";
import {
  buildDefaultJVMConnectionValues,
  hasUnsupportedJVMEditableModes,
  JVM_EDITABLE_MODES,
  normalizeEditableJVMModes,
  resolveEditableJVMModeSelection,
} from "../utils/jvmConnectionConfig";
import { resolveJVMModeMeta } from "../utils/jvmRuntimePresentation";
import {
  DBGetDatabases,
  GetDriverStatusList,
  MongoDiscoverMembers,
  TestConnection,
  RedisConnect,
  RedisGetDatabases,
  NacosConnect,
  SelectDatabaseFile,
  SelectCertificateFile,
  SelectSSHKeyFile,
  TestJVMConnection,
} from "../../wailsjs/go/app/App";
import { ConnectionConfig, MongoMemberInfo, SavedConnection } from "../types";

const { Text } = Typography;
type EditableJVMMode = (typeof JVM_EDITABLE_MODES)[number];
type ChoiceCardOption = {
  value: string;
  label: string;
  description?: string;
};
const MAX_TIMEOUT_SECONDS = 3600;
const DEFAULT_KEEPALIVE_INTERVAL_MINUTES = 240;
const PRIMARY_USERNAME_OPTIONAL_TYPES = new Set([
  "redis",
  "mongodb",
  "elasticsearch",
  "chroma",
  "qdrant",
  "milvus",
  "nacos",
  "rocketmq",
  "mqtt",
  "kafka",
  "rabbitmq",
]);
/** Step1/Step2 弹窗宽度统一为 760，centered 定位下切换步骤不再跳动；
 * Step2 密排表单本身仍保持 ~600 视觉宽度（见 .gn-conn-form-layout 的 max-width），避免右侧空洞或输入框被拉超长，
 * 只是在更宽的弹窗内居中显示。 */
const CONNECTION_MODAL_WIDTH_STEP1 = 760;
const CONNECTION_MODAL_WIDTH_STEP2 = 760;
// 头部高度约 60px，主体固定为 700px，使弹窗整体（760×760）接近正方形。
const CONNECTION_MODAL_BODY_HEIGHT = 700;
const REDIS_DEFAULT_DATABASE_COUNT = 16;
const CLICKHOUSE_PROTOCOL_OPTIONS: Array<{
  value: ClickHouseProtocolChoice;
  label?: string;
  labelKey?: string;
}> = [
  { value: "auto", labelKey: "connection.modal.field.clickHouseProtocol.auto" },
  { value: "http", label: "HTTP" },
  { value: "native", label: "Native" },
];
const OCEANBASE_PROTOCOL_OPTIONS: Array<{
  value: OceanBaseProtocolChoice;
  label: string;
}> = [
  { value: "mysql", label: "MySQL" },
  { value: "oracle", label: "Oracle" },
];

const normalizeRedisDatabaseIndex = (value: unknown): number | null => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.trunc(parsed);
};

const buildRedisDatabaseList = (...values: unknown[]): number[] => {
  const indexes = new Set<number>();
  for (let i = 0; i < REDIS_DEFAULT_DATABASE_COUNT; i += 1) {
    indexes.add(i);
  }
  const collect = (value: unknown) => {
    if (Array.isArray(value)) {
      value.forEach(collect);
      return;
    }
    const index = normalizeRedisDatabaseIndex(value);
    if (index !== null) {
      indexes.add(index);
    }
  };
  values.forEach(collect);
  return Array.from(indexes).sort((a, b) => a - b);
};

const extractRedisDatabaseList = (value: unknown): number[] => {
  if (!Array.isArray(value)) return [];
  const indexes = new Set<number>();
  value.forEach((row: any) => {
    const index = normalizeRedisDatabaseIndex(row?.index ?? row?.Index);
    if (index !== null) {
      indexes.add(index);
    }
  });
  const result = Array.from(indexes).sort((a, b) => a - b);
  return result.length > 0 ? result : buildRedisDatabaseList();
};

const normalizeRedisDatabaseSelection = (
  value: unknown,
  supportedDbs: number[],
): number[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const supported = new Set(supportedDbs);
  const selected = Array.from(
    new Set(
      value
        .map(normalizeRedisDatabaseIndex)
        .filter((index): index is number => index !== null)
        .filter((index) => supported.size === 0 || supported.has(index)),
    ),
  ).sort((a, b) => a - b);
  return selected.length > 0 ? selected : undefined;
};

const resolveOceanBaseProtocolValue = (
  value: unknown,
): OceanBaseProtocolChoice | undefined => {
  const text = String(value || "")
    .trim()
    .toLowerCase();
  if (!text) return undefined;
  return normalizeOceanBaseProtocol(text);
};
const resolveOceanBaseProtocolFromQueryText = (
  value: unknown,
): OceanBaseProtocolChoice | undefined => {
  return resolveOceanBaseProtocolQueryText(value).protocol;
};
const resolveOceanBaseProtocolForConfig = (
  config: Partial<ConnectionConfig>,
): OceanBaseProtocolChoice => {
  return (
    resolveOceanBaseProtocolValue(config.oceanBaseProtocol) ||
    resolveOceanBaseProtocolFromQueryText(config.connectionParams) ||
    resolveOceanBaseProtocolFromQueryText(config.uri) ||
    "mysql"
  );
};
type UriFeedbackState = {
  type: "success" | "warning" | "error";
  messageKey: string;
};

type TestFailureKind =
  | "validation"
  | "runtime"
  | "driver_unavailable"
  | "secret_blocked";

type TestResultState =
  | {
      type: "success";
      message: string;
    }
  | {
      type: "error";
      kind: TestFailureKind;
      reason: string;
      fallbackKey: string;
    };

const resolveInitialSecretFieldValue = (
  initialValues: SavedConnection | null | undefined,
  fieldName: string,
): string => {
  if (!initialValues) {
    return "";
  }

  const config = initialValues.config || ({} as ConnectionConfig);
  switch (fieldName) {
    case "password":
      return String(config.password || "");
    case "sshPassword":
      return String(config.ssh?.password || "");
    case "proxyPassword":
      return String(config.proxy?.password || "");
    case "httpTunnelPassword":
      return String(config.httpTunnel?.password || "");
    case "mysqlReplicaPassword":
      return String(config.mysqlReplicaPassword || "");
    case "mongoReplicaPassword":
      return String(config.mongoReplicaPassword || "");
    case "redisSentinelPassword":
      return String(config.redisSentinelPassword || "");
    case "uri":
      return String(config.uri || "");
    case "dsn":
      return String(config.dsn || "");
    default:
      return "";
  }
};

const ConnectionModal: React.FC<{
  open: boolean;
  onClose: () => void;
  initialValues?: SavedConnection | null;
  onOpenDriverManager?: () => void;
  onSaved?: (savedConnection: SavedConnection) => void | Promise<void>;
}> = ({ open, onClose, initialValues, onOpenDriverManager, onSaved }) => {
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
  const testInFlightRef = useRef(false);
  const testTimerRef = useRef<number | null>(null);
  const testRunIdRef = useRef(0);
  const addConnection = useStore((state) => state.addConnection);
  const updateConnection = useStore((state) => state.updateConnection);
  const savedConnections = useStore((state) => state.connections) ?? [];
  const recentConnectionTargets = useStore((state) => state.recentConnectionTargets) ?? [];
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
        uiVersion: appearance.uiVersion,
      }),
    [appearance.uiVersion, darkMode, disableLocalBackdropFilter],
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

  useEffect(() => {
    if (!open) return;
    const applyForConnectionModal = () => {
      document
        .querySelectorAll(
          ".connection-modal-wrap input, .connection-modal-wrap textarea",
        )
        .forEach(applyNoAutoCapAttributes);
    };
    applyForConnectionModal();
    const observer = new MutationObserver(() => {
      applyForConnectionModal();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
    };
  }, [open]);

  const modalShellStyle = useMemo(
    () => ({
      background: overlayTheme.shellBg,
      border: overlayTheme.shellBorder,
      boxShadow: overlayTheme.shellShadow,
      backdropFilter: overlayTheme.shellBackdropFilter,
    }),
    [overlayTheme],
  );

  // 弹窗内的区块容器去卡片化：原先是 14px 圆角 + 边框 + 独立底色，
  // 而它同时用在左侧导航容器、右侧内容面板与网络安全的各个分组上，
  // 再叠加内部分组各自的卡片，形成多层「卡片套卡片」，整页视觉噪声很高。
  // 现在只保留内边距，靠内部的小标题与分割线划分层次。
  // 保留原有内边距（间距不变，避免表单贴到容器边缘），只去掉边框、底色与圆角。
  const modalInnerSectionStyle = useMemo(
    () => ({
      padding: 14,
      borderRadius: 0,
      border: "none",
      background: "transparent",
    }),
    [],
  );

  const modalMutedTextStyle = useMemo(
    () => ({
      color: overlayTheme.mutedText,
      fontSize: 12,
      lineHeight: 1.6,
    }),
    [overlayTheme],
  );

  const renderStoredSecretControls = ({
    fieldName,
    clearKey,
    hasStoredSecret,
    clearLabel,
    description,
  }: {
    fieldName: string;
    clearKey: ConnectionSecretKey;
    hasStoredSecret?: boolean;
    clearLabel: string;
    description: string;
  }) => {
    if (!initialValues || !hasStoredSecret) {
      return null;
    }
    return (
      <Form.Item
        noStyle
        shouldUpdate={(prev, next) => prev[fieldName] !== next[fieldName]}
      >
        {({ getFieldValue }) => {
          const draftValue = getFieldValue(fieldName);
          const initialSecretValue = resolveInitialSecretFieldValue(
            initialValues,
            fieldName,
          );
          const normalizedDraftValue = String(draftValue ?? "");
          const matchesInitialSecret =
            initialSecretValue !== "" &&
            normalizedDraftValue === initialSecretValue;
          const hasDraftValue =
            normalizedDraftValue !== "" && !matchesInitialSecret;
          const cardBorder = darkMode
            ? "1px solid rgba(255,255,255,0.12)"
            : "1px solid rgba(16,24,40,0.08)";
          const cardBg = darkMode
            ? "rgba(255,255,255,0.03)"
            : "rgba(16,24,40,0.03)";
          const effectiveChecked = clearSecrets[clearKey] && !hasDraftValue;
          return (
            <div
              style={{
                marginBottom: 16,
                padding: "10px 12px",
                borderRadius: 10,
                border: cardBorder,
                background: cardBg,
              }}
            >
              <div
                style={{
                  fontSize: 12,
                  color: overlayTheme.mutedText,
                  lineHeight: 1.6,
                  marginBottom: 8,
                }}
              >
                {hasDraftValue
                  ? t("connection.modal.secret.draftReplacement")
                  : description}
              </div>
              <Checkbox
                checked={effectiveChecked}
                disabled={hasDraftValue}
                onChange={(event) => {
                  const checked = event.target.checked;
                  if (checked && matchesInitialSecret) {
                    form.setFieldValue(fieldName, "");
                  }
                  setClearSecrets((prev) => ({ ...prev, [clearKey]: checked }));
                }}
              >
                {clearLabel}
              </Checkbox>
            </div>
          );
        }}
      </Form.Item>
    );
  };
  const renderConnectionModalTitle = (
    icon: React.ReactNode,
    title: string,
    description: string,
  ) => (
    <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
      <div
        style={{
          width: 36,
          height: 36,
          borderRadius: 12,
          display: "grid",
          placeItems: "center",
          background: overlayTheme.iconBg,
          color: overlayTheme.iconColor,
          flexShrink: 0,
        }}
      >
        {icon}
      </div>
      <div style={{ minWidth: 0 }}>
        <div
          style={{
            fontSize: 16,
            fontWeight: 700,
            color: overlayTheme.titleText,
          }}
        >
          {title}
        </div>
        <div
          style={{
            marginTop: 4,
            color: overlayTheme.mutedText,
            fontSize: 12,
            lineHeight: 1.6,
          }}
        >
          {description}
        </div>
      </div>
    </div>
  );

  const getConnectionOptionCardStyle = (
    _enabled: boolean,
  ): React.CSSProperties => ({
    padding: "12px 14px",
    borderRadius: 14,
    border: "1px solid transparent",
    background: darkMode ? "rgba(255,255,255,0.02)" : "rgba(255,255,255,0.72)",
    boxShadow: darkMode
      ? "inset 0 0 0 1px rgba(255,255,255,0.028)"
      : "inset 0 0 0 1px rgba(16,24,40,0.03)",
    transition: "all 120ms ease",
  });

  const jvmSectionCardStyle = (): React.CSSProperties => ({
    ...modalInnerSectionStyle,
    padding: 16,
  });

  const renderJvmSectionHeader = (
    icon: React.ReactNode,
    title: string,
    description: string,
    badge?: React.ReactNode,
    options?: {
      cursor?: React.CSSProperties["cursor"];
      marginBottom?: number;
      onClick?: () => void;
    },
  ) => (
    <div
      onClick={options?.onClick}
      style={{
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "space-between",
        gap: 12,
        marginBottom: options?.marginBottom ?? 14,
        cursor: options?.cursor,
      }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
        <div
          style={{
            width: 34,
            height: 34,
            borderRadius: 12,
            display: "grid",
            placeItems: "center",
            flexShrink: 0,
            background: darkMode
              ? "rgba(255,214,102,0.14)"
              : "rgba(22,119,255,0.10)",
            color: darkMode ? "#ffd666" : "#1677ff",
          }}
        >
          {icon}
        </div>
        <div style={{ minWidth: 0 }}>
          <div
            style={{
              color: darkMode ? "#f5f7ff" : "#162033",
              fontSize: 14,
              fontWeight: 800,
            }}
          >
            {title}
          </div>
          <div style={{ ...modalMutedTextStyle, marginTop: 4 }}>
            {description}
          </div>
        </div>
      </div>
      {badge ? <div style={{ flexShrink: 0 }}>{badge}</div> : null}
    </div>
  );

  // 表单分组改用「小标题 + 细分割线」而不是卡片：
  // 原先每个分组都是 16px 圆角 + 边框 + 内阴影 + 独立底色的卡片，一屏里叠七八个，
  // 视觉噪声极高且每张卡各占 16px 内边距，把真正的字段挤得很散。
  // 去掉边框/圆角/底色/内阴影，只保留组间的一条上分割线来划分层次，字段密度明显提升。
  const configSectionCardStyle = (): React.CSSProperties => ({
    paddingTop: 18,
    borderTop: darkMode
      ? "1px solid rgba(255,255,255,0.07)"
      : "1px solid rgba(16,24,40,0.07)",
  });

  const renderConfigSectionCard = ({
    sectionKey,
    icon,
    children,
    badge,
    collapsible,
    expanded = true,
    onToggle,
  }: {
    sectionKey: ConnectionConfigSectionKey;
    icon: React.ReactNode;
    children: React.ReactNode;
    badge?: React.ReactNode;
    collapsible?: boolean;
    expanded?: boolean;
    onToggle?: () => void;
  }) => {
    const copy = getConnectionConfigSectionCopy(sectionKey);
    const showChildren = !collapsible || expanded;
    const resolvedBadge = collapsible ? (
      <Space size={8}>
        {badge}
        <Button
          type="text"
          size="small"
          aria-label={copy.title}
          aria-expanded={expanded}
          data-connection-config-section-toggle={sectionKey}
          onClick={(event) => {
            event.stopPropagation();
            onToggle?.();
          }}
          style={{
            width: 26,
            height: 26,
            minWidth: 26,
            padding: 0,
            borderRadius: 8,
            color: overlayTheme.mutedText,
          }}
        >
          {expanded ? <DownOutlined /> : <RightOutlined />}
        </Button>
      </Space>
    ) : badge;
    return (
      <div
        data-connection-config-section={sectionKey}
        style={configSectionCardStyle()}
      >
        {renderJvmSectionHeader(
          icon,
          copy.title,
          copy.description,
          resolvedBadge,
          collapsible
            ? {
                cursor: "pointer",
                marginBottom: showChildren ? 14 : 0,
                onClick: onToggle,
              }
            : undefined,
        )}
        {showChildren ? children : null}
      </div>
    );
  };

  const clearConnectionTestResultForChoice = () => {
    if (testResult) {
      setTestResult(null);
      setTestErrorLogOpen(false);
    }
  };

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

  const fetchDriverStatusMap = async (): Promise<
    Record<string, DriverStatusSnapshot>
  > => {
    const result: Record<string, DriverStatusSnapshot> = {};
    const res = await GetDriverStatusList("", "");
    if (!res?.success) {
      return result;
    }
    const data = (res?.data || {}) as any;
    const drivers = Array.isArray(data.drivers) ? data.drivers : [];
    drivers.forEach((item: any) => {
      const type = normalizeDriverType(String(item.type || "").trim());
      if (!type) return;
      result[type] = {
        type,
        name: String(item.name || item.type || type).trim(),
        connectable: !!item.connectable,
        expectedRevision: String(item.expectedRevision || "").trim() || undefined,
        needsUpdate: !!item.needsUpdate,
        updateReason: String(item.updateReason || "").trim() || undefined,
        affectedConnections: Number.isFinite(Number(item.affectedConnections))
          ? Number(item.affectedConnections)
          : undefined,
        message: String(item.message || "").trim() || undefined,
      };
    });
    return result;
  };

  const refreshDriverStatus = async () => {
    try {
      const next = await fetchDriverStatusMap();
      setDriverStatusMap(next);
    } catch {
      setDriverStatusMap({});
    } finally {
      setDriverStatusLoaded(true);
    }
  };

  const resolveDriverUnavailableReason = async (
    type: string,
    driver?: string,
  ): Promise<string> => {
    const normalized = resolveConnectionDriverType(type, driver);
    if (!normalized || normalized === "custom") {
      return "";
    }
    let snapshot = driverStatusMap;
    if (!snapshot[normalized]) {
      snapshot = await fetchDriverStatusMap();
      setDriverStatusMap(snapshot);
    }
    const status = snapshot[normalized];
    if (!status || status.connectable) {
      return "";
    }
    return (
      status.message ||
      t("connection.modal.driver.unavailableFallback", {
        name: status.name || normalized,
      })
    );
  };

  const promptInstallDriver = (driverType: string, reason: string) => {
    const normalized = normalizeDriverType(driverType);
    const snapshot = driverStatusMap[normalized];
    const driverName =
      snapshot?.name || normalized || t("connection.modal.driver.currentFallback");
    Modal.confirm({
      title: t("connection.modal.driver.unavailableTitle", {
        name: driverName,
      }),
      content:
        reason ||
        t("connection.modal.driver.unavailableFallback", {
          name: driverName,
        }),
      okText: t("connection.modal.driver.installAction"),
      cancelText: t("common.action.cancel"),
      onOk: () => {
        onOpenDriverManager?.();
      },
    });
  };

  const createUriAwareRequiredRule =
    (messageText: string, validateValue?: (value: unknown) => boolean) =>
    ({ getFieldValue }: { getFieldValue: (name: string) => unknown }) => ({
      validator(_: unknown, value: unknown) {
        const uriText = String(getFieldValue("uri") || "").trim();
        const type = String(getFieldValue("type") || dbType)
          .trim()
          .toLowerCase();
        if (uriText && parseUriToValues(uriText, type)) {
          return Promise.resolve();
        }
        const valid = validateValue
          ? validateValue(value)
          : String(value ?? "").trim() !== "";
        return valid
          ? Promise.resolve()
          : Promise.reject(new Error(messageText));
      },
    });

  const createCustomDsnRule = () => ({
    validator(_: unknown, value: unknown) {
      const validationMessage = getCustomConnectionDsnValidationMessage({
        dsnInput: value,
        hasStoredSecret: initialValues?.hasOpaqueDSN,
        clearStoredSecret: clearSecrets.opaqueDSN,
      });
      return validationMessage
        ? Promise.reject(new Error(validationMessage))
        : Promise.resolve();
    },
  });

  const handleGenerateURI = () => {
    try {
      const values = form.getFieldsValue(true);
      const uri = buildUriFromValues(values);
      form.setFieldValue("uri", uri);
      setUriFeedback({
        type: "success",
        messageKey: "connection.modal.uri.feedback.generated",
      });
    } catch {
      setUriFeedback({
        type: "error",
        messageKey: "connection.modal.uri.feedback.generateFailed",
      });
    }
  };

  const handleParseURI = () => {
    try {
      const uriText = String(form.getFieldValue("uri") || "").trim();
      const type = String(form.getFieldValue("type") || dbType)
        .trim()
        .toLowerCase();
      if (!uriText) {
        setUriFeedback({
          type: "warning",
          messageKey: "connection.modal.uri.feedback.emptyInput",
        });
        return;
      }
      const parsedValues = parseUriToValues(uriText, type);
      if (!parsedValues) {
        setUriFeedback({
          type: "error",
          messageKey: "connection.modal.uri.feedback.unsupported",
        });
        return;
      }
      form.setFieldsValue(
        mergeParsedUriValuesForForm(
          form.getFieldsValue(true),
          parsedValues,
          uriText,
        ),
      );
      if (testResult) {
        setTestResult(null);
      }
      setUriFeedback({
        type: "success",
        messageKey: "connection.modal.uri.feedback.parsed",
      });
    } catch {
      setUriFeedback({
        type: "error",
        messageKey: "connection.modal.uri.feedback.parseFailed",
      });
    }
  };

  const handleCopyURI = async () => {
    let uriText = String(form.getFieldValue("uri") || "").trim();
    if (!uriText) {
      const values = form.getFieldsValue(true);
      uriText = buildUriFromValues(values);
      form.setFieldValue("uri", uriText);
    }
    if (!uriText) {
      setUriFeedback({
        type: "warning",
        messageKey: "connection.modal.uri.feedback.emptyCopy",
      });
      return;
    }
    try {
      await navigator.clipboard.writeText(uriText);
      setUriFeedback({
        type: "success",
        messageKey: "connection.modal.uri.feedback.copied",
      });
    } catch {
      setUriFeedback({
        type: "error",
        messageKey: "connection.modal.uri.feedback.copyFailed",
      });
    }
  };

  const handleSelectSSHKeyFile = async () => {
    if (selectingSSHKey) {
      return;
    }
    try {
      setSelectingSSHKey(true);
      const currentPath = String(form.getFieldValue("sshKeyPath") || "").trim();
      const res = await SelectSSHKeyFile(currentPath);
      if (res?.success) {
        const data = res.data || {};
        const selectedPath =
          typeof data === "string" ? data : String(data.path || "").trim();
        if (selectedPath) {
          form.setFieldValue("sshKeyPath", selectedPath);
        }
      } else if (!isBackendCancelledResult(res)) {
        message.error(
          t("connection.modal.filePicker.sshKeyFailure", {
            detail: res?.message || t("connection.modal.error.unknown"),
          }),
        );
      }
    } catch (e: any) {
      message.error(
        t("connection.modal.filePicker.sshKeyFailure", {
          detail: e?.message || String(e),
        }),
      );
    } finally {
      setSelectingSSHKey(false);
    }
  };

  const handleSelectCertificateFile = async (
    fieldName: "sslCAPath" | "sslCertPath" | "sslKeyPath",
    certKind: "ca" | "client-cert" | "client-key",
  ) => {
    if (selectingCertificateField) {
      return;
    }
    try {
      setSelectingCertificateField(fieldName);
      const currentPath = String(form.getFieldValue(fieldName) || "").trim();
      const res = await SelectCertificateFile(currentPath, certKind);
      if (res?.success) {
        const data = res.data || {};
        const selectedPath =
          typeof data === "string" ? data : String(data.path || "").trim();
        if (selectedPath) {
          form.setFieldValue(fieldName, selectedPath);
        }
      } else if (!isBackendCancelledResult(res)) {
        message.error(
          t("connection.modal.filePicker.certificateFailure", {
            detail: res?.message || t("connection.modal.error.unknown"),
          }),
        );
      }
    } catch (e: any) {
      message.error(
        t("connection.modal.filePicker.certificateFailure", {
          detail: e?.message || String(e),
        }),
      );
    } finally {
      setSelectingCertificateField(null);
    }
  };

  const handleSelectDatabaseFile = async () => {
    if (selectingDbFile) {
      return;
    }
    try {
      setSelectingDbFile(true);
      const currentPath = String(form.getFieldValue("host") || "").trim();
      const res = await SelectDatabaseFile(currentPath, dbType);
      if (res?.success) {
        const data = res.data || {};
        const selectedPath =
          typeof data === "string" ? data : String(data.path || "").trim();
        if (selectedPath) {
          form.setFieldValue("host", normalizeFileDbPath(selectedPath));
        }
      } else if (!isBackendCancelledResult(res)) {
        message.error(
          t("connection.modal.filePicker.databaseFailure", {
            detail: res?.message || t("connection.modal.error.unknown"),
          }),
        );
      }
    } catch (e: any) {
      message.error(
        t("connection.modal.filePicker.databaseFailure", {
          detail: e?.message || String(e),
        }),
      );
    } finally {
      setSelectingDbFile(false);
    }
  };

  useEffect(() => {
    testRunIdRef.current += 1;
    if (open) {
      setSaving(false);
      setTestingConnection(false);
      testInFlightRef.current = false;
      if (testTimerRef.current !== null) {
        window.clearTimeout(testTimerRef.current);
        testTimerRef.current = null;
      }
      setTestResult(null); // Reset test result
      setTestErrorLogOpen(false);
      setDbList([]);
      setRedisDbList([]);
      setMongoMembers([]);
      setUriFeedback(null);
      setCustomIconType(undefined);
      setCustomIconColor(undefined);
      setClearSecrets(createEmptyConnectionSecretClearState());
      setPrimaryPasswordVisible(false);
      setTypeSelectWarning(null);
      setDriverStatusLoaded(false);
      void refreshDriverStatus();
      if (initialValues) {
        // Edit mode: Go directly to step 2
        setStep(2);
        const config: any = initialValues.config || {};
        const configType = String(config.type || "mysql");
        const isJvmConfigType = configType === "jvm";
        const defaultPort = getDefaultPortByType(configType);
        const isFileDbConfigType = isFileDatabaseType(configType);
        const jvmDefaultValues = buildDefaultJVMConnectionValues();
        const savedPrimaryAddress = isFileDbConfigType
          ? ""
          : toAddress(
              config.host || "localhost",
              Number(config.port || defaultPort),
              defaultPort,
            );
        const normalizedHosts = isFileDbConfigType
          ? []
          : normalizeAddressList(
              [
                savedPrimaryAddress,
                ...(Array.isArray(config.hosts) ? config.hosts : []),
              ],
              defaultPort,
            );
        const primaryAddress = isFileDbConfigType
          ? null
          : parseHostPort(
              normalizedHosts[0] ||
                savedPrimaryAddress,
              defaultPort,
            );
        const primaryHost = isFileDbConfigType
          ? normalizeFileDbPath(String(config.host || ""))
          : primaryAddress?.host || String(config.host || "localhost");
        const primaryPort = isFileDbConfigType
          ? 0
          : primaryAddress?.port || Number(config.port || defaultPort);
        const mysqlReplicaHosts =
          configType === "mysql" ||
          configType === "goldendb" ||
          configType === "mariadb" ||
          configType === "oceanbase" ||
          configType === "diros" ||
          configType === "starrocks" ||
          configType === "sphinx"
            ? normalizedHosts.slice(1)
            : [];
        const rocketmqHosts =
          configType === "rocketmq" ? normalizedHosts.slice(1) : [];
        const mqttHosts =
          configType === "mqtt" ? normalizedHosts.slice(1) : [];
        const kafkaHosts =
          configType === "kafka" ? normalizedHosts.slice(1) : [];
        const mongoHosts =
          configType === "mongodb" ? normalizedHosts.slice(1) : [];
        const redisHosts =
          configType === "redis" ? normalizedHosts.slice(1) : [];
        const mysqlIsReplica =
          String(config.topology || "").toLowerCase() === "replica" ||
          mysqlReplicaHosts.length > 0;
        const rocketmqIsCluster =
          String(config.topology || "").toLowerCase() === "cluster" ||
          rocketmqHosts.length > 0;
        const mqttIsCluster =
          String(config.topology || "").toLowerCase() === "cluster" ||
          mqttHosts.length > 0;
        const kafkaIsCluster =
          String(config.topology || "").toLowerCase() === "cluster" ||
          kafkaHosts.length > 0;
        const mongoIsReplica =
          String(config.topology || "").toLowerCase() === "replica" ||
          mongoHosts.length > 0 ||
          !!config.replicaSet;
        const redisTopologyValue = String(config.topology || "").toLowerCase();
        const redisIsSentinel = redisTopologyValue === "sentinel";
        const redisIsCluster =
          !redisIsSentinel &&
          (redisTopologyValue === "cluster" || redisHosts.length > 0);
        const {
          allowedModes: resolvedJvmAllowedModes,
          preferredMode: resolvedJvmPreferredMode,
        } = resolveEditableJVMModeSelection({
          allowedModes: config.jvm?.allowedModes,
          preferredMode: config.jvm?.preferredMode,
        });
        const resolvedJvmTimeout = isJvmConfigType
          ? Number(config.jvm?.endpoint?.timeoutSeconds || config.timeout || 30)
          : Number(config.timeout || 30);
        const hasHttpTunnel = !!config.useHttpTunnel;
        const hasProxy = !hasHttpTunnel && !!config.useProxy;
        const protection = resolveConnectionProtectionConfig(config);
        const parsedInitialUri = config.uri
          ? parseUriToValues(config.uri, configType)
          : null;
        const hasStoredConnectionParams =
          String(config.connectionParams || "").trim() !== "";
        const initialConnectionParams =
          (hasStoredConnectionParams ? config.connectionParams : "") ||
          parsedInitialUri?.connectionParams ||
          "";
        const nacosConnectionScope =
          configType === "nacos"
            ? extractNacosConnectionScope(initialConnectionParams)
            : null;
        const initialNacosNamespaceId =
          configType === "nacos" && !hasStoredConnectionParams
            ? String(
                parsedInitialUri?.nacosNamespaceId ||
                  nacosConnectionScope?.scope.namespaceId ||
                  "",
              ).trim()
            : nacosConnectionScope?.scope.namespaceId || "";
        form.setFieldsValue({
          type: configType,
          name: initialValues.name,
          environmentType: normalizeConnectionEnvironmentType(
            initialValues.environmentType,
          ),
          host: primaryHost,
          port: primaryPort,
          user: config.user,
          password: config.password,
          database: config.database,
          restrictDataEdit: protection.restrictDataEdit === true,
          restrictStructureEdit: protection.restrictStructureEdit === true,
          restrictScriptExecution:
            protection.restrictScriptExecution === true,
          restrictDataImport: protection.restrictDataImport === true,
          uri: config.uri || "",
          connectionParams:
            nacosConnectionScope?.connectionParams ?? initialConnectionParams,
          nacosNamespaceId: initialNacosNamespaceId,
          clickHouseProtocol:
            configType === "clickhouse"
              ? normalizeClickHouseProtocolValue(config.clickHouseProtocol)
              : "auto",
          oceanBaseProtocol:
            configType === "oceanbase"
              ? resolveOceanBaseProtocolForConfig(config)
              : "mysql",
          includeDatabases: initialValues.includeDatabases,
          includeRedisDatabases: initialValues.includeRedisDatabases,
          useSSL: !!config.useSSL,
          sslMode: config.sslMode || "preferred",
          sslCAPath: config.sslCAPath || "",
          sslCertPath: config.sslCertPath || "",
          sslKeyPath: config.sslKeyPath || "",
          useSSH: config.useSSH,
          sshHost: config.ssh?.host,
          sshPort: config.ssh?.port,
          sshUser: config.ssh?.user,
          sshPassword: config.ssh?.password,
          sshKeyPath: config.ssh?.keyPath,
          useProxy: hasProxy,
          proxyType: config.proxy?.type || "socks5",
          proxyHost: config.proxy?.host,
          proxyPort: config.proxy?.port,
          proxyUser: config.proxy?.user,
          proxyPassword: config.proxy?.password,
          useHttpTunnel: hasHttpTunnel,
          httpTunnelHost: config.httpTunnel?.host,
          httpTunnelPort: config.httpTunnel?.port || 8080,
          httpTunnelUser: config.httpTunnel?.user,
          httpTunnelPassword: config.httpTunnel?.password,
          driver: config.driver,
          dsn: config.dsn,
          timeout: resolvedJvmTimeout,
          keepAliveEnabled: !!config.keepAliveEnabled,
          keepAliveIntervalMinutes:
            Number(config.keepAliveIntervalMinutes) > 0
              ? Number(config.keepAliveIntervalMinutes)
              : DEFAULT_KEEPALIVE_INTERVAL_MINUTES,
          keepAliveSQL: config.keepAliveSQL || "",
          mysqlTopology: mysqlIsReplica ? "replica" : "single",
          mysqlReplicaHosts: mysqlReplicaHosts,
          rocketmqTopology: rocketmqIsCluster ? "cluster" : "single",
          rocketmqHosts: rocketmqHosts,
          mqttTopology: mqttIsCluster ? "cluster" : "single",
          mqttHosts: mqttHosts,
          kafkaTopology: kafkaIsCluster ? "cluster" : "single",
          kafkaHosts: kafkaHosts,
          mysqlReplicaUser: config.mysqlReplicaUser || "",
          mysqlReplicaPassword: config.mysqlReplicaPassword || "",
          mongoTopology: mongoIsReplica ? "replica" : "single",
          mongoHosts: mongoHosts,
          redisTopology: redisIsSentinel
            ? "sentinel"
            : redisIsCluster
              ? "cluster"
              : "single",
          redisHosts: redisHosts,
          redisSentinelMaster: config.redisSentinelMaster || "",
          redisSentinelUser: config.redisSentinelUser || "",
          redisSentinelPassword: config.redisSentinelPassword || "",
          mongoSrv: !!config.mongoSrv,
          mongoReplicaSet: config.replicaSet || "",
          mongoAuthSource: config.authSource || "",
          mongoReadPreference: config.readPreference || "primary",
          mongoAuthMechanism: config.mongoAuthMechanism || "",
          savePassword: config.savePassword !== false,
          redisDB: Number.isFinite(Number(config.redisDB))
            ? Number(config.redisDB)
            : 0,
          mongoReplicaUser: config.mongoReplicaUser || "",
          mongoReplicaPassword: config.mongoReplicaPassword || "",
          jvmReadOnly: isJvmConfigType
            ? (config.jvm?.readOnly ?? jvmDefaultValues.jvmReadOnly)
            : jvmDefaultValues.jvmReadOnly,
          jvmAllowedModes: isJvmConfigType
            ? resolvedJvmAllowedModes
            : jvmDefaultValues.jvmAllowedModes,
          jvmPreferredMode: isJvmConfigType
            ? resolvedJvmPreferredMode
            : jvmDefaultValues.jvmPreferredMode,
          jvmEnvironment: isJvmConfigType
            ? config.jvm?.environment || jvmDefaultValues.jvmEnvironment
            : jvmDefaultValues.jvmEnvironment,
          jvmEndpointEnabled: isJvmConfigType
            ? (config.jvm?.endpoint?.enabled ??
              resolvedJvmAllowedModes.includes("endpoint"))
            : jvmDefaultValues.jvmEndpointEnabled,
          jvmEndpointBaseUrl: isJvmConfigType
            ? config.jvm?.endpoint?.baseUrl || ""
            : jvmDefaultValues.jvmEndpointBaseUrl,
          jvmEndpointApiKey: isJvmConfigType
            ? config.jvm?.endpoint?.apiKey || ""
            : jvmDefaultValues.jvmEndpointApiKey,
          jvmAgentEnabled: isJvmConfigType
            ? (config.jvm?.agent?.enabled ??
              resolvedJvmAllowedModes.includes("agent"))
            : jvmDefaultValues.jvmAgentEnabled,
          jvmAgentBaseUrl: isJvmConfigType
            ? config.jvm?.agent?.baseUrl || ""
            : jvmDefaultValues.jvmAgentBaseUrl,
          jvmAgentApiKey: isJvmConfigType
            ? config.jvm?.agent?.apiKey || ""
            : jvmDefaultValues.jvmAgentApiKey,
          jvmDiagnosticEnabled: isJvmConfigType
            ? (config.jvm?.diagnostic?.enabled ??
              jvmDefaultValues.jvmDiagnosticEnabled)
            : jvmDefaultValues.jvmDiagnosticEnabled,
          jvmDiagnosticTransport: isJvmConfigType
            ? config.jvm?.diagnostic?.transport ||
              jvmDefaultValues.jvmDiagnosticTransport
            : jvmDefaultValues.jvmDiagnosticTransport,
          jvmDiagnosticBaseUrl: isJvmConfigType
            ? config.jvm?.diagnostic?.baseUrl || ""
            : jvmDefaultValues.jvmDiagnosticBaseUrl,
          jvmDiagnosticTargetId: isJvmConfigType
            ? config.jvm?.diagnostic?.targetId || ""
            : jvmDefaultValues.jvmDiagnosticTargetId,
          jvmDiagnosticApiKey: isJvmConfigType
            ? config.jvm?.diagnostic?.apiKey || ""
            : jvmDefaultValues.jvmDiagnosticApiKey,
          jvmDiagnosticAllowObserveCommands: isJvmConfigType
            ? (config.jvm?.diagnostic?.allowObserveCommands ??
              jvmDefaultValues.jvmDiagnosticAllowObserveCommands)
            : jvmDefaultValues.jvmDiagnosticAllowObserveCommands,
          jvmDiagnosticAllowTraceCommands: isJvmConfigType
            ? (config.jvm?.diagnostic?.allowTraceCommands ??
              jvmDefaultValues.jvmDiagnosticAllowTraceCommands)
            : jvmDefaultValues.jvmDiagnosticAllowTraceCommands,
          jvmDiagnosticAllowMutatingCommands: isJvmConfigType
            ? (config.jvm?.diagnostic?.allowMutatingCommands ??
              jvmDefaultValues.jvmDiagnosticAllowMutatingCommands)
            : jvmDefaultValues.jvmDiagnosticAllowMutatingCommands,
          jvmDiagnosticTimeoutSeconds: isJvmConfigType
            ? Number(
                config.jvm?.diagnostic?.timeoutSeconds ||
                  jvmDefaultValues.jvmDiagnosticTimeoutSeconds,
              )
            : jvmDefaultValues.jvmDiagnosticTimeoutSeconds,
          jvmEndpointTimeoutSeconds: resolvedJvmTimeout,
          jvmJmxHost:
            isJvmConfigType &&
            config.jvm?.jmx?.host &&
            config.jvm.jmx.host !== primaryHost
              ? config.jvm.jmx.host
              : "",
          jvmJmxPort:
            isJvmConfigType &&
            Number(config.jvm?.jmx?.port) > 0 &&
            Number(config.jvm.jmx.port) !== Number(primaryPort || defaultPort)
              ? Number(config.jvm.jmx.port)
              : undefined,
          jvmJmxUsername: isJvmConfigType
            ? config.jvm?.jmx?.username || ""
            : "",
          jvmJmxPassword: isJvmConfigType
            ? config.jvm?.jmx?.password || ""
            : "",
        });
        setPrimaryPasswordVisible(false);
        setUseSSL(!!config.useSSL);
        setCustomIconType(initialValues.iconType);
        setCustomIconColor(initialValues.iconColor);
        setUseSSH(config.useSSH || false);
        setUseProxy(hasProxy);
        setUseHttpTunnel(hasHttpTunnel);
        setDbType(configType);
        if (config.useSSL && supportsSSLForType(configType)) {
          setActiveNetworkConfig("ssl");
        } else if (config.useSSH) {
          setActiveNetworkConfig("ssh");
        } else if (hasProxy) {
          setActiveNetworkConfig("proxy");
        } else if (hasHttpTunnel) {
          setActiveNetworkConfig("httpTunnel");
        } else {
          setActiveNetworkConfig("ssl");
        }
        // 如果是 Redis 编辑模式，设置已保存的 Redis 数据库列表
        if (configType === "redis") {
          setRedisDbList(
            buildRedisDatabaseList(
              config.redisDB,
              initialValues.includeRedisDatabases,
            ),
          );
        }
      } else {
        // Create mode: Start at step 1
        setActiveConfigSection("basic");
        setStep(1);
        form.resetFields();
        form.setFieldValue(
          "environmentType",
          DEFAULT_CONNECTION_ENVIRONMENT,
        );
        setUseSSL(false);
        setUseSSH(false);
        setUseProxy(false);
        setUseHttpTunnel(false);
        setDbType("mysql");
        setActiveGroup(0);
        setDbTypeQuery("");
        setActiveConfigSection("basic");
        setActiveNetworkConfig("ssl");
        setPrimaryPasswordVisible(false);
      }
    }
  }, [open, initialValues]);

  useEffect(() => {
    return () => {
      testRunIdRef.current += 1;
      if (testTimerRef.current !== null) {
        window.clearTimeout(testTimerRef.current);
        testTimerRef.current = null;
      }
    };
  }, []);

  const handleOk = async () => {
    try {
      await form.validateFields();
      const values = { ...form.getFieldsValue(true), type: dbType };
      const unavailableReason = await resolveDriverUnavailableReason(
        values.type,
        values.driver,
      );
      if (unavailableReason) {
        message.warning(unavailableReason);
        promptInstallDriver(
          resolveConnectionDriverType(values.type, values.driver) || values.type,
          unavailableReason,
        );
        return;
      }
      setSaving(true);

      const config = await buildConnectionConfig({
        values,
        forPersist: true,
        initialValues,
        nacosNamespaceIdTouched:
          form.isFieldTouched?.("nacosNamespaceId") === true,
        translate: t,
      });
      const payload = buildSavedConnectionInput({
        config,
        values,
        initialValues,
        clearSecrets,
        customIconType,
        customIconColor,
      });
      const backendApp = (window as any).go?.app?.App;
      const savedConnection = await backendApp?.SaveConnection?.(payload);
      if (!savedConnection) {
        throw new Error(t("connection.modal.save.backendUnavailable"));
      }

      if (initialValues) {
        updateConnection(savedConnection);
        message.success(t("connection.modal.save.updatedUnconnected"));
      } else {
        addConnection(savedConnection);
        message.success(t("connection.modal.save.savedUnconnected"));
      }

      if (onSaved) {
        void Promise.resolve(onSaved(savedConnection)).catch(
          (error: unknown) => {
            console.warn("Failed to refresh post-save state", error);
            void message.warning(
              t("connection.modal.save.refreshWarning"),
            );
          },
        );
      }

      form.resetFields();
      setUseSSL(false);
      setUseSSH(false);
      setUseProxy(false);
      setUseHttpTunnel(false);
      setDbType("mysql");
      setStep(1);
      setClearSecrets(createEmptyConnectionSecretClearState());
      onClose();
    } catch (e: any) {
      message.error(
        normalizeConnectionSecretErrorMessage(
          e?.message || e,
          t("connection.modal.save.failureFallback"),
        ),
      );
    } finally {
      setSaving(false);
    }
  };

  const requestTest = () => {
    if (saving || testingConnection) return;
    if (testTimerRef.current !== null) return;
    testTimerRef.current = window.setTimeout(() => {
      testTimerRef.current = null;
      handleTest();
    }, 0);
  };

  const withClientTimeout = async <T,>(
    promise: Promise<T>,
    timeoutMs: number,
    timeoutMessage: string,
  ): Promise<T> => {
    let timer: number | null = null;
    try {
      return await Promise.race([
        promise,
        new Promise<T>((_, reject) => {
          timer = window.setTimeout(
            () => reject(new Error(timeoutMessage)),
            timeoutMs,
          );
        }),
      ]);
    } finally {
      if (timer !== null) {
        window.clearTimeout(timer);
      }
    }
  };

  const applyTestFailureFeedback = ({
    kind,
    reason,
    fallbackKey,
  }: {
    kind: TestFailureKind;
    reason?: unknown;
    fallbackKey: string;
  }) => {
    void message.destroy("connection-test-failure");
    setTestResult({
      type: "error",
      kind,
      reason: String(reason ?? ""),
      fallbackKey,
    });
  };

  const handleTest = async () => {
    if (testInFlightRef.current) return;
    testInFlightRef.current = true;
    const testRunId = ++testRunIdRef.current;
    const isCurrentTestRun = () => testRunIdRef.current === testRunId;
    try {
      await form.validateFields();
      if (!isCurrentTestRun()) return;
      const values = { ...form.getFieldsValue(true), type: dbType };
      const unavailableReason = await resolveDriverUnavailableReason(
        values.type,
        values.driver,
      );
      if (!isCurrentTestRun()) return;
      if (unavailableReason) {
        applyTestFailureFeedback({
          kind: "driver_unavailable",
          reason: unavailableReason,
          fallbackKey: "connection.modal.test.fallback.driverUnavailable",
        });
        promptInstallDriver(
          resolveConnectionDriverType(values.type, values.driver) || values.type,
          unavailableReason,
        );
        return;
      }
      const blockingSecretClearMessage = getBlockingSecretClearMessage({
        values,
        clearSecrets,
        initialValues,
        translate: t,
      });
      if (blockingSecretClearMessage) {
        applyTestFailureFeedback({
          kind: "secret_blocked",
          reason: blockingSecretClearMessage,
          fallbackKey: "connection.modal.test.fallback.incompleteParams",
        });
        return;
      }
      setTestingConnection(true);
      setTestResult(null);
      const config = await buildConnectionConfig({
        values,
        forPersist: false,
        initialValues,
        nacosNamespaceIdTouched:
          form.isFieldTouched?.("nacosNamespaceId") === true,
        translate: t,
      });
      if (!isCurrentTestRun()) return;
      if (initialValues?.id) {
        config.id = initialValues.id;
      }
      const timeoutSecondsRaw = Number(values.timeout);
      const timeoutSeconds =
        Number.isFinite(timeoutSecondsRaw) && timeoutSecondsRaw > 0
          ? Math.min(timeoutSecondsRaw, MAX_TIMEOUT_SECONDS)
          : 30;
      const rpcTimeoutMs = (timeoutSeconds + 5) * 1000;

      // Use different API for Redis / JVM / Nacos
      const isRedisType = values.type === "redis";
      const isJVMType = values.type === "jvm";
      const isNacosType = values.type === "nacos";
      const dbTestConfig =
        !isRedisType && !isJVMType && !isNacosType
          ? buildRpcConnectionConfig(config as any)
          : config;
      const res = await withClientTimeout(
        isJVMType
          ? TestJVMConnection(config as any)
          : isRedisType
            ? RedisConnect(config as any)
            : isNacosType
              ? NacosConnect(config as any)
              : TestConnection(dbTestConfig as any),
        rpcTimeoutMs,
        t("connection.modal.test.timeout", { seconds: timeoutSeconds }),
      );

      if (!isCurrentTestRun()) return;

      if (res.success) {
        void message.destroy("connection-test-failure");
        setTestResult({ type: "success", message: res.message });
        void (async () => {
          try {
            if (isRedisType) {
              const dbRes = await withClientTimeout(
                RedisGetDatabases(config as any),
                rpcTimeoutMs,
                t("connection.modal.test.redis_database_list_timeout", {
                  seconds: timeoutSeconds,
                }),
              );
              if (!isCurrentTestRun()) return;
              if (dbRes.success) {
                const supportedDbs = extractRedisDatabaseList(dbRes.data);
                setRedisDbList(supportedDbs);
                form.setFieldValue(
                  "includeRedisDatabases",
                  normalizeRedisDatabaseSelection(
                    form.getFieldValue("includeRedisDatabases"),
                    supportedDbs,
                  ),
                );
              } else {
                setRedisDbList(
                  buildRedisDatabaseList(
                    config.redisDB,
                    form.getFieldValue("includeRedisDatabases"),
                  ),
                );
                message.warning(
                  t("connection.modal.test.redis_database_list_failure", {
                    detail: normalizeConnectionSecretErrorMessage(
                      dbRes.message,
                      t("connection.modal.error.unknown"),
                    ),
                  }),
                );
              }
            } else if (!isJVMType && !isNacosType) {
              const dbRes = await withClientTimeout(
                DBGetDatabases(dbTestConfig as any),
                rpcTimeoutMs,
                t("connection.modal.test.databaseListTimeout", {
                  seconds: timeoutSeconds,
                }),
              );
              if (!isCurrentTestRun()) return;
              if (dbRes.success) {
                const dbRows = Array.isArray(dbRes.data) ? dbRes.data : [];
                const dbs = dbRows
                  .map((row: any) => row?.Database || row?.database)
                  .filter(
                    (name: any) =>
                      typeof name === "string" && name.trim() !== "",
                  );
                setDbList(dbs);
                if (dbs.length === 0) {
                  message.warning(
                    values.type === "dameng"
                      ? t("connection.modal.test.noVisibleSchema")
                      : t("connection.modal.test.noVisibleDatabaseList"),
                  );
                }
              } else {
                setDbList([]);
                message.warning(
                  t("connection.modal.test.databaseListFailure", {
                    detail: normalizeConnectionSecretErrorMessage(
                      dbRes.message,
                      t("connection.modal.error.unknown"),
                    ),
                  }),
                );
              }
            }
          } catch (error: unknown) {
            if (!isCurrentTestRun()) return;
            const detail = normalizeConnectionSecretErrorMessage(
              error instanceof Error ? error.message : String(error),
              t("connection.modal.error.unknown"),
            );
            message.warning(
              isRedisType
                ? t("connection.modal.test.redis_database_list_failure", {
                    detail,
                  })
                : t("connection.modal.test.databaseListFailure", { detail }),
            );
          }
        })();
      } else {
        applyTestFailureFeedback({
          kind: "runtime",
          reason: res?.message,
          fallbackKey: "connection.modal.test.fallback.rejected",
        });
      }
    } catch (e: unknown) {
      if (!isCurrentTestRun()) return;
      if (e && typeof e === "object" && "errorFields" in e) {
        applyTestFailureFeedback({
          kind: "validation",
          fallbackKey: "connection.modal.test.fallback.validation",
        });
        return;
      }
      const reason =
        e instanceof Error
          ? e.message
          : typeof e === "string"
            ? e
            : t("connection.modal.test.fallback.unknownException");
      applyTestFailureFeedback({
        kind: "runtime",
        reason,
        fallbackKey: "connection.modal.test.fallback.unknownException",
      });
    } finally {
      if (isCurrentTestRun()) {
        testInFlightRef.current = false;
        setTestingConnection(false);
      }
    }
  };

  const handleDiscoverMongoMembers = async () => {
    if (discoveringMembers || dbType !== "mongodb") {
      return;
    }
    try {
      await form.validateFields();
      const values = form.getFieldsValue(true);
      setDiscoveringMembers(true);
      const blockingSecretClearMessage = getBlockingSecretClearMessage({
        values,
        clearSecrets,
        initialValues,
        translate: t,
      });
      if (blockingSecretClearMessage) {
        message.error(blockingSecretClearMessage);
        return;
      }
      const config = await buildConnectionConfig({
        values,
        forPersist: false,
        initialValues,
        translate: t,
      });
      if (initialValues?.id) {
        config.id = initialValues.id;
      }
      const result = await MongoDiscoverMembers(config as any);
      if (!result.success) {
        message.error(
          normalizeConnectionSecretErrorMessage(
            result.message,
            t("connection.modal.mongo.discover.failure"),
          ),
        );
        return;
      }
      const data = (result.data as Record<string, any>) || {};
      const membersRaw = Array.isArray(data.members) ? data.members : [];
      const members: MongoMemberInfo[] = membersRaw
        .map((item: any) => ({
          host: String(item.host || "").trim(),
          role: String(item.role || item.state || "").trim(),
          state: String(item.state || item.role || "").trim(),
          stateCode: Number(item.stateCode || 0),
          healthy: !!item.healthy,
          isSelf: !!item.isSelf,
        }))
        .filter((item: MongoMemberInfo) => !!item.host);
      setMongoMembers(members);
      if (!form.getFieldValue("mongoReplicaSet") && data.replicaSet) {
        form.setFieldValue("mongoReplicaSet", String(data.replicaSet));
      }
      message.success(
        result.message ||
          t(
            members.length === 1
              ? "connection.modal.mongo.discover.successOne"
              : "connection.modal.mongo.discover.successMany",
            { count: members.length },
          ),
      );
    } catch (error: any) {
      message.error(
        normalizeConnectionSecretErrorMessage(
          error?.message || error,
          t("connection.modal.mongo.discover.failure"),
        ),
      );
    } finally {
      setDiscoveringMembers(false);
    }
  };

  const handleTypeSelect = (type: string) => {
    const normalized = normalizeDriverType(type);
    const snapshot = driverStatusMap[normalized];
    if (snapshot && !snapshot.connectable) {
      const driverName = snapshot.name || type;
      const reason =
        snapshot.message ||
        t("connection.modal.driver.unavailableFallback", {
          name: driverName,
        });
      setTypeSelectWarning({ driverName, reason });
      return;
    }
    setTypeSelectWarning(null);
    setDbType(type);
    form.setFieldsValue({
      type: type,
      clickHouseProtocol: type === "clickhouse" ? "auto" : undefined,
      oceanBaseProtocol: type === "oceanbase" ? "mysql" : undefined,
    });

    const defaultPort = getDefaultPortByType(type);
    if (type === "jvm") {
      const jvmDefaultValues = buildDefaultJVMConnectionValues();
      setUseSSL(false);
      setUseSSH(false);
      setUseProxy(false);
      setUseHttpTunnel(false);
      form.setFieldsValue({
        ...jvmDefaultValues,
        user: "",
        password: "",
        database: "",
        useSSL: false,
        sslMode: undefined,
        sslCAPath: undefined,
        sslCertPath: undefined,
        sslKeyPath: undefined,
        useSSH: false,
        sshHost: "",
        sshPort: 22,
        sshUser: "",
        sshPassword: "",
        sshKeyPath: "",
        useProxy: false,
        proxyType: "socks5",
        proxyHost: "",
        proxyPort: 1080,
        proxyUser: "",
        proxyPassword: "",
        useHttpTunnel: false,
        httpTunnelHost: "",
        httpTunnelPort: 8080,
        httpTunnelUser: "",
        httpTunnelPassword: "",
        timeout: 30,
        keepAliveEnabled: false,
        keepAliveIntervalMinutes: DEFAULT_KEEPALIVE_INTERVAL_MINUTES,
        keepAliveSQL: "",
        uri: "",
        connectionParams: "",
        includeDatabases: undefined,
        includeRedisDatabases: undefined,
        mysqlTopology: "single",
        rocketmqTopology: "single",
        mqttTopology: "single",
        kafkaTopology: "single",
        redisTopology: "single",
        mongoTopology: "single",
        mongoSrv: false,
        mongoReadPreference: "primary",
        mongoReplicaSet: "",
        mongoAuthSource: "",
        mongoAuthMechanism: "",
        savePassword: true,
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
        jvmEndpointTimeoutSeconds: 30,
        jvmJmxHost: "",
        jvmJmxPort: undefined,
        jvmJmxUsername: "",
        jvmJmxPassword: "",
        jvmAgentEnabled: false,
        jvmAgentBaseUrl: "",
        jvmAgentApiKey: "",
      });
    } else if (isFileDatabaseType(type)) {
      setUseSSL(false);
      setUseSSH(false);
      setUseProxy(false);
      setUseHttpTunnel(false);
      form.setFieldsValue({
        host: "",
        port: 0,
        user: "",
        password: "",
        database: "",
        useSSL: false,
        sslMode: "preferred",
        sslCAPath: "",
        sslCertPath: "",
        sslKeyPath: "",
        useSSH: false,
        sshHost: "",
        sshPort: 22,
        sshUser: "",
        sshPassword: "",
        sshKeyPath: "",
        useProxy: false,
        proxyType: "socks5",
        proxyHost: "",
        proxyPort: 1080,
        proxyUser: "",
        proxyPassword: "",
        useHttpTunnel: false,
        httpTunnelHost: "",
        httpTunnelPort: 8080,
        httpTunnelUser: "",
        httpTunnelPassword: "",
        keepAliveEnabled: false,
        keepAliveIntervalMinutes: DEFAULT_KEEPALIVE_INTERVAL_MINUTES,
        keepAliveSQL: "",
        mysqlTopology: "single",
        rocketmqTopology: "single",
        mqttTopology: "single",
        kafkaTopology: "single",
        redisTopology: "single",
        mongoTopology: "single",
        mongoSrv: false,
        mongoReadPreference: "primary",
        mongoReplicaSet: "",
        mongoAuthSource: "",
        mongoAuthMechanism: "",
        savePassword: true,
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
        connectionParams: "",
      });
    } else if (type !== "custom") {
      const defaultUser =
        type === "clickhouse"
          ? "default"
          : PRIMARY_USERNAME_OPTIONAL_TYPES.has(type)
            ? ""
            : "root";
      const sslCapableType = supportsSSLForType(type);
      setUseSSL(false);
      setUseHttpTunnel(false);
      form.setFieldsValue({
        user: defaultUser,
        database: "",
        nacosNamespaceId: "",
        port: defaultPort,
        useSSL: sslCapableType ? false : undefined,
        sslMode: sslCapableType ? "preferred" : undefined,
        sslCAPath: sslCapableType ? "" : undefined,
        sslCertPath: sslCapableType ? "" : undefined,
        sslKeyPath: sslCapableType ? "" : undefined,
        useHttpTunnel: false,
        httpTunnelHost: "",
        httpTunnelPort: 8080,
        httpTunnelUser: "",
        httpTunnelPassword: "",
        keepAliveEnabled: false,
        keepAliveIntervalMinutes: DEFAULT_KEEPALIVE_INTERVAL_MINUTES,
        keepAliveSQL: "",
        mysqlTopology: "single",
        rocketmqTopology: "single",
        mqttTopology: "single",
        kafkaTopology: "single",
        redisTopology: "single",
        mongoTopology: "single",
        mongoSrv: false,
        mongoReadPreference: "primary",
        mongoReplicaSet: "",
        mongoAuthSource: "",
        mongoAuthMechanism: "",
        savePassword: true,
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
        connectionParams: "",
      });
    }

    setMongoMembers([]);
    setActiveConfigSection("basic");
    setStep(2);

    if (!driverStatusLoaded || !snapshot) {
      void refreshDriverStatus();
    }
  };

  const isFileDb = isFileDatabaseType(dbType);
  const isCustom = dbType === "custom";
  const isRedis = dbType === "redis";
  const isJVM = dbType === "jvm";
  const connectionConfigLayout = resolveConnectionConfigLayout(dbType);
  const unsupportedJvmModeMessage =
    isJVM && hasUnsupportedJvmModeSelection
      ? t("connection.modal.jvm.unsupportedMode.banner")
      : "";
  const currentDriverType = resolveConnectionDriverType(dbType, customDriver);
  const hasCurrentDriverType =
    currentDriverType !== "" && currentDriverType !== "custom";
  const currentDriverSnapshot = driverStatusMap[currentDriverType];
  const currentDriverUnavailableReason =
    hasCurrentDriverType &&
    currentDriverSnapshot &&
    !currentDriverSnapshot.connectable
      ? currentDriverSnapshot.message ||
        t("connection.modal.driver.unavailableFallback", {
          name: currentDriverSnapshot.name || dbType,
        })
      : "";
  const currentDriverUpdateReason =
    hasCurrentDriverType &&
    currentDriverSnapshot?.connectable &&
    currentDriverSnapshot.needsUpdate
      ? currentDriverSnapshot.message ||
        currentDriverSnapshot.updateReason ||
        t("connection.modal.driver.updateFallback", {
          name: currentDriverSnapshot.name || dbType,
        })
      : "";
  const driverStatusChecking =
    hasCurrentDriverType && !driverStatusLoaded && step === 2;

  // 翻译函数读取运行时语言；系统语言变化时 preference 仍可能保持 "system"，
  // 因此这组少量目录项必须随组件重渲染重新派生，不能只按 preference 做 memo。
  const localizedDbTypeGroups = buildConnectionTypeGroups(t).map((group) => ({
    ...group,
    items: group.items.map((item) => ({
      ...item,
      icon: getDbIcon(item.key, undefined, 32),
    })),
  }));
  const seenDbTypeKeys = new Set<string>();
  const allDbTypeItems = localizedDbTypeGroups
    .flatMap((group) => group.items)
    .filter((item) => {
      if (seenDbTypeKeys.has(item.key)) {
        return false;
      }
      seenDbTypeKeys.add(item.key);
      return true;
    });
  const dbTypeGroups = [
    {
      labelKey: "connection_modal.step1.group.all",
      label: t("connection.modal.step1.group.all"),
      items: allDbTypeItems,
    },
    ...localizedDbTypeGroups,
  ];

  const normalizedDbTypeQuery = dbTypeQuery.trim().toLowerCase();
  const visibleDbTypeItems = normalizedDbTypeQuery
    ? (dbTypeGroups[0]?.items ?? []).filter(
        (item) =>
          item.name.toLowerCase().includes(normalizedDbTypeQuery) ||
          String(item.key).toLowerCase().includes(normalizedDbTypeQuery),
      )
    : (dbTypeGroups[activeGroup]?.items ?? []);

  const handleDbTypeQueryChange = (value: string) => {
    setDbTypeQuery(value);
    if (value.trim()) {
      setActiveGroup(0);
    }
  };

  const handleDbTypeGroupSelect = (index: number) => {
    setActiveGroup(index);
    setDbTypeQuery("");
  };

  useEffect(() => {
    if (!open || step !== 1 || typeof window === "undefined") return;
    // Studio 选型页快捷键处理器，仅在第一步挂载。
    const focusStudioSearch = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "k") {
        return;
      }
      // 当前弹窗内的数据源搜索框。
      const searchInput = document.querySelector<HTMLInputElement>(
        '.connection-modal-wrap [data-connection-type-search="true"]',
      );
      if (!searchInput) return;
      event.preventDefault();
      searchInput.focus();
    };
    window.addEventListener("keydown", focusStudioSearch);
    return () => window.removeEventListener("keydown", focusStudioSearch);
  }, [open, step]);

  const dbTypes = getAllConnectionTypeCatalogItems();

  const recentConnectionChips = useMemo(() => {
    // 按“最近实际使用”的连接（recentConnectionTargets，已按 openedAt 倒序）
    // 去重取数据源类型，而不是按连接创建/添加顺序。
    const connectionById = new Map(
      savedConnections.map((conn) => [conn.id, conn] as const),
    );
    const seenTypes = new Set<string>();
    const chips: Array<{ type: string; color: string }> = [];
    for (const target of recentConnectionTargets) {
      const conn = connectionById.get(target.connectionId);
      const type = String(conn?.config?.type || "").trim();
      if (!conn || !type || seenTypes.has(type)) continue;
      seenTypes.add(type);
      chips.push({
        type,
        color: conn.iconColor || getDbDefaultColor(conn.iconType || type),
      });
      if (chips.length >= 5) break;
    }
    return chips;
  }, [savedConnections, recentConnectionTargets]);

  const activeGroupLabel =
    dbTypeGroups[activeGroup]?.label || t("connection.modal.step1.group.all");

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
                <button
                  key={item.key}
                  type="button"
                  data-connection-type-key={item.key}
                  aria-label={item.name}
                  onClick={() => {
                    void handleTypeSelect(item.key);
                  }}
                  className="gn-conn-type-card"
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
        primaryPasswordVisible,
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
        setPrimaryPasswordVisible,
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

  const getFooter = () => {
    if (step === 1) {
      return null;
    }
    const typeName = dbTypes.find((t) => t.key === dbType)?.name || dbType;
    const isTestSuccess = testResult?.type === "success";
    const hasTestError = !!testResult && !isTestSuccess;
    const testFailureSummary = hasTestError
      ? summarizeConnectionTestFailureMessage(
          resolvedTestResultMessage,
          t("connection.status.failure"),
        )
      : "";
    const operationBlocked =
      !!currentDriverUnavailableReason ||
      driverStatusChecking ||
      !!unsupportedJvmModeMessage;
    return (
      <div className="gn-conn-studio-foot">
        <div className="gn-conn-studio-foot-left">
          {!initialValues && (
            <Button
              key="back"
              className="gn-conn-studio-button"
              icon={<ArrowLeftOutlined />}
              onClick={() => setStep(1)}
            >
              {t("common.action.back")}
            </Button>
          )}
          <span
            className="gn-conn-studio-foot-status"
            data-status={testResult ? (isTestSuccess ? "success" : "error") : "idle"}
          >
            {testResult ? (
              <>
              {isTestSuccess ? <CheckCircleFilled /> : <CloseCircleFilled />}
                <span>
                  {isTestSuccess
                    ? t("connection.status.success")
                    : t("connection.status.failure")}
                </span>
              </>
            ) : (
              `${t("connection.modal.studio.test.idle")} · ${typeName}`
            )}
          </span>
          {hasTestError && (
            <span
              data-connection-test-error-summary="true"
              title={testFailureSummary}
              className="gn-conn-studio-foot-error"
            >
              {testFailureSummary}
            </span>
          )}
          {hasTestError && (
            <Button
              size="small"
              icon={<FileTextOutlined />}
              className="gn-conn-studio-details-button"
              onClick={() => setTestErrorLogOpen(true)}
            >
              {t("connection.action.viewDetails")}
            </Button>
          )}
        </div>
        <Space size={8} className="gn-conn-studio-foot-right">
          <Button
            key="test"
            className="gn-conn-studio-button"
            loading={testingConnection}
            disabled={operationBlocked || saving}
            onClick={requestTest}
          >
            {t("connection.action.test")}
          </Button>
          <Button key="cancel" className="gn-conn-studio-button" onClick={onClose}>
            {t("common.action.cancel")}
          </Button>
          <Button
            key="submit"
            type="primary"
            className="gn-conn-studio-button"
            loading={saving}
            disabled={operationBlocked || testingConnection}
            onClick={handleOk}
          >
            {t("common.action.save")}
          </Button>
        </Space>
      </div>
    );
  };

  const getStudioTitle = () => {
    const typeName = dbTypes.find((t) => t.key === dbType)?.name || dbType;
    // 是否处于第一步数据源选型页。
    const pickerStep = step === 1;
    // Studio 标题栏三段进度文案。
    const stepItems = pickerStep
      ? [
          t("connection.modal.studio.step.chooseType"),
          t("connection.modal.studio.step.configure"),
          t("connection.modal.studio.step.testSave"),
        ]
      : [
          t("connection.modal.studio.step.type"),
          t("connection.modal.studio.step.params"),
          t("connection.modal.studio.step.save"),
        ];
    // 当前步骤对应的标题文案。
    const title = pickerStep
      ? t("connection.modal.title.step1")
      : initialValues
        ? t("connection.modal.studio.title.edit", { type: typeName })
        : t("connection.modal.studio.title.connection", { type: typeName });
    return (
      <div className="gn-conn-studio-header" data-connection-step={step}>
        <div className="gn-conn-studio-header-left">
          <div
            className="gn-conn-studio-type-badge"
            style={pickerStep ? undefined : { background: getDbDefaultColor(dbType) }}
            aria-hidden="true"
          >
            {pickerStep ? <PlusOutlined /> : getDbIcon(dbType, "#ffffff", 28)}
          </div>
          <div className="gn-conn-studio-heading">
            <div className="gn-conn-studio-title">{title}</div>
            {pickerStep ? (
              <div className="gn-conn-studio-subtitle">
                {t("connection.modal.description.step1")}
              </div>
            ) : null}
          </div>
        </div>
        <div className="gn-conn-studio-steps" aria-label={t("connection.modal.studio.progress")}>
          {stepItems.map((item, index) => {
            // 当前高亮的进度节点。
            const active = pickerStep ? index === 0 : index === 1;
            // 已完成的进度节点。
            const done = !pickerStep && index === 0;
            return (
              <React.Fragment key={item}>
                {index > 0 ? (
                  <RightOutlined className="gn-conn-studio-step-arrow" aria-hidden="true" />
                ) : null}
                <span data-active={active ? "true" : undefined} data-done={done ? "true" : undefined}>
                  {index + 1} {item}
                </span>
              </React.Fragment>
            );
          })}
        </div>
        <button
          type="button"
          className="gn-conn-studio-close"
          aria-label={t("common.action.close")}
          title={t("common.action.close")}
          onClick={onClose}
        >
          <CloseOutlined />
        </button>
      </div>
    );
  };

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
        onCancel={onClose}
        footer={getFooter()}
        closable={false}
        centered
        wrapClassName={
          isFormStep
            ? "connection-modal-wrap connection-modal-form"
            : "connection-modal-wrap"
        }
        width={isFormStep ? CONNECTION_MODAL_WIDTH_STEP2 : CONNECTION_MODAL_WIDTH_STEP1}
        zIndex={APP_FOREGROUND_MODAL_Z_INDEX}
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
        title={renderConnectionModalTitle(
          <FileTextOutlined />,
          t("connection.modal.failureDialog.title"),
          t("connection.modal.failureDialog.description"),
        )}
        open={testErrorLogOpen}
        onCancel={() => setTestErrorLogOpen(false)}
        centered
        width={760}
        zIndex={APP_NESTED_MODAL_Z_INDEX}
        destroyOnHidden
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
          <Button key="close" onClick={() => setTestErrorLogOpen(false)}>
            {t("common.action.close")}
          </Button>,
        ]}
      >
        <pre
          style={{
            margin: 0,
            maxHeight: "50vh",
            overflowY: "auto",
            padding: 12,
            borderRadius: 6,
            background: "#fff2f0",
            border: "1px solid #ffccc7",
            color: "#a8071a",
            whiteSpace: "pre-wrap",
            wordBreak: "break-all",
            lineHeight: "20px",
            fontSize: 13,
            fontFamily: "var(--gn-font-mono)",
          }}
        >
          {String(
            resolvedTestResultMessage ||
              t("connection.modal.failureDialog.emptyLog"),
          )}
        </pre>
      </Modal>
    </>
  );
};

export default ConnectionModal;
