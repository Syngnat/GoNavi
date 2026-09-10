import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import { I18nProvider } from "../i18n/provider";
import FindInDatabaseModal from "./FindInDatabaseModal";

const mocks = vi.hoisted(() => ({
  cancelQuery: vi.fn(),
  dbQueryApplicationWithCancel: vi.fn(),
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
  CancelQuery: mocks.cancelQuery,
  DBQueryApplicationWithCancel: mocks.dbQueryApplicationWithCancel,
  DBGetTables: mocks.dbGetTables,
  DBGetAllColumns: mocks.dbGetAllColumns,
}));

vi.mock("antd", async () => {
  const React = await import("react");
  return {
    Alert: ({
      description,
      message,
    }: {
      description?: React.ReactNode;
      message?: React.ReactNode;
    }) => React.createElement("aside", null, message, description),
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

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const flushPromises = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

const enterKeywordAndSearch = async (renderer: ReactTestRenderer, keyword = "alice") => {
  const input = renderer.root.findByType("input");
  await act(async () => {
    input.props.onChange({ target: { value: keyword } });
  });
  const searchButton = renderer.root.findAllByType("button").find((button) => textContent(button).includes("Search"));
  expect(searchButton).toBeTruthy();
  await act(async () => {
    searchButton?.props.onClick();
    await flushPromises();
  });
};

describe("FindInDatabaseModal i18n", () => {
  beforeEach(() => {
    mocks.storeState.connections[0].config.type = "mysql";
    mocks.cancelQuery.mockReset();
    mocks.cancelQuery.mockResolvedValue({ success: true });
    mocks.dbQueryApplicationWithCancel.mockReset();
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

  it("warns and stops before searching an incomplete table list", async () => {
    mocks.dbGetTables.mockResolvedValue({
      success: true,
      partial: true,
      truncated: true,
      message: "Redis key scan truncated after 2 keys: cursor loop detected",
      data: [{ Table: "orders" }, { Table: "users" }],
    });
    const renderer = renderFindModal();

    const input = renderer.root.findByType("input");
    await act(async () => {
      input.props.onChange({ target: { value: "alice" } });
    });
    const searchButton = renderer.root.findAllByType("button").find((button) => textContent(button).includes("Search"));

    await act(async () => {
      searchButton?.props.onClick();
      await Promise.resolve();
    });

    expect(mocks.message.warning).toHaveBeenCalledWith(
      "Failed to get table list: Redis key scan truncated after 2 keys: cursor loop detected",
    );
    expect(mocks.dbGetAllColumns).not.toHaveBeenCalled();
    expect(mocks.dbQueryApplicationWithCancel).not.toHaveBeenCalled();
  });

  it("warns about an incomplete column summary but searches available columns", async () => {
    mocks.dbGetTables.mockResolvedValue({ success: true, data: [{ Table: "healthy" }, { Table: "restricted" }] });
    mocks.dbGetAllColumns.mockResolvedValue({
      success: true,
      partial: true,
      message: "Column summary is incomplete",
      warnings: ["Failed to read column metadata for restricted: permission denied"],
      data: [{ tableName: "healthy", name: "email", type: "varchar(255)" }],
    });
    mocks.dbQueryApplicationWithCancel.mockResolvedValue({ success: true, data: [] });
    const renderer = renderFindModal();

    const input = renderer.root.findByType("input");
    await act(async () => {
      input.props.onChange({ target: { value: "alice" } });
    });
    const searchButton = renderer.root.findAllByType("button").find((button) => textContent(button).includes("Search"));

    await act(async () => {
      searchButton?.props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.message.warning).toHaveBeenCalledWith("Column summary is incomplete");
    expect(mocks.dbQueryApplicationWithCancel).toHaveBeenCalledTimes(1);
  });

  it("reports a failed column summary instead of presenting no matches", async () => {
    mocks.dbGetTables.mockResolvedValue({ success: true, data: [{ Table: "healthy" }] });
    mocks.dbGetAllColumns.mockResolvedValue({ success: false, message: "metadata permission denied" });
    const renderer = renderFindModal();

    const input = renderer.root.findByType("input");
    await act(async () => {
      input.props.onChange({ target: { value: "alice" } });
    });
    const searchButton = renderer.root.findAllByType("button").find((button) => textContent(button).includes("Search"));

    await act(async () => {
      searchButton?.props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.message.error).toHaveBeenCalledWith("Failed to get column summary: metadata permission denied");
    expect(mocks.message.info).not.toHaveBeenCalledWith("No matching data found");
    expect(mocks.dbQueryApplicationWithCancel).not.toHaveBeenCalled();
  });

  it("reports returned and rejected query failures without counting skipped tables", async () => {
    mocks.dbGetTables.mockResolvedValue({
      success: true,
      data: [{ Table: "denied" }, { Table: "binary_data" }, { Table: "offline" }],
    });
    mocks.dbGetAllColumns.mockResolvedValue({
      success: true,
      data: [
        { tableName: "denied", name: "name", type: "varchar(255)" },
        { tableName: "binary_data", name: "payload", type: "blob" },
        { tableName: "offline", name: "name", type: "text" },
      ],
    });
    mocks.dbQueryApplicationWithCancel
      .mockResolvedValueOnce({ success: false, message: "permission denied" })
      .mockRejectedValueOnce(new Error("connection lost"));
    const renderer = renderFindModal();

    const input = renderer.root.findByType("input");
    await act(async () => {
      input.props.onChange({ target: { value: "alice" } });
    });
    const searchButton = renderer.root.findAllByType("button").find((button) => textContent(button).includes("Search"));

    await act(async () => {
      searchButton?.props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });

    const renderedText = textContent(renderer.toJSON());
    expect(mocks.dbQueryApplicationWithCancel).toHaveBeenCalledTimes(2);
    expect(mocks.message.error).toHaveBeenCalledWith("Search failed for all 2 searchable tables");
    expect(mocks.message.info).not.toHaveBeenCalledWith("No matching data found");
    expect(renderedText).toContain("denied: permission denied");
    expect(renderedText).toContain("offline: connection lost");
    expect(renderedText).not.toContain("binary_data:");
    expect(renderedText).not.toContain("No matching data found");
  });

  it("preserves matches and marks the result incomplete when one table fails", async () => {
    mocks.dbGetTables.mockResolvedValue({ success: true, data: [{ Table: "customers" }, { Table: "restricted" }] });
    mocks.dbGetAllColumns.mockResolvedValue({
      success: true,
      data: [
        { tableName: "customers", name: "name", type: "varchar(255)" },
        { tableName: "restricted", name: "name", type: "varchar(255)" },
      ],
    });
    mocks.dbQueryApplicationWithCancel
      .mockResolvedValueOnce({ success: true, data: [{ name: "Alice" }] })
      .mockResolvedValueOnce({ success: false, message: "permission denied" });
    const renderer = renderFindModal();

    const input = renderer.root.findByType("input");
    await act(async () => {
      input.props.onChange({ target: { value: "alice" } });
    });
    const searchButton = renderer.root.findAllByType("button").find((button) => textContent(button).includes("Search"));

    await act(async () => {
      searchButton?.props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });

    const renderedText = textContent(renderer.toJSON());
    expect(mocks.message.warning).toHaveBeenCalledWith("Search incomplete: 1 of 2 searchable tables failed");
    expect(renderedText).toContain("Matching tables: 1");
    expect(renderedText).toContain("customers");
    expect(renderedText).toContain("restricted: permission denied");
  });

  it("reports no matches only when every searchable table query succeeds", async () => {
    mocks.dbGetTables.mockResolvedValue({ success: true, data: [{ Table: "customers" }, { Table: "orders" }] });
    mocks.dbGetAllColumns.mockResolvedValue({
      success: true,
      data: [
        { tableName: "customers", name: "name", type: "varchar(255)" },
        { tableName: "orders", name: "note", type: "text" },
      ],
    });
    mocks.dbQueryApplicationWithCancel.mockResolvedValue({ success: true, data: [] });
    const renderer = renderFindModal();

    const input = renderer.root.findByType("input");
    await act(async () => {
      input.props.onChange({ target: { value: "alice" } });
    });
    const searchButton = renderer.root.findAllByType("button").find((button) => textContent(button).includes("Search"));

    await act(async () => {
      searchButton?.props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.dbQueryApplicationWithCancel).toHaveBeenCalledTimes(2);
    expect(mocks.message.info).toHaveBeenCalledWith("No matching data found");
    expect(mocks.message.warning).not.toHaveBeenCalled();
    expect(mocks.message.error).not.toHaveBeenCalled();
  });

  it("does not publish a failure outcome after cancellation", async () => {
    let resolveQuery!: (value: unknown) => void;
    mocks.dbGetTables.mockResolvedValue({ success: true, data: [{ Table: "customers" }, { Table: "orders" }] });
    mocks.dbGetAllColumns.mockResolvedValue({
      success: true,
      data: [
        { tableName: "customers", name: "name", type: "varchar(255)" },
        { tableName: "orders", name: "note", type: "text" },
      ],
    });
    mocks.dbQueryApplicationWithCancel.mockReturnValue(new Promise((resolve) => {
      resolveQuery = resolve;
    }));
    const renderer = renderFindModal();

    const input = renderer.root.findByType("input");
    await act(async () => {
      input.props.onChange({ target: { value: "alice" } });
    });
    const searchButton = renderer.root.findAllByType("button").find((button) => textContent(button).includes("Search"));

    await act(async () => {
      void searchButton?.props.onClick();
      await Promise.resolve();
    });
    const cancelButton = renderer.root.findAllByType("button").find((button) => textContent(button).includes("Cancel"));

    await act(async () => {
      cancelButton?.props.onClick();
      resolveQuery({ success: false, message: "connection lost" });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.dbQueryApplicationWithCancel).toHaveBeenCalledTimes(1);
    expect(mocks.message.error).not.toHaveBeenCalled();
    expect(mocks.message.warning).not.toHaveBeenCalled();
    expect(mocks.message.info).not.toHaveBeenCalledWith("No matching data found");
    expect(textContent(renderer.toJSON())).not.toContain("connection lost");
  });

  it.each([
    ["public.users", "public.users", "FROM public.users"],
    ['public."audit.log"', "public.audit.log", 'FROM public."audit.log"'],
    ['public."User""s"', 'public.User"s', 'FROM public."User""s"'],
    ["Sales.User Accounts", "Sales.User Accounts", 'FROM "Sales"."User Accounts"'],
  ])("quotes schema-qualified table %s by segment and matches its column metadata", async (tableName, columnTableName, expectedFrom) => {
    mocks.storeState.connections[0].config.type = "postgres";
    mocks.dbGetTables.mockResolvedValue({ success: true, data: [{ Table: tableName }] });
    mocks.dbGetAllColumns.mockResolvedValue({
      success: true,
      data: [{ tableName: columnTableName, name: "name", type: "text" }],
    });
    mocks.dbQueryApplicationWithCancel.mockResolvedValue({ success: true, data: [] });
    const renderer = renderFindModal();

    const input = renderer.root.findByType("input");
    await act(async () => {
      input.props.onChange({ target: { value: "alice" } });
    });
    const searchButton = renderer.root.findAllByType("button").find((button) => textContent(button).includes("Search"));

    await act(async () => {
      searchButton?.props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.dbQueryApplicationWithCancel).toHaveBeenCalledWith(
      expect.anything(),
      "app_db",
      expect.stringContaining(expectedFrom),
      expect.stringMatching(/^database-search-[0-9a-f-]+-0$/),
    );
    if (tableName === "public.users") {
      expect(mocks.dbQueryApplicationWithCancel.mock.calls[0][2]).not.toContain('FROM "public.users"');
    }
  });

  it("keeps dots inside a MySQL single-part table name", async () => {
    mocks.storeState.connections[0].config.type = "mysql";
    mocks.dbGetTables.mockResolvedValue({ success: true, data: [{ Table: "audit.log" }] });
    mocks.dbGetAllColumns.mockResolvedValue({
      success: true,
      data: [{ tableName: "audit.log", name: "name", type: "varchar(255)" }],
    });
    mocks.dbQueryApplicationWithCancel.mockResolvedValue({ success: true, data: [] });
    const renderer = renderFindModal();

    const input = renderer.root.findByType("input");
    await act(async () => {
      input.props.onChange({ target: { value: "alice" } });
    });
    const searchButton = renderer.root.findAllByType("button").find((button) => textContent(button).includes("Search"));

    await act(async () => {
      searchButton?.props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.dbQueryApplicationWithCancel).toHaveBeenCalledWith(
      expect.anything(),
      "app_db",
      expect.stringContaining("FROM `audit.log`"),
      expect.stringMatching(/^database-search-[0-9a-f-]+-0$/),
    );
  });

  it("cancels the active table query and ignores its late response", async () => {
    const inFlight = deferred<{ success: boolean; data: Array<Record<string, unknown>> }>();
    mocks.dbGetTables.mockResolvedValue({ success: true, data: [{ Table: "users" }, { Table: "orders" }] });
    mocks.dbGetAllColumns.mockResolvedValue({
      success: true,
      data: [
        { tableName: "users", name: "name", type: "varchar(255)" },
        { tableName: "orders", name: "note", type: "text" },
      ],
    });
    mocks.dbQueryApplicationWithCancel.mockReturnValueOnce(inFlight.promise);
    const renderer = renderFindModal();

    await enterKeywordAndSearch(renderer);
    expect(mocks.dbQueryApplicationWithCancel).toHaveBeenCalledTimes(1);
    const queryId = mocks.dbQueryApplicationWithCancel.mock.calls[0][3];

    const cancelButton = renderer.root.findAllByType("button").find((button) => textContent(button).includes("Cancel"));
    expect(cancelButton).toBeTruthy();
    await act(async () => {
      cancelButton?.props.onClick();
      await flushPromises();
    });

    expect(mocks.cancelQuery).toHaveBeenCalledWith(queryId);
    expect(textContent(renderer.toJSON())).toContain("Search");

    await act(async () => {
      inFlight.resolve({ success: true, data: [{ name: "alice-late" }] });
      await flushPromises();
    });

    expect(mocks.dbQueryApplicationWithCancel).toHaveBeenCalledTimes(1);
    expect(textContent(renderer.toJSON())).not.toContain("alice-late");
    expect(mocks.message.info).not.toHaveBeenCalledWith("No matching data found");
  });

  it("uses independent query IDs when a new search starts after cancellation", async () => {
    const firstQuery = deferred<{ success: boolean; data: Array<Record<string, unknown>> }>();
    const secondQuery = deferred<{ success: boolean; data: Array<Record<string, unknown>> }>();
    mocks.dbGetTables.mockResolvedValue({ success: true, data: [{ Table: "users" }] });
    mocks.dbGetAllColumns.mockResolvedValue({
      success: true,
      data: [{ tableName: "users", name: "name", type: "varchar(255)" }],
    });
    mocks.dbQueryApplicationWithCancel
      .mockReturnValueOnce(firstQuery.promise)
      .mockReturnValueOnce(secondQuery.promise);
    const renderer = renderFindModal();

    await enterKeywordAndSearch(renderer);
    const firstId = mocks.dbQueryApplicationWithCancel.mock.calls[0][3];
    const cancelButton = renderer.root.findAllByType("button").find((button) => textContent(button).includes("Cancel"));
    await act(async () => {
      cancelButton?.props.onClick();
      await flushPromises();
    });

    await enterKeywordAndSearch(renderer, "bob");
    const secondId = mocks.dbQueryApplicationWithCancel.mock.calls[1][3];
    expect(secondId).not.toBe(firstId);

    await act(async () => {
      firstQuery.resolve({ success: true, data: [{ name: "alice-late" }] });
      await flushPromises();
    });
    expect(textContent(renderer.toJSON())).not.toContain("alice-late");

    const secondCancelButton = renderer.root.findAllByType("button").find((button) => textContent(button).includes("Cancel"));
    await act(async () => {
      secondCancelButton?.props.onClick();
      await flushPromises();
    });
    expect(mocks.cancelQuery).toHaveBeenNthCalledWith(2, secondId);

    await act(async () => {
      secondQuery.resolve({ success: true, data: [{ name: "bob-late" }] });
      await flushPromises();
    });
    expect(textContent(renderer.toJSON())).not.toContain("bob-late");
  });
});
