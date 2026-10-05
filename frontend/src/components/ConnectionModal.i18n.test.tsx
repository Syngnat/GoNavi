import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { readFileSync } from "node:fs";
import { setCurrentLanguage } from "../i18n";
import {
    storeState,
    mockFormValues,
    antdMessage,
    backendApp,
    setMockFormValues,
    textContent,
    findButton,
    findClickableByAnyText,
    findClickableCard,
    findConnectionTypeGroup,
    findInputByPlaceholder,
    flushConnectionTestTick,
    initialConnection,
} from './connectionModalI18nTestSupport';
import { setUpConnectionModalI18nTest } from './connectionModalI18nTestHooks';

const source = readFileSync(new URL("./ConnectionModal.tsx", import.meta.url), "utf8");

// ConnectionModalStep2.tsx 已拆成多个子模块，源码扫描需一并聚合。
const step2Source = [
  "ConnectionModalStep2.tsx",
  "connectionStep2Constants.ts",
  "useConnectionStep2State.ts",
  "connectionStep2Protection.ts",
  "connectionStep2UriBlock.tsx",
  "connectionStep2DenseRows.tsx",
  "connectionStep2Sections.tsx",
  "connectionStep2FormHandlers.ts",
  "ConnectionStep2JvmModeCards.tsx",
  "ConnectionStep2JvmDetailCards.tsx",
  "ConnectionStep2HostFields.tsx",
  "ConnectionStep2AuthFields.tsx",
  "ConnectionStep2ModeFields.tsx",
  "ConnectionStep2MongoRedisFields.tsx",
  "ConnectionStep2ProtectionFields.tsx",
].map((file) => readFileSync(new URL(`./connectionModal/${file}`, import.meta.url), "utf8")).join("\n");

const networkSecuritySource = readFileSync(
  new URL("./connectionModal/ConnectionModalNetworkSecuritySection.tsx", import.meta.url),
  "utf8",
);

const uriSource = [
  "connectionModalUri.ts",
  "connectionModalUriHosts.ts",
  "connectionModalUriParams.ts",
  "connectionModalUriSchemes.ts",
  "connectionModalUriParse.ts",
  "connectionModalUriBuild.ts",
].map((file) => readFileSync(new URL(`./connectionModal/${file}`, import.meta.url), "utf8")).join("\n");

// ConnectionModal.tsx 已拆成 connectionModal/ 下的 hook 与子组件，源码扫描需一并聚合。
const connectionModalPartsSource = [
  "connectionModalHelpers.tsx",
  "useConnectionModalState.ts",
  "useConnectionModalLifecycle.ts",
  "useConnectionModalSectionRenderers.tsx",
  "useConnectionModalChoices.tsx",
  "useConnectionModalDriverStatus.ts",
  "useConnectionModalUriActions.ts",
  "useConnectionModalFormSync.ts",
  "useConnectionModalSaveAndTest.ts",
  "useConnectionModalSshAndMongo.ts",
  "useConnectionModalTypeSelect.ts",
  "useConnectionModalTypeCatalog.ts",
  "useConnectionModalSteps.tsx",
  "useConnectionModalChrome.tsx",
  "ConnectionModalSSHHostKeyTrustDialog.tsx",
  "ConnectionModalTestFailureLogModal.tsx",
].map((file) => readFileSync(new URL(`./connectionModal/${file}`, import.meta.url), "utf8")).join("\n");

const combinedConnectionModalSource = [
  source,
  connectionModalPartsSource,
  step2Source,
  networkSecuritySource,
  uriSource,
].join("\n");

vi.mock("../store", async () => (await import('./connectionModalI18nTestSupport')).mockModule1());

vi.mock("../../wailsjs/go/app/App", async () => (await import('./connectionModalI18nTestSupport')).mockModule2());

vi.mock("../utils/overlayWorkbenchTheme", async () => (await import('./connectionModalI18nTestSupport')).mockModule3());

vi.mock("./DatabaseIcons", async () => (await import('./connectionModalI18nTestSupport')).mockModule4());

