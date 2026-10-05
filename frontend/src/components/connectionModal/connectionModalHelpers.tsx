import { Typography } from "antd";
import type { ClickHouseProtocolChoice, OceanBaseProtocolChoice } from "./connectionModalUri";
import {
  normalizeOceanBaseProtocol,
  resolveOceanBaseProtocolFromQueryText as resolveOceanBaseProtocolQueryText,
} from "../../utils/oceanBaseProtocol";
import { JVM_EDITABLE_MODES } from "../../utils/jvmConnectionConfig";
import { ConnectionConfig, SavedConnection } from "../../types";

export const { Text } = Typography;
export type EditableJVMMode = (typeof JVM_EDITABLE_MODES)[number];
export type ChoiceCardOption = {
  value: string;
  label: string;
  description?: string;
};
export const MAX_TIMEOUT_SECONDS = 3600;
export const DEFAULT_KEEPALIVE_INTERVAL_MINUTES = 240;
/** Step1/Step2 弹窗宽度统一为 760，centered 定位下切换步骤不再跳动；
 * Step2 密排表单本身仍保持 ~600 视觉宽度（见 .gn-conn-form-layout 的 max-width），避免右侧空洞或输入框被拉超长，
 * 只是在更宽的弹窗内居中显示。 */
export const CONNECTION_MODAL_WIDTH_STEP1 = 760;
export const CONNECTION_MODAL_WIDTH_STEP2 = 760;
// 头部高度约 60px，主体固定为 700px，使弹窗整体（760×760）接近正方形。
export const CONNECTION_MODAL_BODY_HEIGHT = 700;
const REDIS_DEFAULT_DATABASE_COUNT = 16;
const CONNECTION_MODAL_FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export const getConnectionModalFocusableElements = (panel: HTMLElement): HTMLElement[] => (
  Array.from(panel.querySelectorAll<HTMLElement>(CONNECTION_MODAL_FOCUSABLE_SELECTOR))
    .filter((element) => (
      element.parentElement !== panel
      && !element.hidden
      && !(element as HTMLButtonElement | HTMLInputElement).disabled
      && element.getAttribute('aria-hidden') !== 'true'
      && element.getClientRects().length > 0
    ))
);
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

export const buildRedisDatabaseList = (...values: unknown[]): number[] => {
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

export const extractRedisDatabaseList = (value: unknown): number[] => {
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

export const normalizeRedisDatabaseSelection = (
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
export const resolveOceanBaseProtocolForConfig = (
  config: Partial<ConnectionConfig>,
): OceanBaseProtocolChoice => {
  return (
    resolveOceanBaseProtocolValue(config.oceanBaseProtocol) ||
    resolveOceanBaseProtocolFromQueryText(config.connectionParams) ||
    resolveOceanBaseProtocolFromQueryText(config.uri) ||
    "mysql"
  );
};
export type UriFeedbackState = {
  type: "success" | "warning" | "error";
  messageKey: string;
};

export type TestFailureKind =
  | "validation"
  | "runtime"
  | "driver_unavailable"
  | "secret_blocked";

export type TestResultState =
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

export const resolveInitialSecretFieldValue = (
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
