import React from "react";
import { Typography, Input } from "antd";
import type {
  SavedConnection,
  JVMActionDefinition,
  JVMChangePreview,
  JVMApplyResult,
} from "../../../types";
import { buildRpcConnectionConfig } from "../../../utils/connectionRpcConfig";
import type { JVMAIChangeDraft } from "../../../utils/jvmAiPlan";
import { JVM_DEFAULT_PAYLOAD_TEMPLATE } from "../../../utils/jvmResourcePresentation";

export const { Text } = Typography;
export const DESCRIPTION_STYLES = { label: { width: 120 } } as const;
export const { TextArea } = Input;
export const DEFAULT_PAYLOAD_TEXT = JVM_DEFAULT_PAYLOAD_TEMPLATE;

type LocalizedError = Error & {
  userMessage?: string;
};

export const createLocalizedError = (message: string): LocalizedError => {
  const error = new Error(message) as LocalizedError;
  error.userMessage = message;
  return error;
};

export const resolveLocalizedErrorMessage = (
  error: unknown,
  fallback: string,
): string => {
  const userMessage = (error as LocalizedError | undefined)?.userMessage;
  return typeof userMessage === "string" && userMessage.trim()
    ? userMessage
    : fallback;
};

export const buildJVMRuntimeConfig = (
  connection: SavedConnection,
  providerMode: string,
) => {
  const sourceJVM = connection.config.jvm || {};
  return buildRpcConnectionConfig(connection.config, {
    jvm: {
      ...sourceJVM,
      preferredMode: providerMode,
      allowedModes: [providerMode],
    },
  });
};

const buildJVMPreviewConfigRevision = (value: unknown): string => {
  let text = "";
  try {
    text = JSON.stringify(value ?? null);
  } catch {
    return "unserializable";
  }

  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
};

export const buildJVMPreviewRuntimeFingerprint = (
  connection: SavedConnection | undefined,
  providerMode: string,
): string => {
  const config = connection?.config;
  const jvm = config?.jvm || {};
  return JSON.stringify({
    configRevision: buildJVMPreviewConfigRevision(config),
    type: config?.type || "",
    host: config?.host || "",
    port: config?.port || 0,
    user: config?.user || "",
    providerMode,
    environment: jvm.environment || "",
    readOnly: jvm.readOnly !== false,
    allowedModes: jvm.allowedModes || [],
    preferredMode: jvm.preferredMode || "",
    jmx: {
      enabled: jvm.jmx?.enabled || false,
      host: jvm.jmx?.host || "",
      port: jvm.jmx?.port || 0,
      username: jvm.jmx?.username || "",
      domainAllowlist: jvm.jmx?.domainAllowlist || [],
    },
    endpoint: {
      enabled: jvm.endpoint?.enabled || false,
      baseUrl: jvm.endpoint?.baseUrl || "",
      timeoutSeconds: jvm.endpoint?.timeoutSeconds || 0,
    },
    agent: {
      enabled: jvm.agent?.enabled || false,
      baseUrl: jvm.agent?.baseUrl || "",
      timeoutSeconds: jvm.agent?.timeoutSeconds || 0,
    },
  });
};

export const buildJVMPreviewContextKey = (
  connectionId: string,
  mode: string,
  path: string,
  runtimeFingerprint: string,
): string => `${connectionId}::${mode}::${path}::${runtimeFingerprint}`;

export const snapshotBlockStyle = (background: string): React.CSSProperties => ({
  margin: 0,
  borderRadius: 8,
  background,
  overflow: "auto",
});

export const formatDraftPayload = (draft: JVMAIChangeDraft): string => {
  try {
    return JSON.stringify(draft.payload ?? {}, null, 2);
  } catch {
    return "{}";
  }
};

export const resolveDefaultAction = (
  actions: JVMActionDefinition[] | undefined,
  providerMode: "jmx" | "endpoint" | "agent",
): string => {
  if (actions && actions.length > 0) {
    return String(actions[0].action || "").trim() || "put";
  }
  if (providerMode === "jmx") {
    return "set";
  }
  return "put";
};

export const normalizePreviewResult = (value: any): JVMChangePreview | null => {
  if (
    value &&
    typeof value === "object" &&
    typeof value.allowed === "boolean"
  ) {
    return value as JVMChangePreview;
  }
  if (value?.data && typeof value.data.allowed === "boolean") {
    return value.data as JVMChangePreview;
  }
  return null;
};

export const normalizeApplyResult = (value: any): JVMApplyResult | null => {
  if (value && typeof value === "object" && typeof value.status === "string") {
    return value as JVMApplyResult;
  }
  if (value?.data && typeof value.data.status === "string") {
    return value.data as JVMApplyResult;
  }
  return null;
};
