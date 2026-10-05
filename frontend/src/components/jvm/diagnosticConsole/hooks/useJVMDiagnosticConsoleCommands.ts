import { message } from "antd";
import {
  createJVMDiagnosticLocalPendingChunk,
  createJVMDiagnosticRunningRecord,
  registerJVMDiagnosticMonacoSupport,
} from "../jvmDiagnosticConsoleSupport";
import { redactJVMDiagnosticOutput } from "../../../../utils/jvmDiagnosticPresentation";
import type { BeforeMount, OnMount } from "../../../MonacoEditor";
import type { JVMDiagnosticConsoleStateApi } from "./useJVMDiagnosticConsoleState";
import type { JVMDiagnosticConsoleProps } from "../../../JVMDiagnosticConsole";

export interface UseJVMDiagnosticConsoleCommandsInput {
  tab: JVMDiagnosticConsoleProps['tab'];
  rpcConnectionConfig: JVMDiagnosticConsoleStateApi['rpcConnectionConfig'];
  setError: JVMDiagnosticConsoleStateApi['setError'];
  t: JVMDiagnosticConsoleStateApi['t'];
  effectiveSession: JVMDiagnosticConsoleStateApi['effectiveSession'];
  draft: JVMDiagnosticConsoleStateApi['draft'];
  activeCommandIdRef: JVMDiagnosticConsoleStateApi['activeCommandIdRef'];
  terminalCommandIdsRef: JVMDiagnosticConsoleStateApi['terminalCommandIdsRef'];
  setCommandRunning: JVMDiagnosticConsoleStateApi['setCommandRunning'];
  setActiveCommandId: JVMDiagnosticConsoleStateApi['setActiveCommandId'];
  appendOutput: JVMDiagnosticConsoleStateApi['appendOutput'];
  setRecords: JVMDiagnosticConsoleStateApi['setRecords'];
  connection: JVMDiagnosticConsoleStateApi['connection'];
  diagnosticTransport: JVMDiagnosticConsoleStateApi['diagnosticTransport'];
  redactDiagnosticContent: JVMDiagnosticConsoleStateApi['redactDiagnosticContent'];
  redactDiagnosticChunk: JVMDiagnosticConsoleStateApi['redactDiagnosticChunk'];
  finishActiveCommand: JVMDiagnosticConsoleStateApi['finishActiveCommand'];
  loadAuditRecords: JVMDiagnosticConsoleStateApi['loadAuditRecords'];
  activeCommandId: JVMDiagnosticConsoleStateApi['activeCommandId'];
  setLoading: JVMDiagnosticConsoleStateApi['setLoading'];
  darkMode: JVMDiagnosticConsoleStateApi['darkMode'];
}

