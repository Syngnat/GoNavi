import React from 'react';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

import { V2ConnectionContextMenuView } from './V2TableContextMenu';
import { t } from '../i18n';

describe('V2ConnectionContextMenuView connection group actions', () => {
  it('keeps move targets but omits remove from group for an ungrouped connection', () => {
    const markup = renderToStaticMarkup(
      <V2ConnectionContextMenuView
        connectionName="127.0.0.1"
        driverLabel="clickhouse"
        tags={[
          { id: 'team', name: '团队环境', selected: false },
          { id: 'staging', name: '预发布环境', selected: false },
        ]}
      />,
    );

    expect(markup).toContain('团队环境');
    expect(markup).toContain('预发布环境');
    expect(markup).not.toContain(t('connection.sidebar.menu.moveToUngrouped'));
  });

  it('keeps remove from group for a grouped connection', () => {
    const markup = renderToStaticMarkup(
      <V2ConnectionContextMenuView
        connectionName="127.0.0.1"
        driverLabel="clickhouse"
        tags={[
          { id: 'team', name: '团队环境', selected: true },
          { id: 'staging', name: '预发布环境', selected: false },
        ]}
      />,
    );

    expect(markup).toContain(t('connection.sidebar.menu.moveToUngrouped'));
  });
});
