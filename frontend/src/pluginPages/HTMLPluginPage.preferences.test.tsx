/** @vitest-environment jsdom */
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { createRequire } from 'node:module';
import type { PluginHostPreferences } from './hostPreferences';

type ScriptPage = { window: Window & typeof globalThis & { initialPrefs?: PluginHostPreferences; gonaviHostPrefs?: PluginHostPreferences; preferenceEvents: number } };
const { JSDOM } = createRequire(import.meta.url)('jsdom') as { JSDOM: new (html: string, options: { runScripts: 'dangerously' }) => ScriptPage };
import { afterEach, expect, it, vi } from 'vitest';
import { useStore } from '../store';
import { HTMLPluginPage } from './HTMLPluginPage';

const i18n = vi.hoisted(() => ({ language: 'zh-CN' }));
vi.mock('../i18n/provider', () => ({ useI18n: () => ({ ...i18n, t: (key: string) => key }) }));
vi.mock('./api', () => ({ pageCall: vi.fn(async () => null) }));
const container = document.createElement('div');
let root: ReturnType<typeof createRoot> | undefined;
let page: ScriptPage | undefined;
afterEach(() => { act(() => root?.unmount()); root = undefined; page?.window.close(); page = undefined; container.remove(); vi.restoreAllMocks(); });

it('injects initial preferences before page scripts and updates the same iframe and input through its token bridge', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  useStore.setState({ theme: 'light' }); i18n.language = 'zh-CN';
  document.body.append(container); root = createRoot(container);
  const source = '<input id="log"><script>window.initialPrefs = window.gonaviHostPrefs; window.preferenceEvents = 0; window.addEventListener("gonavi:host-preferences", function () { window.preferenceEvents++; });</script>';
  const render = () => root!.render(<HTMLPluginPage pluginID="test.pages" pageID="workbench" title="Tool" source={source} />);
  await act(async () => render());
  const frame = container.querySelector('iframe')!;
  const srcDoc = frame.srcdoc;
  page = new JSDOM(srcDoc, { runScripts: 'dangerously' });
  expect(page.window.initialPrefs).toEqual({ locale: 'zh-CN', theme: 'light' });
  const input = page.window.document.querySelector<HTMLInputElement>('#log')!; input.value = 'keep log input';
  const post = vi.spyOn(frame.contentWindow!, 'postMessage').mockImplementation((data) => {
    page!.window.dispatchEvent(new page!.window.MessageEvent('message', { data, source: page!.window.parent }));
  });
  const initialEvents = page.window.preferenceEvents;
  await act(async () => { useStore.setState({ theme: 'dark' }); i18n.language = 'en-US'; render(); });
  expect(post).toHaveBeenCalled();
  expect(page.window.gonaviHostPrefs).toEqual({ locale: 'en-US', theme: 'dark' });
  expect(page.window.preferenceEvents).toBeGreaterThan(initialEvents);
  expect(container.querySelector('iframe')).toBe(frame);
  expect(frame.srcdoc).toBe(srcDoc);
  expect(page.window.document.querySelector('#log')).toBe(input); expect(input.value).toBe('keep log input');
  const valid = post.mock.calls[post.mock.calls.length - 1]![0] as Record<string, unknown>;
  const count = page.window.preferenceEvents;
  page.window.dispatchEvent(new page.window.MessageEvent('message', { data: { ...valid, token: 'wrong' }, source: page.window.parent }));
  page.window.dispatchEvent(new page.window.MessageEvent('message', { data: valid, source: null }));
  page.window.dispatchEvent(new page.window.MessageEvent('message', { data: { ...valid, preferences: { locale: '</script><script>bad', theme: 'dark', secret: 'no' } }, source: page.window.parent }));
  expect(page.window.preferenceEvents).toBe(count);
  expect(page.window.gonaviHostPrefs).toEqual({ locale: 'en-US', theme: 'dark' });
  act(() => { root!.unmount(); }); root = undefined; post.mockClear();
  act(() => { useStore.setState({ theme: 'light' }); });
  expect(post).not.toHaveBeenCalled();
});

