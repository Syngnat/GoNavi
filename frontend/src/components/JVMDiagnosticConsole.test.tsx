import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create } from "react-test-renderer";
import { message } from "antd";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import JVMDiagnosticConsole, {
  createJVMDiagnosticLocalPendingChunk,
  createJVMDiagnosticRunningRecord,
  isJVMDiagnosticTerminalPhase,
} from "./JVMDiagnosticConsole";
import { setCurrentLanguage } from "../i18n";
import { I18nProvider } from "../i18n/provider";
import type { SupportedLanguage } from "../i18n/types";

const baseState = {
  appearance: {
    dataTableFontSize: 14,
    dataTableFontSizeFollowGlobal: true,
    customMonoFontFamily: "",
  },
  fontSize: 14,
  connections: [
    {
      id: "conn-1",
      name: "orders-jvm",
      config: {
        host: "orders.internal",
        jvm: {
          diagnostic: {
            enabled: true,
            transport: "agent-bridge",
          },
        },
      },
    },
  ],
  jvmDiagnosticDrafts: {},
  jvmDiagnosticOutputs: {},
  setJVMDiagnosticDraft: vi.fn(),
  appendJVMDiagnosticOutput: vi.fn(),
  clearJVMDiagnosticOutput: vi.fn(),
};

let mockState: any = baseState;
let registeredCompletionProvider: any = null;
let registeredDiagnosticChunkHandler: any = null;
let registeredApplyDiagnosticPlanHandler: any = null;
const mountedRenderers: any[] = [];
const mockBackendApp = {
  JVMListDiagnosticAuditRecords: vi.fn(),
  JVMProbeDiagnosticCapabilities: vi.fn(),
  JVMStartDiagnosticSession: vi.fn(),
  JVMExecuteDiagnosticCommand: vi.fn(),
  JVMCancelDiagnosticCommand: vi.fn(),
};
const mockMonaco = {
  Range: class {
    startLineNumber: number;
    startColumn: number;
    endLineNumber: number;
    endColumn: number;

    constructor(
      startLineNumber: number,
      startColumn: number,
      endLineNumber: number,
      endColumn: number,
    ) {
      this.startLineNumber = startLineNumber;
      this.startColumn = startColumn;
      this.endLineNumber = endLineNumber;
      this.endColumn = endColumn;
    }
  },
  KeyMod: { CtrlCmd: 2048 },
  KeyCode: { Enter: 3 },
  editor: {
    defineTheme: vi.fn(),
    setTheme: vi.fn(),
  },
  languages: {
    CompletionItemKind: {
      Keyword: 1,
      Snippet: 2,
      Value: 3,
    },
    CompletionItemInsertTextRule: {
      InsertAsSnippet: 4,
    },
    register: vi.fn(),
    registerCompletionItemProvider: vi.fn((language: string, provider: any) => {
      if (language === "jvm-diagnostic") {
        registeredCompletionProvider = provider;
      }
      return { dispose: vi.fn() };
    }),
  },
};
const mockEditor = {
  addCommand: vi.fn(),
};

vi.mock("@monaco-editor/react", () => ({
  default: ({
    beforeMount,
    language,
    onMount,
    value,
  }: {
    beforeMount?: (monaco: any) => void;
    language?: string;
    onMount?: (editor: any, monaco: any) => void;
    value?: string;
  }) => {
    beforeMount?.(mockMonaco);
    onMount?.(mockEditor, mockMonaco);
    return (
      <div
        data-before-mount={beforeMount ? "true" : "false"}
        data-monaco-editor-mock="true"
        data-language={language}
      >
        {value}
      </div>
    );
  },
}));

vi.mock("../../wailsjs/runtime", () => ({
  EventsOn: vi.fn((_eventName: string, handler: any) => {
    registeredDiagnosticChunkHandler = handler;
    return vi.fn();
  }),
}));

vi.mock("@ant-design/icons", () => {
  const Icon = () => <span />;
  return {
    ClearOutlined: Icon,
    HistoryOutlined: Icon,
    PauseCircleOutlined: Icon,
    PlayCircleOutlined: Icon,
    ReloadOutlined: Icon,
    RocketOutlined: Icon,
    ToolOutlined: Icon,
  };
});

vi.mock("antd", () => {
  const passthrough = ({ children, style }: any) => <div style={style}>{children}</div>;
  const Text = ({ children, style }: any) => <span style={style}>{children}</span>;
  const Paragraph = ({ children, style }: any) => <p style={style}>{children}</p>;
  const Title = ({ children, style }: any) => <h3 style={style}>{children}</h3>;
  const Empty = ({ description }: any) => <div>{description}</div>;
  Empty.PRESENTED_IMAGE_SIMPLE = "simple";
  const List = ({ dataSource = [], renderItem }: any) => (
    <div>{dataSource.map((item: any, index: number) => renderItem(item, index))}</div>
  );
  List.Item = ({ children, style }: any) => <div style={style}>{children}</div>;
  const Typography = { Text, Paragraph, Title };
  return {
    Alert: ({ message: alertMessage, description, style }: any) => (
      <div style={style}>{alertMessage}{description}</div>
    ),
    Button: ({ children, onClick, disabled, style }: any) => <button onClick={onClick} disabled={disabled} style={style}>{children}</button>,
    Card: ({ children, title, style }: any) => <section style={style}>{title}{children}</section>,
    Empty,
    Input: ({ value, onChange, placeholder }: any) => <input value={value} onChange={onChange} placeholder={placeholder} />,
    List,
    Space: passthrough,
    Tag: ({ children, style }: any) => <span style={style}>{children}</span>,
    Typography,
    message: {
      success: vi.fn(),
      warning: vi.fn(),
      info: vi.fn(),
    },
  };
});

