import { useMemo, useState, useRef, useEffect } from "react";
import { useOptionalI18n } from "../../../../i18n/provider";
import { t as translate } from "../../../../i18n";
import { useStore } from "../../../../store";
import {
  buildJVMPreviewRuntimeFingerprint,
  DEFAULT_PAYLOAD_TEXT,
  buildJVMPreviewContextKey,
  buildJVMRuntimeConfig,
  resolveDefaultAction,
  formatDraftPayload,
  createLocalizedError,
} from "../jvmResourceBrowserModel";
import type {
  JVMValueSnapshot,
  JVMChangePreview,
  JVMChangeRequest,
  JVMActionDefinition,
  JVMAIPlanContext,
} from "../../../../types";
import {
  formatJVMValueForDisplay,
  resolveJVMValueEditorLanguage,
  formatJVMMetadataForDisplay,
  resolveJVMActionDisplay,
  buildJVMActionPayloadTemplate,
} from "../../../../utils/jvmResourcePresentation";
import {
  type JVMAIChangePlan,
  matchesJVMAIPlanTargetTab,
  type JVMAIChangeDraft,
  buildJVMChangeDraftFromAIPlan,
  buildJVMAIPlanPrompt,
} from "../../../../utils/jvmAiPlan";
import { buildJVMTabTitle } from "../../../../utils/jvmRuntimePresentation";
import type { JVMResourceBrowserProps } from "../../../JVMResourceBrowser";

export interface UseJVMResourceBrowserStateInput {
  tab: JVMResourceBrowserProps['tab'];
}

export const useJVMResourceBrowserState = ({ tab }: UseJVMResourceBrowserStateInput) => {
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
  return {
    i18nLanguage, tr, connection, darkMode, providerMode, resourcePath, readOnly, loading, snapshot,
    setSnapshot, error, action, reason, setReason, payloadText, setPayloadText, draftSource,
    draftResourceId, draftError, setDraftError, applyMessage, setApplyMessage, previewLoading,
    setPreviewLoading, previewOpen, setPreviewOpen, previewResult, setPreviewResult, previewRequest,
    setPreviewRequest, previewRuntimeConfig, setPreviewRuntimeConfig, previewContextKey,
    setPreviewContextKey, applyLoading, setApplyLoading, previewSequenceRef,
    currentPreviewContextKey, previewContextKeyRef, clearPreviewState, displayValue,
    displayLanguage, metadataText, metadataLanguage, supportedActions, selectedActionDefinition,
    selectedActionDisplay, loadSnapshot, handleSelectAction, buildDraftPlan, handleOpenAudit,
    handleAskAIForPlan,
  };
};

export type JVMResourceBrowserStateApi = ReturnType<typeof useJVMResourceBrowserState>;
