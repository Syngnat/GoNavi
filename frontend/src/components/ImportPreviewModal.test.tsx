import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import { I18nProvider } from "../i18n/provider";
import ImportPreviewModal from "./ImportPreviewModal";

const mocks = vi.hoisted(() => ({
  previewImportFile: vi.fn(),
  dbGetColumns: vi.fn(),
  importDataWithProgressOptions: vi.fn(),
  cancelQuery: vi.fn(),
  progressHandler: null as ((data: any) => void) | null,
  eventsOn: vi.fn((_event: string, handler: (data: any) => void) => {
    mocks.progressHandler = handler;
    return vi.fn();
  }),
  eventsOff: vi.fn(),
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
  },
}));

vi.mock("../store", () => ({
  useStore: (selector: (state: typeof mocks.storeState) => unknown) =>
    selector(mocks.storeState),
}));

vi.mock("../i18n/runtime", () => ({
  applyDayjsLocale: vi.fn(),
  syncLanguageRuntime: vi.fn(),
}));

vi.mock("../../wailsjs/go/app/App", () => ({
  PreviewImportFile: mocks.previewImportFile,
  DBGetColumns: mocks.dbGetColumns,
  ImportDataWithProgressOptions: mocks.importDataWithProgressOptions,
  CancelQuery: mocks.cancelQuery,
}));

vi.mock("../../wailsjs/runtime/runtime", () => ({
  EventsOn: mocks.eventsOn,
  EventsOff: mocks.eventsOff,
}));

vi.mock("antd", async () => {
  const React = await import("react");
  const Modal = ({
    children,
    footer,
    open,
    title,
  }: {
    children?: React.ReactNode;
    footer?: React.ReactNode;
    open?: boolean;
    title?: React.ReactNode;
  }) =>
    open ? React.createElement("section", null, title, children, footer) : null;
  const Table = ({
    columns,
    dataSource,
  }: {
    columns?: any[];
    dataSource?: any[];
  }) =>
    React.createElement(
      "div",
      null,
      columns?.map((column) =>
        React.createElement(
          "span",
          { key: column.key || column.dataIndex },
          column.title,
        ),
      ),
      dataSource?.map((row, index) =>
        React.createElement(
          "div",
          { key: index },
          Object.values(row).map((value, valueIndex) =>
            React.createElement("span", { key: valueIndex }, String(value)),
          ),
        ),
      ),
    );
  return {
    Modal,
    Table,
    Alert: ({
      message,
      description,
    }: {
      message?: React.ReactNode;
      description?: React.ReactNode;
    }) => React.createElement("div", null, message, description),
    Progress: ({ percent }: { percent: number }) =>
      React.createElement("div", null, `${percent}%`),
    Button: ({
      children,
      onClick,
      disabled,
    }: {
      children?: React.ReactNode;
      onClick?: () => void;
      disabled?: boolean;
    }) => React.createElement("button", { onClick, disabled }, children),
    Select: ({
      value,
      options,
      onChange,
    }: {
      value?: string;
      options?: Array<{ value: string; label: React.ReactNode; disabled?: boolean }>;
      onChange?: (value: string) => void;
    }) => React.createElement(
      "select",
      { value, onChange: (event: any) => onChange?.(event.target.value) },
      options?.map((option) => React.createElement(
        "option",
        { key: option.value, value: option.value, disabled: option.disabled },
        option.label,
      )),
    ),
    Space: ({ children }: { children?: React.ReactNode }) =>
      React.createElement("div", null, children),
  };
});

vi.mock("@ant-design/icons", async () => {
  const React = await import("react");
  const Icon = () => React.createElement("span", null);
  return {
    CheckCircleOutlined: Icon,
    CloseCircleOutlined: Icon,
    StopOutlined: Icon,
  };
});

const textContent = (node: any): string => {
  if (node === null || node === undefined) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node))
    return node.map((item) => textContent(item)).join("");
  return textContent(node.children || []);
};

const createImportPreviewTree = (
  filePath = "D:/imports/users.csv",
  presentation: "modal" | "embedded" = "modal",
) => (
  <I18nProvider preference="en-US" onPreferenceChange={() => undefined}>
    <ImportPreviewModal
      visible
      presentation={presentation}
      filePath={filePath}
      connectionId="conn-1"
      dbName="app"
      tableName="users"
      onClose={vi.fn()}
      onSuccess={vi.fn()}
    />
  </I18nProvider>
);

const renderImportPreview = async (
  filePath = "D:/imports/users.csv",
  presentation: "modal" | "embedded" = "modal",
) => {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(createImportPreviewTree(filePath, presentation));
    await Promise.resolve();
    await Promise.resolve();
  });
  return renderer;
};

