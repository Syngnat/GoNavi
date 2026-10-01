import React, { useEffect, useMemo, useRef, useState } from "react";
import Editor from "./MonacoEditor";
import {
  Alert,
  Button,
  Card,
  Descriptions,
  Empty,
  Input,
  Skeleton,
  Space,
  Tag,
  Typography,
} from "antd";
import {
  FileSearchOutlined,
  ReloadOutlined,
  } from "@ant-design/icons";
import AiSparkOutlined from "./icons/AiSparkOutlined";

import { useStore } from "../store";
import type {
  JVMActionDefinition,
  JVMApplyResult,
  JVMChangePreview,
  JVMChangeRequest,
  JVMAIPlanContext,
  JVMValueSnapshot,
  SavedConnection,
  TabData,
} from "../types";
import { buildRpcConnectionConfig } from "../utils/connectionRpcConfig";
import { t as translate } from "../i18n";
import { useOptionalI18n } from "../i18n/provider";
import {
  buildJVMChangeDraftFromAIPlan,
  buildJVMAIPlanPrompt,
  matchesJVMAIPlanTargetTab,
  type JVMAIChangeDraft,
  type JVMAIChangePlan,
} from "../utils/jvmAiPlan";
import {
  buildJVMActionPayloadTemplate,
  buildJVMPreviewApplyRequest,
  estimateJVMResourceEditorHeight,
  formatJVMActionDisplayText,
  formatJVMActionSummary,
  formatJVMMetadataForDisplay,
  formatJVMValueForDisplay,
  JVM_DEFAULT_PAYLOAD_TEMPLATE,
  resolveJVMActionDisplay,
  resolveJVMValueEditorLanguage,
} from "../utils/jvmResourcePresentation";
import { buildJVMTabTitle } from "../utils/jvmRuntimePresentation";
import JVMModeBadge from "./jvm/JVMModeBadge";
import JVMChangePreviewModal from "./jvm/JVMChangePreviewModal";
import {
  getJVMWorkspaceCardStyle,
  JVMWorkspaceHero,
  JVMWorkspaceShell,
} from "./jvm/JVMWorkspaceLayout";

const { Text } = Typography;
const DESCRIPTION_STYLES = { label: { width: 120 } } as const;
const { TextArea } = Input;
const DEFAULT_PAYLOAD_TEXT = JVM_DEFAULT_PAYLOAD_TEMPLATE;

type JVMResourceBrowserProps = {
  tab: TabData;
};

type LocalizedError = Error & {
  userMessage?: string;
};

const createLocalizedError = (message: string): LocalizedError => {
  const error = new Error(message) as LocalizedError;
  error.userMessage = message;
  return error;
};

const resolveLocalizedErrorMessage = (
  error: unknown,
  fallback: string,
): string => {
  const userMessage = (error as LocalizedError | undefined)?.userMessage;
  return typeof userMessage === "string" && userMessage.trim()
    ? userMessage
    : fallback;
};

