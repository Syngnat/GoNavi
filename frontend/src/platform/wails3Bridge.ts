/**
 * Wails v3 compatibility bridge.
 *
 * The shipping v2 build injects `window.go` and `window.runtime` before the
 * app loads. Wails v3 injects its runtime only after navigation completes and
 * ships no v2-shaped globals, so this bridge installs them as soon as the Go
 * side marks the document with `__GONAVI_WAILS3__`. Bindings and runtime calls
 * wait for `window._wails` and then load `@wailsio/runtime` lazily, which keeps
 * the v2 and browser builds untouched.
 */

type AnyRecord = Record<string, any>;
type WailsRuntime = typeof import('@wailsio/runtime');

const PACKAGE_NAMESPACES: Record<string, string> = {
    app: 'GoNavi-Wails/internal/app',
    aiservice: 'GoNavi-Wails/internal/ai/service',
    nativewindow: 'GoNavi-Wails/internal/nativewindow',
};

// The v3 build registers V3Manager (native windows in the same process); the
// frontend keeps calling the v2-generated Manager namespace.
const SERVICE_ALIASES: Record<string, string> = {
    'nativewindow.Manager': 'V3Manager',
};

let runtimePromise: Promise<WailsRuntime> | null = null;
let removeFileDropListener: (() => void) | null = null;

function loadWails3Runtime(): Promise<WailsRuntime> {
    if (!runtimePromise) {
        runtimePromise = new Promise<WailsRuntime>((resolve) => {
            const attempt = () => {
                if ((window as AnyRecord)._wails) {
                    void import('@wailsio/runtime').then(resolve);
                    return;
                }
                window.setTimeout(attempt, 20);
            };
            attempt();
        });
    }
    return runtimePromise;
}

function whenRuntime(callback: (rt: WailsRuntime) => void): void {
    void loadWails3Runtime().then(callback);
}

function bindingName(namespace: string, service: string, method: string): string {
    const pkg = PACKAGE_NAMESPACES[namespace] ?? namespace;
    const serviceName = SERVICE_ALIASES[`${namespace}.${service}`] ?? service;
    return `${pkg}.${serviceName}.${method}`;
}

function createGoProxy(): AnyRecord {
    const serviceProxy = (namespace: string, service: string) =>
        new Proxy(
            {},
            {
                get: (_target, method) => {
                    if (typeof method !== 'string') {
                        return undefined;
                    }
                    return (...args: unknown[]) =>
                        loadWails3Runtime().then((rt) =>
                            rt.Call.ByName(bindingName(namespace, service, method), ...args),
                        );
                },
            },
        );

    return new Proxy(
        {},
        {
            get: (_target, namespace) => {
                if (typeof namespace !== 'string') {
                    return undefined;
                }
                return new Proxy(
                    {},
                    {
                        get: (_serviceTarget, service) => {
                            if (typeof service !== 'string') {
                                return undefined;
                            }
                            return serviceProxy(namespace, service);
                        },
                    },
                );
            },
        },
    );
}

function spreadEventData(data: unknown, callback: (...args: unknown[]) => void): void {
    if (data === undefined || data === null) {
        callback();
        return;
    }
    if (Array.isArray(data)) {
        callback(...data);
        return;
    }
    callback(data);
}

function subscribeEvent(
    name: string,
    callback: (...args: unknown[]) => void,
): () => void {
    let cancelled = false;
    let unsubscribe: (() => void) | null = null;
    void loadWails3Runtime().then((rt) => {
        if (cancelled) {
            return;
        }
        unsubscribe = rt.Events.On(name, (event) => spreadEventData(event?.data, callback));
    });
    return () => {
        cancelled = true;
        unsubscribe?.();
    };
}

