// ConnectionModal.i18n.test.tsx 拆分前的共享 mock 状态、mock 工厂与辅助函数；各拆分文件经 vi.mock 委托到这里。
import React from "react";
import { vi } from "vitest";
import { type ReactTestRenderer } from "react-test-renderer";
import { setCurrentLanguage } from "../i18n";
import { readCssWithImports } from '../test/readCssWithImports';

export const storeState = {
  addConnection: vi.fn(),
  updateConnection: vi.fn(),
  pinnedConnectionTypes: [] as string[],
  setConnectionTypePinned: vi.fn((dbType: string, pinned: boolean) => {
    const normalized = dbType.trim().toLowerCase();
    storeState.pinnedConnectionTypes = pinned
      ? [normalized, ...storeState.pinnedConnectionTypes.filter((item) => item !== normalized)]
      : storeState.pinnedConnectionTypes.filter((item) => item !== normalized);
    notifyStoreSubscribers();
  }),
  theme: "light",
  languagePreference: "zh-CN",
  setLanguagePreference: vi.fn((languagePreference: "zh-CN" | "en-US") => {
    storeState.languagePreference = languagePreference;
    setCurrentLanguage(languagePreference);
    notifyStoreSubscribers();
  }),
  appearance: { opacity: 1 },
};

export const storeSubscribers = new Set<() => void>();

export const notifyStoreSubscribers = () => {
  storeSubscribers.forEach((subscriber) => subscriber());
};

export let mockFormValues: Record<string, any> = {};

export let mockValidateFields: (() => Promise<void>) | undefined;

export const antdMessage = (() => ({
  error: vi.fn(),
  warning: vi.fn(),
  success: vi.fn(),
  destroy: vi.fn(),
}))();

export const backendApp = {
  DBGetDatabases: vi.fn(),
  GetDriverStatusList: vi.fn(),
  MongoDiscoverMembers: vi.fn(),
  SaveConnection: vi.fn(),
  TestConnection: vi.fn(),
  TestConnectionWithProgress: vi.fn(),
  RedisConnect: vi.fn(),
  NacosTestConnection: vi.fn(),
  NacosTestConnectionWithProgress: vi.fn(),
  CancelConnectionTest: vi.fn(),
  RevealSavedConnectionPrimaryPassword: vi.fn(),
  SelectDatabaseFile: vi.fn(),
  SelectCertificateFile: vi.fn(),
  SelectSSHKeyFile: vi.fn(),
  SelectSSHKnownHostsFile: vi.fn(),
  TestJVMConnection: vi.fn(),
  TrustSSHHostKeyForConnection: vi.fn(),
};

export const setMockFormValues = (value: typeof mockFormValues) => {
    mockFormValues = value;
};

export const setMockValidateFields = (value: typeof mockValidateFields) => {
    mockValidateFields = value;
};

export const textContent = (node: any): string => {
  if (node === null || node === undefined) return "";
  if (typeof node === "string") return node;
  if (Array.isArray(node)) {
    return node.map((item) => textContent(item)).join("");
  }
  return [node.props?.placeholder, textContent(node.children || [])]
    .filter(Boolean)
    .join("");
};

export const findButton = (renderer: ReactTestRenderer, text: string) =>
  renderer.root.findAll((node) => node.type === "button" && textContent(node).includes(text))[0];

export const findClickableByAnyText = (renderer: ReactTestRenderer, texts: string[]) =>
  renderer.root.findAll(
    (node) => typeof node.props?.onClick === "function" && texts.some((text) => textContent(node).includes(text)),
  )[0];

export const findClickableCard = (renderer: ReactTestRenderer, text: string) =>
  renderer.root.findAll(
    (node) =>
      (node.props?.role === "button" ||
        typeof node.props?.["data-connection-type-key"] === "string") &&
      textContent(node).includes(text),
  )[0];

export const findConnectionTypeButtons = (renderer: ReactTestRenderer) =>
  renderer.root.findAll(
    (node) =>
      node.type === "button" &&
      typeof node.props?.["data-connection-type-key"] === "string",
  );

export const findConnectionTypeGroup = (
  renderer: ReactTestRenderer,
  groupKey: string,
) =>
  renderer.root.findAll(
    (node) =>
      node.type === "button" &&
      node.props?.["data-connection-group-key"] === groupKey,
  )[0];

