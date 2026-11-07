/**
 * Wails v3 compatibility bridge.
 *
 * The shipping v2 build injects `window.go` and `window.runtime` before the
 * app loads. Wails v3 injects `window._wails` instead and generated bindings
 * call the runtime package directly. This bridge keeps the existing generated
 * `frontend/wailsjs` imports working on both runtimes during the migration:
 * it only runs when v3 is present and v2 globals are absent.
 */

type AnyRecord = Record<string, any>;

const PACKAGE_NAMESPACES: Record<string, string> = {
    app: 'GoNavi-Wails/internal/app',
    aiservice: 'GoNavi-Wails/internal/ai/service',
    nativewindow: 'GoNavi-Wails/internal/nativewindow',
};

let removeFileDropListener: (() => void) | null = null;

function bindingName(namespace: string, service: string, method: string): string {
    const pkg = PACKAGE_NAMESPACES[namespace] ?? namespace;
    return `${pkg}.${service}.${method}`;
}

function createGoProxy(rt: typeof import('@wailsio/runtime')): AnyRecord {
    const serviceProxy = (namespace: string, service: string) =>
        new Proxy(
            {},
            {
                get: (_target, method) => {
                    if (typeof method !== 'string') {
                        return undefined;
                    }
                    return (...args: unknown[]) => rt.Call.ByName(bindingName(namespace, service, method), ...args);
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

function createRuntimeShim(rt: typeof import('@wailsio/runtime')): AnyRecord {
    const log = (level: 'log' | 'info' | 'warn' | 'error' | 'debug') => (message: unknown) =>
        console[level](message);

    return {
        LogPrint: log('log'),
        LogTrace: log('debug'),
        LogDebug: log('debug'),
        LogInfo: log('info'),
        LogWarning: log('warn'),
        LogError: log('error'),

        EventsOn: (name: string, callback: (...args: unknown[]) => void) =>
            rt.Events.On(name, (event) => spreadEventData(event?.data, callback)),
        EventsOnce: (name: string, callback: (...args: unknown[]) => void) =>
            rt.Events.Once(name, (event) => spreadEventData(event?.data, callback)),
        EventsOnMultiple: (name: string, callback: (...args: unknown[]) => void, count: number) =>
            rt.Events.OnMultiple(name, (event) => spreadEventData(event?.data, callback), count),
        // v3 Emit takes one payload; Go stores multiple arguments as an array.
        EventsEmit: (name: string, ...data: unknown[]) => {
            const emit = rt.Events.Emit as (eventName: string, ...payload: unknown[]) => Promise<boolean>;
            if (data.length === 0) {
                return emit(name);
            }
            return emit(name, data.length === 1 ? data[0] : data);
        },
        EventsOff: (...names: string[]) => {
            if (names.length > 0) {
                (rt.Events.Off as (...eventNames: string[]) => void)(...names);
            }
        },

        BrowserOpenURL: (url: string) => rt.Browser.OpenURL(url),

        WindowGetSize: () => rt.Window.Size().then((size) => ({ w: size.width, h: size.height })),
        WindowGetPosition: () => rt.Window.Position(),
        WindowSetSize: (width: number, height: number) => rt.Window.SetSize(width, height),
        WindowSetPosition: (x: number, y: number) => rt.Window.SetPosition(x, y),
        WindowSetTitle: (title: string) => rt.Window.SetTitle(title),
        WindowSetMinSize: (width: number, height: number) => rt.Window.SetMinSize(width, height),
        WindowSetMaxSize: (width: number, height: number) => rt.Window.SetMaxSize(width, height),
        WindowSetAlwaysOnTop: (onTop: boolean) => rt.Window.SetAlwaysOnTop(onTop),
        WindowCenter: () => rt.Window.Center(),
        WindowShow: () => rt.Window.Show(),
        WindowHide: () => rt.Window.Hide(),
        WindowMaximise: () => rt.Window.Maximise(),
        WindowUnmaximise: () => rt.Window.UnMaximise(),
        WindowToggleMaximise: () => rt.Window.ToggleMaximise(),
        WindowMinimise: () => rt.Window.Minimise(),
        WindowUnminimise: () => rt.Window.UnMinimise(),
        WindowFullscreen: () => rt.Window.Fullscreen(),
        WindowUnfullscreen: () => rt.Window.UnFullscreen(),
        WindowIsFullscreen: () => rt.Window.IsFullscreen(),
        WindowIsMaximised: () => rt.Window.IsMaximised(),
        WindowIsMinimised: () => rt.Window.IsMinimised(),
        WindowIsNormal: () =>
            Promise.all([
                rt.Window.IsFullscreen(),
                rt.Window.IsMaximised(),
                rt.Window.IsMinimised(),
            ]).then(([fullscreen, maximised, minimised]) => !fullscreen && !maximised && !minimised),
        WindowReload: () => rt.Window.Reload(),
        WindowReloadApp: () => rt.Window.ForceReload(),
        WindowSetBackgroundColour: (r: number, g: number, b: number, a: number) =>
            rt.Window.SetBackgroundColour(r, g, b, a),
        WindowSetSystemDefaultTheme: () => undefined,
        WindowSetLightTheme: () => undefined,
        WindowSetDarkTheme: () => undefined,

        ClipboardGetText: () => rt.Clipboard.Text(),
        ClipboardSetText: (text: string) => rt.Clipboard.SetText(text),

        Environment: () =>
            rt.System.Environment().then((environment) => ({
                buildType: environment.Debug ? 'dev' : 'production',
                platform: environment.OS,
                arch: environment.Arch,
            })),

        Quit: () => rt.Application.Quit(),
        Show: () => rt.Application.Show(),
        Hide: () => rt.Application.Hide(),

        // v3 delivers native drops to the window event bus in Go; the desktop
        // host forwards them as `gonavi:file-drop` for this shim.
        OnFileDrop: (callback: (x: number, y: number, paths: string[]) => void) => {
            removeFileDropListener?.();
            removeFileDropListener = rt.Events.On('gonavi:file-drop', (event) => {
                const payload = (event?.data ?? {}) as { x?: number; y?: number; paths?: string[] };
                callback(Number(payload.x ?? 0), Number(payload.y ?? 0), payload.paths ?? []);
            });
        },
        OnFileDropOff: () => {
            removeFileDropListener?.();
            removeFileDropListener = null;
        },
        CanResolveFilePaths: () => false,
    };
}

export async function installWails3Bridge(): Promise<void> {
    if (typeof window === 'undefined') {
        return;
    }
    const w = window as AnyRecord;
    if (!w._wails || w.go || w.runtime) {
        return;
    }
    // Loaded lazily: importing the v3 runtime in a v2 or browser build would
    // touch window._wails and break the shipping runtime.
    const rt = await import('@wailsio/runtime');
    w.go = createGoProxy(rt);
    w.runtime = createRuntimeShim(rt);
}

export const wails3Bridge = { installWails3Bridge };