it.each([
  ['light', '#dcefff', '#eef7ff'],
  ['dark', '#172535', '#203246'],
] as const)('injects the actual %s body palette before plugin scripts', async (theme, bg, panel) => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  useStore.setState({ theme }); i18n.language = 'en-US';
  const style = document.createElement('style'); style.id = 'gonavi-custom-theme-style';
  style.textContent = 'body[data-custom-theme] { --gn-bg-panel-2: ' + bg + '; --gn-bg-panel: ' + panel + '; }';
  document.head.append(style); document.body.dataset.customTheme = 'true';
  try {
    document.body.append(container); root = createRoot(container);
    await act(async () => root!.render(<HTMLPluginPage pluginID="test.pages" pageID="palette" title="Tool" source='<script>window.initialPrefs = window.gonaviHostPrefs;</script>' />));
    const frame = container.querySelector('iframe')!;
    page = new JSDOM(frame.srcdoc, { runScripts: 'dangerously' });
    expect(page.window.initialPrefs).toMatchObject({ locale: 'en-US', theme, palette: { bg: 'rgb(' + (theme === 'light' ? '220, 239, 255' : '23, 37, 53') + ')', panel: 'rgb(' + (theme === 'light' ? '238, 247, 255' : '32, 50, 70') + ')' } });
  } finally { style.remove(); delete document.body.dataset.customTheme; }
});

it('syncs same-light custom edits and base reset without losing iframe state or leaking work', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  useStore.setState({ theme: 'light' }); i18n.language = 'en-US';
  const style = document.createElement('style'); style.id = 'gonavi-custom-theme-style';
  style.textContent = 'body[data-custom-theme] { --gn-bg-panel-2: #dcefff; }';
  document.head.append(style); document.body.dataset.customTheme = 'true';
  const frames = new Map<number, FrameRequestCallback>(); let next = 0;
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => { frames.set(++next, callback); return next; });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(id => { frames.delete(id); });
  const flush = async () => {
    await act(async () => { await Promise.resolve(); });
    await act(async () => { const batch = [...frames]; frames.clear(); batch.forEach(([, callback]) => callback(0)); });
  };
  try {
    document.body.append(container); root = createRoot(container);
    await act(async () => root!.render(<HTMLPluginPage pluginID="test.pages" pageID="live" title="Tool" source='<input id="log"><pre id="result">SQL</pre><input id="escape" type="checkbox"><div id="scroll"></div><script>window.preferenceEvents=0;window.addEventListener("gonavi:host-preferences",function(){window.preferenceEvents++;});</script>' />));
    const frame = container.querySelector('iframe')!; const srcDoc = frame.srcdoc;
    page = new JSDOM(srcDoc, { runScripts: 'dangerously' });
    const input = page.window.document.querySelector<HTMLInputElement>('#log')!; input.value = 'saved log';
    const result = page.window.document.querySelector('#result')!;
    const checkbox = page.window.document.querySelector<HTMLInputElement>('#escape')!; checkbox.checked = true;
    const scroll = page.window.document.querySelector<HTMLElement>('#scroll')!; scroll.scrollTop = 37;
    const post = vi.spyOn(frame.contentWindow!, 'postMessage').mockImplementation(data => {
      page!.window.dispatchEvent(new page!.window.MessageEvent('message', { data, source: page!.window.parent }));
    });
    await flush();
    expect(container.querySelector('iframe')).toBe(frame);
    post.mockClear();
    style.textContent = 'body[data-custom-theme] { --gn-bg-panel-2: #ffeedd; }';
    document.body.dataset.customThemeId = 'second-light';
    await flush();
    expect(page.window.gonaviHostPrefs).toMatchObject({ theme: 'light', palette: { bg: 'rgb(255, 238, 221)' } });
    expect(post).toHaveBeenCalledTimes(1); post.mockClear();
    style.firstChild!.textContent = 'body[data-custom-theme] { --gn-bg-panel-2: #ddeeff; }';
    await flush();
    expect(page.window.gonaviHostPrefs).toMatchObject({ palette: { bg: 'rgb(221, 238, 255)' } });
    expect(post).toHaveBeenCalledTimes(1); post.mockClear();
    await flush(); expect(post).not.toHaveBeenCalled(); expect(frames.size).toBe(0);
    style.remove(); delete document.body.dataset.customTheme; document.body.dataset.theme = 'light';
    await flush();
    expect(page.window.gonaviHostPrefs).toEqual({ locale: 'en-US', theme: 'light' });
    expect(container.querySelector('iframe')).toBe(frame); expect(frame.srcdoc).toBe(srcDoc);
    expect(page.window.document.querySelector('#log')).toBe(input); expect(input.value).toBe('saved log');
    expect(page.window.document.querySelector('#result')).toBe(result); expect(result.textContent).toBe('SQL');
    expect(checkbox.checked).toBe(true); expect(scroll.scrollTop).toBe(37);
    document.body.dataset.uiVersion = 'v1'; await act(async () => { await Promise.resolve(); });
    act(() => root!.unmount()); root = undefined; post.mockClear();
    expect(frames.size).toBe(0);
    document.body.dataset.theme = 'dark'; await flush();
    expect(post).not.toHaveBeenCalled(); expect(frames.size).toBe(0);
  } finally { style.remove(); delete document.body.dataset.customTheme; delete document.body.dataset.customThemeId; delete document.body.dataset.theme; delete document.body.dataset.uiVersion; }
});

