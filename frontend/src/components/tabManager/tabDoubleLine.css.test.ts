import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workbenchCss = readFileSync(
  new URL('../../styles/v2Theme/v2-theme-09-full-v2-workbench.css', import.meta.url),
  'utf8',
);

const readRule = (selector: string): string => {
  const match = workbenchCss.match(new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`));
  if (!match) throw new Error(`rule not found: ${selector}`);
  return match[1];
};

describe('double-line workbench tab metrics', () => {
  it('gives the second line a 14px row inside a 50px tab', () => {
    expect(readRule('body[data-ui-version="v2"] .gn-v2-main-tabs-double > .ant-tabs-nav'))
      .toMatch(/height:\s*50px;/);
    expect(readRule('body[data-ui-version="v2"] .gn-v2-main-tabs-double > .ant-tabs-nav .ant-tabs-tab'))
      .toMatch(/height:\s*50px;/);
    expect(readRule('body[data-ui-version="v2"] .gn-v2-tab-label-double'))
      .toMatch(/padding-bottom:\s*5px;/);
    expect(readRule('body[data-ui-version="v2"] .gn-v2-tab-label-double .gn-v2-tab-label-secondary'))
      .toMatch(/min-height:\s*14px;/);
    expect(readRule('body[data-ui-version="v2"] .gn-v2-tab-label-secondary'))
      .toMatch(/gap:\s*0;/);
    expect(readRule('body[data-ui-version="v2"] .gn-v2-tab-kind'))
      .toMatch(/height:\s*14px;/);
    expect(readRule('body[data-ui-version="v2"] .gn-v2-tab-kind'))
      .not.toMatch(/height:\s*17px;/);
  });

  it('stops the tab button line box from clipping the label', () => {
    const tabBtn = readRule('body[data-ui-version="v2"] .gn-v2-main-tabs > .ant-tabs-nav .ant-tabs-tab-btn');
    expect(tabBtn).toMatch(/display:\s*flex;/);
    expect(tabBtn).toMatch(/line-height:\s*1;/);
  });
});
