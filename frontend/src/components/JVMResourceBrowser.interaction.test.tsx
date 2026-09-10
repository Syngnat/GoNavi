import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import JVMResourceBrowser from "./JVMResourceBrowser";
import type { JVMValueSnapshot } from "../types";
import {
  getCurrentLanguage,
  setCurrentLanguage,
  t as translate,
} from "../i18n";
import { I18nProvider } from "../i18n/provider";

const storeState = vi.hoisted(() => ({
  connections: [
    {
      id: "conn-jvm-writable",
      name: "orders-jvm",
      config: {
        host: "127.0.0.1",
        user: "jmx-user",
        port: 9010,
        type: "jvm",
        jvm: {
          preferredMode: "jmx",
          readOnly: false,
          jmx: {
            password: "initial-jmx-secret",
          },
        },
      },
    },
  ],
  addTab: vi.fn(),
  aiPanelVisible: false,
  setAIPanelVisible: vi.fn(),
  theme: "light",
  fontSize: 14,
  appearance: {
    dataTableFontSize: 14,
    dataTableFontSizeFollowGlobal: true,
    customMonoFontFamily: "",
  },
}));

const backendApp = vi.hoisted(() => ({
  JVMGetValue: vi.fn(),
  JVMPreviewChange: vi.fn(),
  JVMApplyChange: vi.fn(),
}));

vi.mock("./MonacoEditor", () => ({
  default: ({ value }: { value?: string }) => <pre>{value}</pre>,
}));

vi.mock("@ant-design/icons", () => ({
  FileSearchOutlined: () => <span />,
  ReloadOutlined: () => <span />,
  RobotOutlined: () => <span />,
}));

