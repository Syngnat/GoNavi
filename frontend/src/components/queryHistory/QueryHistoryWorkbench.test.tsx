import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n/provider';
import type { LanguagePreference } from '../../i18n/types';
import type { TabData } from '../../types';
import QueryHistoryWorkbench from './QueryHistoryWorkbench';

const connections = [{
  id: 'conn-1',
  name: 'orders-prod',
  config: { type: 'mysql', host: 'localhost', port: 3306 },
}];

vi.mock('../../store', () => ({
  useStore: (selector: (state: any) => unknown) => selector({ connections, addTab: vi.fn() }),
}));

const historyTab: TabData = {
  id: 'sql-query-history-center',
  title: '执行历史',
  type: 'sql-audit',
  connectionId: 'conn-1',
  dbName: 'analytics',
  sqlAuditView: 'query-history',
};

const renderWorkbench = (preference: LanguagePreference) => renderToStaticMarkup(
  <I18nProvider preference={preference} systemLanguages={[preference]} onPreferenceChange={vi.fn()}>
    <QueryHistoryWorkbench tab={historyTab} backend={{}} />
  </I18nProvider>,
);

describe('QueryHistoryWorkbench', () => {
  it('renders the localized execution-history shell with the scoped filters preloaded', () => {
    const markup = renderWorkbench('zh-CN');

    expect(markup).toContain('SQL 执行历史');
    expect(markup).toContain('执行历史遵循 SQL 审计策略');
    expect(markup).toContain('搜索 SQL、查询 ID 或错误…');
    expect(markup).toContain('没有符合当前筛选条件的 SQL 执行记录');
    expect(markup).toContain('在左侧选择一条记录');
    expect(markup).toContain('analytics');
    expect(markup).not.toContain('校验完整性');
    expect(markup).not.toContain('清空记录');
  });

  it('follows the interface language', () => {
    const markup = renderWorkbench('en-US');

    expect(markup).toContain('SQL Execution History');
    expect(markup).not.toContain('SQL 执行历史');
  });
});
