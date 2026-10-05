// 拆分后各场景文件共用的 describe 级 beforeEach / afterEach。
import { vi } from "vitest";
import { setCurrentLanguage } from "../i18n";
import {
    storeState,
    antdMessage,
    backendApp,
    setMockFormValues,
    setMockValidateFields,
    modalConfirm,
    modalTestState,
} from './connectionModalI18nTestSupport';

export const setUpConnectionModalI18nTest = () => {
    vi.stubGlobal("document", {
      body: {},
      getElementById: vi.fn(() => null),
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

    storeState.appearance.opacity = 1;
    storeState.pinnedConnectionTypes = [];
    modalTestState.connectionPanel = null;
    backendApp.GetDriverStatusList.mockResolvedValue({ success: true, data: { drivers: [] } });
    backendApp.SaveConnection.mockReset();
    backendApp.SaveConnection.mockImplementation(async (input) => ({
      ...input,
      config: { ...input.config, password: "" },
    }));
    backendApp.TestConnection.mockResolvedValue({ success: false, message: "saved connection not found: conn-1" });
    backendApp.TestConnectionWithProgress.mockReset();
    backendApp.TestConnectionWithProgress.mockResolvedValue({ success: true, message: "ok" });
    backendApp.NacosTestConnection.mockReset();
    backendApp.NacosTestConnection.mockResolvedValue({ success: true, message: "ok" });
    backendApp.NacosTestConnectionWithProgress.mockReset();
    backendApp.NacosTestConnectionWithProgress.mockResolvedValue({ success: true, message: "ok" });
    backendApp.CancelConnectionTest.mockReset();
    backendApp.CancelConnectionTest.mockResolvedValue({ success: true, data: { cancelled: true } });
    backendApp.DBGetDatabases.mockResolvedValue({ success: true, data: [] });
    backendApp.MongoDiscoverMembers.mockResolvedValue({ success: true, data: { members: [] } });
    backendApp.RedisConnect.mockResolvedValue({ success: true, message: "ok" });
    backendApp.RevealSavedConnectionPrimaryPassword.mockReset();
    backendApp.RevealSavedConnectionPrimaryPassword.mockResolvedValue("stored-secret");
    backendApp.TestJVMConnection.mockResolvedValue({ success: true, message: "ok" });
    backendApp.SelectDatabaseFile.mockReset();
    backendApp.SelectCertificateFile.mockReset();
    backendApp.SelectSSHKeyFile.mockReset();
    backendApp.SelectSSHKnownHostsFile.mockReset();
    backendApp.TrustSSHHostKeyForConnection.mockReset();
    backendApp.TrustSSHHostKeyForConnection.mockResolvedValue({ success: true, message: "saved" });
    antdMessage.error.mockReset();
    antdMessage.warning.mockReset();
    antdMessage.success.mockReset();
    antdMessage.destroy.mockReset();
    modalConfirm.mockReset();
    storeState.addConnection.mockReset();
    storeState.updateConnection.mockReset();
    storeState.setConnectionTypePinned.mockClear();
    storeState.setLanguagePreference.mockClear();
    setMockFormValues({});
    setMockValidateFields(undefined);
    setCurrentLanguage("zh-CN");
  };
