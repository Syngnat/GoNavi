import { Alert, Spin } from 'antd';
import './pluginPage.css';
import { useI18n } from '../i18n/provider';
import { publicPluginCommands } from '../plugins/dataSource/reservedCommands';
import { DeclarativePluginPage } from './DeclarativePluginPage';
import { HTMLPluginPage } from './HTMLPluginPage';
import { usePluginPageTarget } from './usePluginPageTarget';

/**
 * Workbench content for one declared plugin page. It never throws into the tab shell: a
 * stopped, removed or redeclared plugin renders the unavailable state instead of a blank tab.
 */
export function PluginPageHost({ pluginID, pageID, launch }: { pluginID: string; pageID: string; launch?: unknown }) {
  const { t } = useI18n();
  const target = usePluginPageTarget(pluginID, pageID);
  if (target.loading) {
    return <div className="plugin-page-status" aria-busy="true"><Spin size="small" /></div>;
  }
  if (target.error) {
    return <div className="plugin-page-status">
      <Alert type="error" showIcon message={t('plugin.pages.unavailable')} description={target.error} />
    </div>;
  }
  if (!target.available || !target.page || !target.status) {
    return <div className="plugin-page-status">
      <Alert type="warning" showIcon message={t('plugin.pages.unavailable')} />
    </div>;
  }
  const page = target.page;
  if (page.html) {
    return <HTMLPluginPage
      key={pluginID + ':' + page.id + ':' + target.status.generation}
      pluginID={pluginID}
      pageID={page.id}
      title={page.title}
      source={page.html.source}
      launch={launch}
    />;
  }
  return <DeclarativePluginPage
    key={pluginID + ':' + page.id + ':' + target.status.generation}
    pluginID={pluginID}
    generation={target.status.generation}
    commands={publicPluginCommands(target.status.manifest)}
    body={page.body}
  />;
}