vi.mock("antd", () => {
  const Text = ({ children }: any) => <span>{children}</span>;
  const Button = ({ children, disabled, loading, onClick, type, ...rest }: any) => (
    <button
      type="button"
      data-button-type={type}
      disabled={disabled || loading}
      onClick={onClick}
      {...rest}
    >
      {children}
    </button>
  );
  const Card = ({ children, title }: any) => (
    <section>
      <h2>{title}</h2>
      {children}
    </section>
  );
  const Descriptions: any = ({ children }: any) => <dl>{children}</dl>;
  Descriptions.Item = ({ children, label }: any) => (
    <div>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
  const Input: any = ({ value, onChange, placeholder }: any) => (
    <input value={value} onChange={onChange} placeholder={placeholder} />
  );
  Input.TextArea = ({ value, onChange }: any) => (
    <textarea value={value} onChange={onChange} />
  );

  return {
    Alert: ({ message }: any) => <div role="alert">{message}</div>,
    Button,
    Card,
    Descriptions,
    Empty: ({ description }: any) => <div>{description}</div>,
    Input,
    Skeleton: () => <div>loading</div>,
    Space: ({ children }: any) => <div>{children}</div>,
    Tag: ({ children }: any) => <span>{children}</span>,
    Typography: { Text },
  };
});

vi.mock("../store", () => {
  const useStore = (selector: (state: typeof storeState) => any) => selector(storeState);
  useStore.getState = () => storeState;
  return { useStore };
});

vi.mock("./jvm/JVMModeBadge", () => ({
  default: ({ mode }: { mode: string }) => <span>{mode}</span>,
}));

vi.mock("./jvm/JVMWorkspaceLayout", () => ({
  getJVMWorkspaceCardStyle: () => ({}),
  JVMWorkspaceHero: ({ actions, badges, description, title }: any) => (
    <header>
      <h1>{title}</h1>
      {description}
      {badges}
      {actions}
    </header>
  ),
  JVMWorkspaceShell: ({ children }: any) => <main>{children}</main>,
}));

vi.mock("./jvm/JVMChangePreviewModal", () => ({
  default: ({ open, onConfirm }: any) =>
    open ? <button type="button" onClick={onConfirm}>确认执行</button> : null,
}));

const writableTab = {
  id: "tab-jvm-resource",
  type: "jvm-resource",
  title: "[orders-jvm] JVM 资源",
  connectionId: "conn-jvm-writable",
  providerMode: "jmx",
  resourcePath: "jmx:/attribute/app/Mode",
  resourceKind: "attribute",
} as any;

const textContent = (node: any): string =>
  (node.children || [])
    .map((item: any) => (typeof item === "string" ? item : textContent(item)))
    .join("");

const findButton = (renderer: ReactTestRenderer, text: string) =>
  renderer.root.findAll((node) => node.type === "button" && textContent(node).includes(text))[0];

const waitForEffects = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

const emitJVMApplyAIPlan = async (detail: any) => {
  const eventListeners = (window.addEventListener as any).mock.calls.filter(
    ([eventName]: [string]) => eventName === "gonavi:jvm-apply-ai-plan",
  );
  const handler = eventListeners[eventListeners.length - 1]?.[1] as
    | EventListener
    | undefined;
  expect(handler).toBeTruthy();
  await act(async () => {
    handler!(new CustomEvent("gonavi:jvm-apply-ai-plan", { detail }));
  });
};

const renderWithI18n = (
  tab: typeof writableTab,
  language: "zh-CN" | "en-US",
) => (
  <I18nProvider
    preference={language}
    systemLanguages={[]}
    onPreferenceChange={vi.fn()}
  >
    <JVMResourceBrowser tab={tab} />
  </I18nProvider>
);

describe("JVMResourceBrowser interactions", () => {
  let previousLanguage = getCurrentLanguage();

  beforeEach(() => {
    previousLanguage = getCurrentLanguage();
    setCurrentLanguage("zh-CN");

    storeState.connections = [
      {
        id: "conn-jvm-writable",
        name: "orders-jvm",
        config: {
          host: "127.0.0.1",
          user: "jmx-user",
          port: 9010,
          type: "jvm",
          jvm: {
            preferredMode: "jmx",
            readOnly: false,
            jmx: {
              password: "initial-jmx-secret",
            },
          },
        },
      },
    ];

    const snapshot: JVMValueSnapshot = {
      resourceId: "jmx:/attribute/app/Mode",
      kind: "attribute",
      format: "string",
      version: "v1",
      value: "cold",
      supportedActions: [
        {
          action: "set",
          label: "设置属性",
          payloadExample: { value: "warm" },
        },
      ],
    };

    backendApp.JVMGetValue.mockResolvedValue({ success: true, data: snapshot });
    backendApp.JVMPreviewChange.mockResolvedValue({
      allowed: true,
      requiresConfirmation: true,
      confirmationToken: "token-from-preview",
      summary: "设置 Mode",
      riskLevel: "high",
      before: snapshot,
      after: { ...snapshot, value: "warm", version: "v2" },
    });
    backendApp.JVMApplyChange.mockResolvedValue({
      success: true,
      data: {
        status: "applied",
        updatedValue: { ...snapshot, value: "warm", version: "v2" },
      },
    });

    vi.stubGlobal("window", {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
      go: {
        app: {
          App: backendApp,
        },
      },
    });
  });

  afterEach(() => {
    setCurrentLanguage(previousLanguage);
    backendApp.JVMGetValue.mockReset();
    backendApp.JVMPreviewChange.mockReset();
    backendApp.JVMApplyChange.mockReset();
    vi.unstubAllGlobals();
  });

  it("localizes resource snapshot and draft form chrome without translating raw values", async () => {
    setCurrentLanguage("en-US");

    backendApp.JVMGetValue.mockResolvedValueOnce({
      success: true,
      data: {
        resourceId: "jmx:/attribute/app/Mode",
        kind: "attribute",
        format: "string",
        version: "v1",
        value: "cold",
        metadata: {
          source: "runtime",
        },
        supportedActions: [
          {
            action: "set",
            label: "设置属性",
            description: "运行时原始说明",
            payloadExample: { value: "warm" },
            payloadFields: [
              { name: "value", required: true },
              { name: "ttlSeconds" },
            ],
          },
        ],
      } as JVMValueSnapshot,
    });

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<JVMResourceBrowser tab={writableTab} />);
    });
    await waitForEffects();

    const text = textContent(renderer!.root);
    expect(text).toContain("JVM Resource Workbench");
    expect(text).toContain("Writable connection");
    expect(findButton(renderer!, "Refresh")).toBeTruthy();
    expect(findButton(renderer!, "Audit log")).toBeTruthy();
    expect(findButton(renderer!, "Generate AI plan")).toBeTruthy();
    expect(text).toContain("Resource snapshot");
    expect(text).toContain("Resource ID");
    expect(text).toContain("Resource type");
    expect(text).toContain("Format");
    expect(text).toContain("Version");
    expect(text).toContain("Available actions");
    expect(text).toContain("Resource value");
    expect(text).toContain("Metadata");
    expect(text).toContain("Change draft");
    expect(text).toContain("Resource path");
    expect(text).toContain("Target resource");
    expect(text).toContain("Resource version");
    expect(text).toContain("Draft source");
    expect(text).toContain("Manual edit");
    expect(text).toContain("Supported resource actions");
    expect(text).toContain("Payload fields: value (required), ttlSeconds");
    expect(text).toContain("Action");
    expect(text).toContain("Current action: 设置属性");
    expect(text).toContain("Change reason");
    expect(text).toContain("Payload (JSON)");
    expect(text).toContain("Preview uses the current draft.");
    expect(text).toContain(
      "A recommended template has been filled for the current action.",
    );
    expect(text).toContain("jmx:/attribute/app/Mode");
    expect(text).toContain("attribute");
    expect(text).toContain("string");
    expect(text).toContain("v1");
    expect(text).toContain("cold");
    expect(text).toContain("设置属性");
    expect(text).toContain("运行时原始说明");
    expect(
      renderer!.root.findAllByType("input").some(
        (item) => item.props.placeholder === "For example, set or invoke",
      ),
    ).toBe(true);
    expect(
      renderer!.root.findAllByType("input").some(
        (item) =>
          item.props.placeholder ===
          "Enter the reason for this JVM resource change",
      ),
    ).toBe(true);
    expect(findButton(renderer!, "Preview change")).toBeTruthy();
    expect(findButton(renderer!, "Ask AI for a plan")).toBeTruthy();

    backendApp.JVMGetValue.mockResolvedValueOnce({ success: true, data: null });
    await act(async () => {
      renderer!.unmount();
      renderer = create(<JVMResourceBrowser tab={writableTab} />);
    });
    await waitForEffects();

    expect(textContent(renderer!.root)).toContain("No resource data");

    storeState.connections = [
      {
        ...storeState.connections[0],
        config: {
          ...storeState.connections[0].config,
          jvm: {
            ...storeState.connections[0].config.jvm,
            readOnly: true,
          },
        },
      },
    ];
    await act(async () => {
      renderer!.unmount();
      renderer = create(<JVMResourceBrowser tab={writableTab} />);
    });
    await waitForEffects();

    expect(textContent(renderer!.root)).toContain("Read-only connection");
  });

  it("localizes JVM resource load error chrome without leaking raw backend detail", async () => {
    setCurrentLanguage("en-US");

    storeState.connections = [];
    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<JVMResourceBrowser tab={writableTab} />);
    });
    expect(textContent(renderer!.root)).toContain(
      "The connection does not exist or has been deleted.",
    );

    storeState.connections = [
      {
        id: "conn-jvm-writable",
        name: "orders-jvm",
        config: {
          host: "127.0.0.1",
          user: "jmx-user",
          port: 9010,
          type: "jvm",
          jvm: {
            preferredMode: "jmx",
            readOnly: false,
            jmx: {
              password: "initial-jmx-secret",
            },
          },
        },
      },
    ];
    vi.stubGlobal("window", {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
      go: {
        app: {
          App: {},
        },
      },
    });
    await act(async () => {
      renderer!.unmount();
      renderer = create(<JVMResourceBrowser tab={writableTab} />);
    });
    await waitForEffects();
    expect(textContent(renderer!.root)).toContain(
      "JVM value reading is not available in this build.",
    );

    vi.stubGlobal("window", {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
      go: {
        app: {
          App: backendApp,
        },
      },
    });
    backendApp.JVMGetValue.mockResolvedValueOnce({ success: false });
    await act(async () => {
      renderer!.unmount();
      renderer = create(<JVMResourceBrowser tab={writableTab} />);
    });
    await waitForEffects();
    expect(textContent(renderer!.root)).toContain("Failed to read JVM resource.");

    backendApp.JVMGetValue.mockResolvedValueOnce({
      success: false,
      message: "raw backend boom",
    });
    await act(async () => {
      renderer!.unmount();
      renderer = create(<JVMResourceBrowser tab={writableTab} />);
    });
    await waitForEffects();

    const text = textContent(renderer!.root);
    expect(text).toContain("Failed to read JVM resource.");
    expect(text).not.toContain("raw backend boom");
  });

  it("refreshes fallback JVM resource load errors after provider locale changes", async () => {
    setCurrentLanguage("en-US");
    backendApp.JVMGetValue
      .mockResolvedValueOnce({ success: false })
      .mockResolvedValueOnce({ success: false });

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(renderWithI18n(writableTab, "en-US"));
    });
    await waitForEffects();

    expect(textContent(renderer!.root)).toContain(
      translate("jvm_resource.error.read_failed", undefined, "en-US"),
    );

    setCurrentLanguage("zh-CN");
    await act(async () => {
      renderer!.update(renderWithI18n(writableTab, "zh-CN"));
    });
    await waitForEffects();

    const text = textContent(renderer!.root);
    expect(backendApp.JVMGetValue).toHaveBeenCalledTimes(2);
    expect(text).toContain(
      translate("jvm_resource.error.read_failed", undefined, "zh-CN"),
    );
    expect(text).not.toContain(
      translate("jvm_resource.error.read_failed", undefined, "en-US"),
    );
  });

  it("localizes AI-plan import and fill chrome while preserving raw resource ids", async () => {
    setCurrentLanguage("en-US");

    const rawResourceId = "jmx:/attribute/app/Mode-RAW-42";
    const tab = {
      ...writableTab,
      resourcePath: rawResourceId,
    };
    const planContext = {
      targetTabId: tab.id,
      connectionId: tab.connectionId,
      providerMode: tab.providerMode,
      resourcePath: tab.resourcePath,
    };
    const validPlan = {
      targetType: "attribute",
      selector: {
        resourcePath: rawResourceId,
      },
      action: "set",
      payload: {
        format: "json",
        value: { value: "warm" },
      },
      reason: "Keep raw id visible",
    };

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<JVMResourceBrowser tab={tab} />);
    });
    await waitForEffects();

    await emitJVMApplyAIPlan({ plan: validPlan });
    expect(textContent(renderer!.root)).toContain(
      "The AI plan is missing its source context. Regenerate it from the target JVM resource page before applying it.",
    );

    await emitJVMApplyAIPlan({
      plan: validPlan,
      ...planContext,
      connectionId: "conn-other",
    });
    expect(textContent(renderer!.root)).toContain(
      "The current JVM tab does not match the source context of the AI plan, so automatic application was rejected.",
    );

    const fallbackPlan = {
      ...validPlan,
      selector: {
        resourcePath: {
          toString: () => {
            throw null;
          },
        },
      },
    };
    await emitJVMApplyAIPlan({
      plan: fallbackPlan,
      ...planContext,
    });
    expect(textContent(renderer!.root)).toContain(
      "The AI plan cannot be converted into a JVM preview draft right now.",
    );

    const rawErrorPlan = {
      ...validPlan,
      selector: {
        resourcePath: {
          toString: () => {
            throw new Error("raw plan detail");
          },
        },
      },
    };
    await emitJVMApplyAIPlan({
      plan: rawErrorPlan,
      ...planContext,
    });
    expect(textContent(renderer!.root)).toContain(
      "The AI plan cannot be converted into a JVM preview draft right now.",
    );
    expect(textContent(renderer!.root)).not.toContain("raw plan detail");

    await emitJVMApplyAIPlan({
      plan: validPlan,
      ...planContext,
    });
    const text = textContent(renderer!.root);
    expect(text).toContain(
      `The draft was filled from the AI plan for ${rawResourceId}. Preview the change before confirming the write.`,
    );
    expect(text).toContain(rawResourceId);
  });

  it("updates AI-plan listener translations after locale changes", async () => {
    setCurrentLanguage("en-US");

    const rawResourceId = "jmx:/attribute/app/Mode-RAW-42";
    const tab = {
      ...writableTab,
      resourcePath: rawResourceId,
    };
    const planContext = {
      targetTabId: tab.id,
      connectionId: tab.connectionId,
      providerMode: tab.providerMode,
      resourcePath: tab.resourcePath,
    };
    const validPlan = {
      targetType: "attribute",
      selector: {
        resourcePath: rawResourceId,
      },
      action: "set",
      payload: {
        format: "json",
        value: { value: "warm" },
      },
      reason: "Keep raw id visible",
    };

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(renderWithI18n(tab, "en-US"));
    });
    await waitForEffects();
    const firstAIPlanHandler = (window.addEventListener as any).mock.calls.find(
      ([eventName]: [string]) => eventName === "gonavi:jvm-apply-ai-plan",
    )?.[1];
    expect(firstAIPlanHandler).toBeTruthy();

    setCurrentLanguage("zh-CN");
    await act(async () => {
      renderer!.update(renderWithI18n(tab, "zh-CN"));
    });
    await waitForEffects();
    expect(window.removeEventListener).toHaveBeenCalledWith(
      "gonavi:jvm-apply-ai-plan",
      firstAIPlanHandler,
    );

    await emitJVMApplyAIPlan({ plan: validPlan });
    expect(textContent(renderer!.root)).toContain(
      translate("jvm_resource.error.ai_plan_missing_context"),
    );

    await emitJVMApplyAIPlan({
      plan: validPlan,
      ...planContext,
    });
    const text = textContent(renderer!.root);
    expect(text).toContain(
      translate("jvm_resource.message.ai_plan_draft_filled", {
        resourceId: rawResourceId,
      }),
    );
    expect(text).toContain(rawResourceId);
  });

  it("localizes draft preview and apply fallbacks while preserving raw backend messages", async () => {
    setCurrentLanguage("en-US");

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<JVMResourceBrowser tab={writableTab} />);
    });
    await waitForEffects();

    await act(async () => {
      findButton(renderer!, "Preview change").props.onClick();
    });
    expect(textContent(renderer!.root)).toContain(
      translate("jvm_resource.error.reason_required", undefined, "en-US"),
    );
    expect(textContent(renderer!.root)).not.toContain("请填写变更原因");

    vi.stubGlobal("window", {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
      go: {
        app: {
          App: {
            JVMGetValue: backendApp.JVMGetValue,
            JVMApplyChange: backendApp.JVMApplyChange,
          },
        },
      },
    });
    await act(async () => {
      renderer!.unmount();
      renderer = create(<JVMResourceBrowser tab={writableTab} />);
    });
    await waitForEffects();
    await act(async () => {
      renderer!.root
        .findAllByType("input")
        .find(
          (item) =>
            item.props.placeholder ===
            translate("jvm_resource.placeholder.reason", undefined, "en-US"),
        )!
        .props.onChange({ target: { value: "change mode" } });
    });
    await act(async () => {
      findButton(renderer!, "Preview change").props.onClick();
    });
    expect(textContent(renderer!.root)).toContain(
      translate("jvm_resource.error.preview_unavailable", undefined, "en-US"),
    );

    vi.stubGlobal("window", {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
      go: {
        app: {
          App: backendApp,
        },
      },
    });
    backendApp.JVMPreviewChange.mockResolvedValueOnce({ success: false });
    await act(async () => {
      renderer!.unmount();
      renderer = create(<JVMResourceBrowser tab={writableTab} />);
    });
    await waitForEffects();
    await act(async () => {
      renderer!.root
        .findAllByType("input")
        .find(
          (item) =>
            item.props.placeholder ===
            translate("jvm_resource.placeholder.reason", undefined, "en-US"),
        )!
        .props.onChange({ target: { value: "change mode" } });
    });
    await act(async () => {
      findButton(renderer!, "Preview change").props.onClick();
    });
    await waitForEffects();
    expect(textContent(renderer!.root)).toContain(
      translate("jvm_resource.error.preview_failed", undefined, "en-US"),
    );

    backendApp.JVMPreviewChange.mockResolvedValueOnce({
      success: false,
      message: "raw preview backend detail",
    });
    await act(async () => {
      renderer!.unmount();
      renderer = create(<JVMResourceBrowser tab={writableTab} />);
    });
    await waitForEffects();
    await act(async () => {
      renderer!.root
        .findAllByType("input")
        .find(
          (item) =>
            item.props.placeholder ===
            translate("jvm_resource.placeholder.reason", undefined, "en-US"),
        )!
        .props.onChange({ target: { value: "change mode" } });
    });
    await act(async () => {
      findButton(renderer!, "Preview change").props.onClick();
    });
    await waitForEffects();
    const rawPreviewText = textContent(renderer!.root);
    expect(rawPreviewText).toContain("raw preview backend detail");
    expect(rawPreviewText).not.toContain(
      translate("jvm_resource.error.preview_failed", undefined, "en-US"),
    );

    backendApp.JVMPreviewChange.mockRejectedValueOnce(
      new Error("HTTP 500 /system raw preview failure checksum=abc123"),
    );
    await act(async () => {
      renderer!.unmount();
      renderer = create(<JVMResourceBrowser tab={writableTab} />);
    });
    await waitForEffects();
    await act(async () => {
      renderer!.root
        .findAllByType("input")
        .find(
          (item) =>
            item.props.placeholder ===
            translate("jvm_resource.placeholder.reason", undefined, "en-US"),
        )!
        .props.onChange({ target: { value: "change mode" } });
    });
    await act(async () => {
      findButton(renderer!, "Preview change").props.onClick();
    });
    await waitForEffects();
    const thrownPreviewText = textContent(renderer!.root);
    expect(thrownPreviewText).toContain(
      "HTTP 500 /system raw preview failure checksum=abc123",
    );
    expect(thrownPreviewText).not.toContain(
      translate("jvm_resource.error.preview_failed", undefined, "en-US"),
    );

    backendApp.JVMPreviewChange.mockResolvedValueOnce({
      allowed: true,
      requiresConfirmation: true,
      confirmationToken: "token-from-preview",
      summary: "preview ready",
      riskLevel: "low",
    });
    backendApp.JVMApplyChange.mockResolvedValueOnce({
      success: true,
      data: { status: "applied" },
    });
    await act(async () => {
      renderer!.unmount();
      renderer = create(<JVMResourceBrowser tab={writableTab} />);
    });
    await waitForEffects();
    await act(async () => {
      renderer!.root
        .findAllByType("input")
        .find(
          (item) =>
            item.props.placeholder ===
            translate("jvm_resource.placeholder.reason", undefined, "en-US"),
        )!
        .props.onChange({ target: { value: "change mode" } });
    });
    await act(async () => {
      findButton(renderer!, "Preview change").props.onClick();
    });
    await waitForEffects();
    await act(async () => {
      findButton(renderer!, "确认执行").props.onClick();
    });
    await waitForEffects();
    expect(textContent(renderer!.root)).toContain(
      translate("jvm_resource.message.apply_success", undefined, "en-US"),
    );

    backendApp.JVMPreviewChange.mockResolvedValueOnce({
      allowed: true,
      requiresConfirmation: true,
      confirmationToken: "token-from-preview",
      summary: "preview ready",
      riskLevel: "low",
    });
    backendApp.JVMApplyChange.mockResolvedValueOnce({
      success: false,
      message: "HTTP 409 raw apply backend detail resourceId=jmx:/internal",
    });
    await act(async () => {
      renderer!.unmount();
      renderer = create(<JVMResourceBrowser tab={writableTab} />);
    });
    await waitForEffects();
    await act(async () => {
      renderer!.root
        .findAllByType("input")
        .find(
          (item) =>
            item.props.placeholder ===
            translate("jvm_resource.placeholder.reason", undefined, "en-US"),
        )!
        .props.onChange({ target: { value: "change mode" } });
    });
    await act(async () => {
      findButton(renderer!, "Preview change").props.onClick();
    });
    await waitForEffects();
    await act(async () => {
      findButton(renderer!, "确认执行").props.onClick();
    });
    await waitForEffects();
    const rawApplyFailureText = textContent(renderer!.root);
    expect(rawApplyFailureText).toContain(
      "HTTP 409 raw apply backend detail resourceId=jmx:/internal",
    );
    expect(rawApplyFailureText).not.toContain(
      translate("jvm_resource.error.apply_failed", undefined, "en-US"),
    );

    backendApp.JVMPreviewChange.mockResolvedValueOnce({
      allowed: true,
      requiresConfirmation: true,
      confirmationToken: "token-from-preview",
      summary: "preview ready",
      riskLevel: "low",
    });
    backendApp.JVMApplyChange.mockResolvedValueOnce({
      success: true,
      data: {
        status: "applied",
        message: "raw apply result success detail",
      },
      message: "raw top-level apply success detail",
    });
    await act(async () => {
      renderer!.unmount();
      renderer = create(<JVMResourceBrowser tab={writableTab} />);
    });
    await waitForEffects();
    await act(async () => {
      renderer!.root
        .findAllByType("input")
        .find(
          (item) =>
            item.props.placeholder ===
            translate("jvm_resource.placeholder.reason", undefined, "en-US"),
        )!
        .props.onChange({ target: { value: "change mode" } });
    });
    await act(async () => {
      findButton(renderer!, "Preview change").props.onClick();
    });
    await waitForEffects();
    await act(async () => {
      findButton(renderer!, "确认执行").props.onClick();
    });
    await waitForEffects();
    const rawApplySuccessText = textContent(renderer!.root);
    expect(rawApplySuccessText).toContain("raw apply result success detail");
    expect(rawApplySuccessText).not.toContain(
      translate("jvm_resource.message.apply_success", undefined, "en-US"),
    );
  });

  it("applies the latest successful preview request even when the draft is edited afterward", async () => {
    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<JVMResourceBrowser tab={writableTab} />);
    });
    await waitForEffects();

    const reasonInput = renderer!.root
      .findAllByType("input")
      .find((item) => item.props.placeholder === "填写本次 JVM 资源变更原因");
    await act(async () => {
      reasonInput!.props.onChange({ target: { value: "修复运行模式" } });
    });

    const payloadEditor = () => renderer!.root.findByType("textarea");
    await act(async () => {
      payloadEditor().props.onChange({ target: { value: '{"value":"previewed"}' } });
    });

    await act(async () => {
      findButton(renderer!, "预览变更").props.onClick();
    });
    await waitForEffects();

    await act(async () => {
      payloadEditor().props.onChange({ target: { value: '{"value":"edited-after-preview"}' } });
    });

    await act(async () => {
      findButton(renderer!, "确认执行").props.onClick();
    });
    await waitForEffects();

    expect(backendApp.JVMApplyChange).toHaveBeenCalledTimes(1);
    expect(backendApp.JVMApplyChange.mock.calls[0][0]).toBe(
      backendApp.JVMPreviewChange.mock.calls[0][0],
    );
    expect(backendApp.JVMApplyChange.mock.calls[0][1]).toMatchObject({
      action: "set",
      confirmationToken: "token-from-preview",
      payload: { value: "previewed" },
    });
  });

  it("does not let a stale snapshot resource id override the current resource preview", async () => {
    backendApp.JVMGetValue.mockResolvedValueOnce({
      success: true,
      data: {
        resourceId: "jmx:/attribute/app/Mode",
        kind: "attribute",
        format: "string",
        version: "v1",
        value: "cold",
        supportedActions: [
          {
            action: "set",
            label: "设置属性",
            payloadExample: { value: "warm" },
          },
        ],
      } as JVMValueSnapshot,
    });

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<JVMResourceBrowser tab={writableTab} />);
    });
    await waitForEffects();

    await act(async () => {
      renderer!.update(
        <JVMResourceBrowser
          tab={{
            ...writableTab,
            resourcePath: "jmx:/attribute/app/OtherMode",
          }}
        />,
      );
    });

    const reasonInput = renderer!.root
      .findAllByType("input")
      .find((item) => item.props.placeholder === "填写本次 JVM 资源变更原因");
    await act(async () => {
      reasonInput!.props.onChange({ target: { value: "修复运行模式" } });
      renderer!.root.findByType("textarea").props.onChange({
        target: { value: '{"value":"previewed"}' },
      });
    });

    await act(async () => {
      findButton(renderer!, "预览变更").props.onClick();
    });
    await waitForEffects();

    expect(backendApp.JVMPreviewChange.mock.calls[backendApp.JVMPreviewChange.mock.calls.length - 1]?.[1]).toMatchObject({
      resourceId: "jmx:/attribute/app/OtherMode",
    });
  });

  it("ignores stale preview responses after the resource context changes", async () => {
    let resolvePreview: (value: any) => void = () => {};
    backendApp.JVMPreviewChange.mockReturnValueOnce(
      new Promise((resolve) => {
        resolvePreview = resolve;
      }),
    );

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<JVMResourceBrowser tab={writableTab} />);
    });
    await waitForEffects();

    const reasonInput = renderer!.root
      .findAllByType("input")
      .find((item) => item.props.placeholder === "填写本次 JVM 资源变更原因");
    await act(async () => {
      reasonInput!.props.onChange({ target: { value: "修复运行模式" } });
      renderer!.root.findByType("textarea").props.onChange({
        target: { value: '{"value":"previewed"}' },
      });
    });

    await act(async () => {
      findButton(renderer!, "预览变更").props.onClick();
    });

    await act(async () => {
      renderer!.update(
        <JVMResourceBrowser
          tab={{
            ...writableTab,
            resourcePath: "jmx:/attribute/app/OtherMode",
          }}
        />,
      );
      resolvePreview({
        allowed: true,
        requiresConfirmation: true,
        confirmationToken: "stale-token",
        summary: "旧预览",
        riskLevel: "high",
        before: {
          resourceId: "jmx:/attribute/app/Mode",
          kind: "attribute",
          format: "string",
          value: "cold",
        },
        after: {
          resourceId: "jmx:/attribute/app/Mode",
          kind: "attribute",
          format: "string",
          value: "warm",
        },
      });
    });
    await waitForEffects();

    expect(findButton(renderer!, "确认执行")).toBeUndefined();
    expect(backendApp.JVMApplyChange).not.toHaveBeenCalled();
  });

  it("rejects confirming a preview after the resource context changes", async () => {
    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<JVMResourceBrowser tab={writableTab} />);
    });
    await waitForEffects();

    const reasonInput = renderer!.root
      .findAllByType("input")
      .find((item) => item.props.placeholder === "填写本次 JVM 资源变更原因");
    await act(async () => {
      reasonInput!.props.onChange({ target: { value: "修复运行模式" } });
      renderer!.root.findByType("textarea").props.onChange({
        target: { value: '{"value":"previewed"}' },
      });
    });

    await act(async () => {
      findButton(renderer!, "预览变更").props.onClick();
    });
    await waitForEffects();

    await act(async () => {
      renderer!.update(
        <JVMResourceBrowser
          tab={{
            ...writableTab,
            resourcePath: "jmx:/attribute/app/OtherMode",
          }}
        />,
      );
      findButton(renderer!, "确认执行").props.onClick();
    });
    await waitForEffects();

    expect(backendApp.JVMApplyChange).not.toHaveBeenCalled();
  });

  it("rejects confirming a preview after the connection config changes", async () => {
    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<JVMResourceBrowser tab={writableTab} />);
    });
    await waitForEffects();

    const reasonInput = renderer!.root
      .findAllByType("input")
      .find((item) => item.props.placeholder === "填写本次 JVM 资源变更原因");
    await act(async () => {
      reasonInput!.props.onChange({ target: { value: "修复运行模式" } });
      renderer!.root.findByType("textarea").props.onChange({
        target: { value: '{"value":"previewed"}' },
      });
    });

    await act(async () => {
      findButton(renderer!, "预览变更").props.onClick();
    });
    await waitForEffects();

    storeState.connections = [
      {
        ...storeState.connections[0],
        config: {
          ...storeState.connections[0].config,
          jvm: {
            ...storeState.connections[0].config.jvm,
            readOnly: true,
          },
        },
      },
    ];

    await act(async () => {
      renderer!.update(<JVMResourceBrowser tab={writableTab} />);
    });

    const confirmButton = findButton(renderer!, "确认执行");
    if (confirmButton) {
      await act(async () => {
        confirmButton.props.onClick();
      });
    }
    await waitForEffects();

    expect(backendApp.JVMApplyChange).not.toHaveBeenCalled();
  });

  it("rejects confirming a preview after JVM credentials change", async () => {
    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<JVMResourceBrowser tab={writableTab} />);
    });
    await waitForEffects();

    const reasonInput = renderer!.root
      .findAllByType("input")
      .find((item) => item.props.placeholder === "填写本次 JVM 资源变更原因");
    await act(async () => {
      reasonInput!.props.onChange({ target: { value: "修复运行模式" } });
      renderer!.root.findByType("textarea").props.onChange({
        target: { value: '{"value":"previewed"}' },
      });
    });

    await act(async () => {
      findButton(renderer!, "预览变更").props.onClick();
    });
    await waitForEffects();

    storeState.connections = [
      {
        ...storeState.connections[0],
        config: {
          ...storeState.connections[0].config,
          jvm: {
            ...storeState.connections[0].config.jvm,
            jmx: {
              ...storeState.connections[0].config.jvm.jmx,
              password: "rotated-jmx-secret",
            },
          },
        },
      },
    ];

    await act(async () => {
      renderer!.update(<JVMResourceBrowser tab={writableTab} />);
    });

    const confirmButton = findButton(renderer!, "确认执行");
    if (confirmButton) {
      await act(async () => {
        confirmButton.props.onClick();
      });
    }
    await waitForEffects();

    expect(backendApp.JVMApplyChange).not.toHaveBeenCalled();
  });

  it("does not seed sensitive payload examples into the draft editor", async () => {
    backendApp.JVMGetValue.mockResolvedValueOnce({
      success: true,
      data: {
        resourceId: "jmx:/attribute/app/Password",
        kind: "attribute",
        format: "string",
        version: "v1",
        value: "secret-token",
        sensitive: true,
        supportedActions: [
          {
            action: "set",
            label: "设置属性",
            payloadExample: { value: "secret-token" },
          },
        ],
      } as JVMValueSnapshot,
    });

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <JVMResourceBrowser
          tab={{
            ...writableTab,
            resourcePath: "jmx:/attribute/app/Password",
          }}
        />,
      );
    });
    await waitForEffects();

    expect(renderer!.root.findByType("textarea").props.value).not.toContain("secret-token");
  });
});
