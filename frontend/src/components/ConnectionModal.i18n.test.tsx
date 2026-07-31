import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { readFileSync } from "node:fs";

import { setCurrentLanguage } from "../i18n";
import { getAllConnectionTypeCatalogItems } from "../utils/connectionTypeCatalog";
import { getCustomConnectionDriverHelp } from "../utils/driverImportGuidance";

const storeState = {
  addConnection: vi.fn(),
  updateConnection: vi.fn(),
  theme: "light",
  languagePreference: "zh-CN",
  setLanguagePreference: vi.fn((languagePreference: "zh-CN" | "en-US") => {
    storeState.languagePreference = languagePreference;
    setCurrentLanguage(languagePreference);
    notifyStoreSubscribers();
  }),
  appearance: { uiVersion: "legacy", opacity: 1 },
};

const storeSubscribers = new Set<() => void>();
const notifyStoreSubscribers = () => {
  storeSubscribers.forEach((subscriber) => subscriber());
};

let mockFormValues: Record<string, any> = {};
let mockValidateFields: (() => Promise<void>) | undefined;

const antdMessage = vi.hoisted(() => ({
  error: vi.fn(),
  warning: vi.fn(),
  success: vi.fn(),
  destroy: vi.fn(),
}));

const backendApp = {
  DBGetDatabases: vi.fn(),
  GetDriverStatusList: vi.fn(),
  MongoDiscoverMembers: vi.fn(),
  SaveConnection: vi.fn(),
  TestConnection: vi.fn(),
  RedisConnect: vi.fn(),
  SelectDatabaseFile: vi.fn(),
  SelectCertificateFile: vi.fn(),
  SelectSSHKeyFile: vi.fn(),
  TestJVMConnection: vi.fn(),
};

const textContent = (node: any): string => {
  if (node === null || node === undefined) return "";
  if (typeof node === "string") return node;
  if (Array.isArray(node)) {
    return node.map((item) => textContent(item)).join("");
  }
  return [node.props?.placeholder, textContent(node.children || [])]
    .filter(Boolean)
    .join("");
};

const findButton = (renderer: ReactTestRenderer, text: string) =>
  renderer.root.findAll((node) => node.type === "button" && textContent(node).includes(text))[0];

const findClickableByAnyText = (renderer: ReactTestRenderer, texts: string[]) =>
  renderer.root.findAll(
    (node) => typeof node.props?.onClick === "function" && texts.some((text) => textContent(node).includes(text)),
  )[0];

const findClickableCard = (renderer: ReactTestRenderer, text: string) =>
  renderer.root.findAll(
    (node) =>
      (node.props?.role === "button" ||
        typeof node.props?.["data-connection-type-key"] === "string") &&
      textContent(node).includes(text),
  )[0];

const findConnectionTypeButtons = (renderer: ReactTestRenderer) =>
  renderer.root.findAll(
    (node) =>
      node.type === "button" &&
      typeof node.props?.["data-connection-type-key"] === "string",
  );

const findConnectionTypeGroup = (
  renderer: ReactTestRenderer,
  groupKey: string,
) =>
  renderer.root.findAll(
    (node) =>
      node.type === "button" &&
      node.props?.["data-connection-group-key"] === groupKey,
  )[0];

const findInputByPlaceholder = (
  renderer: ReactTestRenderer,
  placeholder: string,
) =>
  renderer.root.findAll(
    (node) =>
      node.type === "input" && node.props?.placeholder === placeholder,
  )[0];

/**
 * 展开「连接 URI」分组。
 *
 * 该分组默认折叠：它的多行输入框很高，展开时会把 host/账号/密码这些必填项挤出首屏，
 * 因此只有编辑已含 uri 的连接时才默认展开。断言 URI 相关文案或按钮的用例需先展开。
 */
const expandUriSection = (renderer: ReactTestRenderer) => {
  const toggle = renderer.root.findAll(
    (node) => node.props?.["data-connection-config-section-toggle"] === "uri",
  )[0];
  toggle?.props?.onClick?.({ stopPropagation: () => {} });
};

const flushConnectionTestTick = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
};