vi.mock("../store", () => ({
  useStore: (selector: (state: any) => any) => selector(mockState),
}));

const renderConsoleWithLanguage = (
  language: SupportedLanguage,
  state: any = baseState,
) => {
  mockState = state;
  return renderToStaticMarkup(
    <I18nProvider
      preference={language}
      systemLanguages={[language]}
      onPreferenceChange={vi.fn()}
    >
      <JVMDiagnosticConsole
        tab={{
          id: "tab-1",
          title: "诊断增强",
          type: "jvm-diagnostic",
          connectionId: "conn-1",
        }}
      />
    </I18nProvider>,
  );
};

const createConsoleWithLanguage = async (
  language: SupportedLanguage,
  state: any = baseState,
) => {
  mockState = state;
  let renderer: any;
  await act(async () => {
    renderer = create(
      <I18nProvider
        preference={language}
        systemLanguages={[language]}
        onPreferenceChange={vi.fn()}
      >
        <JVMDiagnosticConsole
          tab={{
            id: "tab-1",
            title: "诊断增强",
            type: "jvm-diagnostic",
            connectionId: "conn-1",
          }}
        />
      </I18nProvider>,
    );
  });
  mountedRenderers.push(renderer);
  return renderer;
};

describe("JVMDiagnosticConsole", () => {
  beforeEach(() => {
    setCurrentLanguage("zh-CN");
    registeredCompletionProvider = null;
    registeredDiagnosticChunkHandler = null;
    registeredApplyDiagnosticPlanHandler = null;
    mockState = {
      ...baseState,
      setJVMDiagnosticDraft: vi.fn(),
      appendJVMDiagnosticOutput: vi.fn(),
      clearJVMDiagnosticOutput: vi.fn(),
    };
    mockBackendApp.JVMListDiagnosticAuditRecords.mockResolvedValue({
      success: true,
      data: [],
    });
    mockBackendApp.JVMProbeDiagnosticCapabilities.mockReset();
    mockBackendApp.JVMStartDiagnosticSession.mockReset();
    mockBackendApp.JVMExecuteDiagnosticCommand.mockReset();
    mockBackendApp.JVMCancelDiagnosticCommand.mockReset();
    vi.mocked(message.success).mockClear();
    vi.mocked(message.warning).mockClear();
    vi.mocked(message.info).mockClear();
    (globalThis as any).window = {
      ...(globalThis as any).window,
      go: { app: { App: mockBackendApp } },
      addEventListener: vi.fn((eventName: string, handler: any) => {
        if (eventName === "gonavi:jvm-apply-diagnostic-plan") {
          registeredApplyDiagnosticPlanHandler = handler;
        }
      }),
      removeEventListener: vi.fn(),
    };
    mockMonaco.editor.setTheme.mockClear();
    mockMonaco.editor.defineTheme.mockClear();
    mockMonaco.languages.register.mockClear();
    mockMonaco.languages.registerCompletionItemProvider.mockClear();
    mockEditor.addCommand.mockClear();
  });

  afterEach(() => {
    while (mountedRenderers.length > 0) {
      mountedRenderers.pop()?.unmount?.();
    }
  });

  it("builds local pending output and history while a command is waiting for backend events", () => {
    const chunk = createJVMDiagnosticLocalPendingChunk({
      sessionId: "session-1",
      commandId: "cmd-1",
      command: "thread -n 5",
    });
    const record = createJVMDiagnosticRunningRecord({
      connectionId: "conn-1",
      sessionId: "session-1",
      commandId: "cmd-1",
      transport: "arthas-tunnel",
      command: "thread -n 5",
      source: "manual",
      reason: "排查线程",
    });

    expect(chunk).toMatchObject({
      sessionId: "session-1",
      commandId: "cmd-1",
      event: "diagnostic",
      phase: "running",
    });
    expect(chunk.content).toContain("thread -n 5");
    expect(record).toMatchObject({
      connectionId: "conn-1",
      sessionId: "session-1",
      commandId: "cmd-1",
      transport: "arthas-tunnel",
      command: "thread -n 5",
      status: "running",
      reason: "排查线程",
    });
    expect(isJVMDiagnosticTerminalPhase("completed")).toBe(true);
    expect(isJVMDiagnosticTerminalPhase("failed")).toBe(true);
    expect(isJVMDiagnosticTerminalPhase("running")).toBe(false);
  });

  it("localizes local pending output while preserving raw command text", () => {
    setCurrentLanguage("en-US");

    const chunk = createJVMDiagnosticLocalPendingChunk({
      sessionId: "session-1",
      commandId: "cmd-1",
      command: "thread -n 5",
    });

    expect(chunk.content).toBe(
      "Diagnostic command submitted; waiting for backend output: thread -n 5",
    );
    expect(chunk.content).toContain("thread -n 5");
    expect(chunk.content).not.toContain("已提交诊断命令");
    expect(chunk.content).not.toContain("{{command}}");
  });

  it("preserves command placeholder-like text as raw local pending output", () => {
    setCurrentLanguage("en-US");

    const chunk = createJVMDiagnosticLocalPendingChunk({
      sessionId: "session-1",
      commandId: "cmd-1",
      command: "echo {{command}}",
    });

    expect(chunk.content).toBe(
      "Diagnostic command submitted; waiting for backend output: echo {{command}}",
    );
  });

  it("keeps a stable workbench shell and hides command inputs before session creation", () => {
    mockState = {
      ...baseState,
      jvmDiagnosticDrafts: {},
    };

    const markup = renderConsoleWithLanguage("zh-CN", mockState);

    expect(markup).toContain("开始一次诊断");
    expect(markup).toContain("命令输入将在会话建立后显示");
    expect(markup).toContain("先建立会话，再显示命令编辑器和模板");
    expect(markup).toContain("会话与能力");
    expect(markup).toContain("审计历史");
    expect(markup).not.toContain("命令模板");
    expect(markup).not.toContain("实时输出");
    expect(markup).not.toContain('data-monaco-editor-mock="true"');
  });

  it("localizes the no-session workflow and workbench shell without translating raw connection details", () => {
    const zhMarkup = renderConsoleWithLanguage("zh-CN", {
      ...baseState,
      jvmDiagnosticDrafts: {},
    });
    const enMarkup = renderConsoleWithLanguage("en-US", {
      ...baseState,
      jvmDiagnosticDrafts: {},
    });

    expect(zhMarkup).toContain("JVM 诊断工作台");
    expect(zhMarkup).toContain("开始一次诊断");
    expect(zhMarkup).toContain("命令输入将在会话建立后显示");
    expect(zhMarkup).toContain("只读取诊断通道、流式输出与命令权限，不创建会话。");
    expect(zhMarkup).toContain("新建诊断会话");
    expect(zhMarkup).toContain("未建会话");
    expect(zhMarkup).toContain("检查能力");

    expect(enMarkup).toContain("JVM diagnostic workbench");
    expect(enMarkup).toContain("Start a diagnostic session");
    expect(enMarkup).toContain("Command input appears after a session is created");
    expect(enMarkup).toContain("Read diagnostic transport, streaming output, and command permissions without creating a session.");
    expect(enMarkup).toContain("Start diagnostic session");
    expect(enMarkup).toContain("No session");
    expect(enMarkup).toContain("Check capabilities");
    expect(enMarkup).not.toContain("开始一次诊断");
    expect(enMarkup).not.toContain("命令输入将在会话建立后显示");

    expect(enMarkup).toContain("orders-jvm");
    expect(enMarkup).toContain("orders.internal");
    expect(enMarkup).toContain("Agent Bridge");
  });

  it("localizes session capability and capability results while keeping transport labels raw", async () => {
    mockState = {
      ...baseState,
      jvmDiagnosticDrafts: {
        "tab-1": {
          sessionId: "session-1",
          command: "thread -n 5",
        },
      },
    };
    mockBackendApp.JVMProbeDiagnosticCapabilities.mockResolvedValue({
      success: true,
      data: [
        {
          transport: "agent-bridge",
          canOpenSession: true,
          canStream: false,
          allowObserveCommands: false,
          allowTraceCommands: true,
          allowMutatingCommands: true,
        },
      ],
    });

    let renderer: any;
    renderer = await createConsoleWithLanguage("en-US", mockState);

    const beforeProbe = JSON.stringify(renderer.toJSON());
    expect(beforeProbe).toContain("Session and capabilities");
    expect(beforeProbe).toContain("Session established");
    expect(beforeProbe).toContain("Idle");
    expect(beforeProbe).toContain("Clear output");
    expect(beforeProbe).toContain("Refresh history");
    expect(beforeProbe).toContain("No capability check yet");
    expect(beforeProbe).not.toContain("会话与能力");
    expect(beforeProbe).toContain("session-1");
    expect(beforeProbe).toContain("Agent Bridge");

    const probeButton = renderer.root
      .findAllByType("button")
      .find((button: any) => button.children.includes("Check capabilities"));
    await act(async () => {
      probeButton.props.onClick();
    });

    const afterProbe = JSON.stringify(renderer.toJSON());
    expect(afterProbe).toContain("Capability check results");
    expect(afterProbe).toContain("Can start sessions");
    expect(afterProbe).toContain("Streaming unsupported");
    expect(afterProbe).toContain("Observe disabled");
    expect(afterProbe).toContain("Trace commands");
    expect(afterProbe).toContain("High-risk commands");
    expect(afterProbe).toContain("Agent Bridge");
    expect(afterProbe).not.toContain("能力检查结果");
  });

  it("shows command input, reason field, and presets after a session exists", () => {
    mockState = {
      ...baseState,
      jvmDiagnosticDrafts: {
        "tab-1": {
          sessionId: "session-1",
          command: "thread -n 5",
          reason: "排查 CPU 线程",
        },
      },
    };

    const markup = renderConsoleWithLanguage("zh-CN", mockState);

    expect(markup).toContain("overflow:auto");
    expect(markup).toContain("JVM 诊断工作台");
    expect(markup).toContain("会话与能力");
    expect(markup).toContain("实时输出");
    expect(markup).toContain("审计历史");
    expect(markup.indexOf("命令输入")).toBeGreaterThanOrEqual(0);
    expect(markup).toContain("诊断命令");
    expect(markup).toContain("诊断原因（可选）");
    expect(markup).toContain("用于审计记录");
    expect(markup.indexOf("命令输入")).toBeLessThan(markup.indexOf("实时输出"));
    expect(markup).toContain("观察类命令");
    expect(markup).toContain("thread");
    expect(markup).toContain("执行命令");
    expect(markup).toContain('data-monaco-editor-mock="true"');
    expect(markup).toContain('data-language="jvm-diagnostic"');
  });

  it("localizes command input and command template cards while preserving raw command details", () => {
    const sessionState = {
      ...baseState,
      jvmDiagnosticDrafts: {
        "tab-1": {
          sessionId: "session-1",
          command: "thread -n 5",
          reason: "排查 CPU 线程",
        },
      },
    };

    const zhMarkup = renderConsoleWithLanguage("zh-CN", sessionState);
    const enMarkup = renderConsoleWithLanguage("en-US", sessionState);

    expect(zhMarkup).toContain("命令输入");
    expect(zhMarkup).toContain("支持自动补全，按 Ctrl/Cmd + Enter 执行");
    expect(zhMarkup).toContain("诊断命令");
    expect(zhMarkup).toContain("输入 Arthas/诊断命令，例如 thread -n 5、dashboard、jvm；也可以从下方模板一键回填。");
    expect(zhMarkup).toContain("诊断原因（可选）");
    expect(zhMarkup).toContain("例如：排查 CPU 飙高、确认线程阻塞、定位慢方法");
    expect(zhMarkup).toContain("用于审计记录和 AI 上下文理解，不会作为 Arthas 命令发送到目标 JVM。");
    expect(zhMarkup).toContain("命令模板");

    expect(enMarkup).toContain("Command input");
    expect(enMarkup).toContain("Supports autocomplete. Press Ctrl/Cmd + Enter to run.");
    expect(enMarkup).toContain("Diagnostic command");
    expect(enMarkup).toContain("Enter an Arthas/diagnostic command, for example thread -n 5, dashboard, or jvm; templates below can fill this in with one click.");
    expect(enMarkup).toContain("Reason (optional)");
    expect(enMarkup).toContain("For example: investigate high CPU, confirm blocked threads, or locate a slow method");
    expect(enMarkup).toContain("Used for audit records and AI context. It is not sent to the target JVM as an Arthas command.");
    expect(enMarkup).toContain("Command templates");
    expect(enMarkup).not.toContain("诊断原因（可选）");
    expect(enMarkup).not.toContain("命令模板");

    expect(enMarkup).toContain("thread -n 5");
    expect(enMarkup).toContain("dashboard");
    expect(enMarkup).toContain("jvm");
    expect(enMarkup).toContain("Arthas");
    expect(enMarkup).toContain("jvm-diagnostic");
    expect(enMarkup).toContain("orders-jvm");
  });

  it("localizes remaining output, history, and missing-connection chrome", () => {
    const sessionState = {
      ...baseState,
      jvmDiagnosticDrafts: {
        "tab-1": {
          sessionId: "session-1",
          command: "thread -n 5",
        },
      },
    };
    const enMarkup = renderConsoleWithLanguage("en-US", sessionState);
    const missingConnectionMarkup = renderConsoleWithLanguage("en-US", {
      ...baseState,
      connections: [],
    });

    expect(enMarkup).toContain("Live output");
    expect(enMarkup).toContain("Appended from backend event stream");
    expect(enMarkup).toContain("Audit history");
    expect(enMarkup).toContain("Recent commands and execution status");
    expect(enMarkup).toContain("session-1");
    expect(enMarkup).not.toContain("按后端事件流追加显示");
    expect(enMarkup).not.toContain("审计历史");
    expect(missingConnectionMarkup).toContain(
      "Connection does not exist or has been deleted",
    );
    expect(missingConnectionMarkup).not.toContain("连接不存在或已被删除");
  });

  it("localizes JVM diagnostic operation fallbacks and default session metadata", async () => {
    mockBackendApp.JVMListDiagnosticAuditRecords.mockResolvedValueOnce({
      success: false,
      message: "",
    });
    let renderer = await createConsoleWithLanguage("en-US", {
      ...baseState,
      jvmDiagnosticDrafts: {},
    });
    expect(JSON.stringify(renderer.toJSON())).toContain(
      "Failed to load diagnostic history",
    );

    mockBackendApp.JVMProbeDiagnosticCapabilities.mockResolvedValueOnce({
      success: false,
      message: "",
    });
    const probeButton = renderer.root
      .findAllByType("button")
      .find((button: any) => button.children.includes("Check capabilities"));
    await act(async () => {
      probeButton.props.onClick();
    });
    expect(JSON.stringify(renderer.toJSON())).toContain(
      "Failed to check diagnostic capabilities",
    );

    mockBackendApp.JVMStartDiagnosticSession.mockResolvedValueOnce({
      success: true,
      data: { sessionId: "session-created", transport: "agent-bridge" },
    });
    const startButton = renderer.root
      .findAllByType("button")
      .find((button: any) => button.children.includes("Start diagnostic session"));
    await act(async () => {
      startButton.props.onClick();
    });
    expect(mockBackendApp.JVMStartDiagnosticSession.mock.calls[0][1]).toMatchObject({
      title: "JVM diagnostic console",
      reason: "Session started from the console",
    });

    renderer = await createConsoleWithLanguage("en-US", {
      ...baseState,
      jvmDiagnosticDrafts: {
        "tab-1": {
          sessionId: "session-1",
          command: "   ",
        },
      },
    });
    const executeButton = renderer.root
      .findAllByType("button")
      .find((button: any) => button.children.includes("Execute command"));
    await act(async () => {
      executeButton.props.onClick();
    });
    expect(JSON.stringify(renderer.toJSON())).toContain(
      "Diagnostic command is required",
    );

    mockBackendApp.JVMExecuteDiagnosticCommand.mockResolvedValueOnce({
      success: true,
    });
    renderer = await createConsoleWithLanguage("en-US", {
      ...baseState,
      jvmDiagnosticDrafts: {
        "tab-1": {
          sessionId: "session-1",
          command: "thread -n 5",
        },
      },
    });
    const fallbackExecuteButton = renderer.root
      .findAllByType("button")
      .find((button: any) => button.children.includes("Execute command"));
    await act(async () => {
      fallbackExecuteButton.props.onClick();
    });
    const appendedChunks = mockState.appendJVMDiagnosticOutput.mock.calls.flatMap(
      (call: any[]) => call[1],
    );
    expect(JSON.stringify(appendedChunks)).toContain(
      "Diagnostic command submitted; waiting for backend output: thread -n 5",
    );
    expect(JSON.stringify(appendedChunks)).toContain(
      "The diagnostic command call returned, but no terminal backend event was received. The frontend ended the waiting state as a fallback.",
    );
    expect(JSON.stringify(appendedChunks)).toContain("thread -n 5");
    expect(JSON.stringify(appendedChunks)).not.toContain("已提交诊断命令");
    expect(JSON.stringify(appendedChunks)).not.toContain("诊断命令调用已返回");
  });

  it("localizes unavailable execute/cancel fallbacks and AI plan messages without translating raw transports", async () => {
    const renderer = await createConsoleWithLanguage("en-US", {
      ...baseState,
      jvmDiagnosticDrafts: {
        "tab-1": {
          sessionId: "session-1",
          command: "thread -n 5",
        },
      },
    });

    await act(async () => {
      registeredApplyDiagnosticPlanHandler({
        detail: {
          targetTabId: "tab-1",
          plan: {
            transport: "arthas-tunnel",
            command: "dashboard",
            reason: "raw AI reason",
          },
        },
      });
    });
    const mismatchJson = JSON.stringify(renderer.toJSON());
    expect(mismatchJson).toContain(
      "The AI plan diagnostic transport is arthas-tunnel, which does not match the current console agent-bridge. Regenerate the plan before applying it.",
    );
    expect(mismatchJson).toContain("arthas-tunnel");
    expect(mismatchJson).toContain("agent-bridge");
    expect(mismatchJson).not.toContain("AI 计划的诊断 transport");

    await act(async () => {
      registeredApplyDiagnosticPlanHandler({
        detail: {
          targetTabId: "tab-1",
          plan: {
            transport: "agent-bridge",
            command: "dashboard",
            reason: "raw AI reason",
          },
        },
      });
    });
    expect(message.success).toHaveBeenCalledWith(
      "AI diagnostic plan filled into the console",
    );
    expect(mockState.setJVMDiagnosticDraft).toHaveBeenCalledWith("tab-1", {
      command: "dashboard",
      reason: "raw AI reason",
      source: "ai-plan",
    });

    (globalThis as any).window.go.app.App = {
      ...mockBackendApp,
      JVMExecuteDiagnosticCommand: undefined,
    };
    const unavailableRenderer = await createConsoleWithLanguage("en-US", {
      ...baseState,
      jvmDiagnosticDrafts: {
        "tab-1": {
          sessionId: "session-1",
          command: "thread -n 5",
        },
      },
    });
    const executeButton = unavailableRenderer.root
      .findAllByType("button")
      .find((button: any) => button.children.includes("Execute command"));
    await act(async () => {
      executeButton.props.onClick();
    });
    expect(JSON.stringify(unavailableRenderer.toJSON())).toContain(
      "JVMExecuteDiagnosticCommand backend method is unavailable",
    );

    let resolveCommand: (value: any) => void = () => {};
    mockBackendApp.JVMExecuteDiagnosticCommand.mockReturnValue(
      new Promise((resolve) => {
        resolveCommand = resolve;
      }),
    );
    (globalThis as any).window.go.app.App = {
      ...mockBackendApp,
      JVMCancelDiagnosticCommand: undefined,
    };
    const cancelRenderer = await createConsoleWithLanguage("en-US", {
      ...baseState,
      jvmDiagnosticDrafts: {
        "tab-1": {
          sessionId: "session-1",
          command: "thread -n 5",
        },
      },
    });
    const cancelExecuteButton = cancelRenderer.root
      .findAllByType("button")
      .find((button: any) => button.children.includes("Execute command"));
    await act(async () => {
      cancelExecuteButton.props.onClick();
    });
    const cancelButton = cancelRenderer.root
      .findAllByType("button")
      .find((button: any) => button.children.includes("Cancel command"));
    await act(async () => {
      cancelButton.props.onClick();
      resolveCommand({ success: true });
    });
    expect(JSON.stringify(cancelRenderer.toJSON())).toContain(
      "JVMCancelDiagnosticCommand backend method is unavailable",
    );
  });

  it("localizes successful cancel request message in en-US", async () => {
    let resolveCommand: (value: any) => void = () => {};
    mockBackendApp.JVMExecuteDiagnosticCommand.mockReturnValue(
      new Promise((resolve) => {
        resolveCommand = resolve;
      }),
    );
    mockBackendApp.JVMCancelDiagnosticCommand.mockResolvedValueOnce({
      success: true,
    });
    const renderer = await createConsoleWithLanguage("en-US", {
      ...baseState,
      jvmDiagnosticDrafts: {
        "tab-1": {
          sessionId: "session-1",
          command: "thread -n 5",
        },
      },
    });

    const executeButton = renderer.root
      .findAllByType("button")
      .find((button: any) => button.children.includes("Execute command"));
    await act(async () => {
      executeButton.props.onClick();
    });
    const cancelButton = renderer.root
      .findAllByType("button")
      .find((button: any) => button.children.includes("Cancel command"));
    await act(async () => {
      cancelButton.props.onClick();
    });

    expect(message.info).toHaveBeenCalledWith("Cancel request sent");
    expect(message.info).not.toHaveBeenCalledWith("已发送取消请求");

    await act(async () => {
      resolveCommand({ success: true });
    });
  });

  it("redacts sensitive diagnostic output in the rendered console", () => {
    mockState = {
      ...baseState,
      jvmDiagnosticDrafts: {
        "tab-1": {
          sessionId: "session-1",
          command: "watch com.foo.SecretService read '{returnObj}'",
        },
      },
      jvmDiagnosticOutputs: {
        "tab-1": [
          {
            sessionId: "session-1",
            commandId: "cmd-1",
            event: "diagnostic",
            phase: "running",
            content: "password=secret-token\napiKey: api-key-secret",
          },
        ],
      },
    };

    const markup = renderConsoleWithLanguage("zh-CN", mockState);

    expect(markup).toContain("password=********");
    expect(markup).toContain("apiKey: ********");
    expect(markup).not.toContain("secret-token");
    expect(markup).not.toContain("api-key-secret");
  });

  it("uses the same styled editor shell and registers command completion before mount", () => {
    mockState = {
      ...mockState,
      jvmDiagnosticDrafts: {
        "tab-1": {
          sessionId: "session-1",
          command: "thr",
          reason: "排查 CPU 线程",
        },
      },
    };

    const markup = renderConsoleWithLanguage("zh-CN", mockState);

    expect(markup).toContain(
      'data-jvm-diagnostic-command-editor-shell="true"',
    );
    expect(markup).toContain('data-before-mount="true"');
    expect(markup).toContain("border-radius:14px");
    expect(registeredCompletionProvider).toBeTruthy();

    const result = registeredCompletionProvider.provideCompletionItems(
      {
        getValueInRange: () => "thr",
        getWordUntilPosition: () => ({ startColumn: 1, endColumn: 4 }),
      },
      { lineNumber: 1, column: 4 },
    );

    expect(result.suggestions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "thread",
          insertText: "thread ",
        }),
      ]),
    );
  });

  it("redacts failed diagnostic event content before storing and alerting", async () => {
    mockState = {
      ...mockState,
      jvmDiagnosticDrafts: {
        "tab-1": {
          sessionId: "session-1",
          command: "thread -n 5",
        },
      },
    };

    let renderer: any;
    renderer = await createConsoleWithLanguage("zh-CN", mockState);

    await act(async () => {
      registeredDiagnosticChunkHandler({
        tabId: "tab-1",
        chunk: {
          sessionId: "session-1",
          commandId: "cmd-1",
          event: "diagnostic",
          phase: "running",
          content: "PRIVATE_KEY=-----BEGIN PRIVATE KEY-----\nabc123",
        },
      });
      registeredDiagnosticChunkHandler({
        tabId: "tab-1",
        chunk: {
          sessionId: "session-1",
          commandId: "cmd-1",
          event: "diagnostic",
          phase: "failed",
          content: "def456\n-----END PRIVATE KEY-----",
        },
      });
    });

    const appendedChunks = mockState.appendJVMDiagnosticOutput.mock.calls.flatMap(
      (call: any[]) => call[1],
    );
    expect(JSON.stringify(appendedChunks)).not.toContain("abc123");
    expect(JSON.stringify(appendedChunks)).not.toContain("def456");
    expect(JSON.stringify(renderer.toJSON())).not.toContain("def456");
  });

  it("redacts successful diagnostic warning messages", async () => {
    mockState = {
      ...mockState,
      jvmDiagnosticDrafts: {
        "tab-1": {
          sessionId: "session-1",
          command: "thread -n 5",
        },
      },
    };
    mockBackendApp.JVMExecuteDiagnosticCommand.mockResolvedValue({
      success: true,
      message: "api_key=query-secret",
    });

    await createConsoleWithLanguage("zh-CN", mockState);

    await act(async () => {
      mockEditor.addCommand.mock.calls[0][1]();
    });

    expect(message.warning).toHaveBeenCalledWith("api_key=********");
    expect(message.warning).not.toHaveBeenCalledWith(
      expect.stringContaining("query-secret"),
    );
  });

  it("redacts successful diagnostic warning messages with the active diagnostic stream state", async () => {
    mockState = {
      ...mockState,
      jvmDiagnosticDrafts: {
        "tab-1": {
          sessionId: "session-1",
          command: "thread -n 5",
        },
      },
    };
    let resolveCommand: (value: any) => void = () => {};
    mockBackendApp.JVMExecuteDiagnosticCommand.mockReturnValue(
      new Promise((resolve) => {
        resolveCommand = resolve;
      }),
    );

    await createConsoleWithLanguage("zh-CN", mockState);

    await act(async () => {
      mockEditor.addCommand.mock.calls[0][1]();
    });

    const executeRequest = mockBackendApp.JVMExecuteDiagnosticCommand.mock.calls[0][2];
    await act(async () => {
      registeredDiagnosticChunkHandler({
        tabId: "tab-1",
        chunk: {
          sessionId: executeRequest.sessionId,
          commandId: executeRequest.commandId,
          event: "diagnostic",
          phase: "running",
          content: "PRIVATE_KEY=-----BEGIN PRIVATE KEY-----\nabc123",
        },
      });
    });

    await act(async () => {
      resolveCommand({
        success: true,
        message: "def456\n-----END PRIVATE KEY-----",
      });
    });

    expect(JSON.stringify((message.warning as any).mock.calls)).not.toContain(
      "def456",
    );
  });

  it("keeps diagnostic redaction state after clearing visible output", async () => {
    mockState = {
      ...mockState,
      jvmDiagnosticDrafts: {
        "tab-1": {
          sessionId: "session-1",
          command: "thread -n 5",
        },
      },
    };

    let renderer: any;
    renderer = await createConsoleWithLanguage("zh-CN", mockState);

    await act(async () => {
      registeredDiagnosticChunkHandler({
        tabId: "tab-1",
        chunk: {
          sessionId: "session-1",
          commandId: "cmd-1",
          event: "diagnostic",
          phase: "running",
          content: "PRIVATE_KEY=-----BEGIN PRIV",
        },
      });
    });

    const clearButton = renderer.root
      .findAllByType("button")
      .find((button: any) => button.children.includes("清空输出"));
    await act(async () => {
      clearButton.props.onClick();
    });

    await act(async () => {
      registeredDiagnosticChunkHandler({
        tabId: "tab-1",
        chunk: {
          sessionId: "session-1",
          commandId: "cmd-1",
          event: "diagnostic",
          phase: "failed",
          content: "ATE KEY-----\nabc123\n-----END PRIVATE KEY-----",
        },
      });
    });

    const appendedChunks = mockState.appendJVMDiagnosticOutput.mock.calls.flatMap(
      (call: any[]) => call[1],
    );
    expect(mockState.clearJVMDiagnosticOutput).toHaveBeenCalledWith("tab-1");
    expect(JSON.stringify(appendedChunks)).not.toContain("ATE KEY");
    expect(JSON.stringify(appendedChunks)).not.toContain("abc123");
  });

  it("redacts frontend fallback errors with the active diagnostic stream state", async () => {
    mockState = {
      ...mockState,
      jvmDiagnosticDrafts: {
        "tab-1": {
          sessionId: "session-1",
          command: "thread -n 5",
        },
      },
    };
    let rejectCommand: (error: Error) => void = () => {};
    mockBackendApp.JVMExecuteDiagnosticCommand.mockReturnValue(
      new Promise((_resolve, reject) => {
        rejectCommand = reject;
      }),
    );

    await createConsoleWithLanguage("zh-CN", mockState);

    await act(async () => {
      mockEditor.addCommand.mock.calls[0][1]();
    });

    const executeRequest = mockBackendApp.JVMExecuteDiagnosticCommand.mock.calls[0][2];
    await act(async () => {
      registeredDiagnosticChunkHandler({
        tabId: "tab-1",
        chunk: {
          sessionId: executeRequest.sessionId,
          commandId: executeRequest.commandId,
          event: "diagnostic",
          phase: "running",
          content: "PRIVATE_KEY=-----BEGIN PRIVATE KEY-----\nabc123",
        },
      });
    });

    await act(async () => {
      rejectCommand(new Error("def456\n-----END PRIVATE KEY-----"));
    });

    const appendedChunks = mockState.appendJVMDiagnosticOutput.mock.calls.flatMap(
      (call: any[]) => call[1],
    );
    expect(JSON.stringify(appendedChunks)).not.toContain("abc123");
    expect(JSON.stringify(appendedChunks)).not.toContain("def456");
  });

  it("keeps diagnostic redaction state after local completion fallback", async () => {
    mockState = {
      ...mockState,
      jvmDiagnosticDrafts: {
        "tab-1": {
          sessionId: "session-1",
          command: "thread -n 5",
        },
      },
    };
    let resolveCommand: (value: any) => void = () => {};
    mockBackendApp.JVMExecuteDiagnosticCommand.mockReturnValue(
      new Promise((resolve) => {
        resolveCommand = resolve;
      }),
    );

    await createConsoleWithLanguage("zh-CN", mockState);

    await act(async () => {
      mockEditor.addCommand.mock.calls[0][1]();
    });

    const executeRequest = mockBackendApp.JVMExecuteDiagnosticCommand.mock.calls[0][2];
    await act(async () => {
      registeredDiagnosticChunkHandler({
        tabId: "tab-1",
        chunk: {
          sessionId: executeRequest.sessionId,
          commandId: executeRequest.commandId,
          event: "diagnostic",
          phase: "running",
          content: "PRIVATE_KEY=-----BEGIN PRIVATE KEY-----\nabc123",
        },
      });
    });

    await act(async () => {
      resolveCommand({ success: true });
    });

    await act(async () => {
      registeredDiagnosticChunkHandler({
        tabId: "tab-1",
        chunk: {
          sessionId: executeRequest.sessionId,
          commandId: executeRequest.commandId,
          event: "diagnostic",
          phase: "completed",
          content: "def456\n-----END PRIVATE KEY-----",
        },
      });
    });

    const appendedChunks = mockState.appendJVMDiagnosticOutput.mock.calls.flatMap(
      (call: any[]) => call[1],
    );
    expect(JSON.stringify(appendedChunks)).not.toContain("abc123");
    expect(JSON.stringify(appendedChunks)).not.toContain("def456");
  });

  it("redacts terminal-seen execute errors with the active diagnostic stream state", async () => {
    mockState = {
      ...mockState,
      jvmDiagnosticDrafts: {
        "tab-1": {
          sessionId: "session-1",
          command: "thread -n 5",
        },
      },
    };
    let rejectCommand: (error: Error) => void = () => {};
    mockBackendApp.JVMExecuteDiagnosticCommand.mockReturnValue(
      new Promise((_resolve, reject) => {
        rejectCommand = reject;
      }),
    );

    let renderer: any;
    renderer = await createConsoleWithLanguage("zh-CN", mockState);

    await act(async () => {
      mockEditor.addCommand.mock.calls[0][1]();
    });

    const executeRequest = mockBackendApp.JVMExecuteDiagnosticCommand.mock.calls[0][2];
    await act(async () => {
      registeredDiagnosticChunkHandler({
        tabId: "tab-1",
        chunk: {
          sessionId: executeRequest.sessionId,
          commandId: executeRequest.commandId,
          event: "diagnostic",
          phase: "running",
          content: "PRIVATE_KEY=-----BEGIN PRIVATE KEY-----\nabc123",
        },
      });
      registeredDiagnosticChunkHandler({
        tabId: "tab-1",
        chunk: {
          sessionId: executeRequest.sessionId,
          commandId: executeRequest.commandId,
          event: "diagnostic",
          phase: "completed",
          content: "still waiting for execute call",
        },
      });
    });

    await act(async () => {
      rejectCommand(new Error("def456\n-----END PRIVATE KEY-----"));
    });

    expect(JSON.stringify(renderer.toJSON())).not.toContain("def456");
  });

  it("redacts execute errors after a real failed terminal event closes the active PEM stream", async () => {
    mockState = {
      ...mockState,
      jvmDiagnosticDrafts: {
        "tab-1": {
          sessionId: "session-1",
          command: "thread -n 5",
        },
      },
    };
    let rejectCommand: (error: Error) => void = () => {};
    mockBackendApp.JVMExecuteDiagnosticCommand.mockReturnValue(
      new Promise((_resolve, reject) => {
        rejectCommand = reject;
      }),
    );

    let renderer: any;
    renderer = await createConsoleWithLanguage("zh-CN", mockState);

    await act(async () => {
      mockEditor.addCommand.mock.calls[0][1]();
    });

    const executeRequest = mockBackendApp.JVMExecuteDiagnosticCommand.mock.calls[0][2];
    await act(async () => {
      registeredDiagnosticChunkHandler({
        tabId: "tab-1",
        chunk: {
          sessionId: executeRequest.sessionId,
          commandId: executeRequest.commandId,
          event: "diagnostic",
          phase: "running",
          content: "PRIVATE_KEY=-----BEGIN PRIVATE KEY-----\nabc123",
        },
      });
      registeredDiagnosticChunkHandler({
        tabId: "tab-1",
        chunk: {
          sessionId: executeRequest.sessionId,
          commandId: executeRequest.commandId,
          event: "diagnostic",
          phase: "failed",
          content: "def456\n-----END PRIVATE KEY-----",
        },
      });
    });

    await act(async () => {
      rejectCommand(new Error("def456\n-----END PRIVATE KEY-----"));
    });

    expect(JSON.stringify(renderer.toJSON())).not.toContain("def456");
  });

  it("redacts delayed failed terminal events after frontend fallback closes the active PEM stream", async () => {
    mockState = {
      ...mockState,
      jvmDiagnosticDrafts: {
        "tab-1": {
          sessionId: "session-1",
          command: "thread -n 5",
        },
      },
    };
    let rejectCommand: (error: Error) => void = () => {};
    mockBackendApp.JVMExecuteDiagnosticCommand.mockReturnValue(
      new Promise((_resolve, reject) => {
        rejectCommand = reject;
      }),
    );

    await createConsoleWithLanguage("zh-CN", mockState);

    await act(async () => {
      mockEditor.addCommand.mock.calls[0][1]();
    });

    const executeRequest = mockBackendApp.JVMExecuteDiagnosticCommand.mock.calls[0][2];
    await act(async () => {
      registeredDiagnosticChunkHandler({
        tabId: "tab-1",
        chunk: {
          sessionId: executeRequest.sessionId,
          commandId: executeRequest.commandId,
          event: "diagnostic",
          phase: "running",
          content: "PRIVATE_KEY=-----BEGIN PRIVATE KEY-----\nabc123",
        },
      });
    });

    await act(async () => {
      rejectCommand(new Error("def456\n-----END PRIVATE KEY-----"));
    });

    await act(async () => {
      registeredDiagnosticChunkHandler({
        tabId: "tab-1",
        chunk: {
          sessionId: executeRequest.sessionId,
          commandId: executeRequest.commandId,
          event: "diagnostic",
          phase: "failed",
          content: "def456\n-----END PRIVATE KEY-----",
        },
      });
    });

    const appendedChunks = mockState.appendJVMDiagnosticOutput.mock.calls.flatMap(
      (call: any[]) => call[1],
    );
    expect(JSON.stringify(appendedChunks)).not.toContain("abc123");
    expect(JSON.stringify(appendedChunks)).not.toContain("def456");
  });
});
