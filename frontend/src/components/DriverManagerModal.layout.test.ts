import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { readV2ThemeCss } from '../test/readV2ThemeCss';
import { readCssWithImports } from '../test/readCssWithImports';

const appCss = readCssWithImports(fileURLToPath(new globalThis.URL('../App.css', import.meta.url)));
const driverManagerWorkbenchCss = readFileSync(
  fileURLToPath(new globalThis.URL('./DriverManagerWorkbench.css', import.meta.url)),
  'utf8',
);
const downloadSourceSelectCss = readFileSync(
  fileURLToPath(new globalThis.URL('./DownloadSourceSelect.css', import.meta.url)),
  'utf8',
);
const downloadSourceCatalogs = ['de-DE', 'en-US', 'ja-JP', 'ru-RU', 'zh-CN', 'zh-TW'].map((locale) => ({
  locale,
  messages: JSON.parse(readFileSync(
    fileURLToPath(new globalThis.URL(`../../../shared/i18n/${locale}.json`, import.meta.url)),
    'utf8',
  )) as Record<string, string>,
}));
const v2ThemeCss = readV2ThemeCss();

const MIN_TEXT_CONTRAST = 4.5;
const MIN_STATE_CONTRAST = 1.25;

const themeModes = ['light', 'dark'] as const;

const primaryButtonStates = [
  {
    name: 'default',
    selector: 'body[data-ui-version="v2"] .ant-btn-primary',
    backgroundToken: '--gn-accent-strong',
    backgroundValue: 'var(--gn-accent-strong, var(--gn-accent))',
  },
  {
    name: 'hover',
    selector: 'body[data-ui-version="v2"] .ant-btn-primary:hover',
    backgroundToken: '--gn-accent-strong-hover',
    backgroundValue: 'var(--gn-accent-strong-hover, var(--gn-accent-2))',
  },
  {
    name: 'active',
    selector: 'body[data-ui-version="v2"] .ant-btn-primary:active',
    backgroundToken: '--gn-accent-strong-active',
    backgroundValue: 'var(--gn-accent-strong-active, var(--gn-accent-2))',
  },
] as const;

const relativeLuminance = (hex: string): number => {
  const channels = [1, 3, 5]
    .map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255)
    .map((channel) => (
      channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
    ));
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
};

const contrastRatio = (foreground: string, background: string): number => {
  const light = Math.max(relativeLuminance(foreground), relativeLuminance(background));
  const dark = Math.min(relativeLuminance(foreground), relativeLuminance(background));
  return (light + 0.05) / (dark + 0.05);
};

const readHexToken = (cssBlock: string, token: string): string => {
  const match = cssBlock.match(new RegExp(`${token}\\s*:\\s*(#[0-9a-f]{6})`, 'i'));
  if (!match?.[1]) throw new Error(`Missing token ${token}`);
  return match[1];
};

const readThemeBlock = (theme: (typeof themeModes)[number]): string => {
  const block = v2ThemeCss.match(
    new RegExp(`body\\[data-ui-version="v2"\\]\\[data-theme="${theme}"\\]\\s*\\{([^}]*)\\}`, 's'),
  )?.[1];
  if (!block) throw new Error(`Missing ${theme} theme block`);
  return block;
};

const readCssRule = (selector: string): string => {
  const selectorStart = v2ThemeCss.indexOf(`${selector} {`);
  if (selectorStart < 0) throw new Error(`Missing CSS rule ${selector}`);
  const bodyStart = v2ThemeCss.indexOf('{', selectorStart) + 1;
  const bodyEnd = v2ThemeCss.indexOf('}', bodyStart);
  if (bodyEnd < 0) throw new Error(`Unclosed CSS rule ${selector}`);
  return v2ThemeCss.slice(bodyStart, bodyEnd);
};

