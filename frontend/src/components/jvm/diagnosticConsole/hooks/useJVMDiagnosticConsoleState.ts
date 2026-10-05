import { useCallback, useState, useRef, useEffect, useMemo } from "react";
import { message } from "antd";
import { useOptionalI18n } from "../../../../i18n/provider";
import type { I18nParams } from "../../../../i18n";
import {
  translateJVMDiagnostic,
  buildJVMDiagnosticRedactionKey,
  isJVMDiagnosticTerminalPhase,
  DEFAULT_COMMAND,
} from "../jvmDiagnosticConsoleSupport";
import { useStore } from "../../../../store";
import type {
  JVMDiagnosticCapability,
  JVMDiagnosticSessionHandle,
  JVMDiagnosticAuditRecord,
  JVMDiagnosticEventChunk,
} from "../../../../types";
import {
  type JVMDiagnosticRedactionState,
  createJVMDiagnosticRedactionState,
  redactJVMDiagnosticChunkContent,
  redactJVMDiagnosticOutput,
} from "../../../../utils/jvmDiagnosticPresentation";
import { buildRpcConnectionConfig } from "../../../../utils/connectionRpcConfig";
import { EventsOn } from "../../../../../wailsjs/runtime";
import type { JVMDiagnosticConsoleProps } from "../../../JVMDiagnosticConsole";

export interface UseJVMDiagnosticConsoleStateInput {
  tab: JVMDiagnosticConsoleProps['tab'];
}

