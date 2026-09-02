import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import { I18nProvider } from "../i18n/provider";
import ImportPreviewModal from "./ImportPreviewModal";
import type { DataImportPreferences } from "./dataImportPreferences";

const mocks = vi.hoisted(() => ({
  previewImportFile: vi.fn(),
  dbGetColumns: vi.fn(),
  importDataWithProgressOptions: vi.fn(),
  exportImportErrorRows: vi.fn(),
  cancelImportJob: vi.fn(),
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
  PreviewImportFileWithOptions: mocks.previewImportFile,
  DBGetColumns: mocks.dbGetColumns,
  ImportDataWithProgressOptions: mocks.importDataWithProgressOptions,
  ExportImportErrorRows: mocks.exportImportErrorRows,
  CancelImportJob: mocks.cancelImportJob,
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
    Progress: ({ percent, ...props }: { percent?: number } & Record<string, unknown>) =>
      React.createElement("div", props, percent === undefined ? "active" : `${percent}%`),
    Spin: (props: Record<string, unknown>) => React.createElement("mock-spin", props),
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
  continueOnError?: boolean,
  importOptions?: DataImportPreferences,
) => (
  <I18nProvider preference="en-US" onPreferenceChange={() => undefined}>
    <ImportPreviewModal
      visible
      presentation={presentation}
      filePath={filePath}
      connectionId="conn-1"
      dbName="app"
      tableName="users"
      continueOnError={continueOnError}
      importOptions={importOptions}
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
    mocks.exportImportErrorRows.mockReset();
    mocks.exportImportErrorRows.mockResolvedValue({ success: true });
    mocks.cancelImportJob.mockReset();
    mocks.cancelImportJob.mockResolvedValue({ success: true });
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

  it("uses shared theme tokens inside the embedded workbench preview", async () => {
    const renderer = await renderImportPreview("D:/imports/users.csv", "embedded");
    const sourceColumns = renderer.root.findByProps({
      "data-import-preview-source-columns": "true",
    });
    const footer = renderer.root.findByProps({
      "data-import-preview-embedded-footer": "true",
    });

    expect(sourceColumns.props.style.background).toContain("var(--gn-bg-subtle");
    expect(footer.props.style.borderTop).toContain("var(--gn-br-1");
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

  it("maps file headers to database fields and submits the selected error policy", async () => {
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
      expect.objectContaining({
        columnMappings: { id: "ID", user_name: "username" },
        continueOnError: false,
        jobId: expect.stringMatching(/^import-/),
      }),
    );
    expect(mocks.dbGetColumns).toHaveBeenCalledWith(
      expect.objectContaining({ type: "mysql" }),
      "app",
      "users",
    );
  });

  it("requires only non-null database fields while allowing nullable fields to be omitted", async () => {
    mocks.previewImportFile.mockResolvedValue({
      success: true,
      data: {
        columns: ["note"],
        totalRows: 1,
        previewRows: [{ note: "optional" }],
      },
    });
    mocks.dbGetColumns.mockResolvedValue({
      success: true,
      data: [
        { name: "id", type: "bigint", nullable: "NO" },
        { name: "note", type: "varchar", nullable: "YES" },
      ],
    });

    const renderer = await renderImportPreview();
    const button = renderer.root.findAllByType("button")
      .find((node) => textContent(node.props.children) === "Start import");
    expect(button?.props.disabled).toBe(true);
    expect(textContent(renderer.toJSON())).toContain(
      "Map the required database columns: id",
    );
  });

  it("uses the same parser options for preview and import", async () => {
    const importOptions: DataImportPreferences = {
      continueOnError: true,
      encoding: "gb18030",
      delimiter: "tab",
      headerRow: 2,
      nullToken: "\\N",
      emptyStringAsNull: true,
      sheetName: " Sheet2 ",
      conflictPolicy: "upsert",
      conflictKeyColumns: ["id"],
    };
    mocks.importDataWithProgressOptions.mockResolvedValue({
      success: true,
      data: { success: 12, failed: 0, total: 12, errorLogs: [] },
    });
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(createImportPreviewTree(
        "D:/imports/users.csv",
        "embedded",
        true,
        importOptions,
      ));
      await Promise.resolve();
      await Promise.resolve();
    });

    const expectedParserOptions = expect.objectContaining({
      continueOnError: true,
      encoding: "gb18030",
      delimiter: "tab",
      headerRow: 2,
      nullToken: "\\N",
      emptyStringAsNull: true,
      sheetName: " Sheet2 ",
      conflictPolicy: "upsert",
      conflictKeyColumns: ["id"],
    });
    expect(mocks.previewImportFile).toHaveBeenCalledWith(
      "D:/imports/users.csv",
      expectedParserOptions,
    );

    const startButton = renderer.root.findAllByType("button")
      .find((node) => textContent(node.props.children) === "Start import");
    await act(async () => {
      startButton?.props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mocks.importDataWithProgressOptions.mock.calls[0][4]).toEqual(expectedParserOptions);
  });

  it("blocks upsert until every conflict key is included in the target mappings", async () => {
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(createImportPreviewTree(
        "D:/imports/users.csv",
        "embedded",
        false,
        {
          continueOnError: false,
          encoding: "auto",
          delimiter: "auto",
          headerRow: 1,
          nullToken: "",
          emptyStringAsNull: false,
          sheetName: "",
          conflictPolicy: "upsert",
          conflictKeyColumns: ["email"],
        },
      ));
      await Promise.resolve();
      await Promise.resolve();
    });

    const startButton = renderer.root.findAllByType("button")
      .find((node) => textContent(node.props.children) === "Start import");
    expect(startButton?.props.disabled).toBe(true);
    expect(textContent(renderer.toJSON())).toContain(
      "Conflict key columns must be included in the selected mappings: email",
    );
  });

  it("uses source bytes for progress when the total row count is unknown", async () => {
    mocks.previewImportFile.mockResolvedValue({
      success: true,
      data: {
        columns: ["id"],
        totalRows: 5,
        totalRowsKnown: false,
        fileSize: 20 * 1024 * 1024,
        sourceIdentity: { token: "source-v1" },
        previewRows: [{ id: 1 }],
      },
    });
    let resolveImport!: (value: any) => void;
    mocks.importDataWithProgressOptions.mockImplementation(() => new Promise((resolve) => {
      resolveImport = resolve;
    }));
    const renderer = await renderImportPreview();
	const previewText = textContent(renderer.toJSON());
	expect(previewText).toContain("Showing 5 sample rows; total row count was not scanned. 1 field");
	expect(previewText).not.toContain("5 rows and 1 field");
    const startButton = renderer.root.findAllByType("button")
      .find((node) => textContent(node.props.children) === "Start import");

    await act(async () => {
      startButton?.props.onClick();
      await Promise.resolve();
    });
    const options = mocks.importDataWithProgressOptions.mock.calls[0][4];
    expect(options.sourceIdentityToken).toBe("source-v1");
    await act(async () => {
      mocks.progressHandler?.({
        jobId: options.jobId,
        current: 3,
        total: 0,
        totalRowsKnown: false,
        success: 3,
        errors: 0,
        skipped: 2,
        bytesRead: 10 * 1024 * 1024,
        totalBytes: 20 * 1024 * 1024,
      });
      await Promise.resolve();
    });

    const byteProgress = renderer.root.findByProps({ "data-import-progress-mode": "bytes" });
    expect(textContent(byteProgress)).toBe("50%");
    expect(renderer.root.findAllByProps({ "data-import-progress-indeterminate": "true" })).toHaveLength(0);
    const renderedText = textContent(renderer.toJSON());
    expect(renderedText).toContain("Processed 3 rows");
    expect(renderedText).toContain("Skipped 2 rows");
    expect(renderedText).not.toContain("Processed 3 / 5 rows");
	const successMetric = renderer.root.findByProps({ "data-import-progress-success": "true" });
	expect(successMetric.props.style.color).toContain("var(--gn-status-connected");

    await act(async () => {
      resolveImport({ success: true, data: { success: 3, failed: 0, total: 3 } });
      await Promise.resolve();
    });
  });

  it("shows a real indeterminate indicator until a parser reports measurable progress", async () => {
    mocks.previewImportFile.mockResolvedValue({
      success: true,
      data: {
        columns: ["id"],
        totalRows: 5,
        totalRowsKnown: false,
        fileSize: 20 * 1024 * 1024,
        previewRows: [{ id: 1 }],
      },
    });
    let resolveImport!: (value: any) => void;
    mocks.importDataWithProgressOptions.mockImplementation(() => new Promise((resolve) => {
      resolveImport = resolve;
    }));
    const renderer = await renderImportPreview("D:/imports/users.xlsx");
    const startButton = renderer.root.findAllByType("button")
      .find((node) => textContent(node.props.children) === "Start import");

    await act(async () => {
      startButton?.props.onClick();
      await Promise.resolve();
    });
    const options = mocks.importDataWithProgressOptions.mock.calls[0][4];
    await act(async () => {
      mocks.progressHandler?.({
        jobId: options.jobId,
        current: 3,
        total: 0,
        totalRowsKnown: false,
        success: 3,
        errors: 0,
        bytesRead: 0,
        totalBytes: 20 * 1024 * 1024,
      });
      await Promise.resolve();
    });

    expect(renderer.root.findByProps({ "data-import-progress-mode": "indeterminate" })).toBeDefined();
    expect(renderer.root.findAll((node) => String(node.type) === "mock-spin")).toHaveLength(1);
    expect(renderer.root.findAllByProps({ "data-import-progress-mode": "bytes" })).toHaveLength(0);

    await act(async () => {
      resolveImport({ success: true, data: { success: 3, failed: 0, total: 3 } });
      await Promise.resolve();
    });
  });

  it("starts only one import when the action is triggered twice before React rerenders", async () => {
	let resolveImport!: (value: any) => void;
	mocks.importDataWithProgressOptions.mockImplementation(() => new Promise((resolve) => {
		resolveImport = resolve;
	}));
	const renderer = await renderImportPreview();
	const startButton = renderer.root.findAllByType("button")
		.find((node) => textContent(node.props.children) === "Start import");

	await act(async () => {
		void startButton?.props.onClick();
		void startButton?.props.onClick();
		await Promise.resolve();
		await Promise.resolve();
	});
	expect(mocks.importDataWithProgressOptions).toHaveBeenCalledTimes(1);

	await act(async () => {
		resolveImport({ success: true, data: { success: 12, failed: 0, total: 12, errorLogs: [] } });
		await Promise.resolve();
	});
  });

  it("locks retry behind an unknown outcome when the import RPC response is lost", async () => {
	mocks.importDataWithProgressOptions.mockRejectedValue(new Error("transport response lost"));
	const renderer = await renderImportPreview();
	const startButton = renderer.root.findAllByType("button")
		.find((node) => textContent(node.props.children) === "Start import");

	await act(async () => {
		await startButton?.props.onClick();
		await Promise.resolve();
	});

	const renderedText = textContent(renderer.toJSON());
	expect(renderedText).toContain("Import failed: transport response lost");
	expect(renderedText).toContain("may have been partially written");
	expect(renderer.root.findAllByType("button")
		.some((node) => textContent(node.props.children) === "Start import")).toBe(false);
  });

  it("submits continue-on-error when the workbench enables it", async () => {
    mocks.importDataWithProgressOptions.mockResolvedValue({
      success: true,
      data: { success: 11, failed: 1, total: 12, errorLogs: ["Row 2: duplicate key"] },
    });
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(createImportPreviewTree("D:/imports/users.csv", "embedded", true));
      await Promise.resolve();
      await Promise.resolve();
    });

    const button = renderer.root
      .findAllByType("button")
      .find((node) => textContent(node.props.children) === "Start import");
    await act(async () => {
      button?.props.onClick();
      await Promise.resolve();
    });

    expect(mocks.importDataWithProgressOptions.mock.calls[0][4]).toEqual(expect.objectContaining({
      continueOnError: true,
    }));
  });

  it("renders a fail-fast partial result without offering an implicit replay", async () => {
    mocks.importDataWithProgressOptions.mockResolvedValue({
      success: false,
      message: "Table import stopped on error",
      data: {
        success: 1000,
        failed: 21,
        total: 2000,
        errorLogs: ["Rows 1001-2000: duplicate key"],
        errorLogsOmitted: 20,
        stoppedOnError: true,
        outcomeUnknown: true,
      },
    });
    const renderer = await renderImportPreview();
    const button = renderer.root
      .findAllByType("button")
      .find((node) => textContent(node.props.children) === "Start import");

    await act(async () => {
      button?.props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });

    const renderedText = textContent(renderer.toJSON());
    expect(renderedText).toContain("Import stopped on error");
    expect(renderedText).toContain("The failed batch may have been partially written");
    expect(renderedText).toContain("Rows 1001-2000: duplicate key");
    expect(renderedText).toContain("20 more error details are not shown");
  });

  it("exports rejected rows through the managed artifact id", async () => {
    mocks.importDataWithProgressOptions.mockResolvedValue({
      success: true,
      data: {
        success: 11,
        failed: 1,
        total: 12,
        errorArtifactId: "artifact-v1",
        errorArtifactCount: 1,
        errorArtifactOmittedCount: 4,
        errorArtifactTruncated: true,
        errorArtifactRetryableCount: 1,
        errorArtifactUnretryableCount: 3,
        errorArtifactScopeKnown: true,
        errorLogs: ["Row 2: duplicate key"],
      },
    });
    const renderer = await renderImportPreview();
    const startButton = renderer.root.findAllByType("button")
      .find((node) => textContent(node.props.children) === "Start import");
    await act(async () => {
      startButton?.props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });
    const exportButton = renderer.root.findAllByType("button")
      .find((node) => textContent(node.props.children) === "Export rejected rows");
    expect(exportButton).toBeDefined();
    const artifact = renderer.root.findByProps({
      "data-import-preview-error-artifact": "true",
    });
    const renderedText = textContent(artifact);
    expect(renderedText).toContain("Rejected rows saved: 1");
    expect(renderedText).toContain("Rejected rows omitted by storage limits: 4");
    expect(renderedText).toContain("Retryable rejected rows: 1");
    expect(renderedText).toContain("Non-retryable rejected rows: 3");
    expect(renderedText).toContain("Rejected-row artifact was truncated because a storage limit was reached.");
    await act(async () => {
      exportButton?.props.onClick();
      await Promise.resolve();
    });
    expect(mocks.exportImportErrorRows).toHaveBeenCalledWith("artifact-v1");
  });

  it("renders an ordinary partial failure as failed instead of completed", async () => {
    mocks.importDataWithProgressOptions.mockResolvedValue({
      success: false,
      message: "Malformed CSV at row 2",
      data: {
        success: 0,
        failed: 0,
        total: 0,
        errorLogs: [],
        stoppedOnError: false,
        outcomeUnknown: false,
      },
    });
    const renderer = await renderImportPreview();
    const button = renderer.root
      .findAllByType("button")
      .find((node) => textContent(node.props.children) === "Start import");

    await act(async () => {
      button?.props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });

    const renderedText = textContent(renderer.toJSON());
    expect(renderedText).toContain("Import failed");
    expect(renderedText).toContain("Malformed CSV at row 2");
    expect(renderedText).not.toContain("Import completed");
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
    const errorLogTitle = renderer.root.findByProps({
      "data-import-preview-error-log-title": "true",
    });
    const errorLogPanel = renderer.root.findByProps({
      "data-import-preview-error-log-panel": "true",
    });
    expect(errorLogTitle.props.style.color).toContain("var(--gn-danger");
    expect(errorLogPanel.props.style.background).toContain("var(--gn-warn-soft");
    expect(errorLogPanel.props.style.border).toContain("var(--gn-warn");
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
    expect(mocks.cancelImportJob).toHaveBeenCalledTimes(1);
    expect(mocks.cancelImportJob).toHaveBeenCalledWith(importJobId);

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
    mocks.cancelImportJob.mockImplementation(
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
    mocks.cancelImportJob.mockResolvedValue({ success: false, message: "No running query" });
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

    mocks.cancelImportJob.mockResolvedValue({ success: true });
    const retryStopButton = renderer.root
      .findAllByType("button")
      .find((node) => textContent(node.props.children) === "Stop import");
    await act(async () => {
      retryStopButton?.props.onClick();
      await Promise.resolve();
    });
    expect(mocks.cancelImportJob).toHaveBeenCalledTimes(2);
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
