/** @vitest-environment jsdom */
import { afterEach, expect, it, vi } from 'vitest';
import { bridgePrefix } from './protocol';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it('installs initial HTML preferences synchronously and ignores late bootstrap and heartbeat after pagehide', async () => {
 vi.useFakeTimers();
 const events = vi.fn(); window.addEventListener('gonavi:host-preferences', events);
 window.__gonaviPluginBootstrap = { pluginId: 'test.one', generation: 2, title: 'Fixture', preferencesRevision: 2, preferences: { locale: 'zh-CN', theme: 'light', palette: { bg: '#445566' } } };
 let bootstrap!: (response: Response) => void;
 let heartbeat!: (response: Response) => void;
 const fetcher = vi.fn(async (url: RequestInfo | URL) => new Promise<Response>(resolve => {
  if (url === bridgePrefix + 'bootstrap') bootstrap = resolve; else heartbeat = resolve;
 }));
 vi.stubGlobal('fetch', fetcher);
 await import('./runtime');
 expect(window.gonaviHostPrefs?.palette?.bg).toBe('rgb(68, 85, 102)');
 expect(window.__gonaviPluginBootstrap).toBeUndefined();
 window.dispatchEvent(new Event('pagehide'));
 const response = () => new Response(JSON.stringify({ pluginId: 'test.one', generation: 2, title: 'Fixture', preferencesRevision: 9, preferences: { locale: 'en-US', theme: 'dark' } }));
 bootstrap(response()); heartbeat(response()); await window.gonaviPlugin.ready;
 await vi.advanceTimersByTimeAsync(5000);
 expect(window.gonaviHostPrefs?.theme).toBe('light'); expect(events).toHaveBeenCalledTimes(1); expect(fetcher).toHaveBeenCalledTimes(2);
 window.removeEventListener('gonavi:host-preferences', events);
});
