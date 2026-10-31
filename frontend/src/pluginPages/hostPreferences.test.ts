/** @vitest-environment jsdom */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { createPageBridgeRuntime } from './bridgeRuntime';
import { pluginHostPreferences, sanitizeHostPalette, serializeHostPreferences } from './hostPreferences';
import { readHostThemePalette } from './useHostThemePalette';

const { JSDOM } = createRequire(import.meta.url)('jsdom') as { JSDOM: new (html: string, options: { runScripts: 'dangerously' }) => { window: Window & typeof globalThis & { gonaviHostPrefs?: unknown } } };

it('drops unknown color profiles rather than trusting a permissive parser', () => {
  expect(sanitizeHostPalette({ bg: 'color(unknown 1 1 1)', panel: 'color(srgb 0.1 0.2 0.3)' })).toEqual({ panel: 'color(srgb 0.1 0.2 0.3)' });
});

it('keeps only bounded literal colors through serialization and the authenticated runtime', () => {
  const colors = { bg: '#abcdef', panel: 'rgba(10, 20, 30, 0.4)', input: 'hsl(120 40% 50% / .5)', code: 'color(display-p3 0.1 0.2 0.3)', text: 'oklch(50% .1 40)', muted: 'rgb(10 20 30 / .6)', border: 'hwb(30 10% 20%)', border1: 'lab(50% 10 20)', accent: 'lch(50% 10 20)', accentSoft: 'oklab(50% .1 .2)' };
  const unsafe = ['url(https://bad)', 'var(--secret)', 'expression(alert(1))', '#fff; color:red', '</style><script>bad', '#12', 'rgb(bad)', '\\23fff', '#fff' + ' '.repeat(129), '\x00#fff', 'color(unknown 1 1 1)', 'color-mix(in srgb, red, blue)'];
  const initial = pluginHostPreferences('de-DE', 'dark', { ...colors, secret: 'no', warn: 'url(https://bad)' });
  expect(initial.palette?.bg).toBe('rgb(171, 205, 239)'); expect(initial.palette?.panel).toBe('rgba(10, 20, 30, 0.4)');
  expect(Object.keys(initial.palette!)).toHaveLength(Object.keys(colors).length);
  expect(serializeHostPreferences(initial).length).toBeLessThan(2048);
  const runtime = createPageBridgeRuntime('token-123', initial);
  expect(runtime).not.toMatch(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/);
  const page = new JSDOM('<script>' + runtime + '</script>', { runScripts: 'dangerously' });
  try {
    let events = 0; page.window.addEventListener('gonavi:host-preferences', () => events++);
    expect(page.window.gonaviHostPrefs).toEqual(initial);
    const send = (palette: unknown, token = 'token-123', source: Window | null = page.window.parent, locale = 'de-DE') => page.window.dispatchEvent(new page.window.MessageEvent('message', { source, data: { type: 'gonavi:host-preferences', token, preferences: { locale, theme: 'light', palette, secret: 'no' } } }));
    for (const bad of unsafe) {
      expect(sanitizeHostPalette({ bg: bad, panel: colors.panel, unknown: '#fff' })).toEqual({ panel: 'rgba(10, 20, 30, 0.4)' });
      send({ bg: bad, panel: colors.panel, unknown: '#fff' });
      expect(page.window.gonaviHostPrefs).toEqual({ locale: 'de-DE', theme: 'light', palette: { panel: 'rgba(10, 20, 30, 0.4)' } });
    }
    const count = events; send(colors, 'wrong'); send(colors, 'token-123', null); send(colors, 'token-123', page.window.parent, 'invalid');
    expect(events).toBe(count);
    send(undefined); expect(page.window.gonaviHostPrefs).toEqual({ locale: 'de-DE', theme: 'light' });
    for (const file of ['hostPreferences.ts', 'bridgeRuntime.ts', 'useHostThemePalette.ts', 'HTMLPluginPage.tsx', 'usePageBridge.ts']) expect(readFileSync(new URL('./' + file, import.meta.url), 'utf8')).not.toMatch(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/);
  } finally { page.window.close(); }
});

it('samples body cascade and only returns resolved colors or safely drops unsupported expressions', () => {
  const style = document.createElement('style');
  style.textContent = ':root { --gn-bg-panel-2: #ffffff; } body { --gn-bg-panel-2: #dcefff; --gn-bg-panel: rgba(10,20,30,.4); --gn-bg-input: var(--gn-bg-panel-2); --gn-accent: color-mix(in srgb, red, blue); --gn-bg-hover: transparent; --gn-warn: url(https://bad); --gn-br-1: currentColor; }';
  document.head.append(style);
  const count = document.body.childElementCount;
  try {
    const palette = readHostThemePalette();
    expect(palette).toMatchObject({ bg: 'rgb(220, 239, 255)', panel: 'rgba(10, 20, 30, 0.4)', hover: 'rgba(0, 0, 0, 0)' });
    expect(palette?.warn).toBeUndefined(); expect(palette?.border1).toBeUndefined();
    for (const color of Object.values(palette!)) expect(color).not.toMatch(/var\s*\(|url\s*\(|color-mix\s*\(|[;<>]/i);
    expect(document.body.childElementCount).toBe(count);
  } finally { style.remove(); }
});
