import { EventsOn } from '../../../wailsjs/runtime';

/**
 * 桌面端把市场网站的 `gonavi://plugin/install` 链接转成的事件。载荷只是提示：
 * spec 交给安装面板重新解析并走既有「检查 → 确认摘要 → 安装」流程，
 * 链接本身永远不会被直接安装。
 */
export const PLUGIN_INSTALL_DEEPLINK_EVENT = 'gonavi:deeplink:plugin-install';

export interface PluginInstallDeeplinkPayload {
  /** 市场页面建议的安装源（github:owner/repo、npm 包名）；面板会再次解析。 */
  spec?: string;
  /** 市场插件 ID；市场服务接入前只能预填输入框，无法自动检查。 */
  id?: string;
}

let pending: PluginInstallDeeplinkPayload | null = null;
const listeners = new Set<(payload: PluginInstallDeeplinkPayload) => void>();

/** 未消费的深链安装请求；面板挂载时取走。 */
export const peekPendingPluginInstall = (): PluginInstallDeeplinkPayload | null => pending;

export const consumePendingPluginInstall = (): PluginInstallDeeplinkPayload | null => {
  const value = pending;
  pending = null;
  return value;
};

export const subscribePluginInstallDeeplink = (
  listener: (payload: PluginInstallDeeplinkPayload) => void,
): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

const normalize = (payload: unknown): PluginInstallDeeplinkPayload | null => {
  if (!payload || typeof payload !== 'object') return null;
  const read = (value: unknown, max: number): string =>
    typeof value === 'string' ? value.trim().slice(0, max) : '';
  const spec = read((payload as Record<string, unknown>).spec, 200);
  const id = read((payload as Record<string, unknown>).id, 120);
  if (!spec && !id) return null;
  return { spec: spec || undefined, id: id || undefined };
};

/** 打开插件工作台 Tab（与标题栏按钮同一条去重路径）。 */
const openPluginWorkbenchTab = async (): Promise<void> => {
  const [{ useStore }, { buildPluginManagerWorkbenchTab }] = await Promise.all([
    import('../../store'),
    import('../../utils/pluginManagerTab'),
  ]);
  useStore.getState().addTab(buildPluginManagerWorkbenchTab());
};

/**
 * 应用启动时订阅一次桌面端的深链安装事件。Web / 浏览器 mock 环境没有事件总线时静默跳过。
 */
export const startPluginInstallDeeplinkListener = (): (() => void) => {
  try {
    return EventsOn(PLUGIN_INSTALL_DEEPLINK_EVENT, (data: unknown) => {
      const payload = normalize(data);
      if (!payload) return;
      pending = payload;
      listeners.forEach((listener) => listener(payload));
      void openPluginWorkbenchTab();
    });
  } catch {
    return () => {};
  }
};

/** 仅供测试：模拟桌面端投递（不打开 Tab），返回载荷是否被接受。 */
export const dispatchPluginInstallForTest = (payload: unknown): boolean => {
  const normalized = normalize(payload);
  if (!normalized) return false;
  pending = normalized;
  listeners.forEach((listener) => listener(normalized));
  return true;
};
