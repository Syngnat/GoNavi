import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n/provider';
import type { LanguagePreference } from '../../i18n/types';
import SqlAuditWorkbench from './SqlAuditWorkbench';

const connections = [{
  id: 'conn-1',
  name: 'orders-prod',
  config: { type: 'mysql', host: 'localhost', port: 3306 },
}];

vi.mock('../../store', () => ({
  useStore: (selector: (state: any) => unknown) => selector({ connections }),
}));

const renderWorkbench = (preference: LanguagePreference = 'en-US') => renderToStaticMarkup(
  <I18nProvider preference={preference} systemLanguages={[preference]} onPreferenceChange={vi.fn()}>
    <SqlAuditWorkbench
      tab={{ id: 'sql-audit-center', title: 'SQL Audit', type: 'sql-audit', connectionId: '' }}
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
});