const buildJVMRuntimeConfig = (
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

const buildJVMPreviewRuntimeFingerprint = (
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

const buildJVMPreviewContextKey = (
  connectionId: string,
  mode: string,
  path: string,
  runtimeFingerprint: string,
): string => `${connectionId}::${mode}::${path}::${runtimeFingerprint}`;

const snapshotBlockStyle = (background: string): React.CSSProperties => ({
  margin: 0,
  borderRadius: 8,
  background,
  overflow: "auto",
});

const formatDraftPayload = (draft: JVMAIChangeDraft): string => {
  try {
    return JSON.stringify(draft.payload ?? {}, null, 2);
  } catch {
    return "{}";
  }
};

const resolveDefaultAction = (
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

const normalizePreviewResult = (value: any): JVMChangePreview | null => {
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

const normalizeApplyResult = (value: any): JVMApplyResult | null => {
  if (value && typeof value === "object" && typeof value.status === "string") {
    return value as JVMApplyResult;
  }
  if (value?.data && typeof value.data.status === "string") {
    return value.data as JVMApplyResult;
  }
  return null;
};

const JVMResourceBrowser: React.FC<JVMResourceBrowserProps> = ({ tab }) => {
  const i18n = useOptionalI18n();
  const i18nLanguage = i18n?.language;
  const tr = (key: string, params?: Parameters<typeof translate>[1]) =>
    translate(key, params, i18nLanguage);
  const connection = useStore((state) =>
    state.connections.find((item) => item.id === tab.connectionId),
  );
  const addTab = useStore((state) => state.addTab);
  const theme = useStore((state) => state.theme);
  const darkMode = theme === "dark";
  const providerMode = (tab.providerMode ||
    connection?.config.jvm?.preferredMode ||
    "jmx") as "jmx" | "endpoint" | "agent";
  const resourcePath = String(tab.resourcePath || "").trim();
  const readOnly = connection?.config.jvm?.readOnly !== false;
  const runtimeFingerprint = useMemo(
    () => buildJVMPreviewRuntimeFingerprint(connection, providerMode),
    [connection, providerMode],
  );
  const [loading, setLoading] = useState(true);
  const [snapshot, setSnapshot] = useState<JVMValueSnapshot | null>(null);
  const [error, setError] = useState("");
  const [action, setAction] = useState("");
  const [reason, setReason] = useState("");
  const [payloadText, setPayloadText] = useState(DEFAULT_PAYLOAD_TEXT);
  const [draftSource, setDraftSource] = useState<"manual" | "ai-plan">(
    "manual",
  );
  const [draftResourceId, setDraftResourceId] = useState("");
  const [draftError, setDraftError] = useState("");
  const [applyMessage, setApplyMessage] = useState("");
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewResult, setPreviewResult] = useState<JVMChangePreview | null>(
    null,
  );
  const [previewRequest, setPreviewRequest] = useState<JVMChangeRequest | null>(
    null,
  );
  const [previewRuntimeConfig, setPreviewRuntimeConfig] = useState<any | null>(
    null,
  );
  const [previewContextKey, setPreviewContextKey] = useState("");
  const [applyLoading, setApplyLoading] = useState(false);
  const snapshotLoadSequenceRef = useRef(0);
  const i18nLanguageRef = useRef(i18nLanguage);
  const previewSequenceRef = useRef(0);
  const currentPreviewContextKey = buildJVMPreviewContextKey(
    tab.connectionId,
    providerMode,
    resourcePath,
    runtimeFingerprint,
  );
  const previewContextKeyRef = useRef(currentPreviewContextKey);
  i18nLanguageRef.current = i18nLanguage;
  previewContextKeyRef.current = currentPreviewContextKey;

  const clearPreviewState = () => {
    setPreviewOpen(false);
    setPreviewResult(null);
    setPreviewRequest(null);
    setPreviewRuntimeConfig(null);
    setPreviewContextKey("");
  };

  const displayValue = useMemo(() => formatJVMValueForDisplay(snapshot), [snapshot]);
  const displayLanguage = useMemo(
    () =>
      snapshot?.sensitive
        ? "plaintext"
        : resolveJVMValueEditorLanguage(snapshot?.format || "", snapshot?.value),
    [snapshot?.format, snapshot?.sensitive, snapshot?.value],
  );
  const metadataText = useMemo(
    () => formatJVMMetadataForDisplay(snapshot),
    [snapshot],
  );
  const metadataLanguage = useMemo(
    () =>
      snapshot?.sensitive
        ? "plaintext"
        : resolveJVMValueEditorLanguage("json", snapshot?.metadata),
    [snapshot?.metadata, snapshot?.sensitive],
  );
  const supportedActions = useMemo(() => {
    if (!Array.isArray(snapshot?.supportedActions)) {
      return [] as JVMActionDefinition[];
    }
    return snapshot.supportedActions.filter(
      (item) => !!String(item?.action || "").trim(),
    );
  }, [snapshot]);
  const selectedActionDefinition = useMemo(
    () => supportedActions.find((item) => item.action === action) || null,
    [action, supportedActions],
  );
  const selectedActionDisplay = useMemo(
    () =>
      resolveJVMActionDisplay(selectedActionDefinition || action, i18nLanguage),
    [action, i18nLanguage, selectedActionDefinition],
  );

  const loadSnapshot = async () => {
    const loadContextKey = currentPreviewContextKey;
    const loadLanguage = i18nLanguage;
    if (!connection) {
      setLoading(false);
      setSnapshot(null);
      setError(tr("jvm_resource.error.connection_missing"));
      return;
    }

    if (!resourcePath) {
      setLoading(false);
      setSnapshot(null);
      setError(tr("jvm_resource.error.resource_path_empty"));
      return;
    }

    const backendApp = (window as any).go?.app?.App;
    if (typeof backendApp?.JVMGetValue !== "function") {
      setLoading(false);
      setSnapshot(null);
      setError(tr("jvm_resource.error.get_value_unavailable"));
      return;
    }

    const loadSequence = ++snapshotLoadSequenceRef.current;
    setLoading(true);
    setError("");
    try {
      const result = await backendApp.JVMGetValue(
        buildJVMRuntimeConfig(connection, providerMode),
        resourcePath,
      );
      if (
        loadSequence !== snapshotLoadSequenceRef.current ||
        loadContextKey !== previewContextKeyRef.current ||
        loadLanguage !== i18nLanguageRef.current
      ) {
        return;
      }
      if (!result?.success) {
        setSnapshot(null);
        setError(tr("jvm_resource.error.read_failed"));
        return;
      }
      setSnapshot((result.data || null) as JVMValueSnapshot | null);
    } catch (err: any) {
      if (
        loadSequence !== snapshotLoadSequenceRef.current ||
        loadContextKey !== previewContextKeyRef.current ||
        loadLanguage !== i18nLanguageRef.current
      ) {
        return;
      }
      setSnapshot(null);
      setError(tr("jvm_resource.error.read_failed"));
    } finally {
      if (
        loadSequence === snapshotLoadSequenceRef.current &&
        loadContextKey === previewContextKeyRef.current &&
        loadLanguage === i18nLanguageRef.current
      ) {
        setLoading(false);
      }
    }
  };

  useEffect(() => {
    void loadSnapshot();
  }, [connection, i18nLanguage, providerMode, resourcePath, runtimeFingerprint, tab.connectionId]);

  useEffect(() => {
    setSnapshot(null);
    setAction("");
    setReason("");
    setPayloadText(DEFAULT_PAYLOAD_TEXT);
    setDraftSource("manual");
    setDraftResourceId("");
    setDraftError("");
    setApplyMessage("");
    previewSequenceRef.current += 1;
    clearPreviewState();
  }, [currentPreviewContextKey]);

  useEffect(() => {
    if (action.trim()) {
      return;
    }
    const nextAction = resolveDefaultAction(supportedActions, providerMode);
    setAction(nextAction);
    const nextDefinition = supportedActions.find(
      (item) => item.action === nextAction,
    );
    if (
      String(payloadText || "").trim() === "" ||
      payloadText === DEFAULT_PAYLOAD_TEXT
    ) {
      setPayloadText(buildJVMActionPayloadTemplate(nextDefinition, snapshot?.sensitive));
    }
  }, [action, payloadText, providerMode, supportedActions]);

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent).detail as
        | {
            plan?: JVMAIChangePlan;
            targetTabId?: string;
            connectionId?: string;
            providerMode?: JVMAIPlanContext["providerMode"];
            resourcePath?: string;
          }
        | undefined;
      const plan = detail?.plan;
      if (!plan || (detail?.targetTabId && detail.targetTabId !== tab.id)) {
        return;
      }

      const planContext =
        detail?.targetTabId &&
        detail?.connectionId &&
        detail?.providerMode &&
        detail?.resourcePath
          ? {
              tabId: detail.targetTabId,
              connectionId: detail.connectionId,
              providerMode: detail.providerMode,
              resourcePath: detail.resourcePath,
            }
          : undefined;

      if (!planContext) {
        setDraftError(tr("jvm_resource.error.ai_plan_missing_context"));
        setApplyMessage("");
        clearPreviewState();
        return;
      }

      if (!matchesJVMAIPlanTargetTab(tab, planContext)) {
        setDraftError(tr("jvm_resource.error.ai_plan_context_mismatch"));
        setApplyMessage("");
        clearPreviewState();
        return;
      }

      let draftFromPlan: JVMAIChangeDraft;
      try {
        draftFromPlan = buildJVMChangeDraftFromAIPlan(plan, tr);
      } catch {
        setDraftError(tr("jvm_resource.error.ai_plan_to_draft_failed"));
        setApplyMessage("");
        clearPreviewState();
        return;
      }

      setDraftResourceId(draftFromPlan.resourceId);
      setAction(draftFromPlan.action);
      setReason(draftFromPlan.reason);
      setPayloadText(formatDraftPayload(draftFromPlan));
      setDraftSource(draftFromPlan.source || "ai-plan");
      setDraftError("");
      setApplyMessage(
        tr("jvm_resource.message.ai_plan_draft_filled", {
          resourceId: draftFromPlan.resourceId,
        }),
      );
      clearPreviewState();
    };

    window.addEventListener(
      "gonavi:jvm-apply-ai-plan",
      handler as EventListener,
    );
    return () =>
      window.removeEventListener(
        "gonavi:jvm-apply-ai-plan",
        handler as EventListener,
      );
  }, [
    i18nLanguage,
    resourcePath,
    tab.connectionId,
    tab.id,
    tab.providerMode,
    tab.type,
  ]);

  const handleSelectAction = (
    nextAction: string,
    definition?: JVMActionDefinition | null,
  ) => {
    const normalized = String(nextAction || "").trim();
    setAction(normalized);
    if (!normalized) {
      return;
    }
    const currentPayload = String(payloadText || "").trim();
    if (
      !currentPayload ||
      currentPayload === "{}" ||
      payloadText === DEFAULT_PAYLOAD_TEXT
    ) {
      setPayloadText(buildJVMActionPayloadTemplate(definition, snapshot?.sensitive));
    }
  };

  const buildDraftPlan = (): JVMChangeRequest => {
    const trimmedAction = String(action || "").trim() || "put";
    const trimmedReason = String(reason || "").trim();
    if (!trimmedReason) {
      throw createLocalizedError(tr("jvm_resource.error.reason_required"));
    }

    const rawPayload = String(payloadText || "").trim();
    let payload: Record<string, any> = {};
    if (rawPayload) {
      const parsed = JSON.parse(rawPayload);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw createLocalizedError(
          tr("jvm_resource.error.payload_object_required"),
        );
      }
      payload = parsed as Record<string, any>;
    }

    const resourceId = String(draftResourceId || resourcePath).trim();
    if (!resourceId) {
      throw createLocalizedError(tr("jvm_resource.error.resource_id_empty"));
    }

    return {
      providerMode,
      resourceId,
      action: trimmedAction,
      reason: trimmedReason,
      source: draftSource,
      expectedVersion: snapshot?.version || undefined,
      payload,
    };
  };

  const handleOpenAudit = () => {
    if (!connection) {
      return;
    }

    addTab({
      id: `jvm-audit-${connection.id}-${providerMode}`,
      title: buildJVMTabTitle(connection.name, "audit", providerMode),
      type: "jvm-audit",
      connectionId: connection.id,
      providerMode,
    });
  };

  const handleAskAIForPlan = () => {
    if (!connection) {
      setDraftError(tr("jvm_resource.error.connection_missing"));
      return;
    }

    const prompt = buildJVMAIPlanPrompt({
      connectionName: connection.name,
      host: connection.config.host,
      providerMode,
      resourcePath,
      readOnly,
      environment: connection.config.jvm?.environment,
      snapshot,
    }, tr);

    const store = useStore.getState();
    const wasClosed = !store.aiPanelVisible;
    if (wasClosed) {
      store.setAIPanelVisible(true);
    }
    setTimeout(
      () => {
        window.dispatchEvent(
          new CustomEvent("gonavi:ai:inject-prompt", { detail: { prompt } }),
        );
      },
      wasClosed ? 350 : 0,
    );
  };

  const handlePreview = async () => {
    if (!connection) {
      setDraftError(tr("jvm_resource.error.connection_missing"));
      return;
    }

    const backendApp = (window as any).go?.app?.App;
    if (typeof backendApp?.JVMPreviewChange !== "function") {
      setDraftError(tr("jvm_resource.error.preview_unavailable"));
      return;
    }

    let draftPlan: JVMChangeRequest;
    try {
      draftPlan = buildDraftPlan();
    } catch (err) {
      setDraftError(
        resolveLocalizedErrorMessage(
          err,
          tr("jvm_resource.error.draft_invalid"),
        ),
      );
      return;
    }

    const previewSequence = ++previewSequenceRef.current;
    const previewContextKey = currentPreviewContextKey;
    const runtimeConfig = buildJVMRuntimeConfig(connection, providerMode);

    setPreviewLoading(true);
    setDraftError("");
    setApplyMessage("");
    try {
      const result = await backendApp.JVMPreviewChange(
        runtimeConfig,
        draftPlan,
      );
      if (
        previewSequence !== previewSequenceRef.current ||
        previewContextKey !== previewContextKeyRef.current
      ) {
        return;
      }

      if (result?.success === false) {
        clearPreviewState();
        setDraftError(
          String(result?.message || tr("jvm_resource.error.preview_failed")),
        );
        return;
      }

      const preview = normalizePreviewResult(result);
      if (!preview) {
        clearPreviewState();
        setDraftError(tr("jvm_resource.error.preview_result_invalid"));
        return;
      }

      setPreviewResult(preview);
      setPreviewRequest(draftPlan);
      setPreviewRuntimeConfig(runtimeConfig);
      setPreviewContextKey(previewContextKey);
      setPreviewOpen(true);
    } catch (err: any) {
      clearPreviewState();
      setDraftError(
        err?.message ||
          (typeof err === "string" ? err : "") ||
          tr("jvm_resource.error.preview_failed"),
      );
    } finally {
      setPreviewLoading(false);
    }
  };

  const handleApply = async () => {
    await Promise.resolve();

    if (!connection) {
      setDraftError(tr("jvm_resource.error.connection_missing"));
      return;
    }

    const backendApp = (window as any).go?.app?.App;
    if (typeof backendApp?.JVMApplyChange !== "function") {
      setDraftError(tr("jvm_resource.error.apply_unavailable"));
      return;
    }

    if (!previewResult || !previewRequest || !previewRuntimeConfig) {
      setDraftError(tr("jvm_resource.error.preview_required"));
      return;
    }
    if (previewContextKey !== previewContextKeyRef.current) {
      clearPreviewState();
      setDraftError(tr("jvm_resource.error.context_changed"));
      return;
    }

    let applyRequest: JVMChangeRequest;
    try {
      applyRequest = buildJVMPreviewApplyRequest(previewRequest, previewResult);
    } catch {
      setDraftError(tr("jvm_resource.error.confirmation_missing"));
      return;
    }

    setApplyLoading(true);
    setDraftError("");
    setApplyMessage("");
    try {
      const result = await backendApp.JVMApplyChange(
        previewRuntimeConfig,
        applyRequest,
      );
      if (result?.success === false) {
        setDraftError(
          String(result?.message || tr("jvm_resource.error.apply_failed")),
        );
        return;
      }

      const applyResult = normalizeApplyResult(result);
      if (applyResult?.updatedValue) {
        setSnapshot(applyResult.updatedValue);
      }

      clearPreviewState();
      setApplyMessage(
        applyResult?.message ||
          result?.message ||
          tr("jvm_resource.message.apply_success"),
      );
      await loadSnapshot();
    } catch (err: any) {
      setDraftError(
        err?.message ||
          (typeof err === "string" ? err : "") ||
          tr("jvm_resource.error.apply_failed"),
      );
    } finally {
      setApplyLoading(false);
    }
  };

  if (!connection) {
    return (
      <Empty description={tr("jvm_resource.error.connection_missing")} style={{ marginTop: 64 }} />
    );
  }

  const cardStyle = getJVMWorkspaceCardStyle(darkMode);

  return (
    <>
      <style>{`
        .jvm-resource-browser-scroll-shell {
          scrollbar-width: thin;
        }
        .jvm-resource-browser-scroll-shell::-webkit-scrollbar,
        .jvm-resource-browser-code-block::-webkit-scrollbar {
          width: 10px;
          height: 10px;
        }
        .jvm-resource-browser-scroll-shell::-webkit-scrollbar-thumb,
        .jvm-resource-browser-code-block::-webkit-scrollbar-thumb {
          background: rgba(0, 0, 0, 0.22);
          border-radius: 999px;
        }
        .jvm-resource-browser-scroll-shell::-webkit-scrollbar-track,
        .jvm-resource-browser-code-block::-webkit-scrollbar-track {
          background: transparent;
        }
        @media (max-width: 1120px) {
          .jvm-resource-workbench {
            grid-template-columns: 1fr !important;
          }
        }
      `}</style>
      <JVMWorkspaceShell
        darkMode={darkMode}
        className="jvm-resource-browser-scroll-shell"
        data-jvm-resource-browser-scroll-shell="true"
      >
        <JVMWorkspaceHero
          darkMode={darkMode}
          eyebrow="JVM Resource"
          title={tr("jvm_resource.title")}
          description={
            <>
              <Text strong>{connection.name}</Text>
              <Text type="secondary"> · {resourcePath || "-"}</Text>
            </>
          }
          badges={
            <>
              <JVMModeBadge mode={providerMode} />
              <Tag color={readOnly ? "blue" : "red"}>
                {readOnly
                  ? tr("jvm_resource.badge.read_only")
                  : tr("jvm_resource.badge.writable")}
              </Tag>
            </>
          }
          actions={
            <>
              <Button
                size="small"
                icon={<ReloadOutlined />}
                onClick={() => void loadSnapshot()}
              >
                {tr("common.refresh")}
              </Button>
              <Button
                size="small"
                icon={<FileSearchOutlined />}
                onClick={handleOpenAudit}
              >
                {tr("jvm_resource.action.audit")}
              </Button>
              <Button
                size="small"
                icon={<AiSparkOutlined />}
                onClick={handleAskAIForPlan}
              >
                {tr("jvm_resource.action.generate_ai_plan")}
              </Button>
            </>
          }
        />

        <div
          className="jvm-resource-workbench"
          data-jvm-resource-workbench="true"
          style={{
            display: "grid",
            gridTemplateColumns: "minmax(0, 1fr) minmax(360px, 440px)",
            gap: 18,
            alignItems: "start",
          }}
        >
          <Card
            title={tr("jvm_resource.card.snapshot")}
            variant="borderless"
            style={{
              ...cardStyle,
              gridColumn: readOnly ? "1 / -1" : undefined,
            }}
          >
            {loading ? (
              <Skeleton active paragraph={{ rows: 6 }} />
            ) : (
              <Space direction="vertical" size={16} style={{ width: "100%" }}>
                {error ? <Alert type="error" showIcon message={error} /> : null}
                {snapshot ? (
                  <>
                    <Descriptions
                      column={1}
                      size="small"
                      styles={DESCRIPTION_STYLES}
                    >
                      <Descriptions.Item label={tr("jvm_resource.field.resource_id")}>
                        {snapshot.resourceId || "-"}
                      </Descriptions.Item>
                      <Descriptions.Item label={tr("jvm_resource.field.resource_type")}>
                        {snapshot.kind || tab.resourceKind || "-"}
                      </Descriptions.Item>
                      <Descriptions.Item label={tr("jvm_resource.field.format")}>
                        {snapshot.format || "-"}
                      </Descriptions.Item>
                      <Descriptions.Item label={tr("jvm_resource.field.version")}>
                        {snapshot.version || "-"}
                      </Descriptions.Item>
                      <Descriptions.Item label={tr("jvm_resource.field.available_actions")}>
                        {formatJVMActionSummary(supportedActions, i18nLanguage)}
                      </Descriptions.Item>
                    </Descriptions>
                    {snapshot.description ? (
                      <Text type="secondary">{snapshot.description}</Text>
                    ) : null}
                    <div>
                      <Text
                        strong
                        style={{ display: "block", marginBottom: 8 }}
                      >
                        {tr("jvm_resource.section.resource_value")}
                      </Text>
                      <div
                        className="jvm-resource-browser-code-block"
                        style={{
                          ...snapshotBlockStyle("rgba(0, 0, 0, 0.04)"),
                          height: estimateJVMResourceEditorHeight(displayValue),
                        }}
                      >
                        <Editor
                          height="100%"
                          language={displayLanguage}
                          theme={
                            darkMode ? "transparent-dark" : "transparent-light"
                          }
                          value={displayValue}
                          options={{
                            readOnly: true,
                            minimap: { enabled: false },
                            lineNumbers: "on",
                            wordWrap: "on",
                            scrollBeyondLastLine: false,
                            automaticLayout: true,
                            folding: true,
                            renderValidationDecorations: "off",
                          }}
                        />
                      </div>
                    </div>
                    {metadataText ? (
                      <div>
                        <Text
                          strong
                          style={{ display: "block", marginBottom: 8 }}
                        >
                          {tr("jvm_resource.section.metadata")}
                        </Text>
                        <div
                          className="jvm-resource-browser-code-block"
                          style={{
                            ...snapshotBlockStyle("rgba(0, 0, 0, 0.03)"),
                            height:
                              estimateJVMResourceEditorHeight(metadataText),
                          }}
                        >
                          <Editor
                            height="100%"
                            language={metadataLanguage}
                            theme={
                              darkMode
                                ? "transparent-dark"
                                : "transparent-light"
                            }
                            value={metadataText}
                            options={{
                              readOnly: true,
                              minimap: { enabled: false },
                              lineNumbers: "on",
                              wordWrap: "on",
                              scrollBeyondLastLine: false,
                              automaticLayout: true,
                              folding: true,
                              renderValidationDecorations: "off",
                            }}
                          />
                        </div>
                      </div>
                    ) : null}
                  </>
                ) : error ? null : (
                  <Empty description={tr("jvm_resource.empty.no_resource_data")} />
                )}
              </Space>
            )}
          </Card>

          {!readOnly ? (
            <Card title={tr("jvm_resource.card.change_draft")} variant="borderless" style={cardStyle}>
              <Space direction="vertical" size={16} style={{ width: "100%" }}>
                {draftError ? (
                  <Alert type="error" showIcon message={draftError} />
                ) : null}
                {applyMessage ? (
                  <Alert type="success" showIcon message={applyMessage} />
                ) : null}
                <Descriptions
                  column={1}
                  size="small"
                  styles={DESCRIPTION_STYLES}
                >
                  <Descriptions.Item label={tr("jvm_resource.field.resource_path")}>
                    {resourcePath || "-"}
                  </Descriptions.Item>
                  <Descriptions.Item label={tr("jvm_resource.field.target_resource")}>
                    {draftResourceId || resourcePath || "-"}
                  </Descriptions.Item>
                  <Descriptions.Item label={tr("jvm_resource.field.resource_version")}>
                    {snapshot?.version || "-"}
                  </Descriptions.Item>
                  <Descriptions.Item label={tr("jvm_resource.field.draft_source")}>
                    {draftSource === "ai-plan"
                      ? tr("jvm_resource.draft_source.ai_plan")
                      : tr("jvm_resource.draft_source.manual")}
                  </Descriptions.Item>
                </Descriptions>
                {supportedActions.length > 0 ? (
                  <Space
                    direction="vertical"
                    size={8}
                    style={{ width: "100%" }}
                  >
                    <Text strong>
                      {tr("jvm_resource.section.supported_actions")}
                    </Text>
                    <Space size={8} wrap>
                      {supportedActions.map((item) => (
                        <Button
                          key={item.action}
                          size="small"
                          type={action === item.action ? "primary" : "default"}
                          danger={item.dangerous}
                          onClick={() => handleSelectAction(item.action, item)}
                        >
                          {resolveJVMActionDisplay(item, i18nLanguage).label}
                        </Button>
                      ))}
                    </Space>
                    {selectedActionDisplay.description ? (
                      <Text type="secondary">
                        {selectedActionDisplay.description}
                      </Text>
                    ) : null}
                    {selectedActionDefinition?.payloadFields?.length ? (
                      <Text type="secondary">
                        {tr("jvm_resource.field.payload_fields")}
                        {selectedActionDefinition.payloadFields
                          .map(
                            (field) =>
                              `${field.name}${
                                field.required
                                  ? tr("jvm_resource.marker.required_suffix")
                                  : ""
                              }`,
                          )
                          .join(tr("jvm_resource.list_separator"))}
                      </Text>
                    ) : null}
                  </Space>
                ) : null}
                <Space direction="vertical" size={8} style={{ width: "100%" }}>
                  <Text strong>{tr("jvm_resource.field.action")}</Text>
                  <Input
                    value={action}
                    onChange={(event) =>
                      handleSelectAction(
                        event.target.value,
                        selectedActionDefinition,
                      )
                    }
                    placeholder={
                      providerMode === "jmx"
                        ? tr("jvm_resource.placeholder.action_jmx")
                        : tr("jvm_resource.placeholder.action_default")
                    }
                    maxLength={64}
                  />
                  {action ? (
                    <Text type="secondary">
                      {tr("jvm_resource.message.current_action")}
                      {formatJVMActionDisplayText(
                        selectedActionDisplay,
                        i18nLanguage,
                      )}
                    </Text>
                  ) : null}
                </Space>
                <Space direction="vertical" size={8} style={{ width: "100%" }}>
                  <Text strong>{tr("jvm_resource.field.reason")}</Text>
                  <Input
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                    placeholder={tr("jvm_resource.placeholder.reason")}
                    maxLength={200}
                  />
                </Space>
                <Space direction="vertical" size={8} style={{ width: "100%" }}>
                  <Text strong>{tr("jvm_resource.field.payload")}</Text>
                  <Text type="secondary">
                    {tr("jvm_resource.message.payload_hint")}
                    {selectedActionDefinition?.payloadExample &&
                    !snapshot?.sensitive
                      ? ` ${tr("jvm_resource.message.payload_template_applied")}`
                      : ""}
                  </Text>
                  <TextArea
                    value={payloadText}
                    onChange={(event) => setPayloadText(event.target.value)}
                    autoSize={{ minRows: 8, maxRows: 18 }}
                    spellCheck={false}
                  />
                </Space>
                <Space size={12} wrap>
                  <Button
                    type="primary"
                    loading={previewLoading}
                    onClick={() => void handlePreview()}
                  >
                    {tr("jvm_resource.action.preview_change")}
                  </Button>
                  <Button icon={<AiSparkOutlined />} onClick={handleAskAIForPlan}>
                    {tr("jvm_resource.action.ask_ai_plan")}
                  </Button>
                </Space>
              </Space>
            </Card>
          ) : null}
        </div>
      </JVMWorkspaceShell>

      <JVMChangePreviewModal
        open={previewOpen}
        preview={previewResult}
        applying={applyLoading}
        onCancel={() => {
          if (applyLoading) {
            return;
          }
          setPreviewOpen(false);
        }}
        onConfirm={() => void handleApply()}
      />
    </>
  );
};

export default JVMResourceBrowser;