const source = readFileSync(new URL("./ConnectionModal.tsx", import.meta.url), "utf8");
const step2Source = readFileSync(new URL("./connectionModal/ConnectionModalStep2.tsx", import.meta.url), "utf8");
const networkSecuritySource = readFileSync(
  new URL("./connectionModal/ConnectionModalNetworkSecuritySection.tsx", import.meta.url),
  "utf8",
);
const uriSource = readFileSync(new URL("./connectionModal/connectionModalUri.ts", import.meta.url), "utf8");
const combinedConnectionModalSource = [
  source,
  step2Source,
  networkSecuritySource,
  uriSource,
].join("\n");

const initialConnection = (type: string, config: Record<string, any> = {}) =>
  ({
    id: `${type}-conn`,
    name: `${type} connection`,
    type,
    config: {
      type,
      host: "localhost",
      port: 3306,
      user: "user",
      ...config,
    },
  }) as any;

vi.mock("../store", () => ({
  useStore: (selector: (state: typeof storeState) => unknown) =>
    React.useSyncExternalStore(
      (subscriber) => {
        storeSubscribers.add(subscriber);
        return () => {
          storeSubscribers.delete(subscriber);
        };
      },
      () => selector(storeState),
      () => selector(storeState),
    ),
}));

vi.mock("../../wailsjs/go/app/App", () => backendApp);

vi.mock("../utils/overlayWorkbenchTheme", () => ({
  buildOverlayWorkbenchTheme: () => ({
    shellBg: "#fff",
    shellBorder: "1px solid #eee",
    shellShadow: "none",
    shellBackdropFilter: "none",
    sectionBorder: "1px solid #eee",
    sectionBg: "#fff",
    mutedText: "#666",
    titleText: "#111",
    iconBg: "#f5f5f5",
    iconColor: "#111",
  }),
}));

vi.mock("./DatabaseIcons", () => ({
  getDbIcon: (type: string) => <span>{type}</span>,
  getDbDefaultColor: () => "#1677ff",
  getDbIconLabel: (type: string) => type,
  getDbIconAssetSrc: () => "",
  getDbIconContainerBg: () => "#1677ff",
  hasDbIconAsset: () => false,
  DB_ICON_TYPES: ["mysql", "postgres"],
  PRESET_ICON_COLORS: ["#1677ff", "#52c41a"],
}));

vi.mock("@ant-design/icons", () => {
  const Icon = () => <span />;
  return {
    DatabaseOutlined: Icon,
    FileTextOutlined: Icon,
    CloudOutlined: Icon,
    CheckCircleFilled: Icon,
    CloseCircleFilled: Icon,
    ArrowLeftOutlined: Icon,
    CloseOutlined: Icon,
    PlusOutlined: Icon,
    BgColorsOutlined: Icon,
    ApiOutlined: Icon,
    ClusterOutlined: Icon,
    CodeOutlined: Icon,
    GatewayOutlined: Icon,
    SafetyCertificateOutlined: Icon,
    ThunderboltOutlined: Icon,
    DownOutlined: Icon,
    RightOutlined: Icon,
    SearchOutlined: Icon,
  };
});

const modalConfirm = vi.hoisted(() => vi.fn());

