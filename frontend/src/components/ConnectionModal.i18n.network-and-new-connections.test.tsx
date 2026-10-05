import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { setCurrentLanguage } from "../i18n";
import { getAllConnectionTypeCatalogItems } from "../utils/connectionTypeCatalog";
import { getCustomConnectionDriverHelp } from "../utils/driverImportGuidance";
import {
    storeState,
    mockFormValues,
    antdMessage,
    backendApp,
    setMockFormValues,
    setMockValidateFields,
    textContent,
    findButton,
    findClickableByAnyText,
    findClickableCard,
    findConnectionTypeButtons,
    findConnectionTypeGroup,
    findConnectionTypePin,
    findInputByPlaceholder,
    expandUriSection,
    flushConnectionTestTick,
    appCssSource,
    initialConnection,
    modalTestState,
} from './connectionModalI18nTestSupport';
import { setUpConnectionModalI18nTest } from './connectionModalI18nTestHooks';

vi.mock("../store", async () => (await import('./connectionModalI18nTestSupport')).mockModule1());

vi.mock("../../wailsjs/go/app/App", async () => (await import('./connectionModalI18nTestSupport')).mockModule2());

vi.mock("../utils/overlayWorkbenchTheme", async () => (await import('./connectionModalI18nTestSupport')).mockModule3());

vi.mock("./DatabaseIcons", async () => (await import('./connectionModalI18nTestSupport')).mockModule4());

vi.mock("@ant-design/icons", async () => (await import('./connectionModalI18nTestSupport')).mockModule5());

vi.mock("antd", async () => (await import('./connectionModalI18nTestSupport')).mockModule6());

