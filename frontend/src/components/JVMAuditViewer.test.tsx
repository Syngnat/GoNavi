import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { t } from "../i18n";
import { I18nProvider } from "../i18n/provider";
import type { LanguagePreference } from "../i18n/types";
import JVMAuditViewer from "./JVMAuditViewer";

const mockState = {
  connections: [
    {
      id: "conn-jvm-1",
      name: "orders-jvm",
      config: {
        host: "localhost",
        port: 10990,
        jvm: {
          preferredMode: "endpoint",
          readOnly: false,
        },
      },
    },
  ] as any[],
  theme: "light",
};

const backendApp = {
  JVMListAuditRecords: vi.fn(),
};

vi.mock("../store", () => ({
  useStore: (selector: (state: any) => any) =>
    selector({
      connections: mockState.connections,
      theme: mockState.theme,
    }),
}));

const tab = {
  id: "tab-jvm-audit",
  type: "jvm-audit",
  title: "[orders-jvm] JVM 审计",
  connectionId: "conn-jvm-1",
  providerMode: "endpoint",
} as any;

const renderWithI18n = (node: React.ReactNode, preference: LanguagePreference = "en-US") => (
  <I18nProvider
    preference={preference}
    systemLanguages={[preference]}
    onPreferenceChange={vi.fn()}
  >
    {node}
  </I18nProvider>
);

beforeEach(() => {
  mockState.connections = [
    {
      id: "conn-jvm-1",
      name: "orders-jvm",
      config: {
        host: "localhost",
        port: 10990,
        jvm: {
          preferredMode: "endpoint",
          readOnly: false,
        },
      },
    },
  ];
  mockState.theme = "light";
  backendApp.JVMListAuditRecords.mockReset();
  vi.stubGlobal("window", {
    go: {
      app: {
        App: backendApp,
      },
    },
  });
});

describe("JVMAuditViewer", () => {
  it("renders a localized en-US JVM workspace audit shell", () => {
    const markup = renderToStaticMarkup(
      renderWithI18n(<JVMAuditViewer tab={tab} />),
    );

    expect(markup).toContain('data-jvm-workspace-shell="true"');
    expect(markup).toContain('data-jvm-workspace-hero="true"');
    [
      t("jvm_audit.eyebrow", undefined, "en-US"),
      t("jvm_audit.title", undefined, "en-US"),
      t("jvm_audit.card.records", undefined, "en-US"),
      t("jvm_audit.description.current_range", { limit: 50 }, "en-US"),
      t("jvm_audit.action.refresh", undefined, "en-US"),
      t("jvm_audit.option.last_records", { limit: 50 }, "en-US"),
      t("jvm_audit.column.time", undefined, "en-US"),
      t("jvm_audit.column.mode", undefined, "en-US"),
      t("jvm_audit.column.action", undefined, "en-US"),
      t("jvm_audit.column.resource", undefined, "en-US"),
      t("jvm_audit.column.reason", undefined, "en-US"),
      t("jvm_audit.column.source", undefined, "en-US"),
      t("jvm_audit.column.result", undefined, "en-US"),
      t("jvm_audit.empty.no_records", undefined, "en-US"),
    ].forEach((snippet) => {
      expect(markup).toContain(snippet);
    });

    [
      "JVM 变更审计",
      "审计记录",
      "当前范围",
      "最近 50 条",
      "刷新",
      "时间",
      "模式",
      "动作",
      "资源",
      "原因",
      "来源",
      "结果",
      "暂无审计记录",
    ].forEach((snippet) => {
      expect(markup).not.toContain(snippet);
    });
  });

  it("renders the missing connection empty state in en-US", () => {
    mockState.connections = [];

    const markup = renderToStaticMarkup(
      renderWithI18n(<JVMAuditViewer tab={tab} />),
    );

    expect(markup).toContain(
      t("jvm_audit.error.connection_missing", undefined, "en-US"),
    );
    expect(markup).not.toContain("连接不存在或已被删除");
  });
});
