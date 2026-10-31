import { useI18n } from '../../i18n/provider';
import { PluginManagerPanel } from './PluginManagerPanel';
import './pluginManagerWorkbench.css';

/**
 * 插件管理工作台：独立标签页外壳。PluginManagerPanel 自带标题与说明，
 * 这里只负责工作台区域的内边距与滚动。
 */
export default function PluginManagerWorkbench() {
  const { t } = useI18n();
  return (
    <main className="gn-plugin-manager-workbench" aria-label={t('plugin.manager.title')}>
      <div className="gn-plugin-manager-workbench-body">
        <PluginManagerPanel />
      </div>
    </main>
  );
}