vi.mock("antd", () => {
  const Button: any = ({ children, disabled, loading, onClick, ...rest }: any) => (
    <button type="button" disabled={disabled || loading} onClick={onClick} {...rest}>
      {children}
    </button>
  );
  Button.Group = ({ children }: any) => <div>{children}</div>;

  const Input: any = ({ children, value, onChange, placeholder, ...rest }: any) => (
    <input value={value} onChange={onChange} placeholder={placeholder} {...rest}>
      {children}
    </input>
  );
  Input.Password = ({ value, onChange, placeholder, ...rest }: any) => (
    <input value={value} onChange={onChange} placeholder={placeholder} {...rest} />
  );
  Input.TextArea = ({ value, onChange, placeholder, ...rest }: any) => (
    <textarea value={value} onChange={onChange} placeholder={placeholder} {...rest} />
  );

  const Select: any = ({ children, options = [], placeholder }: any) => (
    <div>
      {placeholder ? <span>{placeholder}</span> : null}
      {options.map((option: any) => (
        <span key={String(option.value)}>{option.label}</span>
      ))}
      {children}
    </div>
  );
  Select.Option = ({ children }: any) => <span>{children}</span>;
  const Checkbox = ({ children, checked, onChange }: any) => (
    <label onChange={onChange}>
      <input type="checkbox" checked={checked} onChange={onChange} />
      {children}
    </label>
  );
  const Alert = ({ message, description }: any) => (
    <div>
      <div>{message}</div>
      <div>{description}</div>
    </div>
  );
  const Card = ({ children, onClick }: any) => (
    <div onClick={onClick} role="button">
      {children}
    </div>
  );
  const Row = ({ children }: any) => <div>{children}</div>;
  const Col = ({ children }: any) => <div>{children}</div>;
  const Space: any = ({ children }: any) => <div>{children}</div>;
  Space.Compact = ({ children, ...rest }: any) => <div {...rest}>{children}</div>;
  const Table = () => <div />;
  const Tag = ({ children }: any) => <span>{children}</span>;
  const Switch = () => <button type="button">switch</button>;

  const formApi = {
    validateFields: vi.fn(() => mockValidateFields?.() ?? Promise.resolve()),
    getFieldsValue: vi.fn(() => ({
      type: "mysql",
      timeout: 30,
      useSSH: false,
      useProxy: false,
      useHttpTunnel: false,
      password: "",
      ...mockFormValues,
    })),
    setFieldsValue: vi.fn((values: Record<string, any>) => {
      mockFormValues = { ...mockFormValues, ...values };
    }),
    setFieldValue: vi.fn((name: string, value: any) => {
      mockFormValues = { ...mockFormValues, [name]: value };
    }),
    getFieldValue: vi.fn((name: string) => mockFormValues[name]),
    resetFields: vi.fn(() => {
      mockFormValues = {};
    }),
  };

  const Form: any = ({ children }: any) => <form>{children}</form>;
  Form.Item = ({ children, label, help }: any) => (
    <div>
      {label ? <div>{label}</div> : null}
      {typeof children === "function" ? children(formApi) : children}
      {help ? <div>{help}</div> : null}
    </div>
  );
  Form.useForm = () => [formApi];
  Form.useWatch = (name: string) => {
    if (mockFormValues[name] !== undefined) {
      return mockFormValues[name];
    }
    switch (name) {
      case "mysqlTopology":
      case "mongoTopology":
      case "redisTopology":
        return "single";
      case "mongoSrv":
        return false;
      case "jvmDiagnosticEnabled":
        return mockFormValues.jvmDiagnosticEnabled ?? false;
      case "sslMode":
        return "preferred";
      case "proxyType":
        return "socks5";
      case "driver":
      case "mongoAuthMechanism":
        return "";
      case "mongoReadPreference":
        return "primary";
      case "jvmEnvironment":
        return "dev";
      case "jvmPreferredMode":
        return "jmx";
      case "jvmDiagnosticTransport":
        return mockFormValues.jvmDiagnosticTransport ?? "agent-bridge";
      default:
        return undefined;
    }
  };

  const Modal: any = ({ title, children, footer, open }: any) =>
    open ? (
      <section>
        <div>{title}</div>
        <div>{children}</div>
        <div>{footer}</div>
      </section>
    ) : null;
  Modal.confirm = modalConfirm;

  const Typography = {
    Text: ({ children }: any) => <span>{children}</span>,
  };

  return {
    Modal,
    Form,
    Input,
    InputNumber: Input,
    Button,
    message: antdMessage,
    Checkbox,
    Select,
    Alert,
    Card,
    Row,
    Col,
    Typography,
    Space,
    Table,
    Tag,
    Switch,
  };
});

