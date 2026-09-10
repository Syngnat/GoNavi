import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const appSource = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8');
const v2ThemeCss = readFileSync(new URL('./v2-theme.css', import.meta.url), 'utf8');

describe('sidebar resize hit area', () => {
  it('keeps the native tree scrollbar outside the width resize hit area', () => {
    expect(appSource).toContain(
      "['--gonavi-sidebar-resize-inner-hit-width' as any]: `${sidebarResizeHandleWidth / 2}px`",
    );
    expect(appSource).toContain('data-sidebar-resize-handle="true"');
    expect(appSource).toContain('right: -(sidebarResizeHandleWidth / 2)');
    expect(v2ThemeCss).toContain(
      'padding: 6px max(8px, var(--gonavi-sidebar-resize-inner-hit-width, 8px)) 8px 8px;',
    );
  });
});
