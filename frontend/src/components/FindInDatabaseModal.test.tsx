import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import { I18nProvider } from "../i18n/provider";
import FindInDatabaseModal from "./FindInDatabaseModal";

const mocks = vi.hoisted(() => ({
  dbQuery: vi.fn(),
  dbGetTables: vi.fn(),
  dbGetAllColumns: vi.fn(),
  message: {
    warning: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
  storeState: {
    connections: [
      {
        id: "conn-1",
        config: {
          type: "mysql",
          host: "localhost",
          port: 3306,
          user: "root",
          password: "",
          database: "app",
        },
      },
    ],
    theme: "light",
  },
}));

vi.mock("../store", () => ({
  useStore: (selector: (state: typeof mocks.storeState) => unknown) => selector(mocks.storeState),
}));

vi.mock("../i18n/runtime", () => ({
  applyDayjsLocale: vi.fn(),
  syncLanguageRuntime: vi.fn(),
}));

vi.mock("../../wailsjs/go/app/App", () => ({
  DBQuery: mocks.dbQuery,
  DBGetTables: mocks.dbGetTables,
  DBGetAllColumns: mocks.dbGetAllColumns,
}));

vi.mock("antd", async () => {
  const React = await import("react");
  return {
    Modal: ({
      children,
      open,
      title,
    }: {
      children?: React.ReactNode;
      open?: boolean;
      title?: React.ReactNode;
    }) => (open ? React.createElement("section", null, title, children) : null),
    Input: ({
      placeholder,
      value,
      onChange,
    }: {
      placeholder?: string;
      value?: string;
      onChange?: (event: { target: { value: string } }) => void;
    }) =>
      React.createElement("input", {
        placeholder,
        value,
        onChange: (event: any) => onChange?.({ target: { value: event.target.value } }),
      }),
    Button: ({
      children,
      disabled,
      icon,
      onClick,
    }: {
      children?: React.ReactNode;
      disabled?: boolean;
      icon?: React.ReactNode;
      onClick?: () => void;
    }) => React.createElement("button", { disabled, onClick }, icon, children),
    Select: ({ options }: { options?: Array<{ label: React.ReactNode; value: string }> }) =>
      React.createElement(
        "div",
        null,
        options?.map((option) => React.createElement("span", { key: option.value }, option.label)),
      ),
    Table: ({ columns, dataSource }: { columns?: any[]; dataSource?: any[] }) =>
      React.createElement(
        "div",
        null,
        columns?.map((column) => React.createElement("span", { key: column.key || column.dataIndex }, column.title)),
        dataSource?.map((row, index) =>
          React.createElement(
            "div",
            { key: index },
            Object.values(row).map((value, valueIndex) =>
              React.createElement("span", { key: valueIndex }, String(value)),
            ),
          ),
        ),
      ),
    Progress: ({ percent }: { percent: number }) => React.createElement("div", null, `${percent}%`),
    Space: ({ children }: { children?: React.ReactNode }) => React.createElement("div", null, children),
    Tag: ({ children }: { children?: React.ReactNode }) => React.createElement("span", null, children),
    Tooltip: ({ children, title }: { children?: React.ReactNode; title?: React.ReactNode }) =>
      React.createElement("span", { title }, children),
    Empty: ({ description }: { description?: React.ReactNode }) => React.createElement("div", null, description),
    message: mocks.message,
  };
});

vi.mock("@ant-design/icons", async () => {
  const React = await import("react");
  const Icon = () => React.createElement("span", null);
  return {
    SearchOutlined: Icon,
    StopOutlined: Icon,
    EyeOutlined: Icon,
    DatabaseOutlined: Icon,
  };
});

const textContent = (node: any): string => {
  if (node === null || node === undefined) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map((item) => textContent(item)).join("");
  return textContent(node.children || []);
};

const renderFindModal = () => {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      <I18nProvider preference="en-US" onPreferenceChange={() => undefined}>
        <FindInDatabaseModal open connectionId="conn-1" dbName="app_db" onClose={vi.fn()} />
      </I18nProvider>,
    );
  });
  return renderer;
};

describe("FindInDatabaseModal i18n", () => {
  beforeEach(() => {
    mocks.dbQuery.mockReset();
    mocks.dbGetTables.mockReset();
    mocks.dbGetAllColumns.mockReset();
    mocks.message.warning.mockClear();
    mocks.message.error.mockClear();
    mocks.message.info.mockClear();
  });

  it("renders search chrome in the active language while preserving raw database name", () => {
    const renderer = renderFindModal();
    const renderedText = textContent(renderer.toJSON());
    const input = renderer.root.findByType("input");

    expect(renderedText).toContain("Search in database - app_db");
    expect(input.props.placeholder).toBe("Enter the string to search for...");
    expect(renderedText).toContain("Contains");
    expect(renderedText).toContain("Exact match");
    expect(renderedText).toContain("Search");
  });

  it("localizes controlled error wrappers while preserving backend detail", async () => {
    mocks.dbGetTables.mockResolvedValue({ success: false, message: "driver raw detail" });
    const renderer = renderFindModal();

    const input = renderer.root.findByType("input");
    await act(async () => {
      input.props.onChange({ target: { value: "alice" } });
    });

    const searchButton = renderer.root.findAllByType("button").find((button) => textContent(button).includes("Search"));
    expect(searchButton).toBeTruthy();

    await act(async () => {
      searchButton?.props.onClick();
      await Promise.resolve();
    });

    expect(mocks.message.error).toHaveBeenCalledWith("Failed to get table list: driver raw detail");
  });
});
