import React, { useEffect, useSyncExternalStore } from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
// import './index.css' // Optional global styles

import { setCurrentLanguage } from './i18n';
import { I18nProvider } from './i18n/provider'
import { applyDayjsLocale } from './i18n/runtime'
import { useStore } from './store'
import RootErrorBoundary from './components/RootErrorBoundary'
import { hideBootSplash } from './utils/bootSplash'
import {
    signalMainWindowFrontendReady, waitForMainWindowContentPaint,
    waitForStartupWindowGeometrySettled,
} from './utils/mainWindowStartup'
import { configureAntdStaticOverlayLayer } from './utils/overlayZIndex'
import { devHarnessMode } from './dev/devHarnessMode';
import { installBrowserMockRuntime } from './dev/browserMock/installBrowserMockRuntime';
import { startPluginInstallDeeplinkListener } from './components/pluginManager/pluginInstallDeeplink';
import { installIpcMeter } from './utils/ipcMeter';
import { installTabSwitchProbe } from './utils/tabSwitchProbe';

configureAntdStaticOverlayLayer();

if (
    typeof window !== 'undefined'
    && (
        typeof (window as any).go?.app?.App?.GetSavedConnections !== 'function'
        || typeof (window as any).go?.aiservice?.Service?.AIGetProviders !== 'function'
    )
) {
    installBrowserMockRuntime();
}
// 诊断设施安装点（各一行，默认关闭、只读计量）。放在 mock 之后：dev/Web 模式下绑定由 mock 提供。
installIpcMeter();
installTabSwitchProbe(useStore);
const rootNode = document.getElementById('root')!;

const readBrowserLanguages = (): string[] => {
    if (typeof navigator === 'undefined') return [];
    if (Array.isArray(navigator.languages) && navigator.languages.length > 0) {
        return [...navigator.languages];
    }
    return navigator.language ? [navigator.language] : [];
};

const serializeBrowserLanguages = (languages: readonly string[]) => languages.join('\n');

const deserializeBrowserLanguages = (snapshot: string) =>
    snapshot ? snapshot.split('\n').filter(Boolean) : [];

const getBrowserLanguageSnapshot = () => serializeBrowserLanguages(readBrowserLanguages());

const subscribeBrowserLanguageChange = (listener: () => void) => {
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') {
        return () => {};
    }
    window.addEventListener('languagechange', listener);
    return () => {
        if (typeof window.removeEventListener === 'function') {
            window.removeEventListener('languagechange', listener);
        }
    };
};

const subscribeStoreHydration = (listener: () => void) => {
    if (useStore.persist.hasHydrated()) {
        listener();
        return () => {};
    }
    return useStore.persist.onFinishHydration(() => {
        listener();
    });
};

const getStoreHydrationSnapshot = () => useStore.persist.hasHydrated();

const Root = ({ rootComponent }: { rootComponent: React.ReactNode }) => {
    const isStoreHydrated = useSyncExternalStore(
        subscribeStoreHydration,
        getStoreHydrationSnapshot,
        getStoreHydrationSnapshot,
    );
    const languagePreference = useStore((state) => state.languagePreference);
    const setLanguagePreference = useStore((state) => state.setLanguagePreference);
    const browserLanguageSnapshot = useSyncExternalStore(
        subscribeBrowserLanguageChange,
        getBrowserLanguageSnapshot,
        getBrowserLanguageSnapshot,
    );

    useEffect(() => {
        if (!isStoreHydrated) {
            return;
        }
        // 市场网站 gonavi://plugin/install 的接收端；订阅先行，早于首屏握手发出。
        const stopPluginInstallDeeplink = startPluginInstallDeeplinkListener();
        let cancelled = false;
        // 先撤启动遮罩（Web 模式没有原生窗口可等），再等启动窗口几何落到最终
        // 状态后才发首屏握手：主窗口此时仍隐藏，用户看不到“小窗 → 全屏”的过渡。
        void waitForMainWindowContentPaint().then(() => {
            if (cancelled) return;
            hideBootSplash();
            return waitForStartupWindowGeometrySettled();
        }).then(() => {
            if (cancelled) return;
            signalMainWindowFrontendReady();
        });
        return () => {
            cancelled = true;
            stopPluginInstallDeeplink();
        };
    }, [isStoreHydrated]);

    if (!isStoreHydrated) {
        return null;
    }

    const systemLanguages = deserializeBrowserLanguages(browserLanguageSnapshot);
    const resolvedLanguage = setCurrentLanguage(languagePreference, systemLanguages);
    applyDayjsLocale(resolvedLanguage);

    return (
        <I18nProvider
            preference={languagePreference}
            onPreferenceChange={setLanguagePreference}
            systemLanguages={systemLanguages}
        >
            {rootComponent}
        </I18nProvider>
    );
};

const renderRoot = async () => {
    let rootComponent: React.ReactNode = <App />;
    if (devHarnessMode === 'datagrid-perf') {
        const { default: PerfDataGridHarness } = await import('./dev/PerfDataGridHarness');
        rootComponent = <PerfDataGridHarness />;
    }

    ReactDOM.createRoot(rootNode).render(
      <React.StrictMode>
        <RootErrorBoundary>
          <Root rootComponent={rootComponent} />
        </RootErrorBoundary>
      </React.StrictMode>,
    );
};

void renderRoot();
