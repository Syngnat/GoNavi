import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n/provider';
import type { LanguagePreference } from '../../i18n/types';
import type { TabData } from '../../types';
import SqlAuditWorkbench from './SqlAuditWorkbench';

const connections = [{
  id: 'conn-1',
  name: 'orders-prod',
  config: { type: 'mysql', host: 'localhost', port: 3306 },
}];

vi.mock('../../store', () => ({
  useStore: (selector: (state: any) => unknown) => selector({ connections, addTab: vi.fn() }),
}));

const renderWorkbench = (
  preference: LanguagePreference = 'en-US',
  tab: TabData = { id: 'sql-audit-center', title: 'SQL Audit', type: 'sql-audit', connectionId: '' },
) => renderToStaticMarkup(
  <I18nProvider preference={preference} systemLanguages={[preference]} onPreferenceChange={vi.fn()}>
    <SqlAuditWorkbench
      tab={tab}
      backend={{}}
    />
  </I18nProvider>,
);

describe('SqlAuditWorkbench', () => {
  it('renders a localized, privacy-first audit workspace empty state', () => {
    const markup = renderWorkbench('en-US');

    expect(markup).toContain('SQL Audit Center');
    expect(markup).toContain('Audit SQL is redacted by default');
    expect(markup).toContain('No SQL audit records yet');
    expect(markup).toContain('Search SQL, fingerprint, query ID, or error…');
    expect(markup).not.toContain('SQL 审计中心');
  });

  it('renders the execution-history workflow separately from the audit workspace', () => {
    const markup = renderWorkbench('zh-CN', {
      id: 'sql-query-history-center',
      title: '执行历史',
      type: 'sql-audit',
      connectionId: 'conn-1',
      dbName: 'analytics',
      sqlAuditView: 'query-history',
    });

    expect(markup).toContain('SQL 执行历史');
    expect(markup).toContain('执行历史遵循 SQL 审计策略');
    expect(markup).toContain('没有符合当前筛选条件的 SQL 执行记录');
    expect(markup).not.toContain('校验完整性');
    expect(markup).not.toContain('清空记录');
  });
});