export const useJVMDiagnosticConsoleState = ({ tab }: UseJVMDiagnosticConsoleStateInput) => {
  const i18n = useOptionalI18n();
  const t = useCallback(
    (key: string, params?: I18nParams) =>
      i18n?.t ? i18n.t(key, params) : translateJVMDiagnostic(key, params, "zh-CN"),
    [i18n],
  );
  const connection = useStore((state) =>
    state.connections.find((item) => item.id === tab.connectionId),
  );
  const draft = useStore(
    (state) => state.jvmDiagnosticDrafts[tab.id] || { command: "" },
  );
  const chunks = useStore(
    (state) => state.jvmDiagnosticOutputs[tab.id] || [],
  );
  const setDraft = useStore((state) => state.setJVMDiagnosticDraft);
  const appendOutput = useStore((state) => state.appendJVMDiagnosticOutput);
  const clearOutput = useStore((state) => state.clearJVMDiagnosticOutput);
  const darkMode = useStore((state) => state.theme === "dark");
  const [capabilities, setCapabilities] = useState<JVMDiagnosticCapability[]>([]);
  const [session, setSession] = useState<JVMDiagnosticSessionHandle | null>(null);
  const [records, setRecords] = useState<JVMDiagnosticAuditRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [commandRunning, setCommandRunning] = useState(false);
  const [activeCommandId, setActiveCommandId] = useState("");
  const [error, setError] = useState("");
  const activeCommandIdRef = useRef("");
  const terminalCommandIdsRef = useRef<Set<string>>(new Set());
  const redactionStatesRef = useRef<Record<string, JVMDiagnosticRedactionState>>({});

  const redactDiagnosticContent = useCallback(
    (
      content: string,
      chunk: Pick<JVMDiagnosticEventChunk, "sessionId" | "commandId">,
    ) => {
      const key = buildJVMDiagnosticRedactionKey(chunk);
      const state =
        redactionStatesRef.current[key] || createJVMDiagnosticRedactionState();
      redactionStatesRef.current[key] = state;
      return redactJVMDiagnosticChunkContent(content, state);
    },
    [],
  );

  const redactDiagnosticChunk = useCallback(
    (chunk: JVMDiagnosticEventChunk, options: { keepState?: boolean } = {}) => {
      const key = buildJVMDiagnosticRedactionKey(chunk);
      const safeChunk = {
        ...chunk,
        content: redactDiagnosticContent(String(chunk.content || ""), chunk),
      };
      if (
        !options.keepState &&
        isJVMDiagnosticTerminalPhase(chunk.phase) &&
        !redactionStatesRef.current[key]?.insideSensitivePem &&
        !redactionStatesRef.current[key]?.sawSensitivePem
      ) {
        delete redactionStatesRef.current[key];
      }
      return safeChunk;
    },
    [redactDiagnosticContent],
  );

  const finishActiveCommand = useCallback((commandId: string) => {
    if (!commandId || activeCommandIdRef.current !== commandId) {
      return;
    }
    activeCommandIdRef.current = "";
    setCommandRunning(false);
    setActiveCommandId("");
  }, []);

  useEffect(() => {
    if (!draft.command) {
      setDraft(tab.id, { command: DEFAULT_COMMAND, source: "manual" });
    }
  }, [draft.command, setDraft, tab.id]);

  const diagnosticTransport = useMemo(
    () => connection?.config.jvm?.diagnostic?.transport || "agent-bridge",
    [connection],
  );
  const rpcConnectionConfig = useMemo(
    () =>
      connection
        ? buildRpcConnectionConfig(connection.config, { id: connection.id })
        : null,
    [connection],
  );
  const effectiveSession = useMemo(
    () =>
      session ||
      (draft.sessionId
        ? {
            sessionId: draft.sessionId,
            transport: diagnosticTransport,
            startedAt: 0,
          }
        : null),
    [diagnosticTransport, draft.sessionId, session],
  );
  const hasSession = Boolean(effectiveSession?.sessionId);

  const loadAuditRecords = useCallback(async () => {
    if (!connection) {
      setRecords([]);
      return;
    }
    const backendApp = (window as any).go?.app?.App;
    if (typeof backendApp?.JVMListDiagnosticAuditRecords !== "function") {
      return;
    }

    setHistoryLoading(true);
    try {
      const result = await backendApp.JVMListDiagnosticAuditRecords(connection.id, 20);
      if (result?.success === false) {
        throw new Error(
          String(result?.message || t("jvm_diagnostic.error.history_load_failed")),
        );
      }
      setRecords(Array.isArray(result?.data) ? result.data : []);
    } catch (err: any) {
      setError(
        redactJVMDiagnosticOutput(
          err?.message || t("jvm_diagnostic.error.history_load_failed"),
        ),
      );
    } finally {
      setHistoryLoading(false);
    }
  }, [connection, t]);

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (!detail || detail.targetTabId !== tab.id || !detail.plan) {
        return;
      }

      const planTransport = String(detail.plan.transport || diagnosticTransport);
      if (planTransport !== diagnosticTransport) {
        setError(
          t("jvm_diagnostic.ai_plan.error.transport_mismatch", {
            planTransport,
            currentTransport: diagnosticTransport,
          }),
        );
        return;
      }

      setError("");
      setDraft(tab.id, {
        command: String(detail.plan.command || ""),
        reason: String(detail.plan.reason || ""),
        source: "ai-plan",
      });
      message.success(t("jvm_diagnostic.ai_plan.message.filled"));
    };

    window.addEventListener("gonavi:jvm-apply-diagnostic-plan", handler);
    return () =>
      window.removeEventListener("gonavi:jvm-apply-diagnostic-plan", handler);
  }, [diagnosticTransport, setDraft, t, tab.id]);

  useEffect(() => {
    void loadAuditRecords();
  }, [loadAuditRecords]);

  useEffect(() => {
    const eventName = "jvm:diagnostic:chunk";
    const stopListening = EventsOn(eventName, (payload: {
      tabId?: string;
      chunk?: JVMDiagnosticEventChunk;
    }) => {
      if (!payload || payload.tabId !== tab.id || !payload.chunk) {
        return;
      }

      const safeChunk = redactDiagnosticChunk(payload.chunk);
      appendOutput(tab.id, [safeChunk]);
      if (safeChunk.phase === "failed") {
        setError(
          safeChunk.content || t("jvm_diagnostic.error.execute_failed"),
        );
      }
      if (safeChunk.commandId && isJVMDiagnosticTerminalPhase(safeChunk.phase)) {
        terminalCommandIdsRef.current.add(safeChunk.commandId);
        finishActiveCommand(safeChunk.commandId);
        void loadAuditRecords();
      }
    });

    return () => {
      if (typeof stopListening === "function") {
        stopListening();
      }
    };
  }, [appendOutput, finishActiveCommand, loadAuditRecords, redactDiagnosticChunk, t, tab.id]);

  const handleProbe = async () => {
    if (!rpcConnectionConfig) {
      return;
    }
    const backendApp = (window as any).go?.app?.App;
    if (typeof backendApp?.JVMProbeDiagnosticCapabilities !== "function") {
      setError(t("jvm_diagnostic.error.probe_unavailable"));
      return;
    }

    setLoading(true);
    setError("");
    try {
      const result = await backendApp.JVMProbeDiagnosticCapabilities(
        rpcConnectionConfig,
      );
      if (result?.success === false) {
        throw new Error(
          String(result?.message || t("jvm_diagnostic.error.probe_failed")),
        );
      }
      setCapabilities(Array.isArray(result?.data) ? result.data : []);
    } catch (err: any) {
      setCapabilities([]);
      setError(
        redactJVMDiagnosticOutput(
          err?.message || t("jvm_diagnostic.error.probe_failed"),
        ),
      );
    } finally {
      setLoading(false);
    }
  };

  const handleStartSession = async () => {
    if (!rpcConnectionConfig) {
      return;
    }
    const backendApp = (window as any).go?.app?.App;
    if (typeof backendApp?.JVMStartDiagnosticSession !== "function") {
      setError(t("jvm_diagnostic.error.start_unavailable"));
      return;
    }

    setLoading(true);
    setError("");
    try {
      const result = await backendApp.JVMStartDiagnosticSession(
        rpcConnectionConfig,
        {
          title: t("jvm_diagnostic.session.default_title"),
          reason: draft.reason || t("jvm_diagnostic.session.default_reason"),
        },
      );
      if (result?.success === false) {
        throw new Error(
          String(result?.message || t("jvm_diagnostic.error.start_failed")),
        );
      }
      const nextSession = (result?.data || null) as JVMDiagnosticSessionHandle | null;
      setSession(nextSession);
      if (nextSession?.sessionId) {
        setDraft(tab.id, { sessionId: nextSession.sessionId });
      }
      void loadAuditRecords();
    } catch (err: any) {
      setSession(null);
      setError(
        redactJVMDiagnosticOutput(
          err?.message || t("jvm_diagnostic.error.start_failed"),
        ),
      );
    } finally {
      setLoading(false);
    }
  };
  return {
    t, connection, draft, chunks, setDraft, appendOutput, clearOutput, darkMode, capabilities,
    records, setRecords, loading, setLoading, historyLoading, commandRunning, setCommandRunning,
    activeCommandId, setActiveCommandId, error, setError, activeCommandIdRef, terminalCommandIdsRef,
    redactDiagnosticContent, redactDiagnosticChunk, finishActiveCommand, diagnosticTransport,
    rpcConnectionConfig, effectiveSession, hasSession, loadAuditRecords, handleProbe,
    handleStartSession,
  };
};

export type JVMDiagnosticConsoleStateApi = ReturnType<typeof useJVMDiagnosticConsoleState>;
