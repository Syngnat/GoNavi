import { useMemo } from 'react';

// The frame runs in an opaque origin and cannot reach host storage, cookies, files or
// bindings. Its CSP blocks page fetch/XHR/WebSocket, forms, frames, objects and base
// changes. Inline scripts/styles stay allowed, and the host's own origin may serve the
// page UI bundle and package-relative assets; no other network origin is permitted.
export function panelCsp(hostOrigin?: string): string {
  const origin = hostOrigin && hostOrigin !== 'null' && /^https?:\/\//.test(hostOrigin) ? ' ' + hostOrigin : '';
  return [
    "default-src 'none'",
    `script-src 'unsafe-inline'${origin}`,
    `style-src 'unsafe-inline'${origin}`,
    `img-src data:${origin}`,
    "font-src data:",
    "media-src data:",
    "connect-src 'none'",
    "form-action 'none'",
    // navigate-to is not implemented by every engine, but where it is it stops the document
    // from navigating itself to a network origin; the WebView-level check is still required.
    "navigate-to 'none'",
    "base-uri 'none'",
    "frame-src 'none'",
    "object-src 'none'",
  ].join('; ');
}

const BASE_STYLE = 'html,body{margin:0;padding:0;min-height:100%;background:transparent;color:inherit;font:inherit}body{padding:12px;box-sizing:border-box}*{box-sizing:border-box}';

export function sandboxedPanelDocument(source: string, hostOrigin?: string): string {
  return '<!doctype html><html><head><meta charset="utf-8">'
    + '<meta http-equiv="Content-Security-Policy" content="' + panelCsp(hostOrigin) + '">'
    + '<meta name="referrer" content="no-referrer">'
    + '<style>' + BASE_STYLE + '</style></head><body>' + source + '</body></html>';
}

export function SandboxedHTMLPanel({ title, source }: { title: string; source: string }) {
  const document = useMemo(
    () => sandboxedPanelDocument(source, typeof window === 'undefined' ? undefined : window.location.origin),
    [source],
  );
  return <iframe
    className="plugin-html-frame"
    title={title}
    sandbox="allow-scripts"
    referrerPolicy="no-referrer"
    loading="lazy"
    allow="camera 'none'; microphone 'none'; geolocation 'none'; payment 'none'; usb 'none'; serial 'none'; midi 'none'; clipboard-read 'none'; clipboard-write 'none'"
    srcDoc={document}
  />;
}
