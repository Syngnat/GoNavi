import { describe, expect, it } from 'vitest';
import { sandboxedPageDocument } from './pageDocument';
import { pluginHostPreferences } from './hostPreferences';

const TOKEN = 'a1b2c3d4e5f60718';

describe('plugin page document', () => {
  it('keeps the panel CSP so a page cannot reach the network, forms or nested frames', () => {
    const document = sandboxedPageDocument('<h1>Hi</h1>', TOKEN);
    for (const directive of [
      "default-src 'none'",
      "connect-src 'none'",
      "form-action 'none'",
      "frame-src 'none'",
      "base-uri 'none'",
      "object-src 'none'",
    ]) {
      expect(document).toContain(directive);
    }
  });

  it('installs window.gonavi bound to this frame token before the page markup runs', () => {
    const document = sandboxedPageDocument('<h1>Hi</h1>', TOKEN);
    const runtimeIndex = document.indexOf('window.gonavi');
    const markupIndex = document.indexOf('<h1>Hi</h1>');
    expect(runtimeIndex).toBeGreaterThan(-1);
    expect(markupIndex).toBeGreaterThan(-1);
    expect(runtimeIndex).toBeLessThan(markupIndex);
    expect(document).toContain('gonavi:page-call');
    expect(document).toContain('gonavi:page-result');
    expect(document).toContain('"' + TOKEN + '"');
    // The token stays in the runtime closure and the inline script removes itself,
    // so page markup cannot read it or carry it across a navigation.
    expect(document).toContain('document.currentScript.parentNode.removeChild');
    expect(document).toContain('parent.postMessage.bind(parent)');
    expect(document).toContain('event.source !== parent');
  });

  it.each(['zh-CN', 'zh-TW', 'en-US', 'ja-JP', 'de-DE', 'ru-RU'])('initializes only JSON-safe non-sensitive preferences for %s', (locale) => {
    const document = sandboxedPageDocument('<script>window.readPrefs = window.gonaviHostPrefs</script>', TOKEN, undefined, pluginHostPreferences(locale, 'dark'));
    const match = /window.gonaviHostPrefs = (\{[^;]+\});/.exec(document)!;
    expect(JSON.parse(match[1])).toEqual({ locale, theme: 'dark' });
    expect(document.indexOf(match[0])).toBeLessThan(document.indexOf('window.readPrefs'));
    const unsafe = sandboxedPageDocument('<h1>Hi</h1>', TOKEN, undefined, pluginHostPreferences('</script><script>bad', 'secret'));
    expect(unsafe).not.toContain('<script>bad');
    expect(unsafe).toContain('window.gonaviHostPrefs = {"locale":"en-US","theme":"light"};');
  });
  it('passes the page source through unchanged', () => {
    const source = '<section data-page="dashboard">ready</section>';
    expect(sandboxedPageDocument(source, TOKEN)).toContain(source);
  });
});