export const useJVMDiagnosticConsoleCommands = ({
  tab, rpcConnectionConfig, setError, t, effectiveSession, draft, activeCommandIdRef,
  terminalCommandIdsRef, setCommandRunning, setActiveCommandId, appendOutput, setRecords,
  connection, diagnosticTransport, redactDiagnosticContent, redactDiagnosticChunk,
  finishActiveCommand, loadAuditRecords, activeCommandId, setLoading, darkMode,
}: UseJVMDiagnosticConsoleCommandsInput) => {
  const handleExecuteCommand = async () => {
    if (!rpcConnectionConfig) {
      return;
    }
    const backendApp = (window as any).go?.app?.App;
    if (typeof backendApp?.JVMExecuteDiagnosticCommand !== "function") {
      setError(t("jvm_diagnostic.error.execute_unavailable"));
      return;
    }
    if (!effectiveSession?.sessionId) {
      setError(t("jvm_diagnostic.error.execute_session_required"));
      return;
    }
    const command = draft.command.trim();
    if (!command) {
      setError(t("jvm_diagnostic.error.execute_command_required"));
      return;
    }

    const sessionId = effectiveSession.sessionId;
    const commandId = `diag-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const source = draft.source || "manual";
    const reason = (draft.reason || "").trim();
    activeCommandIdRef.current = commandId;
    terminalCommandIdsRef.current.delete(commandId);
    setCommandRunning(true);
    setActiveCommandId(commandId);
    setError("");
    appendOutput(tab.id, [
      createJVMDiagnosticLocalPendingChunk({
        sessionId,
        commandId,
        command,
        content: t("jvm_diagnostic.output.local_pending", { command }),
      }),
    ]);
    setRecords((current) => [
      createJVMDiagnosticRunningRecord({
        connectionId: connection?.id || rpcConnectionConfig.id || "",
        sessionId,
        commandId,
        transport: diagnosticTransport,
        command,
        source,
        reason,
      }),
      ...current.filter((record) => record.commandId !== commandId),
    ].slice(0, 20));
    try {
      const result = await backendApp.JVMExecuteDiagnosticCommand(
        rpcConnectionConfig,
        tab.id,
        {
          sessionId,
          commandId,
          command,
          source,
          reason,
        },
      );
      if (result?.success === false) {
        throw new Error(
          String(result?.message || t("jvm_diagnostic.error.execute_failed")),
        );
      }
      if (result?.message) {
        message.warning(
          redactDiagnosticContent(String(result.message), { sessionId, commandId }),
        );
      }
      const terminalSeen = terminalCommandIdsRef.current.has(commandId);
      if (!terminalSeen) {
        appendOutput(tab.id, [
          redactDiagnosticChunk(
            {
              sessionId,
              commandId,
              event: "diagnostic",
              phase: "completed",
              content: t("jvm_diagnostic.output.frontend_completed_fallback"),
              timestamp: Date.now(),
              metadata: {
                source: "frontend-fallback",
              },
            },
            { keepState: true },
          ),
        ]);
      }
      finishActiveCommand(commandId);
      await loadAuditRecords();
      if (!terminalSeen) {
        setRecords((current) => {
          const index = current.findIndex((record) => record.commandId === commandId);
          if (index >= 0) {
            const next = [...current];
            next[index] = { ...next[index], status: "completed" };
            return next;
          }
          return [
            {
              ...createJVMDiagnosticRunningRecord({
                connectionId: connection?.id || rpcConnectionConfig.id || "",
                sessionId,
                commandId,
                transport: diagnosticTransport,
                command,
                source,
                reason,
              }),
              status: "completed",
            },
            ...current,
          ].slice(0, 20);
        });
      }
    } catch (err: any) {
      const rawMessageText = String(
        err?.message || t("jvm_diagnostic.error.execute_failed"),
      );
      let messageText = "";
      if (!terminalCommandIdsRef.current.has(commandId)) {
        const safeChunk = redactDiagnosticChunk({
          sessionId,
          commandId,
          event: "diagnostic",
          phase: "failed",
          content: rawMessageText,
          timestamp: Date.now(),
          metadata: {
            source: "frontend-fallback",
          },
        });
        messageText = safeChunk.content;
        appendOutput(tab.id, [safeChunk]);
        setRecords((current) =>
          current.map((record) =>
            record.commandId === commandId
              ? { ...record, status: "failed" }
              : record,
          ),
        );
      } else {
        messageText = redactDiagnosticContent(rawMessageText, { sessionId, commandId });
      }
      finishActiveCommand(commandId);
      setError(messageText);
    }
  };

  const handleCancelCommand = async () => {
    if (!rpcConnectionConfig || !effectiveSession?.sessionId || !activeCommandId) {
      return;
    }
    const backendApp = (window as any).go?.app?.App;
    if (typeof backendApp?.JVMCancelDiagnosticCommand !== "function") {
      setError(t("jvm_diagnostic.error.cancel_unavailable"));
      return;
    }

    setLoading(true);
    setError("");
    try {
      const result = await backendApp.JVMCancelDiagnosticCommand(
        rpcConnectionConfig,
        tab.id,
        effectiveSession.sessionId,
        activeCommandId,
      );
      if (result?.success === false) {
        throw new Error(
          String(result?.message || t("jvm_diagnostic.error.cancel_failed")),
        );
      }
      message.info(t("jvm_diagnostic.message.cancel_sent"));
    } catch (err: any) {
      setError(
        redactJVMDiagnosticOutput(
          err?.message || t("jvm_diagnostic.error.cancel_failed"),
        ),
      );
    } finally {
      setLoading(false);
    }
  };

  const handleCommandEditorBeforeMount: BeforeMount = (monaco) => {
    registerJVMDiagnosticMonacoSupport(monaco);
  };

  const handleCommandEditorMount: OnMount = (editor, monaco) => {
    monaco.editor.setTheme(darkMode ? "transparent-dark" : "transparent-light");

    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => {
      void handleExecuteCommand();
    });
  };
  return {
    handleExecuteCommand, handleCancelCommand, handleCommandEditorBeforeMount,
    handleCommandEditorMount,
  };
};

export type JVMDiagnosticConsoleCommandsApi = ReturnType<typeof useJVMDiagnosticConsoleCommands>;