describe("ConnectionModal i18n", () => {
  beforeAll(async () => {
    // 预热组件模块树的转换缓存：本文件首个用例的动态 import 不应在 5s 用例超时内承担冷编译耗时。
    await import("./ConnectionModal");
  }, 30000);

  beforeEach(setUpConnectionModalI18nTest);

  it("renders English network, appearance, and raw-preserving copy for v2 ui", async () => {

    setCurrentLanguage("en-US");
    setMockFormValues({
      type: "mysql",
      name: "prod",
      host: "localhost",
      port: 3306,
      user: "root",
      password: "",
      timeout: 30,
      useSSL: true,
      sslMode: "preferred",
      useProxy: true,
      proxyType: "socks5",
      proxyHost: "127.0.0.1",
      proxyPort: 1080,
      proxyUser: "",
      proxyPassword: "",
      useSSH: false,
      useHttpTunnel: false,
    });
    const { default: ConnectionModal } = await import("./ConnectionModal");

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<ConnectionModal open onClose={vi.fn()} />);
    });

    await act(async () => {
      findClickableCard(renderer!, "MySQL").props.onClick();
      await flushConnectionTestTick();
    });
    setMockFormValues({
      ...mockFormValues,
      useSSL: true,
      sslMode: "preferred",
    });
    await act(async () => {
      renderer!.update(<ConnectionModal open onClose={vi.fn()} />);
    });

    await act(async () => {
      findClickableByAnyText(renderer!, ["Network & Security", "网络与安全"]).props.onClick();
    });
    setMockFormValues({
      ...mockFormValues,
      useProxy: true,
      proxyType: "socks5",
      proxyHost: "127.0.0.1",
      proxyPort: 1080,
      proxyUser: "",
      proxyPassword: "",
      useSSH: false,
      useHttpTunnel: false,
    });

    let pageText = textContent(renderer!.toJSON());
    expect(pageText).toContain("Network & Security");
    expect(pageText).toContain("Check to enable · click a row to edit details");
    expect(pageText).toContain("SSL/TLS");
    expect(pageText).toContain("Preferred");
    expect(pageText).toContain("Required");
    expect(pageText).toContain("Skip Verify");
    expect(pageText).toContain("SSH tunnel");
    expect(pageText).toContain("Proxy");
    expect(pageText).toContain("HTTP tunnel");
    expect(pageText).toContain("Advanced connection");
    expect(pageText).toContain("Connection timeout (seconds)");
    expect(pageText).toContain("Appearance");
    expect(pageText).toContain("Advanced");

    await act(async () => {
      findClickableCard(renderer!, "Proxy").props.onClick();
    });
    await act(async () => {
      renderer!.update(<ConnectionModal open onClose={vi.fn()} />);
    });

    pageText = textContent(renderer!.toJSON());
    // 密排布局：左列用短标签（Type/Addr/Auth），完整标题在 title 属性上；
    // 描述性 placeholder 仍完整可见，作为断言锚点。
    expect(pageText).toContain("Type");
    expect(pageText).toContain("Addr");
    expect(pageText).toContain("For example: 127.0.0.1 or proxy.company.com");
    expect(pageText).toContain("SOCKS5");
    expect(pageText).toContain("HTTP CONNECT");
    expect(pageText).toContain("Leave blank for no authentication");

    await act(async () => {
      renderer!.update(
        <ConnectionModal
          open
          onClose={vi.fn()}
          initialValues={
            {
              id: "conn-1",
              name: "prod",
              type: "mysql",
              config: {
                type: "mysql",
                host: "localhost",
                port: 3306,
                user: "root",
                useProxy: true,
                proxy: {
                  type: "socks5",
                  host: "127.0.0.1",
                  port: 1080,
                  user: "",
                  password: "",
                },
              },
              hasProxyPassword: true,
            } as any
          }
        />,
      );
    });

    await act(async () => {
      renderer!.root.findAll((node) =>
        textContent(node).includes("Clear saved proxy password") &&
        typeof node.props.onChange === "function",
      )[0].props.onChange({ target: { checked: true } });
    });

    await act(async () => {
      findButton(renderer!, "Test connection").props.onClick();
      await flushConnectionTestTick();
    });

    const failedText = textContent(renderer!.toJSON());
    expect(failedText).toContain(
      "enter a new proxy password before testing, or cancel clearing the saved proxy password.",
    );
    expect(failedText).toContain("127.0.0.1");
  });

  it("renders English driver unavailable alert while preserving product names", async () => {

    setCurrentLanguage("en-US");
    backendApp.GetDriverStatusList.mockResolvedValue({
      success: true,
      data: {
        drivers: [
          {
            type: "dameng",
            name: "Dameng (达梦)",
            connectable: false,
            message: "",
          },
        ],
      },
    });
    const { default: ConnectionModal } = await import("./ConnectionModal");

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <ConnectionModal
          open
          onClose={vi.fn()}
          initialValues={initialConnection("dameng", {
            port: 5236,
          })}
        />,
      );
      await flushConnectionTestTick();
    });

    const pageText = textContent(renderer!.toJSON());
    expect(pageText).toContain("Dameng (达梦) driver unavailable");
    expect(pageText).toContain("Install in Driver Manager");
  });

  it("renders English tail copy for SSL hints, driver confirm, Mongo discovery, ClickHouse auto, and examples", async () => {

    setCurrentLanguage("en-US");
    const { default: ConnectionModal } = await import("./ConnectionModal");
    const { Modal } = await import("antd");

    backendApp.GetDriverStatusList.mockResolvedValueOnce({
      success: true,
      data: {
        drivers: [
          {
            type: "dameng",
            name: "Dameng (达梦)",
            connectable: false,
            message: "",
          },
        ],
      },
    });
    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <ConnectionModal
          open
          onClose={vi.fn()}
          initialValues={initialConnection("dameng", { port: 5236 })}
        />,
      );
      await flushConnectionTestTick();
    });
    await act(async () => {
      findButton(renderer!, "Test connection").props.onClick();
      await flushConnectionTestTick();
    });
    expect(Modal.confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Dameng (达梦) driver unavailable",
        content: "Dameng (达梦) driver is not installed or enabled. Install it in Driver Manager first.",
        okText: "Install in Driver Manager",
        cancelText: "Cancel",
      }),
    );

    setMockFormValues({
      type: "mysql",
      useSSL: true,
      sslMode: "preferred",
      timeout: 30,
    });
    await act(async () => {
      renderer!.update(<ConnectionModal open onClose={vi.fn()} />);
    });
    await act(async () => {
      findClickableCard(renderer!, "MySQL").props.onClick();
    });
    await act(async () => {
      findClickableByAnyText(renderer!, ["Network & Security", "网络与安全"]).props.onClick();
    });
    expect(textContent(renderer!.toJSON())).toContain(
      "MySQL-compatible data sources support CA certificates, client certificates, and private keys.",
    );
    expect(textContent(renderer!.toJSON())).toContain("Not enabled");

    setMockFormValues({
      type: "clickhouse",
      clickHouseProtocol: "auto",
      timeout: 30,
    });
    await act(async () => {
      renderer!.update(
        <ConnectionModal
          open
          onClose={vi.fn()}
          initialValues={initialConnection("clickhouse", { port: 9000 })}
        />,
      );
    });
    await act(async () => {
      findClickableByAnyText(renderer!, ["Basic", "基础信息"]).props.onClick();
    });
    expect(textContent(renderer!.toJSON())).toContain("Auto");

    setMockFormValues({
      type: "postgres",
      timeout: 30,
    });
    await act(async () => {
      renderer!.update(
        <ConnectionModal
          open
          onClose={vi.fn()}
          initialValues={initialConnection("postgres", { port: 5432 })}
        />,
      );
    });
    // URI 分组默认折叠（见 expandUriSection 的说明），先展开再断言其占位示例。
    await act(async () => {
      expandUriSection(renderer!);
    });
    expect(textContent(renderer!.toJSON())).toContain(
      "For example: postgres://user:pass@127.0.0.1:5432/db_name",
    );

    setMockFormValues({
      type: "mongodb",
      mongoTopology: "replica",
      mongoReadPreference: "primary",
      mongoAuthMechanism: "",
      timeout: 30,
    });
    backendApp.MongoDiscoverMembers.mockResolvedValueOnce({
      success: true,
      data: { members: [{ host: "mongo-1:27017", role: "PRIMARY", healthy: true }] },
    });
    await act(async () => {
      renderer!.unmount();
      renderer = create(
        <ConnectionModal
          open
          onClose={vi.fn()}
          initialValues={initialConnection("mongodb", {
            port: 27017,
            mongoTopology: "replica",
          })}
        />,
      );
    });
    await act(async () => {
      findClickableByAnyText(renderer!, ["Replica set / multi-node"]).props.onClick();
      await flushConnectionTestTick();
    });
    await act(async () => {
      findButton(renderer!, "Discover members").props.onClick();
      await flushConnectionTestTick();
    });
    expect(antdMessage.success).toHaveBeenCalledWith("Discovered 1 member.");

    backendApp.MongoDiscoverMembers.mockResolvedValueOnce({
      success: false,
      message: "",
    });
    await act(async () => {
      findButton(renderer!, "Discover members").props.onClick();
      await flushConnectionTestTick();
    });
    expect(antdMessage.error).toHaveBeenCalledWith("Member discovery failed");
  });

  it("renders English URI feedback and file picker error shell while preserving raw detail", async () => {

    setCurrentLanguage("en-US");
    backendApp.SelectDatabaseFile.mockResolvedValue({
      success: false,
      message: "backend raw error: /tmp/app.db",
    });
    const { default: ConnectionModal } = await import("./ConnectionModal");
    let dismissUriFeedback: (() => void) | undefined;
    const uriFeedbackTimer = vi.fn((callback: () => void, delay: number) => {
      if (delay === 4000) dismissUriFeedback = callback;
      return 1;
    });
    Object.assign(window, {
      setTimeout: uriFeedbackTimer,
      clearTimeout: vi.fn(),
    });

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<ConnectionModal open onClose={vi.fn()} />);
    });

    await act(async () => {
      findClickableCard(renderer!, "MySQL").props.onClick();
    });

    await act(async () => {
      expandUriSection(renderer!);
    });

    await act(async () => {
      findButton(renderer!, "Generate from fields").props.onClick();
    });

    expect(textContent(renderer!.toJSON())).toContain("URI generated.");
    expect(uriFeedbackTimer).toHaveBeenCalledWith(expect.any(Function), 4000);

    await act(async () => {
      dismissUriFeedback?.();
    });
    expect(textContent(renderer!.toJSON())).not.toContain("URI generated.");

    await act(async () => {
      findButton(renderer!, "Back").props.onClick();
    });
    await act(async () => {
      findClickableCard(renderer!, "SQLite").props.onClick();
    });
    await act(async () => {
      findButton(renderer!, "Browse...").props.onClick();
      await flushConnectionTestTick();
    });

    expect(antdMessage.error).toHaveBeenCalledWith(
      "Failed to select database file: backend raw error: /tmp/app.db",
    );
  });

  it("automatically dismisses URI warning feedback after four seconds", async () => {

    setCurrentLanguage("en-US");
    const { default: ConnectionModal } = await import("./ConnectionModal");
    let dismissUriFeedback: (() => void) | undefined;
    const uriFeedbackTimer = vi.fn((callback: () => void, delay: number) => {
      if (delay === 4000) dismissUriFeedback = callback;
      return 1;
    });
    Object.assign(window, {
      setTimeout: uriFeedbackTimer,
      clearTimeout: vi.fn(),
    });

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<ConnectionModal open onClose={vi.fn()} />);
    });
    await act(async () => {
      findClickableCard(renderer!, "MySQL").props.onClick();
    });
    await act(async () => {
      expandUriSection(renderer!);
    });
    const parseUriButton = findButton(renderer!, "Parse & fill");
    expect(parseUriButton, textContent(renderer!.toJSON())).toBeDefined();
    await act(async () => {
      parseUriButton.props.onClick();
    });

    expect(textContent(renderer!.toJSON())).toContain("Enter a URI first");
    expect(uriFeedbackTimer).toHaveBeenCalledWith(expect.any(Function), 4000);

    await act(async () => {
      dismissUriFeedback?.();
    });
    expect(textContent(renderer!.toJSON())).not.toContain("Enter a URI first");
  });

  it("retranslates test failure feedback while preserving raw detail when language changes in-place", async () => {

    setCurrentLanguage("zh-CN");
    backendApp.TestConnection.mockReset();
    backendApp.TestConnection.mockResolvedValue({
      success: false,
      message: "backend raw error: /tmp/app.db",
    });
    const { default: ConnectionModal } = await import("./ConnectionModal");

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<ConnectionModal open onClose={vi.fn()} />);
    });

    await act(async () => {
      findClickableCard(renderer!, "MySQL").props.onClick();
    });

    await act(async () => {
      findButton(renderer!, "测试连接").props.onClick();
      await flushConnectionTestTick();
    });

    let pageText = textContent(renderer!.toJSON());
    expect(pageText).toContain("连接失败");
    expect(pageText).toContain("测试失败: backend raw error: /tmp/app.db");
    expect(pageText).toContain("查看原因");

    await act(async () => {
      storeState.setLanguagePreference("en-US");
    });

    pageText = textContent(renderer!.toJSON());
    expect(pageText).toContain(
      "Connection test failed: backend raw error: /tmp/app.db",
    );
    expect(pageText).toContain("View details");
    expect(pageText).toContain("backend raw error: /tmp/app.db");
  });

  it("stops connection action loading before optional database discovery finishes", async () => {

    setCurrentLanguage("zh-CN");
    backendApp.TestConnection.mockResolvedValue({
      success: true,
      message: "连接正常",
    });
    let resolveDatabases: ((value: { success: true; data: unknown[] }) => void) | undefined;
    backendApp.DBGetDatabases.mockReset();
    backendApp.DBGetDatabases.mockReturnValue(
      new Promise((resolve) => {
        resolveDatabases = resolve;
      }),
    );
    const { default: ConnectionModal } = await import("./ConnectionModal");

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <ConnectionModal
          open
          onClose={vi.fn()}
          initialValues={initialConnection("elasticsearch", { port: 9200 })}
        />,
      );
    });

    await act(async () => {
      findButton(renderer!, "测试连接").props.onClick();
      await flushConnectionTestTick();
    });

    expect(textContent(renderer!.toJSON())).toContain("连接成功");
    expect(findButton(renderer!, "测试连接").props.disabled).toBe(false);
    expect(findButton(renderer!, "保存").props.disabled).toBe(false);
    expect(backendApp.DBGetDatabases).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveDatabases?.({ success: true, data: [] });
      await flushConnectionTestTick();
    });
  });

  it("does not let a stale validation run restart loading after the modal reopens", async () => {

    setCurrentLanguage("zh-CN");
    let resolveValidation: (() => void) | undefined;
    setMockValidateFields(() =>
      new Promise<void>((resolve) => {
        resolveValidation = resolve;
      }));
    backendApp.TestConnection.mockReset();
    backendApp.TestConnection.mockRejectedValue(new Error("stale validation failure"));
    const { default: ConnectionModal } = await import("./ConnectionModal");
    const connection = initialConnection("elasticsearch", { port: 9200 });
    const onClose = vi.fn();

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <ConnectionModal open onClose={onClose} initialValues={connection} />,
      );
    });
    await act(async () => {
      findButton(renderer!, "测试连接").props.onClick();
      await flushConnectionTestTick();
    });
    await act(async () => {
      renderer!.update(
        <ConnectionModal open={false} onClose={onClose} initialValues={connection} />,
      );
    });
    await act(async () => {
      renderer!.update(
        <ConnectionModal open onClose={onClose} initialValues={connection} />,
      );
    });
    await act(async () => {
      resolveValidation?.();
      await flushConnectionTestTick();
    });

    expect(backendApp.TestConnection).not.toHaveBeenCalled();
    expect(textContent(renderer!.toJSON())).not.toContain("stale validation failure");
    expect(findButton(renderer!, "测试连接").props.disabled).toBe(false);
    expect(findButton(renderer!, "保存").props.disabled).toBe(false);
  });

  it("ignores a stale connection-test rejection after the modal reopens", async () => {

    setCurrentLanguage("zh-CN");
    let rejectConnection: ((reason?: unknown) => void) | undefined;
    backendApp.TestConnection.mockReset();
    backendApp.TestConnection.mockReturnValue(
      new Promise((_, reject) => {
        rejectConnection = reject;
      }),
    );
    const { default: ConnectionModal } = await import("./ConnectionModal");
    const connection = initialConnection("elasticsearch", { port: 9200 });
    const onClose = vi.fn();

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <ConnectionModal open onClose={onClose} initialValues={connection} />,
      );
    });
    await act(async () => {
      findButton(renderer!, "测试连接").props.onClick();
      await flushConnectionTestTick();
    });
    expect(backendApp.TestConnection).toHaveBeenCalledTimes(1);

    await act(async () => {
      renderer!.update(
        <ConnectionModal open={false} onClose={onClose} initialValues={connection} />,
      );
    });
    await act(async () => {
      renderer!.update(
        <ConnectionModal open onClose={onClose} initialValues={connection} />,
      );
    });
    await act(async () => {
      rejectConnection?.(new Error("stale connection failure"));
      await flushConnectionTestTick();
    });

    expect(textContent(renderer!.toJSON())).not.toContain("stale connection failure");
    expect(findButton(renderer!, "测试连接").props.disabled).toBe(false);
    expect(findButton(renderer!, "保存").props.disabled).toBe(false);
  });

  it("cancels an in-flight Nacos test and ignores its late result", async () => {

    setCurrentLanguage("zh-CN");
    let resolveConnection: ((value: unknown) => void) | undefined;
    backendApp.NacosTestConnectionWithProgress.mockReset();
    backendApp.NacosTestConnectionWithProgress.mockReturnValue(
      new Promise((resolve) => {
        resolveConnection = resolve;
      }),
    );
    const { default: ConnectionModal } = await import("./ConnectionModal");
    const connection = initialConnection("nacos", { port: 8848 });

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <ConnectionModal open onClose={vi.fn()} initialValues={connection} />,
      );
    });
    await act(async () => {
      findButton(renderer!, "测试连接").props.onClick();
      await flushConnectionTestTick();
    });

    expect(backendApp.NacosTestConnectionWithProgress).toHaveBeenCalledWith(
      expect.objectContaining({ type: "nacos", useSSH: false }),
      expect.stringMatching(/^nacos-test-/),
    );
    const runID = backendApp.NacosTestConnectionWithProgress.mock.calls[0][1];
    expect(findButton(renderer!, "取消测试连接")).toBeDefined();

    await act(async () => {
      findButton(renderer!, "取消测试连接").props.onClick();
      await flushConnectionTestTick();
    });

    expect(backendApp.CancelConnectionTest).toHaveBeenCalledWith(runID);
    expect(findButton(renderer!, "测试连接").props.disabled).toBe(false);
    expect(findButton(renderer!, "保存").props.disabled).toBe(false);

    await act(async () => {
      resolveConnection?.({ success: false, message: "late Nacos failure" });
      await flushConnectionTestTick();
    });

    expect(textContent(renderer!.toJSON())).not.toContain("late Nacos failure");
    expect(findButton(renderer!, "测试连接").props.disabled).toBe(false);
  });

  it("renders English data source groups and hints for the remaining step one copy", async () => {

    setCurrentLanguage("en-US");
    setMockFormValues({
      jvmDiagnosticEnabled: true,
      jvmDiagnosticTransport: "agent-bridge",
    });
    const { default: ConnectionModal } = await import("./ConnectionModal");

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<ConnectionModal open onClose={vi.fn()} />);
    });

    let pageText = textContent(renderer!.toJSON());
    expect(pageText).toContain("Relational databases");
    expect(pageText).toContain("Domestic databases");
    expect(pageText).toContain("NoSQL databases");
    expect(pageText).toContain("Time-series databases");
    expect(pageText).toContain("Other");
    expect(pageText).toContain("Local file connection");
    expect(pageText).toContain("Standard connection configuration");

    await act(async () => {
      findClickableByAnyText(renderer!, ["Other"]).props.onClick();
    });
    pageText = textContent(renderer!.toJSON());
    expect(pageText).toContain("JVM runtime");
    expect(pageText).not.toContain("JVM Runtime");
    expect(pageText).toContain("Custom");
    expect(pageText).not.toContain("Custom (自定义)");
  });

  it("searches across all data sources, keeps category state consistent, and resets on reopen", async () => {

    setCurrentLanguage("en-US");
    const { default: ConnectionModal } = await import("./ConnectionModal");
    const onClose = vi.fn();

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<ConnectionModal open onClose={onClose} />);
    });

    const expectedKeys = new Set(
      getAllConnectionTypeCatalogItems().map((item) => item.key),
    );
    expect(
      findConnectionTypeButtons(renderer!).map(
        (node) => node.props["data-connection-type-key"],
      ),
    ).toEqual([...expectedKeys]);

    await act(async () => {
      findConnectionTypeGroup(
        renderer!,
        "connection_modal.step1.group.nosql",
      ).props.onClick();
    });
    expect(
      findConnectionTypeButtons(renderer!).map(
        (node) => node.props["data-connection-type-key"],
      ),
    ).toEqual(["mongodb", "redis"]);

    await act(async () => {
      findInputByPlaceholder(
        renderer!,
        "Search data source name",
      ).props.onChange({
        target: { value: " DIROS " },
      });
    });
    expect(
      findConnectionTypeGroup(
        renderer!,
        "connection_modal.step1.group.all",
      ).props["aria-pressed"],
    ).toBe(true);
    expect(
      findConnectionTypeButtons(renderer!).map(
        (node) => node.props["data-connection-type-key"],
      ),
    ).toEqual(["diros"]);
    expect(textContent(renderer!.toJSON())).toContain("Doris");

    await act(async () => {
      findInputByPlaceholder(
        renderer!,
        "Search data source name",
      ).props.onChange({
        target: { value: "not-a-real-data-source" },
      });
    });
    expect(findConnectionTypeButtons(renderer!)).toHaveLength(0);
    expect(textContent(renderer!.toJSON())).toContain(
      "No matching data source",
    );

    await act(async () => {
      renderer!.update(<ConnectionModal open={false} onClose={onClose} />);
    });
    await act(async () => {
      renderer!.update(<ConnectionModal open onClose={onClose} />);
    });
    expect(
      findInputByPlaceholder(renderer!, "Search data source name").props.value,
    ).toBe("");
    expect(findConnectionTypeButtons(renderer!)).toHaveLength(
      expectedKeys.size,
    );

    await act(async () => {
      findConnectionTypeGroup(
        renderer!,
        "connection_modal.step1.group.other",
      ).props.onClick();
    });
    expect(
      findConnectionTypeButtons(renderer!).map(
        (node) => node.props["data-connection-type-key"],
      ),
    ).toEqual(["jvm", "custom"]);
  });

  it("uses native buttons for category and data source keyboard interaction", async () => {
    const { default: ConnectionModal } = await import("./ConnectionModal");

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<ConnectionModal open onClose={vi.fn()} />);
    });

    expect(
      findConnectionTypeGroup(
        renderer!,
        "connection_modal.step1.group.all",
      ).props.type,
    ).toBe("button");
    expect(findClickableCard(renderer!, "MySQL").type).toBe("button");
    expect(findClickableCard(renderer!, "MySQL").props.type).toBe("button");
  });

  it("keeps keyboard focus in the active form after switching connection type", async () => {
    const createFocusable = () => {
      const element: any = {
        disabled: false,
        hidden: false,
        parentElement: {},
        closest: vi.fn(() => null),
        getAttribute: vi.fn(() => null),
        hasAttribute: vi.fn(() => false),
        getClientRects: vi.fn(() => [{}]),
      };
      element.focus = vi.fn(() => {
        (document as any).activeElement = element;
      });
      return element;
    };

    const outsideControl = createFocusable();
    const portalControl = createFocusable();
    const firstControl = createFocusable();
    const selectedSection = createFocusable();
    const lastControl = createFocusable();
    const panel = {
      contains: vi.fn((element: unknown) =>
        [firstControl, selectedSection, lastControl].includes(element),
      ),
      querySelector: vi.fn((selector: string) =>
        selector.includes("gn-conn-form-nav-item") ? selectedSection : null,
      ),
      querySelectorAll: vi.fn(() => [firstControl, selectedSection, lastControl]),
    };
    modalTestState.connectionPanel = panel;
    vi.mocked(document.getElementById).mockReturnValue({
      contains: (element: unknown) => element === outsideControl,
    } as HTMLElement);
    (document as any).activeElement = outsideControl;

    const onClose = vi.fn();
    const { default: ConnectionModal } = await import("./ConnectionModal");
    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<ConnectionModal open onClose={onClose} />);
    });
    await act(async () => {
      findClickableCard(renderer!, "MySQL").props.onClick();
    });

    expect(selectedSection.focus).toHaveBeenCalledTimes(1);
    expect((document as any).activeElement).toBe(selectedSection);

    const keydownRegistrations = vi.mocked(window.addEventListener).mock.calls
      .filter(([type, _listener, options]) => type === "keydown" && options === true);
    const keydownListener = (
      keydownRegistrations[keydownRegistrations.length - 1]?.[1]
    ) as EventListener | undefined;
    expect(keydownListener).toBeDefined();

    const dispatchKey = (key: string, shiftKey = false) => {
      const event = {
        key,
        shiftKey,
        defaultPrevented: false,
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
      };
      keydownListener?.(event as unknown as Event);
      return event;
    };

    (document as any).activeElement = outsideControl;
    const forwardTab = dispatchKey("Tab");
    expect(forwardTab.preventDefault).toHaveBeenCalledTimes(1);
    expect(firstControl.focus).toHaveBeenCalledTimes(1);

    (document as any).activeElement = outsideControl;
    const backwardTab = dispatchKey("Tab", true);
    expect(backwardTab.preventDefault).toHaveBeenCalledTimes(1);
    expect(lastControl.focus).toHaveBeenCalledTimes(1);

    (document as any).activeElement = outsideControl;
    const escape = dispatchKey("Escape");
    expect(escape.preventDefault).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);

    (document as any).activeElement = portalControl;
    const portalEscape = dispatchKey("Escape");
    expect(portalEscape.preventDefault).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("pins data source types without opening the form and restores their personal order", async () => {
    setCurrentLanguage("en-US");
    const { default: ConnectionModal } = await import("./ConnectionModal");

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<ConnectionModal open onClose={vi.fn()} />);
    });

    expect(
      findConnectionTypeButtons(renderer!).slice(0, 3).map(
        (node) => node.props["data-connection-type-key"],
      ),
    ).toEqual(["mysql", "mariadb", "diros"]);
    expect(findConnectionTypePin(renderer!, "postgres").props["aria-pressed"]).toBe(false);
    expect(findConnectionTypePin(renderer!, "postgres").props["aria-label"]).toBe(
      "Pin PostgreSQL",
    );

    await act(async () => {
      findConnectionTypePin(renderer!, "postgres").props.onClick();
    });

    expect(storeState.setConnectionTypePinned).toHaveBeenCalledWith("postgres", true);
    expect(findConnectionTypeButtons(renderer!)[0].props["data-connection-type-key"]).toBe(
      "postgres",
    );
    expect(findConnectionTypePin(renderer!, "postgres").props["aria-pressed"]).toBe(true);
    expect(findConnectionTypePin(renderer!, "postgres").props["aria-label"]).toBe(
      "Unpin PostgreSQL",
    );
    expect(
      renderer!.root.findAll(
        (node) => node.props?.["data-connection-step"] === "1",
      ),
    ).toHaveLength(1);

    await act(async () => {
      findConnectionTypePin(renderer!, "redis").props.onClick();
    });
    expect(
      findConnectionTypeButtons(renderer!).slice(0, 3).map(
        (node) => node.props["data-connection-type-key"],
      ),
    ).toEqual(["redis", "postgres", "mysql"]);

    await act(async () => {
      findConnectionTypePin(renderer!, "redis").props.onClick();
    });
    expect(findConnectionTypeButtons(renderer!)[0].props["data-connection-type-key"]).toBe(
      "postgres",
    );
  });

  it("keeps the pinned button frame level while rotating only the pushpin icon", () => {
    const pinnedButtonRule = appCssSource.match(
      /\.gn-conn-type-card-pin\[aria-pressed='true'\]\s*\{([^}]*)\}/,
    );
    const pinnedIconRule = appCssSource.match(
      /\.gn-conn-type-card-pin\[aria-pressed='true'\]\s+\.anticon\s*\{([^}]*)\}/,
    );

    expect(pinnedButtonRule).not.toBeNull();
    expect(pinnedButtonRule?.[1]).not.toMatch(/transform\s*:/);
    expect(pinnedIconRule).not.toBeNull();
    expect(pinnedIconRule?.[1]).toMatch(/transform:\s*rotate\(-18deg\)/);
  });

  it("renders English custom driver DSN copy after the module was loaded in another language", async () => {

    setCurrentLanguage("zh-CN");
    const { default: ConnectionModal } = await import("./ConnectionModal");
    setCurrentLanguage("en-US");

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <ConnectionModal
          open
          onClose={vi.fn()}
          initialValues={initialConnection("custom", {
            driver: "mysql",
            dsn: "user:pass@tcp(localhost:3306)/dbname",
          })}
        />,
      );
    });

    const pageText = textContent(renderer!.toJSON());
    expect(pageText).toContain("Driver Name");
    expect(pageText).toContain("Connection string (DSN)");
    expect(pageText).toContain(getCustomConnectionDriverHelp("en-US"));
  });

  it("renders English JVM fields and diagnostic transport copy", async () => {

    setCurrentLanguage("en-US");
    const { default: ConnectionModal } = await import("./ConnectionModal");

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <ConnectionModal
          open
          onClose={vi.fn()}
          initialValues={initialConnection("jvm", {
            port: 9010,
            jvm: {
              allowedModes: ["jmx", "endpoint", "agent"],
              preferredMode: "jmx",
              diagnostic: {
                enabled: true,
                transport: "agent-bridge",
              },
            },
          })}
        />,
      );
    });

    const pageText = textContent(renderer!.toJSON());
    expect(pageText).toContain("JMX host override");
    expect(pageText).toContain("JMX port");
    expect(pageText).toContain("JMX username");
    expect(pageText).toContain("Endpoint address");
    expect(pageText).toContain("Agent address");
    expect(pageText).toContain("Diagnostic transport");
    expect(pageText).toContain("Agent Bridge");
    expect(pageText).toContain("Bridge diagnostic commands through GoNavi Agent.");
    expect(pageText).toContain("Observe commands");
    expect(pageText).toContain(
      "Read-only troubleshooting commands such as thread, dashboard, and jvm.",
    );
    expect(pageText).toContain("Trace commands");
    expect(pageText).toContain(
      "Commands such as trace and watch that add extra overhead to the target.",
    );
    expect(pageText).toContain("High-risk commands");
    expect(pageText).toContain(
      "Commands that may change runtime state or cause noticeable performance impact.",
    );
  });

  it("renders English protocol and database service fields", async () => {

    setCurrentLanguage("en-US");
    const { default: ConnectionModal } = await import("./ConnectionModal");

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <ConnectionModal
          open
          onClose={vi.fn()}
          initialValues={initialConnection("oceanbase", {
            oceanBaseProtocol: "mysql",
          })}
        />,
      );
    });

    let pageText = textContent(renderer!.toJSON());
    expect(pageText).toContain("Proto");
    expect(pageText).toContain("Choose MySQL for MySQL tenants and Oracle for Oracle tenants.");

    await act(async () => {
      renderer!.update(
        <ConnectionModal
          open
          onClose={vi.fn()}
          initialValues={initialConnection("postgres", {
            port: 5432,
            database: "appdb",
          })}
        />,
      );
    });

    pageText = textContent(renderer!.toJSON());
    expect(pageText).toContain("Database");

    await act(async () => {
      renderer!.update(
        <ConnectionModal
          open
          onClose={vi.fn()}
          initialValues={initialConnection("oracle", {
            port: 1521,
            database: "ORCLPDB1",
          })}
        />,
      );
    });

    pageText = textContent(renderer!.toJSON());
    expect(pageText).toContain("Svc");
  });

  it("renders and restores the Nacos scoped namespace without requiring a username", async () => {
    setCurrentLanguage("en-US");
    const { default: ConnectionModal } = await import("./ConnectionModal");

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <ConnectionModal
          open
          onClose={vi.fn()}
          initialValues={initialConnection("nacos", {
            port: 8848,
            user: "",
            connectionParams:
              "contextPath=%2Fnacos&namespaceId=public&custom=value",
          })}
        />,
      );
    });

    const pageText = textContent(renderer!.toJSON());
    expect(pageText).toContain("Namespace ID");
    expect(pageText).toContain(
      "Administrators can leave this empty to discover all namespaces.",
    );
    expect(mockFormValues.nacosNamespaceId).toBe("public");
    expect(new URLSearchParams(mockFormValues.connectionParams)).toEqual(
      new URLSearchParams("contextPath=%2Fnacos&custom=value"),
    );
    expect(
      findInputByPlaceholder(
        renderer!,
        "Leave empty when authentication is disabled",
      ),
    ).toBeDefined();
  });

  it("restores a legacy Nacos namespace stored only in the connection URI", async () => {
    setCurrentLanguage("en-US");
    const { default: ConnectionModal } = await import("./ConnectionModal");

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <ConnectionModal
          open
          onClose={vi.fn()}
          initialValues={initialConnection("nacos", {
            port: 8848,
            connectionParams: "",
            uri: "https://nacos.example.test:8848/registry?namespaceId=dev-team&custom=value",
          })}
        />,
      );
    });

    expect(mockFormValues.nacosNamespaceId).toBe("dev-team");
    const params = new URLSearchParams(mockFormValues.connectionParams);
    expect(params.get("contextPath")).toBe("/registry");
    expect(params.get("custom")).toBe("value");
    expect(params.has("namespaceId")).toBe(false);
  });

  it("starts a new Nacos connection with optional authentication and no namespace scope", async () => {
    setCurrentLanguage("en-US");
    const { default: ConnectionModal } = await import("./ConnectionModal");

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<ConnectionModal open onClose={vi.fn()} />);
    });
    await act(async () => {
      findClickableCard(renderer!, "Nacos").props.onClick();
    });

    expect(mockFormValues.user).toBe("");
    expect(mockFormValues.nacosNamespaceId).toBe("");
    expect(
      findInputByPlaceholder(
        renderer!,
        "Leave empty when authentication is disabled",
      ),
    ).toBeDefined();
  });
});
