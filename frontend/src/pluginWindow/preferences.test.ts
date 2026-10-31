/** @vitest-environment jsdom */
import { afterEach, expect, it, vi } from 'vitest';

import { createPluginBridge } from './bridge';
import { startPluginHeartbeat } from './heartbeat';
import { bridgePrefix } from './protocol';
import { createPreferenceReceiver, HOST_PREFERENCES_EVENT } from './preferences';

const response = (revision: number, bg: string) => new Response(JSON.stringify({ pluginId: 'test.one', generation: 2, title: 'Fixture', preferencesRevision: revision, preferences: { locale: 'zh-CN', theme: 'light', palette: { bg } } }));
afterEach(() => { vi.useRealTimers(); Reflect.deleteProperty(window, 'gonaviHostPrefs'); });

it('keeps a newer heartbeat when bootstrap arrives late, and emits only changes without resetting input', async () => {
 vi.useFakeTimers();
 const receive = createPreferenceReceiver();
 const events = vi.fn();
 window.addEventListener(HOST_PREFERENCES_EVENT, events);
 const input = document.createElement('textarea'); document.body.append(input);
 input.value = 'keep session input'; input.setSelectionRange(2, 6);
 let finish!: (response: Response) => void;
 const fetcher = vi.fn(async (url: RequestInfo | URL) => url === bridgePrefix + 'bootstrap'
   ? new Promise<Response>(resolve => { finish = resolve; }) : response(2, '#445566'));
 const bridge = createPluginBridge(fetcher, () => 'unused', receive);
 const stop = startPluginHeartbeat(fetcher, receive);
 await vi.advanceTimersByTimeAsync(0);
 expect(window.gonaviHostPrefs?.palette?.bg).toBe('rgb(68, 85, 102)');
 finish(response(1, '#112233')); await bridge.ready;
 await vi.advanceTimersByTimeAsync(1000);
 expect(events).toHaveBeenCalledTimes(1);
 expect(input.value).toBe('keep session input'); expect(input.selectionStart).toBe(2); expect(input.selectionEnd).toBe(6);
 stop(); input.remove(); window.removeEventListener(HOST_PREFERENCES_EVENT, events);
});

it('stops in-flight heartbeat publication and remains compatible with old 204 hosts', async () => {
 vi.useFakeTimers();
 let finish!: (response: Response) => void;
 const receive = vi.fn();
 const fetcher = vi.fn(async () => new Promise<Response>(resolve => { finish = resolve; }));
 const stop = startPluginHeartbeat(fetcher, receive); stop(); finish(response(3, '#123456'));
 await vi.advanceTimersByTimeAsync(5000);
 expect(receive).not.toHaveBeenCalled(); expect(fetcher).toHaveBeenCalledTimes(1);
 const legacy = vi.fn(async () => new Response(null, { status: 204 }));
 const stopLegacy = startPluginHeartbeat(legacy, receive);
 await vi.advanceTimersByTimeAsync(1000); stopLegacy();
 expect(legacy).toHaveBeenCalledTimes(2); expect(receive).not.toHaveBeenCalled();
});

it('drops unsafe CSS, unknown data, and wrong generation without publishing plugin assets', () => {
 const receive = createPreferenceReceiver();
 receive({ generation: 2, preferencesRevision: 1, preferences: { locale: 'zh-CN', theme: 'light', palette: { bg: 'url(file:///secret)', accent: '#123456', secret: 'hidden' }, appearance: { fontFamily: 'x; color:red', radius: 8, background: { enabled: true, url: 'file:///private' } }, rawCSS: 'unsafe' } });
 expect(window.gonaviHostPrefs).toEqual({ locale: 'zh-CN', theme: 'light', palette: { accent: 'rgb(18, 52, 86)' }, appearance: { radius: 8, background: { enabled: true } } });
 receive({ generation: 1, preferencesRevision: 9, preferences: { locale: 'en-US', theme: 'dark' } });
 expect(window.gonaviHostPrefs?.theme).toBe('light');
});

it('publishes bootstrap preferences before ready resolves', async () => {
 const bridge = createPluginBridge(vi.fn(async () => response(1, '#123456')), () => 'unused');
 await bridge.ready;
 expect(window.gonaviHostPrefs).toEqual({ locale: 'zh-CN', theme: 'light', palette: { bg: 'rgb(18, 52, 86)' } });
});