it('injects the measured host fonts, sizes, radius and opacity before the first page script', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  useStore.setState({ theme: 'light' }); i18n.language = 'en-US';
  const style = document.createElement('style'); style.id = 'gonavi-custom-theme-style';
  style.textContent = 'body { font-family: "Segoe UI", sans-serif; font-size: 17px; --gn-font-mono: Consolas, monospace; --gn-font-size-mono: 14px; } .ant-input { border-radius: 9px; }';
  document.head.append(style); document.documentElement.style.setProperty('--gn-window-opacity', '.8');
  const control = document.createElement('input'); control.className = 'ant-input'; document.body.append(control);
  const workbench = document.createElement('div'); workbench.className = 'gn-v2-app-root'; document.body.append(workbench);
  const callbacks = new Map<number, FrameRequestCallback>(); let id = 0;
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => { callbacks.set(++id, callback); return id; });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(key => { callbacks.delete(key); });
  const flush = async () => {
    await act(async () => { await Promise.resolve(); });
    await act(async () => { const batch = [...callbacks]; callbacks.clear(); batch.forEach(([, callback]) => callback(0)); });
  };
  try {
    workbench.append(container); root = createRoot(container);
    await act(async () => root!.render(<HTMLPluginPage pluginID="test.pages" pageID="appearance" title="Tool" source='<script>window.initialPrefs=window.gonaviHostPrefs;</script>' />));
    page = new JSDOM(container.querySelector('iframe')!.srcdoc, { runScripts: 'dangerously' });
    expect(page.window.initialPrefs).toMatchObject({ appearance: { fontFamily: '"Segoe UI", sans-serif', monoFontFamily: 'Consolas, monospace', fontSize: 17, monoFontSize: 14, radius: 9, opacity: .8 } });
    const frame = container.querySelector('iframe')!; const srcDoc = frame.srcdoc;
    const post = vi.spyOn(frame.contentWindow!, 'postMessage').mockImplementation(data => page!.window.dispatchEvent(new page!.window.MessageEvent('message', { data, source: page!.window.parent })));
    await flush(); post.mockClear();
    document.documentElement.style.setProperty('--gn-window-opacity', '.6');
    workbench.dataset.backgroundImage = 'true'; workbench.style.setProperty('--gn-background-tint', '85%');
    workbench.style.setProperty('--gn-background-image', 'url("file:///private/background.png")');
    await flush();
    expect(page.window.gonaviHostPrefs).toMatchObject({ appearance: { opacity: .6, background: { enabled: true, tint: .85 } } });
    expect(post).toHaveBeenCalledTimes(1); expect(JSON.stringify(post.mock.calls)).not.toMatch(/private|background.png|file:|url\(/); post.mockClear();
    style.textContent = 'body { font-family: Arial, sans-serif; font-size: 19px; --gn-font-mono: Menlo, monospace; --gn-font-size-mono: 16px; } .ant-input { border-radius: 12px; }';
    await flush();
    expect(page.window.gonaviHostPrefs).toMatchObject({ appearance: { fontFamily: 'Arial, sans-serif', fontSize: 19, monoFontSize: 16, radius: 12 } });
    post.mockClear(); workbench.style.setProperty('--gn-background-image', 'url("file:///changed.png")'); workbench.style.setProperty('--gn-background-offset-x', '12vw');
    await flush(); expect(post).not.toHaveBeenCalled();
    workbench.removeAttribute('data-background-image'); await flush();
    expect(page.window.gonaviHostPrefs).toMatchObject({ appearance: { background: { enabled: false } } });
    expect(container.querySelector('iframe')).toBe(frame); expect(frame.srcdoc).toBe(srcDoc);
    act(() => root!.unmount()); root = undefined; post.mockClear();
    document.documentElement.style.setProperty('--gn-window-opacity', '.7'); workbench.dataset.backgroundImage = 'true'; await flush();
    expect(post).not.toHaveBeenCalled(); expect(callbacks.size).toBe(0);
  } finally { style.remove(); control.remove(); workbench.remove(); document.documentElement.style.removeProperty('--gn-window-opacity'); }
});
