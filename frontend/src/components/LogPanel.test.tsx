import React from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import { I18nProvider } from "../i18n/provider";
import { readV2ThemeCss } from "../test/readV2ThemeCss";
import LogPanel from "./LogPanel";

const storeState = {
  sqlLogs: [] as Array<{
    id: string;
    timestamp: number;
    sql: string;
    status: "success" | "error";
    duration: number;
    message?: string;
    affectedRows?: number;
    category?: "query" | "transaction";
  }>,
  clearSqlLogs: vi.fn(),
  theme: "light",
  appearance: { enabled: true, opacity: 1, blur: 0, uiVersion: "legacy" },
};

vi.mock("../store", () => ({
  useStore: (selector: (state: typeof storeState) => unknown) => selector(storeState),
}));

vi.mock("../i18n/runtime", () => ({
  applyDayjsLocale: vi.fn(),
  syncLanguageRuntime: vi.fn(),
}));

vi.mock("antd", async () => {
  const React = await import("react");
  const Table = ({ dataSource, columns }: { dataSource: any[]; columns: any[] }) =>
    React.createElement(
      "div",
      null,
      dataSource.map((record) =>
        React.createElement(
          "div",
          { key: record.id },
          columns.map((column) =>
            React.createElement(
              "div",
              { key: column.dataIndex || column.title },
              column.render
                ? column.render(record[column.dataIndex], record)
                : record[column.dataIndex],
            ),
          ),
        ),
      ),
    );
  const Empty = ({ description }: { description?: React.ReactNode }) =>
    React.createElement("div", null, description);
  (Empty as any).PRESENTED_IMAGE_SIMPLE = "simple";

  return {
    Table,
    Tag: ({ children }: { children?: React.ReactNode }) => React.createElement("span", null, children),
    Button: ({
      children,
      icon,
      onClick,
    }: {
      children?: React.ReactNode;
      icon?: React.ReactNode;
      onClick?: () => void;
    }) => React.createElement("button", { onClick }, icon, children),
    Tooltip: ({ children, title }: { children?: React.ReactNode; title?: React.ReactNode }) =>
      React.createElement("span", { title }, children),
    Empty,
  };
});

vi.mock("@ant-design/icons", async () => {
  const React = await import("react");
  const Icon = () => React.createElement("span", null);
  return {
    BugOutlined: Icon,
    ClearOutlined: Icon,
    CloseOutlined: Icon,
    ClockCircleOutlined: Icon,
    RobotOutlined: Icon,
  };
});

const renderLogPanel = (props: Partial<React.ComponentProps<typeof LogPanel>> = {}) => {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      <I18nProvider preference="en-US" onPreferenceChange={() => undefined}>
        <LogPanel height={260} onClose={vi.fn()} onResizeStart={vi.fn()} {...props} />
      </I18nProvider>,
    );
  });
  return renderer;
};

const textContent = (node: any): string => {
  if (node === null || node === undefined) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map((item) => textContent(item)).join("");
  return textContent(node.children || []);
};