vi.mock("@ant-design/icons", async () => (await import('./connectionModalI18nTestSupport')).mockModule5());

vi.mock("antd", async () => (await import('./connectionModalI18nTestSupport')).mockModule6());

describe("ConnectionModal i18n", () => {
  beforeEach(setUpConnectionModalI18nTest);

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
    setMockFormValues({ ...mockFormValues, type: "mysql" });
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
  }, 15000);

  it("shows a staged SSH tunnel result instead of only a generic connection spinner", async () => {
    const { default: ConnectionModal } = await import("./ConnectionModal");
    const connection = initialConnection("mysql", {
      useSSH: true,
      ssh: {
        host: "bastion.example.com",
        port: 22,
        user: "ops",
        password: "secret",
      },
    });

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <ConnectionModal open onClose={vi.fn()} initialValues={connection} />,
      );
      await flushConnectionTestTick();
    });
    await act(async () => {
      findButton(renderer!, "测试连接").props.onClick();
      await flushConnectionTestTick();
    });

    expect(backendApp.TestConnectionWithProgress).toHaveBeenCalledWith(
      expect.objectContaining({ useSSH: true }),
      expect.stringMatching(/^ssh-test-/),
    );
    expect(textContent(renderer!.toJSON())).toContain("正在验证 SSH 隧道");
    expect(textContent(renderer!.toJSON())).toContain("网络连接");
    expect(textContent(renderer!.toJSON())).toContain("数据库验证");
  });

  it("shows staged SSH progress and logs when testing a Nacos connection", async () => {
    const { default: ConnectionModal } = await import("./ConnectionModal");
    const connection = initialConnection("nacos", {
      useSSH: true,
      ssh: {
        host: "bastion.example.com",
        port: 22,
        user: "ops",
        password: "secret",
      },
    });

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <ConnectionModal open onClose={vi.fn()} initialValues={connection} />,
      );
      await flushConnectionTestTick();
    });
    await act(async () => {
      findButton(renderer!, "测试连接").props.onClick();
      await flushConnectionTestTick();
    });

    expect(backendApp.NacosTestConnectionWithProgress).toHaveBeenCalledWith(
      expect.objectContaining({ type: "nacos", useSSH: true }),
      expect.stringMatching(/^ssh-test-/),
    );
    expect(backendApp.NacosTestConnection).not.toHaveBeenCalled();
    expect(textContent(renderer!.toJSON())).toContain("正在验证 SSH 隧道");
    expect(textContent(renderer!.toJSON())).toContain("网络连接");
    expect(textContent(renderer!.toJSON())).toContain("数据库验证");
    expect(textContent(renderer!.toJSON())).toContain("准备连接检查");
  });

  it("shows a driver preflight failure in the SSH log without blaming the network", async () => {
    const revisionMismatch =
      "clickhouse 驱动代理 revision 不匹配（已安装：src-old，当前需要：src-new）";
    backendApp.TestConnectionWithProgress.mockResolvedValue({
      success: false,
      message: revisionMismatch,
    });
    const { default: ConnectionModal } = await import("./ConnectionModal");
    const connection = initialConnection("clickhouse", {
      useSSH: true,
      ssh: {
        host: "bastion.example.com",
        port: 22,
        user: "ops",
        password: "secret",
      },
    });

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <ConnectionModal open onClose={vi.fn()} initialValues={connection} />,
      );
      await flushConnectionTestTick();
    });
    await act(async () => {
      findButton(renderer!, "测试连接").props.onClick();
      await flushConnectionTestTick();
    });

    expect(textContent(renderer!.toJSON())).toContain("连接测试失败");
    const progressLog = renderer!.root.findAll(
      (node) => node.props?.role === "log",
    )[0];
    expect(textContent(progressLog)).toContain(revisionMismatch);
    const networkStep = renderer!.root.findAll(
      (node) => node.type === "li" && textContent(node).includes("网络连接"),
    )[0];
    expect(networkStep.props["data-status"]).toBe("pending");
    expect(
      renderer!.root.findAll(
        (node) => node.type === "li" && node.props?.["data-status"] === "error",
      ),
    ).toHaveLength(0);
  });

  it("guides an unknown SSH host through automatic confirmation without a manual field", async () => {
    const fingerprint = "SHA256:QWERTYuiopASDFghjklZXCVbnm1234567890abcd";
    backendApp.TestConnectionWithProgress.mockReset();
    backendApp.TestConnectionWithProgress
      .mockResolvedValueOnce({
        success: false,
        message: "confirmation required",
        data: {
          sshHostKeyTrust: {
            state: "unknown",
            source: "discovered",
            host: "bastion.example.com",
            port: 2222,
            address: "bastion.example.com:2222",
            keyType: "ssh-ed25519",
            fingerprint,
          },
        },
      })
      .mockResolvedValueOnce({ success: true, message: "ok" });
    const { default: ConnectionModal } = await import("./ConnectionModal");
    const connection = initialConnection("mysql", {
      useSSH: true,
      ssh: {
        host: "bastion.example.com",
        port: 2222,
        user: "ops",
      },
    });

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <ConnectionModal open onClose={vi.fn()} initialValues={connection} />,
      );
      await flushConnectionTestTick();
    });
    await act(async () => {
      findButton(renderer!, "测试连接").props.onClick();
      await flushConnectionTestTick();
    });

    const pageText = textContent(renderer!.toJSON());
    expect(pageText).toContain("确认 SSH 服务器身份");
    expect(pageText).toContain("bastion.example.com:2222");
    expect(pageText).toContain(fingerprint);
    expect(findButton(renderer!, "仅本次继续")).toBeDefined();
    expect(findButton(renderer!, "信任并保存")).toBeDefined();

    await act(async () => {
      findButton(renderer!, "仅本次继续").props.onClick();
      await flushConnectionTestTick();
    });
    expect(backendApp.TestConnectionWithProgress).toHaveBeenLastCalledWith(
      expect.objectContaining({
        useSSH: true,
        ssh: expect.objectContaining({ hostKeyFingerprint: fingerprint }),
      }),
      expect.stringMatching(/^ssh-test-/),
    );
    expect(backendApp.TrustSSHHostKeyForConnection).not.toHaveBeenCalled();
  });

  it("saves an explicitly approved SSH host key before retrying", async () => {
    const fingerprint = "SHA256:ZXCVbnm1234567890abcdQWERTYuiopASDFghjkl";
    backendApp.TestConnectionWithProgress.mockReset();
    backendApp.TestConnectionWithProgress
      .mockResolvedValueOnce({
        success: false,
        message: "confirmation required",
        data: {
          sshHostKeyTrust: {
            state: "changed",
            source: "gonavi",
            host: "bastion.example.com",
            port: 22,
            address: "bastion.example.com:22",
            keyType: "ssh-ed25519",
            fingerprint,
            previousFingerprint: "SHA256:previous",
          },
        },
      })
      .mockResolvedValueOnce({ success: true, message: "ok" });
    const { default: ConnectionModal } = await import("./ConnectionModal");

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <ConnectionModal
          open
          onClose={vi.fn()}
          initialValues={initialConnection("mysql", {
            useSSH: true,
            ssh: {
              host: "bastion.example.com",
              port: 22,
              user: "ops",
              hostKeyFingerprint: "SHA256:legacy",
            },
          })}
        />,
      );
      await flushConnectionTestTick();
    });
    await act(async () => {
      findButton(renderer!, "测试连接").props.onClick();
      await flushConnectionTestTick();
    });

    expect(textContent(renderer!.toJSON())).toContain("SSH 服务器密钥已变化");
    expect(textContent(renderer!.toJSON())).toContain("SHA256:previous");
    await act(async () => {
      findButton(renderer!, "替换并信任").props.onClick();
      await flushConnectionTestTick();
    });

    expect(backendApp.TrustSSHHostKeyForConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        useSSH: true,
        ssh: expect.objectContaining({
          host: "bastion.example.com",
          port: 22,
        }),
      }),
      fingerprint,
    );
    expect(backendApp.TestConnectionWithProgress).toHaveBeenLastCalledWith(
      expect.objectContaining({
        ssh: expect.objectContaining({ hostKeyFingerprint: "" }),
      }),
      expect.stringMatching(/^ssh-test-/),
    );
  });

  it("reveals a saved primary password when the password visibility button is opened", async () => {
    Object.assign(window, {
      go: { app: { App: backendApp } },
    });
    const { default: ConnectionModal } = await import("./ConnectionModal");
    const connection = {
      ...initialConnection("mysql"),
      hasPrimaryPassword: true,
    };

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <ConnectionModal open onClose={vi.fn()} initialValues={connection} />,
      );
      await flushConnectionTestTick();
    });

    const passwordInput = findInputByPlaceholder(
      renderer!,
      "••••••（留空表示继续沿用已保存密码）",
    );
    await act(async () => {
      await passwordInput.props.visibilityToggle.onVisibleChange(true);
      await flushConnectionTestTick();
    });

    expect(backendApp.RevealSavedConnectionPrimaryPassword).toHaveBeenCalledWith(
      "mysql-conn",
    );
    expect(mockFormValues.password).toBe("stored-secret");
    expect(
      findInputByPlaceholder(
        renderer!,
        "••••••（留空表示继续沿用已保存密码）",
      ).props.visibilityToggle.visible,
    ).toBe(true);
    expect(textContent(renderer!.toJSON())).not.toContain(
      "已输入新值，保存时会替换当前已保存内容。",
    );
  });

  it("returns the password input to hidden mode when revealing fails", async () => {
    backendApp.RevealSavedConnectionPrimaryPassword.mockRejectedValue(
      new Error("secret store unavailable"),
    );
    Object.assign(window, {
      go: { app: { App: backendApp } },
    });
    const { default: ConnectionModal } = await import("./ConnectionModal");
    const connection = {
      ...initialConnection("mysql"),
      hasPrimaryPassword: true,
    };

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <ConnectionModal open onClose={vi.fn()} initialValues={connection} />,
      );
      await flushConnectionTestTick();
    });

    const placeholder = "••••••（留空表示继续沿用已保存密码）";
    await act(async () => {
      await findInputByPlaceholder(
        renderer!,
        placeholder,
      ).props.visibilityToggle.onVisibleChange(true);
      await flushConnectionTestTick();
    });

    expect(findInputByPlaceholder(renderer!, placeholder).props.type).toBe(
      "password",
    );
    expect(antdMessage.error).toHaveBeenCalledWith(
      expect.stringContaining("系统密文存储当前不可用"),
    );
  });

  it("does not let a delayed password reveal overwrite a user replacement", async () => {
    let resolveReveal: ((value: string) => void) | undefined;
    backendApp.RevealSavedConnectionPrimaryPassword.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          resolveReveal = resolve;
        }),
    );
    Object.assign(window, {
      go: { app: { App: backendApp } },
    });
    const { default: ConnectionModal } = await import("./ConnectionModal");
    const connection = {
      ...initialConnection("mysql"),
      hasPrimaryPassword: true,
    };

    let renderer: ReactTestRenderer;
    let revealRequest: Promise<void>;
    await act(async () => {
      renderer = create(
        <ConnectionModal open onClose={vi.fn()} initialValues={connection} />,
      );
      await flushConnectionTestTick();
      revealRequest = findInputByPlaceholder(
        renderer,
        "••••••（留空表示继续沿用已保存密码）",
      ).props.visibilityToggle.onVisibleChange(true);
      await Promise.resolve();
    });

    expect(
      findInputByPlaceholder(
        renderer!,
        "••••••（留空表示继续沿用已保存密码）",
      ).props.type,
    ).toBe("password");
    setMockFormValues({ ...mockFormValues, password: "user-replacement" });
    await act(async () => {
      resolveReveal?.("stored-secret");
      await revealRequest!;
      await flushConnectionTestTick();
    });

    expect(mockFormValues.password).toBe("user-replacement");
  });

  it("does not let a delayed password reveal undo an explicit clear", async () => {
    let resolveReveal: ((value: string) => void) | undefined;
    backendApp.RevealSavedConnectionPrimaryPassword.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          resolveReveal = resolve;
        }),
    );
    Object.assign(window, {
      go: { app: { App: backendApp } },
    });
    const { default: ConnectionModal } = await import("./ConnectionModal");
    const connection = {
      ...initialConnection("mysql"),
      hasPrimaryPassword: true,
    };

    let renderer: ReactTestRenderer;
    let revealRequest: Promise<void>;
    await act(async () => {
      renderer = create(
        <ConnectionModal open onClose={vi.fn()} initialValues={connection} />,
      );
      await flushConnectionTestTick();
      revealRequest = findInputByPlaceholder(
        renderer,
        "••••••（留空表示继续沿用已保存密码）",
      ).props.visibilityToggle.onVisibleChange(true);
      await Promise.resolve();
    });

    await act(async () => {
      renderer!.root.findAll(
        (node) =>
          textContent(node).includes("清除已保存密码") &&
          typeof node.props.onChange === "function",
      )[0].props.onChange({ target: { checked: true } });
    });
    await act(async () => {
      resolveReveal?.("stored-secret");
      await revealRequest!;
      await flushConnectionTestTick();
    });

    expect(String(mockFormValues.password ?? "")).toBe("");
    await act(async () => {
      findButton(renderer!, "保存").props.onClick();
      await flushConnectionTestTick();
    });
    expect(backendApp.SaveConnection).toHaveBeenCalledWith(
      expect.objectContaining({ clearPrimaryPassword: true }),
    );
  });

  it("clears revealed password state when the modal closes or switches connections", async () => {
    let resolveReveal: ((value: string) => void) | undefined;
    backendApp.RevealSavedConnectionPrimaryPassword.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          resolveReveal = resolve;
        }),
    );
    Object.assign(window, {
      go: { app: { App: backendApp } },
    });
    const { default: ConnectionModal } = await import("./ConnectionModal");
    const firstConnection = {
      ...initialConnection("mysql"),
      hasPrimaryPassword: true,
    };
    const secondConnection = {
      ...initialConnection("postgres"),
      hasPrimaryPassword: true,
    };

    let renderer: ReactTestRenderer;
    let revealRequest: Promise<void>;
    await act(async () => {
      renderer = create(
        <ConnectionModal open onClose={vi.fn()} initialValues={firstConnection} />,
      );
      await flushConnectionTestTick();
      revealRequest = findInputByPlaceholder(
        renderer,
        "••••••（留空表示继续沿用已保存密码）",
      ).props.visibilityToggle.onVisibleChange(true);
      await Promise.resolve();
    });

    await act(async () => {
      renderer!.update(
        <ConnectionModal
          open={false}
          onClose={vi.fn()}
          initialValues={firstConnection}
        />,
      );
    });
    expect(String(mockFormValues.password ?? "")).toBe("");

    await act(async () => {
      renderer!.update(
        <ConnectionModal open onClose={vi.fn()} initialValues={secondConnection} />,
      );
      await flushConnectionTestTick();
    });
    expect(
      findInputByPlaceholder(
        renderer!,
        "••••••（留空表示继续沿用已保存密码）",
      ).props.visibilityToggle.visible,
    ).toBe(false);

    await act(async () => {
      resolveReveal?.("first-connection-secret");
      await revealRequest!;
      await flushConnectionTestTick();
    });
    expect(String(mockFormValues.password ?? "")).toBe("");
  });

  it("removes an already revealed password as soon as the modal closes", async () => {
    Object.assign(window, {
      go: { app: { App: backendApp } },
    });
    const { default: ConnectionModal } = await import("./ConnectionModal");
    const connection = {
      ...initialConnection("mysql"),
      hasPrimaryPassword: true,
    };
    const onClose = vi.fn();

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <ConnectionModal open onClose={onClose} initialValues={connection} />,
      );
      await flushConnectionTestTick();
      await findInputByPlaceholder(
        renderer,
        "••••••（留空表示继续沿用已保存密码）",
      ).props.visibilityToggle.onVisibleChange(true);
      await flushConnectionTestTick();
    });
    expect(mockFormValues.password).toBe("stored-secret");

    await act(async () => {
      findButton(renderer!, "取消").props.onClick();
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(String(mockFormValues.password ?? "")).toBe("");
  });

  it("preserves a revealed password unless the user actually replaces it", async () => {
    Object.assign(window, {
      go: { app: { App: backendApp } },
    });
    const { default: ConnectionModal } = await import("./ConnectionModal");
    const connection = {
      ...initialConnection("mysql"),
      hasPrimaryPassword: true,
    };

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <ConnectionModal open onClose={vi.fn()} initialValues={connection} />,
      );
      await flushConnectionTestTick();
      await findInputByPlaceholder(
        renderer,
        "••••••（留空表示继续沿用已保存密码）",
      ).props.visibilityToggle.onVisibleChange(true);
      await flushConnectionTestTick();
    });
    await act(async () => {
      findButton(renderer!, "保存").props.onClick();
      await flushConnectionTestTick();
    });
    expect(backendApp.SaveConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        clearPrimaryPassword: false,
        config: expect.objectContaining({ password: "" }),
      }),
    );

    await act(async () => {
      renderer!.unmount();
    });
    backendApp.SaveConnection.mockClear();
    let replacementRenderer: ReactTestRenderer;
    await act(async () => {
      replacementRenderer = create(
        <ConnectionModal open onClose={vi.fn()} initialValues={connection} />,
      );
      await flushConnectionTestTick();
      await findInputByPlaceholder(
        replacementRenderer,
        "••••••（留空表示继续沿用已保存密码）",
      ).props.visibilityToggle.onVisibleChange(true);
      await flushConnectionTestTick();
    });
    setMockFormValues({ ...mockFormValues, password: "user-replacement" });
    await act(async () => {
      findButton(replacementRenderer!, "保存").props.onClick();
      await flushConnectionTestTick();
    });
    expect(backendApp.SaveConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        clearPrimaryPassword: false,
        config: expect.objectContaining({ password: "user-replacement" }),
      }),
    );
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

  it(
    "renders localized create flow copy",
    async () => {

      setMockFormValues({
        type: "mysql",
        useSSL: true,
        sslMode: "preferred",
        timeout: 30,
      });
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

      setMockFormValues({
        ...mockFormValues,
        useSSL: true,
        sslMode: "preferred",
      });
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

  it(
    "renders English titles, footer copy, and raw-preserving failure feedback",
    async () => {

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
      setMockFormValues({
        type: "mysql",
        restrictDataEdit: true,
        restrictStructureEdit: true,
        restrictScriptExecution: false,
        restrictDataImport: false,
        useSSL: true,
        sslMode: "preferred",
        timeout: 30,
      });

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

    setCurrentLanguage("en-US");
    const { default: ConnectionModal } = await import("./ConnectionModal");

    setMockFormValues({
      mysqlTopology: "replica",
    });
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

    setMockFormValues({
      mongoTopology: "replica",
      mongoSrv: false,
      mongoReadPreference: "primary",
      mongoAuthMechanism: "",
    });
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

    setMockFormValues({
      redisTopology: "cluster",
    });
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
    expect(pageText).toContain("Leave empty when authentication is disabled");
    expect(pageText).toContain("Redis password");
    expect(pageText).toContain("Scope");
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
    expect(combinedConnectionModalSource).not.toContain("SelectSSHKnownHostsFile");
  });

  it("uses a complete Navicat tunnel URL and exposes base64 encoding without a form port", () => {
    expect(networkSecuritySource).toContain('name="httpTunnelHost"');
    expect(networkSecuritySource).toContain(
      '"connection.modal.network.httpTunnel.urlPlaceholder"',
    );
    expect(networkSecuritySource).toContain(
      'name="httpTunnelEncodeBase64"',
    );
    expect(networkSecuritySource).not.toContain('name="httpTunnelPort"');
    expect(step2Source).toContain("httpTunnelEncodeBase64: true");
    expect(combinedConnectionModalSource).toContain("config.httpTunnel?.encodeBase64 !== false");
  });
});
