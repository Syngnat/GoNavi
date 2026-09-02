import React from 'react';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

import { V2ConnectionContextMenuView } from './V2TableContextMenu';
import { t } from '../i18n';

const renderMenu = (supportsQueryEditor?: boolean): string => renderToStaticMarkup(
  <V2ConnectionContextMenuView
    connectionName="dev240"
    driverLabel="jvm"
    supportsQueryEditor={supportsQueryEditor}
  />,
);

describe('V2ConnectionContextMenuView query entry gating', () => {
  it('omits new query and run SQL file actions when the connection has no query workflow', () => {
    const markup = renderMenu(false);
    expect(markup).not.toContain(t('sidebar.menu.new_query'));
    expect(markup).not.toContain(t('sidebar.sql_file_exec.title'));
    expect(markup).toContain(t('connection.sidebar.menu.refresh'));
    expect(markup).toContain(t('sidebar.menu.edit_connection'));
  });

  it('keeps new query and run SQL file actions for query-capable connections', () => {
    const markup = renderMenu(true);
    expect(markup).toContain(t('sidebar.menu.new_query'));
    expect(markup).toContain(t('sidebar.sql_file_exec.title'));
  });

  it('uses Elasticsearch index terminology for its top-level create action', () => {
    const markup = renderToStaticMarkup(
      <V2ConnectionContextMenuView
        connectionName="Elasticsearch dev"
        driverLabel="elasticsearch"
        supportsCreateDatabase={false}
        supportsCreateIndex
        createIndexLabel={t('query_editor.elasticsearch.templates.create_index')}
      />,
    );

    expect(markup).toContain(t('query_editor.elasticsearch.templates.create_index'));
    expect(markup).not.toContain(t('connection.sidebar.menu.createDatabase'));
  });
});
