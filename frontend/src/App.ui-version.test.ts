import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const appSource = readFileSync(
  fileURLToPath(new globalThis.URL('./App.tsx', import.meta.url)),
  'utf8',
);
const appCss = readFileSync(
  fileURLToPath(new globalThis.URL('./App.css', import.meta.url)),
  'utf8',
);

describe('UI version switch placement', () => {
  it('loads the v2 theme stylesheet with the app shell', () => {
    expect(appSource).toContain("import './App.css';");
    expect(appSource).toContain("import './v2-theme.css';");
  });

  it('gives legacy sidebar the same resize bounds as v2', () => {
    expect(appCss).toContain('body[data-ui-version="legacy"] .ant-layout-sider');
    expect(appCss).toMatch(/min-width:\s*232px\s*!important/);
    expect(appCss).toMatch(/max-width:\s*420px\s*!important/);
  });

  it('keeps the UI version switch in theme mode and outside macOS-only settings', () => {
    const themeBranchIndex = appSource.indexOf("{themeModalSection === 'theme' ? (");
    const uiVersionIndex = appSource.indexOf('界面版本', themeBranchIndex);
    const lightThemeIndex = appSource.indexOf('亮色主题', themeBranchIndex);
    const appearanceBranchIndex = appSource.indexOf(') : (', themeBranchIndex);
    const macWindowIndex = appSource.indexOf('macOS 窗口控制');

    expect(themeBranchIndex).toBeGreaterThan(-1);
    expect(uiVersionIndex).toBeGreaterThan(themeBranchIndex);
    expect(uiVersionIndex).toBeLessThan(lightThemeIndex);
    expect(uiVersionIndex).toBeLessThan(appearanceBranchIndex);
    expect(macWindowIndex).toBeGreaterThan(uiVersionIndex);
    expect(appSource).toContain("badge: '默认'");
    expect(appSource).toContain("badge: 'Beta'");
    expect(appSource).toContain("onClick={() => setAppearance({ uiVersion: item.key as 'legacy' | 'v2' })}");
    expect(appSource).toContain('新版 UI 仍在 Beta');
    expect(appSource).toContain('Windows、macOS 与 Linux 均可切换');
    expect(appSource).toContain('新版左侧搜索模式');
    expect(appSource).toContain("value={appearance.v2SidebarSearchMode ?? 'command'}");
    expect(appSource).toContain("setAppearance({ v2SidebarSearchMode: value as 'command' | 'filter' })");
  });

  it('uses the card-style v2 switch from the redesign instead of the segmented pill', () => {
    const uiVersionIndex = appSource.indexOf('界面版本');
    const themeModeIndex = appSource.indexOf('主题模式', uiVersionIndex);
    const uiVersionBlock = appSource.slice(uiVersionIndex, themeModeIndex);

    expect(uiVersionBlock).toContain('NEW');
    expect(uiVersionBlock).toContain("gridTemplateColumns: 'repeat(2, minmax(0, 1fr))'");
    expect(uiVersionBlock).toContain("label: '旧版 UI'");
    expect(uiVersionBlock).toContain("label: '新版 UI'");
    expect(uiVersionBlock).toContain('CheckOutlined');
    expect(uiVersionBlock).toContain('新版左侧搜索模式');
    expect(uiVersionBlock).toContain('<Segmented');
  });
});
