import { act, create } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
const host = vi.hoisted(() => ({ PluginList: vi.fn(), PluginInspect: vi.fn(), PluginInstall: vi.fn(),
  PluginSetEnabled: vi.fn(), PluginRemove: vi.fn(), PluginInvoke: vi.fn(), PluginOpenWindow: vi.fn(), PluginRuntimeInfo: vi.fn() }));
vi.mock('../../wailsjs/go/app/App', () => host);
import { usePluginInvocation } from './usePluginInvocation';
import { I18nProvider } from '../i18n/provider';
import type { LanguagePreference } from '../i18n/types';
import { useStore } from '../store';
vi.mock('../i18n/runtime', () => ({ syncLanguageRuntime: vi.fn(async () => undefined) }));
const initialAppearance = { languagePreference: useStore.getState().languagePreference,
  themePreference: useStore.getState().themePreference, theme: useStore.getState().theme };
let invocation: ReturnType<typeof usePluginInvocation>;
let renderer: ReturnType<typeof create> | undefined;
function InvocationProbe({ generation, active }: { generation: number; active: boolean }) {
  invocation = usePluginInvocation('test.hello', generation, active); return null;
}
function Harness({ generation, active, preference = 'zh-CN' }: {
  generation: number; active: boolean; preference?: LanguagePreference;
}) {
  return <I18nProvider preference={preference} onPreferenceChange={() => undefined}>
    <InvocationProbe generation={generation} active={active} />
  </I18nProvider>;
}
afterEach(() => {
  if (renderer) act(() => renderer!.unmount());
  renderer = undefined; useStore.setState(initialAppearance); vi.resetAllMocks(); vi.unstubAllGlobals();
});
describe('plugin window appearance', () => {
  it.each<{ preference: LanguagePreference; systemLanguages: string[]; expected: string }>([
    { preference: 'system', systemLanguages: ['fr-FR', 'de-DE'], expected: 'de-DE' },
    { preference: 'system', systemLanguages: ['fr-FR'], expected: 'en-US' },
    { preference: 'system', systemLanguages: ['zh-HK'], expected: 'zh-TW' },
    { preference: 'system', systemLanguages: ['de-DE', 'zh-CN'], expected: 'de-DE' },
    { preference: 'zh-CN', systemLanguages: ['de-DE'], expected: 'zh-CN' },
    { preference: 'en-US', systemLanguages: ['zh-HK'], expected: 'en-US' },
    { preference: 'ja-JP', systemLanguages: ['fr-FR', 'de-DE'], expected: 'ja-JP' },
  ])('passes resolved $expected for $preference with $systemLanguages', async ({ preference, systemLanguages, expected }) => {
    vi.stubGlobal('navigator', { language: systemLanguages[0], languages: systemLanguages });
    useStore.setState({ languagePreference: preference, themePreference: 'light', theme: 'light' });
    host.PluginOpenWindow.mockResolvedValue({ success: true });
    await act(async () => { renderer = create(<Harness generation={1} active preference={preference} />); });
    await act(async () => { await invocation.openWindow(); });
    expect(host.PluginOpenWindow).toHaveBeenCalledWith('test.hello', expected, 'light');
  });
  it('follows a language change from the main provider', async () => {
    vi.stubGlobal('navigator', { language: 'fr-FR', languages: ['fr-FR', 'de-DE'] });
    useStore.setState({ languagePreference: 'system', themePreference: 'light', theme: 'light' });
    host.PluginOpenWindow.mockResolvedValue({ success: true });
    await act(async () => { renderer = create(<Harness generation={1} active preference="system" />); });
    await act(async () => { await invocation.openWindow(); });
    expect(host.PluginOpenWindow).toHaveBeenLastCalledWith('test.hello', 'de-DE', 'light');
    await act(async () => { renderer!.update(<Harness generation={1} active preference="ru-RU" />); });
    await act(async () => { await invocation.openWindow(); });
    expect(host.PluginOpenWindow).toHaveBeenLastCalledWith('test.hello', 'ru-RU', 'light');
  });
  it.each<{ preference: 'system' | 'light' | 'dark'; theme: 'light' | 'dark'; systemDark: boolean }>([
    { preference: 'system', theme: 'dark', systemDark: false },
    { preference: 'system', theme: 'light', systemDark: true },
    { preference: 'dark', theme: 'dark', systemDark: false },
    { preference: 'light', theme: 'light', systemDark: true },
  ])('uses resolved $theme for $preference without querying the system', async ({ preference, theme, systemDark }) => {
    const matchMedia = vi.fn(() => ({ matches: systemDark }));
    vi.stubGlobal('window', { matchMedia });
    useStore.setState({ languagePreference: 'zh-CN', themePreference: preference, theme });
    host.PluginOpenWindow.mockResolvedValue({ success: true });
    await act(async () => { renderer = create(<Harness generation={1} active />); });
    await act(async () => { await invocation.openWindow(); });
    expect(host.PluginOpenWindow).toHaveBeenCalledWith('test.hello', 'zh-CN', theme);
    expect(matchMedia).not.toHaveBeenCalled();
  });
  it('reads the current store theme when a window is opened', async () => {
    vi.stubGlobal('window', { matchMedia: vi.fn(() => ({ matches: false })) });
    useStore.setState({ languagePreference: 'zh-CN', themePreference: 'system', theme: 'light' });
    host.PluginOpenWindow.mockResolvedValue({ success: true });
    await act(async () => { renderer = create(<Harness generation={1} active />); });
    useStore.setState({ theme: 'dark' });
    await act(async () => { await invocation.openWindow(); });
    expect(host.PluginOpenWindow).toHaveBeenCalledWith('test.hello', 'zh-CN', 'dark');
  });
});
describe('invocation generation fencing', () => {
  it('ignores stale results after disable and after a new generation starts', async () => {
    let finish: (result: unknown) => void = () => {};
    host.PluginInvoke.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }))
      .mockResolvedValue({ success: true, data: { generation: 2 } });
    await act(async () => { renderer = create(<Harness generation={1} active />); });
    let previous: Promise<void>;
    await act(async () => { previous = invocation.invoke('hello', {}); });
    await act(async () => { renderer!.update(<Harness generation={1} active={false} />); });
    expect(invocation.result).toBe(''); expect(invocation.busy).toBe(false);
    await act(async () => { renderer!.update(<Harness generation={2} active />); });
    await act(async () => { await invocation.invoke('hello', {}); });
    await act(async () => { finish({ success: true, data: { stale: true } }); await previous!; });
    expect(invocation.result).toContain('"generation": 2');
    expect(invocation.result).not.toContain('stale');
  });
  it('does not invoke commands or open windows when revoked', async () => {
    await act(async () => { renderer = create(<Harness generation={1} active={false} />); });
    await act(async () => { await invocation.invoke('hello', {}); await invocation.openWindow(); });
    expect(host.PluginInvoke).not.toHaveBeenCalled(); expect(host.PluginOpenWindow).not.toHaveBeenCalled();
  });
});