export const findConnectionTypePin = (
  renderer: ReactTestRenderer,
  dbType: string,
) =>
  renderer.root.findAll(
    (node) =>
      node.type === "button" &&
      node.props?.["data-connection-type-pin"] === dbType,
  )[0];

export const findInputByPlaceholder = (
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
export const expandUriSection = (renderer: ReactTestRenderer) => {
  const toggle = renderer.root.findAll(
    (node) => node.props?.["data-connection-config-section-toggle"] === "uri",
  )[0];
  toggle?.props?.onClick?.({ stopPropagation: () => {} });
};

export const flushConnectionTestTick = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
};

export const appCssSource = readCssWithImports(new URL("../App.css", import.meta.url));

export const initialConnection = (type: string, config: Record<string, any> = {}) =>
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

// vi.mock("../store")
export const mockModule1 = () => ({
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
});

// vi.mock("../../wailsjs/go/app/App")
export const mockModule2 = () => backendApp;

// vi.mock("../utils/overlayWorkbenchTheme")
export const mockModule3 = () => ({
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
});

// vi.mock("./DatabaseIcons")
export const mockModule4 = () => ({
  getDbIcon: (type: string) => <span>{type}</span>,
  getDbDefaultColor: () => "#1677ff",
  getDbIconLabel: (type: string) => type,
  getDbIconAssetSrc: () => "",
  getDbIconContainerBg: () => "#1677ff",
  hasDbIconAsset: () => false,
  DB_ICON_TYPES: ["mysql", "postgres"],
  PRESET_ICON_COLORS: ["#1677ff", "#52c41a"],
});

// vi.mock("@ant-design/icons")
export const mockModule5 = () => {
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
    PushpinOutlined: Icon,
  };
};

export const modalConfirm = (() => vi.fn())();

export const modalTestState = (() => ({
  connectionPanel: null as any,
}))();

// vi.mock("antd")
export const mockModule6 = () => {
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
  Input.Password = ({ value, onChange, placeholder, visibilityToggle, ...rest }: any) => {
    const visibilityControlled =
      typeof visibilityToggle === "object" && visibilityToggle.visible !== undefined;
    const [visible, setVisible] = React.useState(
      visibilityControlled ? visibilityToggle.visible : false,
    );
    React.useEffect(() => {
      if (visibilityControlled) {
        setVisible(visibilityToggle.visible);
      }
    }, [visibilityControlled, visibilityToggle]);
    const simulatedVisibilityToggle =
      typeof visibilityToggle === "object"
        ? {
            ...visibilityToggle,
            onVisibleChange: async (nextVisible: boolean) => {
              setVisible(nextVisible);
              return visibilityToggle.onVisibleChange?.(nextVisible);
            },
          }
        : visibilityToggle;
    return (
      <input
        type={visible ? "text" : "password"}
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        visibilityToggle={simulatedVisibilityToggle}
        {...rest}
      />
    );
  };
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
  const Radio = ({ children, value }: any) => (
    <label>
      <input type="radio" value={value} />
      {children}
    </label>
  );
  Radio.Group = ({ children, value }: any) => (
    <div>
      {children}
      {value ? <span>radio:{value}</span> : null}
    </div>
  );
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
      setMockFormValues({ ...mockFormValues, ...values });
    }),
    setFieldValue: vi.fn((name: string, value: any) => {
      setMockFormValues({ ...mockFormValues, [name]: value });
    }),
    getFieldValue: vi.fn((name: string) => mockFormValues[name]),
    resetFields: vi.fn(() => {
      setMockFormValues({});
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

  const Modal: any = ({ title, children, footer, open, panelRef, wrapClassName }: any) => {
    React.useLayoutEffect(() => {
      if (!String(wrapClassName || "").includes("connection-modal-wrap") || !panelRef) {
        return undefined;
      }
      const panel = open ? modalTestState.connectionPanel : null;
      if (typeof panelRef === "function") {
        panelRef(panel);
      } else {
        panelRef.current = panel;
      }
      return () => {
        if (typeof panelRef === "function") {
          panelRef(null);
        } else {
          panelRef.current = null;
        }
      };
    }, [open, panelRef, wrapClassName]);

    return open ? (
      <section>
        <div>{title}</div>
        <div>{children}</div>
        <div>{footer}</div>
      </section>
    ) : null;
  };
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
    Radio,
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
};
