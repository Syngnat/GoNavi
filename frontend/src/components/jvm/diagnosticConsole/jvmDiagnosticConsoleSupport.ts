import React from "react";
import { Typography } from "antd";
import { type I18nParams, t as translate } from "../../../i18n";
import type { JVMDiagnosticEventChunk, JVMDiagnosticAuditRecord } from "../../../types";
import { resolveJVMDiagnosticCompletionItems } from "../../../utils/jvmDiagnosticCompletion";
import { JVM_DIAGNOSTIC_COMMAND_PRESETS } from "../../../utils/jvmDiagnosticPresentation";

export const { Text, Paragraph } = Typography;
export const JVM_DIAGNOSTIC_EDITOR_LANGUAGE = "jvm-diagnostic";
let jvmDiagnosticCompletionDisposable: { dispose?: () => void } | null = null;

export const DEFAULT_COMMAND =
  JVM_DIAGNOSTIC_COMMAND_PRESETS.find((item) => item.category === "observe")
    ?.command || "thread -n 5";

export const translateJVMDiagnostic = (
  key: string,
  params?: I18nParams,
  language?: string,
): string => translate(key, params, language);

export const DIAGNOSTIC_WORKFLOW_STEPS = [
  {
    index: "01",
    titleKey: "jvm_diagnostic.workflow.probe.title",
    descriptionKey: "jvm_diagnostic.workflow.probe.description",
  },
  {
    index: "02",
    titleKey: "jvm_diagnostic.workflow.session.title",
    descriptionKey: "jvm_diagnostic.workflow.session.description",
  },
  {
    index: "03",
    titleKey: "jvm_diagnostic.workflow.command.title",
    descriptionKey: "jvm_diagnostic.workflow.command.description",
  },
];

export const commandEditorShellStyle = (darkMode: boolean): React.CSSProperties => ({
  borderRadius: 14,
  border: darkMode
    ? "1px solid rgba(255,255,255,0.12)"
    : "1px solid rgba(22,119,255,0.16)",
  background: darkMode ? "rgba(5,12,20,0.68)" : "rgba(246,249,253,0.92)",
  boxShadow: darkMode
    ? "inset 0 0 0 1px rgba(255,255,255,0.03)"
    : "inset 0 0 0 1px rgba(255,255,255,0.86)",
  overflow: "hidden",
});

export const registerJVMDiagnosticMonacoSupport = (monaco: any) => {
  const languageRegistry = monaco.languages as Record<string, any>;
  if (!languageRegistry.__gonaviJvmDiagnosticLanguageRegistered) {
    languageRegistry.__gonaviJvmDiagnosticLanguageRegistered = true;
    monaco.languages.register({ id: JVM_DIAGNOSTIC_EDITOR_LANGUAGE });
  }

  if (jvmDiagnosticCompletionDisposable?.dispose) {
    jvmDiagnosticCompletionDisposable.dispose();
  }

  jvmDiagnosticCompletionDisposable =
    monaco.languages.registerCompletionItemProvider(
      JVM_DIAGNOSTIC_EDITOR_LANGUAGE,
      {
        triggerCharacters: [" ", "-", ".", "@", "'", "\"", "{", "/"],
        provideCompletionItems: (model: any, position: any) => {
          const textBeforeCursor = model.getValueInRange(
            new monaco.Range(1, 1, position.lineNumber, position.column),
          );
          const word = model.getWordUntilPosition(position);
          const range = {
            startLineNumber: position.lineNumber,
            endLineNumber: position.lineNumber,
            startColumn: word.startColumn,
            endColumn: word.endColumn,
          };

          const suggestions = resolveJVMDiagnosticCompletionItems(
            textBeforeCursor,
          ).map((item, index) => ({
            label: item.label,
            kind:
              item.scope === "command"
                ? monaco.languages.CompletionItemKind.Keyword
                : item.isSnippet
                  ? monaco.languages.CompletionItemKind.Snippet
                  : monaco.languages.CompletionItemKind.Value,
            insertText:
              item.scope === "command"
                ? `${item.insertText} `
                : item.insertText,
            insertTextRules: item.isSnippet
              ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet
              : undefined,
            detail: item.detail,
            documentation: item.documentation,
            range,
            sortText: `${item.scope === "command" ? "0" : "1"}-${String(index).padStart(3, "0")}`,
            command:
              item.scope === "command"
                ? { id: "editor.action.triggerSuggest" }
                : undefined,
          }));

          return { suggestions };
        },
      },
    );
};

export const isJVMDiagnosticTerminalPhase = (phase?: string): boolean =>
  ["completed", "failed", "canceled"].includes(
    String(phase || "").toLowerCase().trim(),
  );

export const createJVMDiagnosticLocalPendingChunk = ({
  sessionId,
  commandId,
  command,
  content,
  timestamp = Date.now(),
}: {
  sessionId: string;
  commandId: string;
  command: string;
  content?: string;
  timestamp?: number;
}): JVMDiagnosticEventChunk => ({
  sessionId,
  commandId,
  event: "diagnostic",
  phase: "running",
  content:
    content ||
    translateJVMDiagnostic("jvm_diagnostic.output.local_pending", {
      command,
    }),
  timestamp,
  metadata: {
    source: "local-pending",
  },
});

export const createJVMDiagnosticRunningRecord = ({
  connectionId,
  sessionId,
  commandId,
  transport,
  command,
  source,
  reason,
  timestamp = Date.now(),
}: {
  connectionId: string;
  sessionId: string;
  commandId: string;
  transport: string;
  command: string;
  source?: string;
  reason?: string;
  timestamp?: number;
}): JVMDiagnosticAuditRecord => ({
  timestamp,
  connectionId,
  sessionId,
  commandId,
  transport,
  command,
  source,
  reason,
  status: "running",
});

export const buildJVMDiagnosticRedactionKey = (
  chunk: Pick<JVMDiagnosticEventChunk, "sessionId" | "commandId">,
): string => `${chunk.sessionId || "unknown-session"}::${chunk.commandId || "unknown-command"}`;
