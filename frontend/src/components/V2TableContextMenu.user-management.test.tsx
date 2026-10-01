import React from 'react';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

import { V2ConnectionContextMenuView } from './V2TableContextMenu';
import { t } from '../i18n';

describe('V2ConnectionContextMenuView user management entry', () => {
  it('shows the user management action only for data sources that support it', () => {
    const supported = renderToStaticMarkup(<V2ConnectionContextMenuView connectionName="mysql" supportsUserManagement />);
    const unsupported = renderToStaticMarkup(<V2ConnectionContextMenuView connectionName="sqlite" />);
    expect(supported).toContain(t('sidebar.action.user_management'));
    expect(unsupported).not.toContain(t('sidebar.action.user_management'));
  });

  it('keeps the entry for redis connections that support ACL management', () => {
    const markup = renderToStaticMarkup(<V2ConnectionContextMenuView connectionName="cache" isRedis supportsUserManagement />);
    expect(markup).toContain(t('sidebar.action.user_management'));
  });
});
