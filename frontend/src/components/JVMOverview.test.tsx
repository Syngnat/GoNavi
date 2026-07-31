import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { t } from "../i18n";
import { I18nProvider } from "../i18n/provider";
import type { LanguagePreference } from "../i18n/types";
import JVMOverview from "./JVMOverview";

vi.mock("../../wailsjs/go/app/App", () => ({
  JVMProbeCapabilities: vi.fn(),
}));

const mockState = {
  connections: [] as any[],
  theme: "light",
};

vi.mock("../store", () => ({
  useStore: (selector: (state: any) => any) =>
    selector({
      connections: mockState.connections,
      theme: mockState.theme,
    }),
}));

const renderWithI18n = (node: React.ReactNode, preference: LanguagePreference = "en-US") => (
  <I18nProvider
    preference={preference}
    systemLanguages={[preference]}
    onPreferenceChange={vi.fn()}
  >
    {node}
  </I18nProvider>
);

const overviewTab = {
  id: "tab-jvm-overview",
  type: "jvm-overview",
  title: "[orders-jvm] JVM 概览",
  connectionId: "conn-jvm-1",
  providerMode: "jmx",
} as any;

beforeEach(() => {
  mockState.connections = [
    {
      id: "conn-jvm-1",
      name: "orders-jvm",
      config: {
        host: "localhost",
        port: 10990,
        jvm: {
          preferredMode: "jmx",
          allowedModes: ["jmx", "endpoint", "agent"],
          readOnly: true,
          environment: "dev",
          endpoint: {
            enabled: true,
            baseUrl: "",
          },
          agent: {
            enabled: false,
            baseUrl: "",
          },
        },
      },
    },
  ];
  mockState.theme = "light";
});

describe("JVMOverview", () => {
  it("renders a localized en-US JVM workspace overview shell", () => {
    const markup = renderToStaticMarkup(
      renderWithI18n(<JVMOverview tab={overviewTab} />),
    );

    expect(markup).toContain('data-jvm-workspace-shell="true"');
    expect(markup).toContain('data-jvm-workspace-hero="true"');
    [
      t("jvm_overview.eyebrow", undefined, "en-US"),
      t("jvm_overview.title", undefined, "en-US"),
      t("jvm_overview.badge.read_only", undefined, "en-US"),
      t("jvm_overview.card.connection_summary", undefined, "en-US"),
      t("jvm_overview.card.mode_capability", undefined, "en-US"),
      t("jvm_overview.field.current_mode", undefined, "en-US"),
      t("jvm_overview.field.allowed_modes", undefined, "en-US"),
      t("jvm_overview.field.jmx_address", undefined, "en-US"),
      t("jvm_overview.field.endpoint", undefined, "en-US"),
      t("jvm_overview.field.agent", undefined, "en-US"),
      t("jvm_overview.field.resource_browse", undefined, "en-US"),
      t("jvm_overview.value.enabled", undefined, "en-US"),
      t("jvm_overview.value.not_configured", undefined, "en-US"),
      t("jvm_overview.value.resource_browse_lazy_load", undefined, "en-US"),
    ].forEach((snippet) => {
      expect(markup).toContain(snippet);
    });
    expect(markup).toContain("JMX, Endpoint, Agent");
    expect(markup).toContain("orders-jvm");
    expect(markup).toContain("localhost:10990");
    expect(markup).toContain("Endpoint");
    expect(markup).toContain("Agent");

    [
      "JVM 运行时概览",
      "只读连接",
      "连接摘要",
      "模式能力",
      "当前模式",
      "允许模式",
      "JMX 地址",
      "资源浏览",
      "已启用",
      "未配置",
      "通过侧边栏展开模式节点后懒加载",
      "JMX、Endpoint、Agent",
    ].forEach((snippet) => {
      expect(markup).not.toContain(snippet);
    });
  });

  it("renders the missing connection empty state in en-US", () => {
    mockState.connections = [];

    const markup = renderToStaticMarkup(
      renderWithI18n(<JVMOverview tab={overviewTab} />),
    );

    expect(markup).toContain(
      t("jvm_overview.connection_missing.message", undefined, "en-US"),
    );
    expect(markup).not.toContain("连接不存在或已被删除");
  });
});