function createRuntimeShim(): AnyRecord {
    const log = (level: 'log' | 'info' | 'warn' | 'error' | 'debug') => (message: unknown) =>
        console[level](message);

    return {
        LogPrint: log('log'),
        LogTrace: log('debug'),
        LogDebug: log('debug'),
        LogInfo: log('info'),
        LogWarning: log('warn'),
        LogError: log('error'),

        EventsOn: subscribeEvent,
        EventsOnce: (name: string, callback: (...args: unknown[]) => void) => {
            let cancelled = false;
            let unsubscribe: (() => void) | null = null;
            void loadWails3Runtime().then((rt) => {
                if (!cancelled) {
                    unsubscribe = rt.Events.Once(name, (event) =>
                        spreadEventData(event?.data, callback),
                    );
                }
            });
            return () => {
                cancelled = true;
                unsubscribe?.();
            };
        },
        EventsOnMultiple: (name: string, callback: (...args: unknown[]) => void, count: number) => {
            let cancelled = false;
            let unsubscribe: (() => void) | null = null;
            void loadWails3Runtime().then((rt) => {
                if (!cancelled) {
                    unsubscribe = rt.Events.OnMultiple(
                        name,
                        (event) => spreadEventData(event?.data, callback),
                        count,
                    );
                }
            });
            return () => {
                cancelled = true;
                unsubscribe?.();
            };
        },
        // v3 Emit takes one payload; Go stores multiple arguments as an array.
        EventsEmit: (name: string, ...data: unknown[]) =>
            loadWails3Runtime().then((rt) => {
                const emit = rt.Events.Emit as (eventName: string, ...payload: unknown[]) => Promise<boolean>;
                if (data.length === 0) {
                    return emit(name);
                }
                return emit(name, data.length === 1 ? data[0] : data);
            }),
        EventsOff: (...names: string[]) => {
            if (names.length === 0) {
                return;
            }
            whenRuntime((rt) => {
                (rt.Events.Off as (...eventNames: string[]) => void)(...names);
            });
        },
        EventsOffAll: () => whenRuntime((rt) => rt.Events.OffAll()),

        BrowserOpenURL: (url: string) => whenRuntime((rt) => void rt.Browser.OpenURL(url)),

        WindowGetSize: () =>
            loadWails3Runtime().then((rt) =>
                rt.Window.Size().then((size) => ({ w: size.width, h: size.height })),
            ),
        WindowGetPosition: () => loadWails3Runtime().then((rt) => rt.Window.Position()),
        WindowSetSize: (width: number, height: number) =>
            whenRuntime((rt) => void rt.Window.SetSize(width, height)),
        WindowSetPosition: (x: number, y: number) =>
            whenRuntime((rt) => void rt.Window.SetPosition(x, y)),
        WindowSetTitle: (title: string) => whenRuntime((rt) => void rt.Window.SetTitle(title)),
        WindowSetMinSize: (width: number, height: number) =>
            whenRuntime((rt) => void rt.Window.SetMinSize(width, height)),
        WindowSetMaxSize: (width: number, height: number) =>
            whenRuntime((rt) => void rt.Window.SetMaxSize(width, height)),
        WindowSetAlwaysOnTop: (onTop: boolean) =>
            whenRuntime((rt) => void rt.Window.SetAlwaysOnTop(onTop)),
        WindowCenter: () => whenRuntime((rt) => void rt.Window.Center()),
        WindowShow: () => whenRuntime((rt) => void rt.Window.Show()),
        WindowHide: () => whenRuntime((rt) => void rt.Window.Hide()),
        WindowMaximise: () => whenRuntime((rt) => void rt.Window.Maximise()),
        WindowUnmaximise: () => whenRuntime((rt) => void rt.Window.UnMaximise()),
        WindowToggleMaximise: () => whenRuntime((rt) => void rt.Window.ToggleMaximise()),
        WindowMinimise: () => whenRuntime((rt) => void rt.Window.Minimise()),
        WindowUnminimise: () => whenRuntime((rt) => void rt.Window.UnMinimise()),
        WindowFullscreen: () => whenRuntime((rt) => void rt.Window.Fullscreen()),
        WindowUnfullscreen: () => whenRuntime((rt) => void rt.Window.UnFullscreen()),
        WindowIsFullscreen: () => loadWails3Runtime().then((rt) => rt.Window.IsFullscreen()),
        WindowIsMaximised: () => loadWails3Runtime().then((rt) => rt.Window.IsMaximised()),
        WindowIsMinimised: () => loadWails3Runtime().then((rt) => rt.Window.IsMinimised()),
        WindowIsNormal: () =>
            loadWails3Runtime().then((rt) =>
                Promise.all([
                    rt.Window.IsFullscreen(),
                    rt.Window.IsMaximised(),
                    rt.Window.IsMinimised(),
                ]).then(([fullscreen, maximised, minimised]) => !fullscreen && !maximised && !minimised),
            ),
        WindowReload: () => whenRuntime((rt) => void rt.Window.Reload()),
        WindowReloadApp: () => whenRuntime((rt) => void rt.Window.ForceReload()),
        WindowSetBackgroundColour: (r: number, g: number, b: number, a: number) =>
            whenRuntime((rt) => void rt.Window.SetBackgroundColour(r, g, b, a)),
        WindowSetSystemDefaultTheme: () => undefined,
        WindowSetLightTheme: () => undefined,
        WindowSetDarkTheme: () => undefined,

        ClipboardGetText: () => loadWails3Runtime().then((rt) => rt.Clipboard.Text()),
        ClipboardSetText: (text: string) =>
            loadWails3Runtime().then((rt) => rt.Clipboard.SetText(text)),

        Environment: () =>
            loadWails3Runtime().then((rt) =>
                rt.System.Environment().then((environment) => ({
                    buildType: environment.Debug ? 'dev' : 'production',
                    platform: environment.OS,
                    arch: environment.Arch,
                })),
            ),

        Quit: () => whenRuntime((rt) => void rt.Application.Quit()),
        Show: () => whenRuntime((rt) => void rt.Application.Show()),
        Hide: () => whenRuntime((rt) => void rt.Application.Hide()),

        // v3 delivers native drops to the window event bus in Go; the desktop
        // host forwards them as `gonavi:file-drop` for this shim.
        OnFileDrop: (callback: (x: number, y: number, paths: string[]) => void) => {
            removeFileDropListener?.();
            removeFileDropListener = subscribeEvent('gonavi:file-drop', (payload) => {
                const record = (payload ?? {}) as { x?: number; y?: number; paths?: string[] };
                callback(Number(record.x ?? 0), Number(record.y ?? 0), record.paths ?? []);
            });
        },
        OnFileDropOff: () => {
            removeFileDropListener?.();
            removeFileDropListener = null;
        },
        CanResolveFilePaths: () => false,
    };
}

export function installWails3Bridge(): void {
    if (typeof window === 'undefined') {
        return;
    }
    const w = window as AnyRecord;
    const isWails3 = w.__GONAVI_WAILS3__ === true || Boolean(w._wails);
    if (!isWails3 || w.__GONAVI_V3_BRIDGE__) {
        return;
    }
    w.__GONAVI_V3_BRIDGE__ = true;
    // Replace the browser mock and any partial v2 compatibility object before
    // the app renders. The proxies resolve once the v3 runtime is injected.
    w.go = createGoProxy();
    w.runtime = createRuntimeShim();
}

export const wails3Bridge = { installWails3Bridge };
