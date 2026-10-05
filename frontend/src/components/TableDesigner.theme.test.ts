import { describe, expect, it } from 'vitest';
import { readCssWithImports } from '../test/readCssWithImports';

/**
 * 对象设计表（TableDesigner）工作台样式断言。
 *
 * 这里只读 .css —— 样式表没有可执行的被测代码，文本断言是其唯一验证方式。
 * 原先散落在此的组件源码（.tsx）文本断言已按 testPolicy 守卫移除：
 * 竖向网格线开关的规则现由 utils/dataGridDisplay 的
 * resolveDataTableVerticalBorderRule 统一给出，其行为断言见 dataGridDisplay.test.ts。
 */

const workbenchCss = readCssWithImports(new URL('../styles/v2-theme-workbench.css', import.meta.url));

describe('TableDesigner workbench surfaces', () => {
  it('uses the same workbench panel token as the data preview grid', () => {
    expect(workbenchCss).toContain('.gn-v2-table-designer {');
    expect(workbenchCss).toContain('background: var(--gn-bg-panel-2);');
    expect(workbenchCss).toContain('.gn-v2-table-designer.is-embedded {');
    expect(workbenchCss).toContain('background: var(--gn-bg-panel-2) !important;');
    expect(workbenchCss).toContain('.gn-v2-table-designer .ant-table-content {');
  });

  it('keeps the select-all checkbox on the same vertical axis as row checkboxes', () => {
    expect(workbenchCss).toContain('.ant-table-thead > tr > th.table-designer-select-column');
    expect(workbenchCss).toContain('.ant-table-tbody > tr > td.table-designer-select-column');
    expect(workbenchCss).toContain('padding: 0 !important;');
  });
});