describe('DriverManagerModal embedded layout', () => {
  it('keeps the two-pane master-detail driver workbench layout', () => {
    // Two-pane body: fixed-width driver list pane + fluid detail pane.
    expect(appCss).toMatch(
      /\.driver-manager-columns\s*\{[^}]*display:\s*grid[^}]*grid-template-columns:\s*minmax\(300px, 440px\) minmax\(0, 1fr\)/s,
    );
    expect(appCss).toMatch(
      /\.driver-manager-list-pane\s*\{[^}]*padding-right:\s*16px[^}]*border-right:\s*1px solid/s,
    );
    // List rows are quiet selectable items with a soft selected state.
    expect(appCss).toMatch(
      /\.driver-manager-list-item\.is-selected\s*\{[^}]*background:\s*rgba\(22, 119, 255, 0\.10\)/s,
    );
    expect(appCss).toMatch(
      /\.driver-manager-list-item-meta\s*\{[^}]*text-overflow:\s*ellipsis/s,
    );
    // Detail pane holds the selected driver's controls.
    expect(appCss).toMatch(/\.driver-manager-detail-controls\s*\{/);
    // Bulk operations live on a slim bar above the panes.
    expect(appCss).toMatch(/\.driver-manager-bulkbar\s*\{[^}]*display:\s*flex/s);
    // 目录类操作紧跟主按钮组：不推到最右，否则按钮独占一行时中间留大片空白。
    const bulkbarDirBlock = appCss.match(/\.driver-manager-bulkbar-dir\s*\{([^}]*)\}/)?.[1];
    expect(bulkbarDirBlock).toBeTruthy();
    expect(bulkbarDirBlock).toMatch(/margin-left:\s*0/);
    expect(bulkbarDirBlock).not.toMatch(/margin-left:\s*auto/);
    // 导入驱动目录是 antd 的 Dropdown.Button，内部 Space.Compact 带 -block 类，
    // antd 给该类写死 width: 100%；工具条按内容定宽时这个 100% 会被解析成整条
    // 工具条的宽度，把同排后面的「导出/导入驱动包」顶出可视区。必须改回按内容定宽。
    const importDropdownBlock = appCss.match(
      /\.driver-manager-bulkbar-dir\s+\.driver-manager-import-directory-dropdown\s*\{([^}]*)\}/,
    )?.[1];
    expect(importDropdownBlock).toBeTruthy();
    expect(importDropdownBlock).toMatch(/width:\s*auto/);
    expect(importDropdownBlock).not.toMatch(/width:\s*100%/);
    // Footer: ambient network status left, action buttons right.
    expect(appCss).toMatch(
      /\.driver-manager-footer-actions\s*\{[^}]*justify-content:\s*space-between/s,
    );
    expect(appCss).toContain('.driver-manager-footer-actions.is-status-only');
    expect(appCss).toContain('.driver-manager-bulkbar.is-embedded-toolbar');
    expect(appCss).toMatch(
      /\.driver-manager-list-search-row\.is-embedded\s*\{[^}]*flex-wrap:\s*wrap[^}]*gap:\s*6px/s,
    );
    expect(appCss).toMatch(
      /\.driver-manager-mirror-chip\.is-compact\s*\{[^}]*flex-wrap:\s*wrap[^}]*width:\s*max-content[^}]*max-width:\s*100%[^}]*flex:\s*0 1 auto/s,
    );
    // Keep the mirror chip content-driven: the long localized "GitHub official"
    // label must not reserve a fixed slot in the driver toolbar.
    for (const { locale, messages } of downloadSourceCatalogs) {
      expect(
        messages['app.download_source.option.github'],
        `${locale} GitHub mirror label`,
      ).toBe('GitHub');
    }
    expect(appCss).toMatch(
      /\.driver-manager-mirror-chip-copy\s*\{[^}]*display:\s*flex[^}]*min-width:\s*0[^}]*flex:\s*0 1 auto/s,
    );
    // The mirror dropdown's selected label truncates instead of reserving a fixed slot.
    expect(downloadSourceSelectCss).toMatch(
      /\.gn-download-source-value-name\s*\{[^}]*min-width:\s*0[^}]*overflow:\s*hidden[^}]*text-overflow:\s*ellipsis[^}]*white-space:\s*nowrap/s,
    );
    expect(downloadSourceSelectCss).not.toMatch(
      /\.gn-download-source-value-name\s*\{[^}]*(?:width|max-width|flex):\s*[^;}]*11ch/s,
    );
    expect(downloadSourceSelectCss).toMatch(
      /\.gn-download-source-dot\s*\{[^}]*width:\s*8px[^}]*height:\s*8px[^}]*flex:\s*0 0 auto/s,
    );
    expect(driverManagerWorkbenchCss).toMatch(
      /\.preview-settings-source-select\.ant-select\s*\{[^}]*min-width:\s*140px[^}]*flex:\s*0 0 auto/s,
    );
    expect(appCss).toMatch(
      /\.gonavi-about-download-source\s*\{[^}]*flex-wrap:\s*wrap[^}]*width:\s*max-content[^}]*max-width:\s*100%/s,
    );
    expect(appCss).toMatch(
      /body \.gonavi-about-section\s*\{[^}]*grid-template-columns:\s*var\(--gn-about-label-width\) minmax\(0, 1fr\)/s,
    );
    expect(appCss).toMatch(
      /body \.gonavi-about-setting,\s*body \.gonavi-about-facts,\s*body \.gonavi-about-link-grid,\s*body \.gonavi-about-download-source\s*\{[^}]*grid-column:\s*1 \/ -1/s,
    );
    expect(appCss).toContain('--gn-about-label-width: 14rem');
    expect(appCss).toMatch(
      /body \.gonavi-about-field > :not\(\.gonavi-about-field-label\)\s*\{[^}]*justify-self:\s*start[^}]*width:\s*max-content/s,
    );
    expect(appCss).toMatch(
      /body \.gonavi-about-field-control \.ant-switch\s*\{[^}]*width:\s*44px !important/s,
    );
    expect(appCss).toMatch(
      /\.driver-manager-mirror-chip\.is-compact\s*>\s*\.ant-select,\s*\.gonavi-about-download-source\s*>\s*\.ant-select\s*\{[^}]*margin-left:\s*auto/s,
    );
    expect(appCss).toMatch(/\.driver-manager-filterbar\s*\{[^}]*grid-template-columns:\s*repeat\(4, minmax\(0, 1fr\)\)/s);
    expect(appCss).toMatch(/\.driver-manager-filter-chip\s*\{[^}]*padding:\s*6px 8px/s);
    // The old single-column card list chrome is gone.
    expect(appCss).not.toMatch(/\.driver-manager-card\s[{,]/);
    expect(appCss).not.toMatch(/@container driver-card/);
    expect(appCss).toMatch(
      /\.driver-manager-control-block\s*\{[^}]*min-width:\s*0/s,
    );
    expect(appCss).toMatch(
      /\.driver-manager-progress\.ant-progress-line\s*\{[^}]*width:\s*100%[^}]*min-width:\s*0/s,
    );
  });

  it('keeps the two-pane side-by-side layout on narrow containers', () => {
    // 小屏只收窄左栏，不折叠成上下两段：容器查询里必须仍是两列，
    // 左栏用 clamp 同时保住可读下限与断点处的连续过渡。
    const narrowContainerBlock = appCss.match(
      /@container \(max-width:\s*960px\)\s*\{([\s\S]*?)\n\}/,
    )?.[1];
    expect(narrowContainerBlock).toBeTruthy();
    expect(narrowContainerBlock).toMatch(
      /\.driver-manager-columns\s*\{[^}]*grid-template-columns:\s*clamp\([^)]+\)\s*minmax\(0, 1fr\)/s,
    );
    // 旧行为（单列堆叠）不得回归。
    expect(narrowContainerBlock).not.toMatch(
      /\.driver-manager-columns\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)\s*;/s,
    );
    // 列表栏的分隔线与内边距在窄屏下继续保留（左右分栏的视觉前提）。
    expect(narrowContainerBlock).not.toMatch(/\.driver-manager-list-pane\s*\{/);
    expect(narrowContainerBlock).not.toMatch(/\.driver-manager-detail\s*\{[^}]*padding-left:\s*0\s*;/s);
  });

  it('uses the settings body font for driver detail actions, paths, and logs', () => {
    expect(appCss).toMatch(
      /\.driver-manager-shell\s*\{[^}]*--driver-manager-font-body:\s*var\(--gn-settings-font-body, var\(--gn-font-size, 14px\)\)/s,
    );
    expect(appCss).toMatch(
      /\.driver-manager-progress-error\s*\{[^}]*font-size:\s*var\(--driver-manager-font-body\)/s,
    );
    expect(appCss).toMatch(
      /\.driver-manager-detail-path\s*\{[^}]*font-size:\s*var\(--driver-manager-font-body\)/s,
    );
    expect(appCss).toMatch(
      /\.driver-manager-control-label,\s*\.driver-manager-small-text\s*\{[^}]*font-size:\s*var\(--driver-manager-font-body\)/s,
    );
    expect(appCss).toMatch(
      /\.driver-manager-log-empty\s*\{[^}]*font-size:\s*var\(--driver-manager-font-body\)/s,
    );
    expect(appCss).toMatch(
      /body\[data-ui-version\] \.gonavi-settings-center-modal \.driver-manager-card-actions \.ant-btn-sm\s*\{[^}]*font-size:\s*var\(--driver-manager-font-body, var\(--gn-font-size, 14px\)\)/s,
    );
  });

});

