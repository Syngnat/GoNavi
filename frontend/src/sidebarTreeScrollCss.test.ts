import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const appCss = readFileSync(path.resolve(__dirname, './App.css'), 'utf8');

describe('sidebar tree horizontal scroll css', () => {
  it('keeps the virtual tree width anchored to the sidebar by default', () => {
    expect(appCss).toMatch(/\.sidebar-tree-scroll-shell\s+\.ant-tree\s+\.ant-tree-list-holder,\s*\.sidebar-tree-scroll-shell\s+\.ant-tree\s+\.ant-tree-list-holder-inner\s*\{[^}]*min-width:\s*100%;/s);
    expect(appCss).not.toMatch(/\.sidebar-tree-scroll-shell\s+\.ant-tree\s+\.ant-tree-list-holder,\s*\.sidebar-tree-scroll-shell\s+\.ant-tree\s+\.ant-tree-list-holder-inner\s*\{[^}]*max-content/s);

    expect(appCss).toMatch(/\.sidebar-tree-scroll-shell\s+\.ant-tree\s+\.ant-tree-treenode\s*\{[^}]*width:\s*auto;[^}]*min-width:\s*100%;/s);
    expect(appCss).not.toMatch(/\.sidebar-tree-scroll-shell\s+\.ant-tree\s+\.ant-tree-treenode\s*\{[^}]*width:\s*max-content/s);

    expect(appCss).toMatch(/\.sidebar-tree-scroll-shell\s+\.ant-tree\s+\.ant-tree-node-content-wrapper\s*\{[^}]*width:\s*auto\s*!important;[^}]*min-width:\s*0;/s);
    expect(appCss).not.toMatch(/\.sidebar-tree-scroll-shell\s+\.ant-tree\s+\.ant-tree-node-content-wrapper\s*\{[^}]*max-content/s);

    expect(appCss).toMatch(/\.sidebar-tree-scroll-shell\s+\.ant-tree\s+\.ant-tree-title\s*\{[^}]*min-width:\s*0;[^}]*overflow:\s*visible;/s);
    expect(appCss).not.toMatch(/\.sidebar-tree-scroll-shell\s+\.ant-tree\s+\.ant-tree-title\s*\{[^}]*max-content/s);

    expect(appCss).toMatch(/\.sidebar-tree-scroll-shell\s+\.ant-tree\s+\.ant-tree-switcher\s*\{[^}]*flex:\s*0 0 24px;[^}]*width:\s*24px\s*!important;[^}]*min-width:\s*24px;/s);
    expect(appCss).toMatch(/\.sidebar-tree-scroll-shell\s+\.ant-tree\s+\.ant-tree-iconEle\s*\{[^}]*flex:\s*0 0 26px;[^}]*width:\s*26px\s*!important;[^}]*min-width:\s*26px;/s);
  });
});
