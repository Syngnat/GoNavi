import { loadCatalog } from './i18n/catalog';
import { resolveLanguage } from './i18n/resolveLanguage';
import { isNativeDetachedWindowRoute } from './utils/nativeDetachedWindowRoute';
import { showBootSplashError } from './utils/bootSplash';

type DetachedBootstrapRuntime = {
  loadBootstrap?: () => Promise<{
    payload?: { storeState?: { languagePreference?: string } };
  }>;
};

// 开发模式下 WKWebView 经 wails:// 代理并发拉取上千个 ESM 模块时，
// 偶发单次请求瞬时失败（Importing a module script failed）。WebKit 会把
// 失败结果写进当前文档的模块映射表——同页面内重试同一 URL 不会重新
// 发请求，因此自愈必须整页重载（新文档 = 新模块映射）。已加载的模块
// 走 HTTP 缓存，重载代价很小。用 sessionStorage 计数防死循环。
const ENTRY_RELOAD_COUNT_KEY = 'gonavi-entry-reload-count';
const ENTRY_MAX_RELOADS = 3;
const ENTRY_RELOAD_BASE_DELAY_MS = 500;

const readBrowserLanguages = (): string[] => {
  if (typeof navigator === 'undefined') return [];
  if (Array.isArray(navigator.languages) && navigator.languages.length > 0) {
    return [...navigator.languages];
  }
  return navigator.language ? [navigator.language] : [];
};

const readDetachedLanguagePreference = async (): Promise<string | undefined> => {
  if (typeof window === 'undefined') return undefined;
  const runtime = (window as typeof window & {
    __GONAVI_DETACHED__?: DetachedBootstrapRuntime;
  }).__GONAVI_DETACHED__;
  if (typeof runtime?.loadBootstrap !== 'function') return undefined;
  try {
    const bootstrap = await runtime.loadBootstrap();
    return bootstrap.payload?.storeState?.languagePreference;
  } catch {
    return undefined;
  }
};

const loadEntry = async (): Promise<void> => {
  const detached = isNativeDetachedWindowRoute();
  const preference = detached ? await readDetachedLanguagePreference() : undefined;
  const language = resolveLanguage(preference, readBrowserLanguages());
  await loadCatalog(language);
  if (detached) {
    await import('./nativeDetachedMain');
  } else {
    await import('./main');
  }
};

const readReloadCount = (): number => {
  try {
    return Number(sessionStorage.getItem(ENTRY_RELOAD_COUNT_KEY) || '0') || 0;
  } catch {
    return 0;
  }
};

const clearReloadCount = (): void => {
  try {
    sessionStorage.removeItem(ENTRY_RELOAD_COUNT_KEY);
  } catch {
    // 无痕模式等场景下 sessionStorage 不可用时忽略
  }
};

void loadEntry().then(() => {
  clearReloadCount();
}).catch((error) => {
  console.error('[GoNavi] Failed to load frontend entry', error);
  // 生产构建是本地打包资源，失败重载无意义；仅开发模式自愈。
  if (!import.meta.env.DEV) {
    showBootSplashError(error instanceof Error ? error.message : String(error));
    return;
  }
  const reloadCount = readReloadCount();
  if (reloadCount >= ENTRY_MAX_RELOADS) {
    clearReloadCount();
    showBootSplashError(error instanceof Error ? error.message : String(error));
    return;
  }
  const nextDelay = ENTRY_RELOAD_BASE_DELAY_MS * (reloadCount + 1);
  console.warn(`[GoNavi] 前端入口加载失败，${nextDelay}ms 后整页重载自愈（第 ${reloadCount + 1}/${ENTRY_MAX_RELOADS} 次）`);
  try {
    sessionStorage.setItem(ENTRY_RELOAD_COUNT_KEY, String(reloadCount + 1));
  } catch {
    // sessionStorage 不可用时不计数，靠最长 3 次的自然上限兜底
  }
  window.setTimeout(() => { window.location.reload(); }, nextDelay);
});