describe('V2 filled accent contrast', () => {
  it.each(themeModes)('keeps %s-theme accent surfaces readable', (theme) => {
    const block = readThemeBlock(theme);
    const foreground = readHexToken(block, '--gn-on-accent');

    for (const backgroundToken of ['--gn-accent', '--gn-accent-2']) {
      const background = readHexToken(block, backgroundToken);
      expect(
        contrastRatio(foreground, background),
        `${theme} ${backgroundToken} foreground contrast`,
      ).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
    }
  });

  it.each(themeModes)('keeps %s-theme primary button states readable and distinct', (theme) => {
    const block = readThemeBlock(theme);
    const foreground = readHexToken(
      readCssRule('body[data-ui-version="v2"]:not([data-custom-theme])'),
      '--gn-ant-on-primary',
    );
    const backgrounds = primaryButtonStates.map(({ backgroundToken }) => (
      readHexToken(block, backgroundToken)
    ));

    backgrounds.forEach((background, index) => {
      expect(
        contrastRatio(foreground, background),
        `${theme} ${primaryButtonStates[index].name} label contrast`,
      ).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
    });
    for (let index = 0; index < backgrounds.length - 1; index += 1) {
      expect(
        contrastRatio(backgrounds[index], backgrounds[index + 1]),
        `${theme} ${primaryButtonStates[index].name} to ${primaryButtonStates[index + 1].name} state contrast`,
      ).toBeGreaterThanOrEqual(MIN_STATE_CONTRAST);
    }
  });

  it('wires every primary button state to the primary foreground token', () => {
    for (const state of primaryButtonStates) {
      const rule = readCssRule(state.selector);
      expect(rule).toContain(`background: ${state.backgroundValue} !important;`);
      expect(rule).toContain(
        'color: var(--gn-ant-on-primary, var(--gn-on-accent, #fff)) !important;',
      );
    }
  });
});
