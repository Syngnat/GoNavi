/** @vitest-environment jsdom */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const css = readFileSync(resolve(process.cwd(), 'src/pluginPages/pluginPage.css'), 'utf8');
import { expect, it } from 'vitest';
import { sanitizeHostAppearance } from './hostAppearance';
import { createPageBridgeRuntime } from './bridgeRuntime';
import { createRequire } from 'node:module';

it('lets the already painted workbench background show through only while enabled', () => {
  const style = document.createElement('style'); style.textContent = css.replace('background: var(--gn-bg-panel-2)', 'background: rgb(1, 2, 3)'); document.head.append(style);
  const root = document.createElement('div'); root.className = 'gn-v2-app-root'; document.body.append(root);
  const frame = document.createElement('iframe'); frame.className = 'plugin-page-frame'; root.append(frame);
  try {
    const before = getComputedStyle(frame).backgroundColor; expect(before).toBe('rgb(1, 2, 3)');
    root.dataset.backgroundImage = 'true';
    expect(getComputedStyle(frame).backgroundColor).toBe('rgba(0, 0, 0, 0)');
    root.removeAttribute('data-background-image');
    expect(getComputedStyle(frame).backgroundColor).toBe(before);
  } finally { root.remove(); style.remove(); }
});

it('rejects inherited fields and global font keywords at the appearance boundary', () => {
  expect(sanitizeHostAppearance(Object.create({ fontSize: 16, opacity: .6, background: { enabled: true } }))).toBeUndefined();
  for (const font of ['inherit', 'unset', 'initial', 'revert', 'revert-layer']) expect(sanitizeHostAppearance({ fontFamily: font, monoFontFamily: font })).toBeUndefined();
  expect(sanitizeHostAppearance({ fontSize: 16, background: Object.create({ enabled: true, tint: .8 }) })).toEqual({ fontSize: 16 });
});

it('keeps bounded appearance fields through the token bridge and clears stale overrides', () => {
  const { JSDOM } = createRequire(import.meta.url)('jsdom') as { JSDOM: new (html: string, options: { runScripts: 'dangerously' }) => { window: Window & typeof globalThis & { gonaviHostPrefs?: unknown } } };
  const appearance = { fontFamily: '"Varela Round", sans-serif', monoFontFamily: 'Consolas, monospace', fontSize: 18, monoFontSize: 14, radius: 8, opacity: .6, background: { enabled: true, tint: .85 } };
  const page = new JSDOM('<script>' + createPageBridgeRuntime('appearance-token', { locale: 'en-US', theme: 'light', appearance }) + '</script>', { runScripts: 'dangerously' });
  const send = (metrics: unknown, token = 'appearance-token', source: Window | null = page.window.parent) => page.window.dispatchEvent(new page.window.MessageEvent('message', { source, data: { type: 'gonavi:host-preferences', token, preferences: { locale: 'en-US', theme: 'light', appearance: metrics } } }));
  try {
    expect(page.window.gonaviHostPrefs).toMatchObject({ appearance });
    let events = 0; page.window.addEventListener('gonavi:host-preferences', () => events++);
    for (const bad of ['var(--secret)', 'url(file:///secret)', 'env(name)', 'expression(alert(1))', 'Arial; color:red', '</style>', '\\41rial', 'A'.repeat(513), String.fromCharCode(0) + 'Arial', '@font-face']) {
      send({ fontFamily: bad, fontSize: 17, background: { enabled: true, url: 'secret', tint: 5 } });
      expect(page.window.gonaviHostPrefs).toEqual({ locale: 'en-US', theme: 'light', appearance: { fontSize: 17, background: { enabled: true } } });
    }
    const count = events; send(appearance, 'wrong'); send(appearance, 'appearance-token', null); expect(events).toBe(count);
    send({ fontSize: 49, monoFontSize: NaN, radius: -1, opacity: Infinity, background: { enabled: 'true' }, unknown: 'secret' });
    expect(page.window.gonaviHostPrefs).toEqual({ locale: 'en-US', theme: 'light' });
    send(undefined); expect(page.window.gonaviHostPrefs).toEqual({ locale: 'en-US', theme: 'light' });
  } finally { page.window.close(); }
});