describe("ConnectionModal i18n", () => {
  beforeEach(() => {
    vi.stubGlobal("document", {
      body: {},
      querySelectorAll: vi.fn(() => []),
    });
    vi.stubGlobal(
      "MutationObserver",
      class {
        observe = vi.fn();
        disconnect = vi.fn();
      },
    );
    vi.stubGlobal("window", {
      setTimeout,
      clearTimeout,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    storeState.theme = "light";
    storeState.languagePreference = "zh-CN";
    storeState.appearance.uiVersion = "legacy";
    storeState.appearance.opacity = 1;
    backendApp.GetDriverStatusList.mockResolvedValue({ success: true, data: { drivers: [] } });
    backendApp.SaveConnection.mockReset();
    backendApp.SaveConnection.mockImplementation(async (input) => ({
      ...input,
      config: { ...input.config, password: "" },
    }));
    backendApp.TestConnection.mockResolvedValue({ success: false, message: "saved connection not found: conn-1" });
    backendApp.DBGetDatabases.mockResolvedValue({ success: true, data: [] });
    backendApp.MongoDiscoverMembers.mockResolvedValue({ success: true, data: { members: [] } });
    backendApp.RedisConnect.mockResolvedValue({ success: true, message: "ok" });
    backendApp.TestJVMConnection.mockResolvedValue({ success: true, message: "ok" });
    backendApp.SelectDatabaseFile.mockReset();
    backendApp.SelectCertificateFile.mockReset();
    backendApp.SelectSSHKeyFile.mockReset();
    antdMessage.error.mockReset();
    antdMessage.warning.mockReset();
    antdMessage.success.mockReset();
    antdMessage.destroy.mockReset();
    modalConfirm.mockReset();
    storeState.addConnection.mockReset();
    storeState.updateConnection.mockReset();
    storeState.setLanguagePreference.mockClear();
    mockFormValues = {};
    mockValidateFields = undefined;
    setCurrentLanguage("zh-CN");
  });

  it("keeps the selected RabbitMQ type when the hidden form value drifts after a failed test", async () => {
    setCurrentLanguage("zh-CN");
    backendApp.TestConnection.mockResolvedValue({
      success: false,
      message: "RabbitMQ Management API port required",
    });
    const onClose = vi.fn();
    Object.assign(window, {
      go: { app: { App: backendApp } },
    });
    const { default: ConnectionModal } = await import("./ConnectionModal");

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<ConnectionModal open onClose={onClose} />);
    });
    await act(async () => {
      findClickableCard(renderer!, "RabbitMQ").props.onClick();
    });
    await act(async () => {
      findButton(renderer!, "测试连接").props.onClick();
      await flushConnectionTestTick();
    });

    expect(backendApp.TestConnection).toHaveBeenCalledWith(
      expect.objectContaining({ type: "rabbitmq", port: 15672 }),
    );

    // Reproduces the observed mismatch: the visible selected type remains
    // RabbitMQ while Ant Design's hidden field falls back to its initial value.
    mockFormValues = { ...mockFormValues, type: "mysql" };
    await act(async () => {
      findButton(renderer!, "保存").props.onClick();
      await flushConnectionTestTick();
    });

    expect(backendApp.SaveConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        iconType: "",
        config: expect.objectContaining({ type: "rabbitmq", port: 15672 }),
      }),
    );
    expect(storeState.addConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({ type: "rabbitmq", port: 15672 }),
      }),
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("updates visible copy when languagePreference changes while the modal stays open", async () => {
    const { default: ConnectionModal } = await import("./ConnectionModal");

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<ConnectionModal open onClose={vi.fn()} />);
    });

    expect(textContent(renderer!.toJSON())).toContain("选择数据源类型");
    expect(
      textContent(
        findConnectionTypeGroup(
          renderer!,
          "connection_modal.step1.group.all",
        ),
      ),
    ).toContain("全部");

    await act(async () => {
      storeState.setLanguagePreference("en-US");
    });

    expect(storeState.setLanguagePreference).toHaveBeenCalledWith("en-US");
    expect(textContent(renderer!.toJSON())).toContain("Select connection type");
    expect(
      textContent(
        findConnectionTypeGroup(
          renderer!,
          "connection_modal.step1.group.all",
        ),
      ),
    ).toContain("All");
    expect(
      textContent(
        findConnectionTypeGroup(
          renderer!,
          "connection_modal.step1.group.other",
        ),
      ),
    ).toContain("Other");
    expect(textContent(renderer!.toJSON())).not.toContain("选择数据源类型");
  });

  it("retranslates data source groups when resolved system language changes", async () => {
    storeState.languagePreference = "system";
    setCurrentLanguage("zh-CN");
    const { default: ConnectionModal } = await import("./ConnectionModal");
    const onClose = vi.fn();

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<ConnectionModal open onClose={onClose} />);
    });
    expect(
      textContent(
        findConnectionTypeGroup(
          renderer!,
          "connection_modal.step1.group.all",
        ),
      ),
    ).toContain("全部");

    setCurrentLanguage("en-US");
    await act(async () => {
      renderer!.update(<ConnectionModal open onClose={onClose} />);
    });
    expect(
      textContent(
        findConnectionTypeGroup(
          renderer!,
          "connection_modal.step1.group.all",
        ),
      ),
    ).toContain("All");
  });

  it.each(["legacy", "v2"] as const)(
    "renders localized create flow copy for %s ui",
    async (uiVersion) => {
      storeState.appearance.uiVersion = uiVersion;
      mockFormValues = {
        type: "mysql",
        useSSL: true,
        sslMode: "preferred",
        timeout: 30,
      };
      const { default: ConnectionModal } = await import("./ConnectionModal");

      let renderer: ReactTestRenderer;
      await act(async () => {
        renderer = create(<ConnectionModal open onClose={vi.fn()} />);
      });

      expect(textContent(renderer!.toJSON())).toContain("选择数据源类型");
      expect(textContent(renderer!.toJSON())).toContain("选择数据源");
      expect(textContent(renderer!.toJSON())).toContain("1 选类型");
      expect(textContent(renderer!.toJSON())).toContain("SSL");

      await act(async () => {
        findClickableCard(renderer!, "MySQL").props.onClick();
      });

      mockFormValues = {
        ...mockFormValues,
        useSSL: true,
        sslMode: "preferred",
      };
      await act(async () => {
        renderer!.update(<ConnectionModal open onClose={vi.fn()} />);
      });

      expect(textContent(renderer!.toJSON())).toContain("MySQL 连接");
      expect(textContent(renderer!.toJSON())).toContain("2 参数");
      expect(textContent(renderer!.toJSON())).toContain("未测试");
      expect(textContent(renderer!.toJSON())).toContain("名称");
      expect(textContent(renderer!.toJSON())).toContain("测试连接");
      expect(textContent(renderer!.toJSON())).toContain("保存");
      expect(textContent(renderer!.toJSON())).toContain("上一步");

      await act(async () => {
        findClickableByAnyText(renderer!, ["Network & Security", "网络与安全"]).props.onClick();
      });

      const pageText = textContent(renderer!.toJSON());
      expect(pageText).toContain("首选");
      expect(pageText).toContain("必需");
      expect(pageText).toContain("跳过验证");
      expect(pageText).toContain("自定义探活 SQL");
    },
  );

  it.each(["legacy", "v2"] as const)(
    "renders English titles, footer copy, and raw-preserving failure feedback for %s ui",
    async (uiVersion) => {
      storeState.appearance.uiVersion = uiVersion;
      setCurrentLanguage("en-US");
      const { default: ConnectionModal } = await import("./ConnectionModal");

      let renderer: ReactTestRenderer;
      await act(async () => {
        renderer = create(<ConnectionModal open onClose={vi.fn()} />);
      });

      expect(textContent(renderer!.toJSON())).toContain("Select connection type");
      expect(textContent(renderer!.toJSON())).toContain("Click to configure");
      expect(textContent(renderer!.toJSON())).toContain("Categories");
      expect(textContent(renderer!.toJSON())).toContain("1 Choose type");

      await act(async () => {
        findClickableCard(renderer!, "MySQL").props.onClick();
      });

      expect(textContent(renderer!.toJSON())).toContain("MySQL connection");
      expect(textContent(renderer!.toJSON())).toContain("2 Parameters");
      expect(textContent(renderer!.toJSON())).toContain("Not tested");
      expect(textContent(renderer!.toJSON())).toContain("Name");
      expect(textContent(renderer!.toJSON())).toContain("Test connection");
      expect(textContent(renderer!.toJSON())).toContain("Save");
      expect(textContent(renderer!.toJSON())).toContain("Back");

      await act(async () => {
        findButton(renderer!, "Test connection").props.onClick();
        await flushConnectionTestTick();
      });

      expect(textContent(renderer!.toJSON())).toContain(
        "The saved secret for this connection was not found. Enter the password again and save before retrying.",
      );
      expect(textContent(renderer!.toJSON())).toContain("View details");
    },
  );

  it.each([
    {
      language: "zh-CN" as const,
      sourceLabel: "MySQL",
      expectations: [
        "生产连接保护",
        "按需勾选限制项",
        "限制数据编辑",
        "限制结构编辑",
        "限制脚本执行",
        "限制数据导入",
        "当前策略",
      ],
    },
    {
      language: "en-US" as const,
      sourceLabel: "MySQL",
      expectations: [
        "Production guard",
        "Select only the restrictions you need",
        "Restrict data edits",
        "Restrict structure edits",
        "Restrict script execution",
        "Restrict data import",
        "Current policy",
      ],
    },
  ])(
    "renders a detailed production-guard card in $language",
    async ({ language, sourceLabel, expectations }) => {
      setCurrentLanguage(language);
      storeState.languagePreference = language;
      mockFormValues = {
        type: "mysql",
        restrictDataEdit: true,
        restrictStructureEdit: true,
        restrictScriptExecution: false,
        restrictDataImport: false,
        useSSL: true,
        sslMode: "preferred",
        timeout: 30,
      };

      const { default: ConnectionModal } = await import("./ConnectionModal");

      let renderer: ReactTestRenderer;
      await act(async () => {
        renderer = create(<ConnectionModal open onClose={vi.fn()} />);
      });

      await act(async () => {
        findClickableCard(renderer!, sourceLabel).props.onClick();
      });

      // A · Studio：生产保护默认折叠，展开后选项文案才可见。
      let pageText = textContent(renderer!.toJSON());
      expect(pageText).toContain(expectations[0]);
      expect(pageText).not.toContain(expectations[2]);
      expect(pageText).not.toContain(expectations[3]);
      expect(pageText).not.toContain("connection.modal.section.undefined.title");
      expect(pageText).not.toContain("connection.modal.section.undefined.description");

      const protectionToggle = renderer!.root.findAll(
        (node) => node.props?.["data-connection-config-section-toggle"] === "readOnly",
      )[0];
      expect(protectionToggle.props["aria-expanded"]).toBe(false);

      await act(async () => {
        protectionToggle.props.onClick({ stopPropagation: vi.fn() });
      });

      pageText = textContent(renderer!.toJSON());
      expect(pageText).toContain(expectations[0]);
      expect(pageText).toContain(expectations[2]);
      expect(pageText).toContain(expectations[6]);
    },
  );

  it("renders English topology and authentication copy for legacy mysql, mongodb, and redis sections", async () => {
    storeState.appearance.uiVersion = "legacy";
    setCurrentLanguage("en-US");
    const { default: ConnectionModal } = await import("./ConnectionModal");

    mockFormValues = {
      mysqlTopology: "replica",
    };
    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <ConnectionModal
          open
          onClose={vi.fn()}
          initialValues={initialConnection("mysql", {
            mysqlTopology: "replica",
          })}
        />,
      );
      await flushConnectionTestTick();
    });

    let pageText = textContent(renderer!.toJSON());
    expect(pageText).toContain("Primary-replica");

    mockFormValues = {
      mongoTopology: "replica",
      mongoSrv: false,
      mongoReadPreference: "primary",
      mongoAuthMechanism: "",
    };
    await act(async () => {
      renderer!.update(
        <ConnectionModal
          open
          onClose={vi.fn()}
          initialValues={initialConnection("mongodb", {
            port: 27017,
            topology: "replica",
            mongoTopology: "replica",
          })}
        />,
      );
    });

    pageText = textContent(renderer!.toJSON());
    expect(pageText).toContain("Replica set / multi-node");
    expect(pageText).toContain("Standard address");
    expect(pageText).toContain("Auth");
    expect(pageText).toContain("Mode");
    expect(pageText).toContain("Read from the primary node only.");
    expect(pageText).toContain("Auth");
    expect(pageText).toContain("Auto-negotiate");
    expect(pageText).toContain("Let the driver choose based on server capabilities.");

    mockFormValues = {
      redisTopology: "cluster",
    };
    await act(async () => {
      renderer!.update(
        <ConnectionModal
          open
          onClose={vi.fn()}
          initialValues={initialConnection("redis", {
            port: 6379,
            redisTopology: "cluster",
          })}
        />,
      );
    });

    pageText = textContent(renderer!.toJSON());
    expect(pageText).toContain("Cluster mode");
    expect(pageText).toContain("Redis password");
    expect(pageText).toContain("Scope");
  });

  it("renders English network, appearance, and raw-preserving copy for v2 ui", async () => {
    storeState.appearance.uiVersion = "v2";
    setCurrentLanguage("en-US");
    mockFormValues = {
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
    };
    const { default: ConnectionModal } = await import("./ConnectionModal");

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<ConnectionModal open onClose={vi.fn()} />);
    });

    await act(async () => {
      findClickableCard(renderer!, "MySQL").props.onClick();
      await flushConnectionTestTick();
    });
    mockFormValues = {
      ...mockFormValues,
      useSSL: true,
      sslMode: "preferred",
    };
    await act(async () => {
      renderer!.update(<ConnectionModal open onClose={vi.fn()} />);
    });

    await act(async () => {
      findClickableByAnyText(renderer!, ["Network & Security", "网络与安全"]).props.onClick();
    });
    mockFormValues = {
      ...mockFormValues,
      useProxy: true,
      proxyType: "socks5",
      proxyHost: "127.0.0.1",
      proxyPort: 1080,
      proxyUser: "",
      proxyPassword: "",
      useSSH: false,
      useHttpTunnel: false,
    };

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
    storeState.appearance.uiVersion = "legacy";
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
    storeState.appearance.uiVersion = "legacy";
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

    mockFormValues = {
      type: "mysql",
      useSSL: true,
      sslMode: "preferred",
      timeout: 30,
    };
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

    mockFormValues = {
      type: "clickhouse",
      clickHouseProtocol: "auto",
      timeout: 30,
    };
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

    mockFormValues = {
      type: "postgres",
      timeout: 30,
    };
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

    mockFormValues = {
      type: "mongodb",
      mongoTopology: "replica",
      mongoReadPreference: "primary",
      mongoAuthMechanism: "",
      timeout: 30,
    };
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

  it("removes the remaining Chinese user-facing tail strings from ConnectionModal source", () => {
    [
      'label: "自动"',
      '"已输入新值，保存时会替换当前已保存内容。"',
      '<Tag color="blue">当前</Tag>',
      '"当前"',
      '"成员发现失败"',
      '`发现 ${members.length} 个成员`',
      '"达梦启用 SSL 时必须填写证书路径与私钥路径"',
      '"TLS 客户端证书与私钥路径需要同时填写"',
      '"HTTP 隧道主机不能为空"',
      '"HTTP 隧道端口必须在 1-65535 之间"',
      '"例如：orders-app_A1B2C3D4E5"',
      '"例如：orders-prod-01"',
      'help="例如: /Users/name/.ssh/id_rsa"',
      'label: "NoSQL"',
      'name: "Custom (自定义)"',
    ].forEach((snippet) => {
    });
    expect(combinedConnectionModalSource.match(/isBackendCancelledResult\(res\)/g) ?? []).toHaveLength(3);
  });

  it("renders English URI feedback and file picker error shell while preserving raw detail", async () => {
    storeState.appearance.uiVersion = "legacy";
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
    storeState.appearance.uiVersion = "legacy";
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
    storeState.appearance.uiVersion = "legacy";
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
    storeState.appearance.uiVersion = "legacy";
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
    storeState.appearance.uiVersion = "legacy";
    setCurrentLanguage("zh-CN");
    let resolveValidation: (() => void) | undefined;
    mockValidateFields = () =>
      new Promise<void>((resolve) => {
        resolveValidation = resolve;
      });
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
    storeState.appearance.uiVersion = "legacy";
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

  it("renders English data source groups and hints for the remaining step one copy", async () => {
    storeState.appearance.uiVersion = "legacy";
    setCurrentLanguage("en-US");
    mockFormValues = {
      jvmDiagnosticEnabled: true,
      jvmDiagnosticTransport: "agent-bridge",
    };
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
    storeState.appearance.uiVersion = "legacy";
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
    ).toEqual(["mongodb", "redis", "elasticsearch"]);

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

  it("renders English custom driver DSN copy after the module was loaded in another language", async () => {
    storeState.appearance.uiVersion = "legacy";
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
    storeState.appearance.uiVersion = "legacy";
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
    storeState.appearance.uiVersion = "legacy";
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
