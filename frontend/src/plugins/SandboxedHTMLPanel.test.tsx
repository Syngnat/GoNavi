import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SandboxedHTMLPanel, sandboxedPanelDocument } from './SandboxedHTMLPanel';

describe('sandboxed custom HTML panel', () => {
  it('renders an opaque-origin frame without host navigation or same-origin access', () => {
    const html = renderToStaticMarkup(<SandboxedHTMLPanel title="Dashboard" source="<h1>Hello</h1>" />);
    expect(html).toContain('sandbox="allow-scripts"');
    expect(html).not.toContain('allow-same-origin');
    expect(html).not.toContain('allow-top-navigation');
    expect(html).toContain('referrerPolicy="no-referrer"');
    expect(html).toContain('allow="camera &#x27;none&#x27;');
    expect(html).toContain('clipboard-read &#x27;none&#x27;');
    expect(html).toContain('title="Dashboard"');
  });

  it('blocks network, forms, nested frames and base URL changes in the frame document', () => {
    const document = sandboxedPanelDocument('<h1>Hello</h1><script>document.title = "ready"</script>');
    expect(document).toContain("default-src 'none'");
    expect(document).toContain("connect-src 'none'");
    expect(document).toContain("form-action 'none'");
    expect(document).toContain("frame-src 'none'");
    expect(document).toContain("base-uri 'none'");
    expect(document).toContain("object-src 'none'");
    expect(document).toContain('<h1>Hello</h1><script>document.title = "ready"</script>');
  });
});

describe('page CSP host sources', () => {
  it('allows the macOS wails scheme and its origin', async () => {
    const { panelCsp } = await import('./SandboxedHTMLPanel');
    const csp = panelCsp('wails://wails');
    expect(csp).toContain("script-src 'unsafe-inline' wails://wails wails:");
    expect(csp).toContain("style-src 'unsafe-inline' wails://wails wails:");
    expect(csp).toContain("font-src data: wails://wails wails:");
    expect(csp).toContain("connect-src 'none'");
  });

  it('allows the Windows/Linux wails.localhost origin only', async () => {
    const { panelCsp } = await import('./SandboxedHTMLPanel');
    const csp = panelCsp('http://wails.localhost');
    expect(csp).toContain("script-src 'unsafe-inline' http://wails.localhost");
    expect(csp).not.toContain('wails:');
  });

  it('adds no host source without a browser origin', async () => {
    const { panelCsp } = await import('./SandboxedHTMLPanel');
    const csp = panelCsp();
    expect(csp).toContain("script-src 'unsafe-inline';");
    expect(csp).not.toContain('wails://');
  });
});