describe("LogPanel i18n", () => {
  beforeEach(() => {
    storeState.sqlLogs = [];
    storeState.clearSqlLogs.mockClear();
    storeState.theme = "light";
    storeState.appearance = { enabled: true, opacity: 1, blur: 0, uiVersion: "legacy" };
  });

  it("renders log panel chrome in the active language", () => {
    const renderer = renderLogPanel();
    const renderedText = textContent(renderer.toJSON());

    expect(renderedText).toContain("SQL execution log");
    expect(renderedText).toContain("Track execution status, duration, and errors for quick review.");
    expect(renderedText).toContain("No SQL execution logs");
    expect(renderer.root.findAll((node) => node.props?.title === "Clear logs").length).toBeGreaterThan(0);
    expect(renderer.root.findAll((node) => node.props?.title === "Close panel").length).toBeGreaterThan(0);
  });

  it("localizes table labels while preserving raw SQL and message content", () => {
    storeState.sqlLogs = [
      {
        id: "log-1",
        timestamp: Date.UTC(2026, 5, 16, 1, 2, 3),
        sql: "SELECT * FROM users WHERE id = 7",
        status: "success",
        duration: 42,
        message: "driver raw detail",
        affectedRows: 7,
      },
    ];

    const renderer = renderLogPanel();
    const renderedText = textContent(renderer.toJSON());

    expect(renderedText).toContain("SELECT * FROM users WHERE id = 7");
    expect(renderedText).toContain("driver raw detail");
    expect(renderedText).toContain("Affected: 7");
    expect(renderedText).toContain("42ms");
    expect(renderedText).toContain("OK");
  });

  it("keeps detailed transaction statements on separate readable lines", () => {
    storeState.sqlLogs = [
      {
        id: "transaction-log-1",
        timestamp: Date.UTC(2026, 6, 10, 9, 43, 45),
        sql: "START TRANSACTION;\nUPDATE `users` SET `name` = 'new-name' WHERE `id` = 8;\nCOMMIT;",
        status: "success",
        duration: 295,
        category: "transaction",
      },
    ];

    const renderer = renderLogPanel();
    const sqlNodes = renderer.root.findAll((node) => (
      node.type === "div"
      && node.props?.style?.fontFamily === "var(--gn-font-mono)"
      && node.props?.style?.whiteSpace === "pre-wrap"
    ));

    expect(sqlNodes).toHaveLength(1);
    expect(textContent(sqlNodes[0])).toContain("TX");
    expect(textContent(sqlNodes[0])).toContain("UPDATE `users` SET `name` = 'new-name' WHERE `id` = 8;");
  });

  it("renders the current execution error summary inside the embedded log tab", () => {
    storeState.sqlLogs = [
      {
        id: "log-err",
        timestamp: Date.UTC(2026, 5, 20, 5, 40, 0),
        sql: "SELECT * FROM message;",
        status: "error",
        duration: 18,
        message: "driver exploded",
      },
    ];
    const onDiagnoseExecutionError = vi.fn();
    const renderer = renderLogPanel({
      variant: "embedded",
      executionError: "Table 'missav_bot.message' doesn't exist",
      onDiagnoseExecutionError,
    });
    const renderedText = textContent(renderer.toJSON());

    expect(renderedText).toContain("Execution failed");
    expect(renderedText).toContain("Table 'missav_bot.message' doesn't exist");
    expect(renderedText).toContain("AI diagnose");

    const diagnoseButton = renderer.root.findAll((node) => node.type === "button" && textContent(node).includes("AI diagnose"))[0];
    act(() => {
      diagnoseButton.props.onClick?.();
    });
    expect(onDiagnoseExecutionError).toHaveBeenCalledTimes(1);
  });

  it("omits duplicate log chrome from the embedded log tab", () => {
    storeState.sqlLogs = [{
      id: "log-embedded",
      timestamp: Date.UTC(2026, 6, 30, 8, 0, 0),
      sql: "SELECT 1",
      status: "success",
      duration: 3,
    }];

    const renderer = renderLogPanel({ variant: "embedded" });
    const renderedText = textContent(renderer.toJSON());

    expect(renderedText).not.toContain("SQL execution log");
    expect(renderedText).not.toContain("Track execution status, duration, and errors for quick review.");
    expect(renderer.root.findAll((node) => node.props?.title === "Clear logs")).toHaveLength(0);
    expect(renderedText).toContain("SELECT 1");
  });

  it("uses the shared SQL workbench background for the embedded log surface", () => {
    storeState.appearance = { enabled: true, opacity: 1, blur: 0, uiVersion: "v2" };

    const renderer = renderLogPanel({ variant: "embedded" });
    const embeddedPanel = renderer.root.findByProps({ className: "log-panel-embedded" });
    const scrollPanel = renderer.root.findByProps({ className: "log-panel-scroll" });
    const css = readV2ThemeCss();
    const embeddedTableCss = css.slice(
      css.indexOf('body[data-ui-version="v2"] .log-panel-embedded .log-panel-table .ant-table {'),
      css.indexOf('body[data-ui-version="v2"] .gn-v2-query-result-panel-header .query-result-panel-header-title'),
    );

    expect(embeddedPanel.props.style.background).toBe(
      "var(--gn-query-workbench-bg, var(--gn-bg-panel-2))",
    );
    expect(scrollPanel.props.style.padding).toBe("0 0 12px");
    expect(embeddedTableCss).toContain(
      "background: var(--gn-query-workbench-bg, var(--gn-bg-panel-2)) !important;",
    );
  });
});