describe("ImportPreviewModal i18n", () => {
  beforeEach(() => {
    mocks.storeState.connections = [
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
    ];
    mocks.previewImportFile.mockReset();
    mocks.previewImportFile.mockResolvedValue({
      success: true,
      data: {
        columns: ["id", "user_name"],
        totalRows: 12,
        previewRows: [{ id: 1, user_name: "alice" }],
      },
    });
    mocks.dbGetColumns.mockReset();
    mocks.dbGetColumns.mockResolvedValue({
      success: true,
      data: [
        { name: "ID", type: "bigint" },
        { name: "username", type: "varchar" },
        { name: "email", type: "varchar" },
      ],
    });
    mocks.importDataWithProgressOptions.mockReset();
    mocks.cancelQuery.mockReset();
    mocks.cancelQuery.mockResolvedValue({ success: true });
    mocks.progressHandler = null;
    mocks.eventsOn.mockClear();
    mocks.eventsOff.mockClear();
  });

  it("renders preview chrome in the active language while preserving raw column names", async () => {
    const renderer = await renderImportPreview();
    const renderedText = textContent(renderer.toJSON());

    expect(renderedText).toContain("Import data preview");
    expect(renderedText).toContain("12 rows and 2 fields");
    expect(renderedText).toContain(
      "The first 5 rows are shown below. Start the import after confirming the data.",
    );
    expect(renderedText).toContain("Field list:");
    expect(renderedText).toContain("Data preview (first 5 rows):");
    expect(renderedText).toContain("Cancel");
    expect(renderedText).toContain("Start import");
    expect(renderedText).toContain("id");
    expect(renderedText).toContain("user_name");
  });

  it("renders the same preview and actions inside a workbench panel", async () => {
    const renderer = await renderImportPreview("D:/imports/users.csv", "embedded");

    expect(renderer.root.findByProps({
      "data-import-preview-embedded": "true",
    })).toBeDefined();
    expect(renderer.root.findByProps({
      "data-import-preview-embedded-footer": "true",
    })).toBeDefined();
    const renderedText = textContent(renderer.toJSON());
    expect(renderedText).toContain("Import data preview");
    expect(renderedText).toContain("Start import");
    expect(renderedText).toContain("alice");
  });

  it("keeps preview total when progress events omit total rows", async () => {
    let resolveImport!: (value: any) => void;
    mocks.importDataWithProgressOptions.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveImport = resolve;
        }),
    );

    const renderer = await renderImportPreview();
    const button = renderer.root
      .findAllByType("button")
      .find((node) => textContent(node.props.children) === "Start import");
    expect(button).toBeDefined();

    await act(async () => {
      button?.props.onClick();
      await Promise.resolve();
    });

    expect(mocks.progressHandler).toBeTypeOf("function");
    const importJobId = mocks.importDataWithProgressOptions.mock.calls[0][4].jobId;

    await act(async () => {
      mocks.progressHandler?.({
        jobId: "another-import-job",
        current: 9,
        total: 12,
        success: 9,
        errors: 0,
      });
      mocks.progressHandler?.({
        jobId: importJobId,
        current: 3,
        total: 0,
        success: 3,
        errors: 0,
        totalRowsKnown: false,
      });
      await Promise.resolve();
    });

    expect(textContent(renderer.toJSON())).toContain("Processed 3 / 12 rows");
    expect(textContent(renderer.toJSON())).toContain("25%");

    await act(async () => {
      resolveImport({
        success: true,
        data: { success: 3, failed: 0, total: 12, errorLogs: [] },
      });
      await Promise.resolve();
    });
  });

  it("maps file headers to database fields and submits only selected mappings", async () => {
    mocks.importDataWithProgressOptions.mockResolvedValue({
      success: true,
      data: { success: 12, failed: 0, total: 12, errorLogs: [] },
    });
    const renderer = await renderImportPreview();

    const selects = renderer.root.findAllByType("select");
    expect(selects).toHaveLength(2);
    expect(selects[0].props.value).toBe("ID");
    expect(selects[1].props.value).toBe("");

    await act(async () => {
      selects[1].props.onChange({ target: { value: "username" } });
      await Promise.resolve();
    });

    const button = renderer.root
      .findAllByType("button")
      .find((node) => textContent(node.props.children) === "Start import");
    expect(button?.props.disabled).toBe(false);

    await act(async () => {
      button?.props.onClick();
      await Promise.resolve();
    });

    expect(mocks.importDataWithProgressOptions).toHaveBeenCalledWith(
      expect.objectContaining({ type: "mysql" }),
      "app",
      "users",
      "D:/imports/users.csv",
      {
        columnMappings: { id: "ID", user_name: "username" },
        jobId: expect.stringMatching(/^import-/),
      },
    );
    expect(mocks.dbGetColumns).toHaveBeenCalledWith(
      expect.objectContaining({ type: "mysql" }),
      "app",
      "users",
    );
  });

  it("disables import until at least one source column is mapped", async () => {
    mocks.previewImportFile.mockResolvedValue({
      success: true,
      data: {
        columns: ["legacy_name"],
        totalRows: 1,
        previewRows: [{ legacy_name: "alice" }],
      },
    });
    const renderer = await renderImportPreview();
    const button = renderer.root
      .findAllByType("button")
      .find((node) => textContent(node.props.children) === "Start import");

    expect(button?.props.disabled).toBe(true);
    expect(textContent(renderer.toJSON())).toContain("Map at least one file column");
  });

  it("ignores stale preview responses after switching files", async () => {
    let resolveFirstPreview!: (value: any) => void;
    mocks.previewImportFile
      .mockImplementationOnce(() => new Promise((resolve) => {
        resolveFirstPreview = resolve;
      }))
      .mockResolvedValueOnce({
        success: true,
        data: {
          columns: ["email"],
          totalRows: 1,
          previewRows: [{ email: "new@example.com" }],
        },
      });

    const renderer = await renderImportPreview("D:/imports/old.csv");
    await act(async () => {
      renderer.update(createImportPreviewTree("D:/imports/new.csv"));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(textContent(renderer.toJSON())).toContain("new@example.com");

    await act(async () => {
      resolveFirstPreview({
        success: true,
        data: {
          columns: ["user_name"],
          totalRows: 1,
          previewRows: [{ user_name: "stale-user" }],
        },
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    const renderedText = textContent(renderer.toJSON());
    expect(renderedText).toContain("new@example.com");
    expect(renderedText).not.toContain("stale-user");
  });

  it("ignores blank file headers when building column mappings", async () => {
    mocks.previewImportFile.mockResolvedValue({
      success: true,
      data: {
        columns: ["", "id", "   "],
        totalRows: 1,
        previewRows: [{ id: 1 }],
      },
    });

    const renderer = await renderImportPreview();
    const selects = renderer.root.findAllByType("select");
    expect(selects).toHaveLength(1);
    expect(selects[0].props.value).toBe("ID");
  });

  it("keeps a pending import locked and preserves partial failures when connection state changes", async () => {
    let resolveImport!: (value: any) => void;
    mocks.importDataWithProgressOptions.mockImplementation(
      () => new Promise((resolve) => {
        resolveImport = resolve;
      }),
    );
    const renderer = await renderImportPreview();
    const startButton = renderer.root
      .findAllByType("button")
      .find((node) => textContent(node.props.children) === "Start import");

    await act(async () => {
      startButton?.props.onClick();
      await Promise.resolve();
    });
    expect(mocks.importDataWithProgressOptions).toHaveBeenCalledTimes(1);

    mocks.storeState.connections = mocks.storeState.connections.map((item) => ({
      ...item,
      config: { ...item.config, host: "changed-host" },
    }));
    await act(async () => {
      renderer.update(createImportPreviewTree());
      await Promise.resolve();
    });

    expect(mocks.previewImportFile).toHaveBeenCalledTimes(1);
    expect(mocks.importDataWithProgressOptions).toHaveBeenCalledTimes(1);
    expect(textContent(renderer.toJSON())).toContain("Importing data");
    expect(textContent(renderer.toJSON())).not.toContain("Start import");

    await act(async () => {
      resolveImport({
        success: true,
        data: {
          success: 11,
          failed: 1,
          total: 12,
          errorLogs: ["Row 12: duplicate key"],
        },
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mocks.eventsOff).not.toHaveBeenCalled();
    expect(mocks.previewImportFile).toHaveBeenCalledTimes(1);
    expect(textContent(renderer.toJSON())).toContain("Failed 1 rows");
    expect(textContent(renderer.toJSON())).toContain("Row 12: duplicate key");
  });

  it("stops an active import by its job id and preserves the partial result", async () => {
    let resolveImport!: (value: any) => void;
    mocks.importDataWithProgressOptions.mockImplementation(
      () => new Promise((resolve) => {
        resolveImport = resolve;
      }),
    );
    const renderer = await renderImportPreview();
    const startButton = renderer.root
      .findAllByType("button")
      .find((node) => textContent(node.props.children) === "Start import");

    await act(async () => {
      startButton?.props.onClick();
      await Promise.resolve();
    });

    const importJobId = mocks.importDataWithProgressOptions.mock.calls[0][4].jobId;
    const stopButton = renderer.root
      .findAllByType("button")
      .find((node) => textContent(node.props.children) === "Stop import");
    expect(stopButton).toBeDefined();

    await act(async () => {
      stopButton?.props.onClick();
      stopButton?.props.onClick();
      await Promise.resolve();
    });
    expect(mocks.cancelQuery).toHaveBeenCalledTimes(1);
    expect(mocks.cancelQuery).toHaveBeenCalledWith(importJobId);

    await act(async () => {
      resolveImport({
        success: false,
        message: "Import stopped",
        data: {
          success: 10,
          failed: 2,
          total: 12,
          errorLogs: ["Row 11: duplicate key", "Row 12: duplicate key"],
          cancelled: true,
        },
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    const renderedText = textContent(renderer.toJSON());
    expect(renderedText).toContain("Import stopped");
    expect(renderedText).toContain("Successfully imported 10 rows");
    expect(renderedText).toContain("Failed 2 rows");
  });

  it("ignores a late stop failure after the import already completed", async () => {
    let resolveImport!: (value: any) => void;
    let resolveCancel!: (value: any) => void;
    mocks.importDataWithProgressOptions.mockImplementation(
      () => new Promise((resolve) => {
        resolveImport = resolve;
      }),
    );
    mocks.cancelQuery.mockImplementation(
      () => new Promise((resolve) => {
        resolveCancel = resolve;
      }),
    );
    const renderer = await renderImportPreview();
    const startButton = renderer.root
      .findAllByType("button")
      .find((node) => textContent(node.props.children) === "Start import");

    await act(async () => {
      startButton?.props.onClick();
      await Promise.resolve();
    });
    const stopButton = renderer.root
      .findAllByType("button")
      .find((node) => textContent(node.props.children) === "Stop import");
    await act(async () => {
      stopButton?.props.onClick();
      await Promise.resolve();
    });

    await act(async () => {
      resolveImport({
        success: true,
        data: { success: 12, failed: 0, total: 12, errorLogs: [] },
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      resolveCancel({ success: false, message: "No running query" });
      await Promise.resolve();
    });

    const renderedText = textContent(renderer.toJSON());
    expect(renderedText).toContain("Import completed");
    expect(renderedText).not.toContain("No running query");
  });

  it("clears an earlier stop failure when stop is retried", async () => {
    let resolveImport!: (value: any) => void;
    mocks.importDataWithProgressOptions.mockImplementation(
      () => new Promise((resolve) => {
        resolveImport = resolve;
      }),
    );
    mocks.cancelQuery.mockResolvedValue({ success: false, message: "No running query" });
    const renderer = await renderImportPreview();
    const startButton = renderer.root
      .findAllByType("button")
      .find((node) => textContent(node.props.children) === "Start import");

    await act(async () => {
      startButton?.props.onClick();
      await Promise.resolve();
    });
    const stopButton = renderer.root
      .findAllByType("button")
      .find((node) => textContent(node.props.children) === "Stop import");
    await act(async () => {
      stopButton?.props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(textContent(renderer.toJSON())).toContain("No running query");

    mocks.cancelQuery.mockResolvedValue({ success: true });
    const retryStopButton = renderer.root
      .findAllByType("button")
      .find((node) => textContent(node.props.children) === "Stop import");
    await act(async () => {
      retryStopButton?.props.onClick();
      await Promise.resolve();
    });
    expect(mocks.cancelQuery).toHaveBeenCalledTimes(2);
    expect(textContent(renderer.toJSON())).not.toContain("No running query");

    await act(async () => {
      resolveImport({
        success: false,
        message: "Import stopped",
        data: { success: 10, failed: 2, total: 12, errorLogs: [], cancelled: true },
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    const renderedText = textContent(renderer.toJSON());
    expect(renderedText).toContain("Import stopped");
    expect(renderedText).not.toContain("No running query");
  });

  it("preserves an RPC failure when connection state changes during import", async () => {
    let resolveImport!: (value: any) => void;
    mocks.importDataWithProgressOptions.mockImplementation(
      () => new Promise((resolve) => {
        resolveImport = resolve;
      }),
    );
    const renderer = await renderImportPreview();
    const startButton = renderer.root
      .findAllByType("button")
      .find((node) => textContent(node.props.children) === "Start import");

    await act(async () => {
      startButton?.props.onClick();
      await Promise.resolve();
    });
    mocks.storeState.connections = mocks.storeState.connections.map((item) => ({
      ...item,
      config: { ...item.config, host: "changed-host" },
    }));
    await act(async () => {
      renderer.update(createImportPreviewTree());
      await Promise.resolve();
    });
    await act(async () => {
      resolveImport({ success: false, message: "database rejected import" });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.previewImportFile).toHaveBeenCalledTimes(1);
    expect(textContent(renderer.toJSON())).toContain("database rejected import");
  });
});
