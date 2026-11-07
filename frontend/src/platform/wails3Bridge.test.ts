// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { installWails3Bridge } from './wails3Bridge';

const runtimeWindow = window as unknown as Record<string, any>;

const clearBridge = () => {
    delete runtimeWindow.go;
    delete runtimeWindow.runtime;
    delete runtimeWindow._wails;
    delete runtimeWindow.__GONAVI_WAILS3__;
    delete runtimeWindow.__GONAVI_V3_BRIDGE__;
};

afterEach(clearBridge);

describe('installWails3Bridge', () => {
    it('leaves the v2 and browser runtimes untouched', () => {
        runtimeWindow.go = { app: { App: { GetSavedConnections: () => Promise.resolve([]) } } };
        runtimeWindow.runtime = { WindowGetSize: () => Promise.resolve({ w: 1, h: 1 }) };

        installWails3Bridge();

        expect(runtimeWindow.__GONAVI_V3_BRIDGE__).toBeUndefined();
        expect(runtimeWindow.go.app.App.GetSavedConnections).toBeInstanceOf(Function);
    });

    it('installs the complete v2-shaped surface before the v3 runtime arrives', () => {
        runtimeWindow.__GONAVI_WAILS3__ = true;

        installWails3Bridge();

        expect(runtimeWindow.__GONAVI_V3_BRIDGE__).toBe(true);
        expect(typeof runtimeWindow.go.app.App.GetSavedConnections).toBe('function');
        expect(typeof runtimeWindow.go.aiservice.Service.AIGetProviders).toBe('function');
        expect(typeof runtimeWindow.go.nativewindow.Manager.Open).toBe('function');
        expect(typeof runtimeWindow.runtime.EventsOn).toBe('function');
        expect(typeof runtimeWindow.runtime.WindowGetSize).toBe('function');
        expect(typeof runtimeWindow.runtime.OnFileDrop).toBe('function');
        expect(runtimeWindow.runtime.CanResolveFilePaths()).toBe(false);
    });

    it('does not replace an already installed bridge', () => {
        runtimeWindow.__GONAVI_WAILS3__ = true;
        installWails3Bridge();
        const installedGo = runtimeWindow.go;

        installWails3Bridge();

        expect(runtimeWindow.go).toBe(installedGo);
    });
});
