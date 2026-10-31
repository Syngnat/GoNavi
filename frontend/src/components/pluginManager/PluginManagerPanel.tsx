import { useEffect, useState } from 'react';
import { Alert, Button, Empty, Pagination, Spin, Tabs, Tag, Typography } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { useI18n } from '../../i18n/provider';
import { usePluginManager } from '../../plugins/usePluginManager';
import { notifyPluginLifecycle } from '../../plugins/events';
import { PluginMarketPanel } from '../../pluginMarket/PluginMarketPanel';
import { MarketDetailDrawer } from '../../pluginMarket/MarketDetailDrawer';
import { useInstalledPluginUpdates } from '../../pluginMarket/useInstalledPluginUpdates';
import type { InstalledPluginUpdate } from '../../pluginMarket/installedPluginUpdates';
import { LocalInstallPanel } from './LocalInstallPanel';
import { PluginCard } from './PluginCard';
import './pluginManager.css';

export function PluginManagerPanel() {
  const { t } = useI18n();
  const manager = usePluginManager();
  const [activeTab, setActiveTab] = useState('installed');
  const [page, setPage] = useState(1);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [selectedUpdate, setSelectedUpdate] = useState<InstalledPluginUpdate | null>(null);
  const updates = useInstalledPluginUpdates(manager.plugins, activeTab === 'installed');
  const refresh = () => { void manager.refresh(); void updates.reload(); };
  const installedChanged = () => { void manager.refresh(); void updates.reload(); notifyPluginLifecycle(); };
  useEffect(() => {
    if (selectedUpdate && (activeTab !== 'installed'
      || !manager.plugins.some((item) => item.manifest.id === selectedUpdate.plugin.id && item.manifest.version === selectedUpdate.installedVersion)
      || (updates.sourcesKnown && !updates.sources.some((source) => source.sourceId === selectedUpdate.source.sourceId)))) setSelectedUpdate(null);
  }, [activeTab, manager.plugins, selectedUpdate, updates.sources, updates.sourcesKnown]);
  const currentPage = Math.min(page, Math.max(1, Math.ceil(manager.plugins.length / 10)));
  const installed = <div className="plugin-installed-layout">
    <section className="plugin-library plugin-stack" aria-label={t('plugin.manager.installed')}>
      <header className="plugin-library-header">
        <div className="plugin-library-heading"><Typography.Text strong>{t('plugin.manager.installed')}</Typography.Text>
          <Tag>{manager.plugins.length}</Tag></div>
        <div className="plugin-library-actions">
          <Button type="text" loading={updates.loading} onClick={() => void updates.reload()}>{t('plugin.update.check')}</Button>
          <Button type="text" icon={<ReloadOutlined aria-hidden />} onClick={refresh}>{t('plugin.action.refresh')}</Button>
        </div>
      </header>
      {manager.error && <Alert showIcon type="error" message={manager.error} />}
      {updates.failed && <Alert showIcon type="warning" message={t('plugin.update.check_failed')} />}
      {updates.checked && !updates.failed && updates.sources.length === 0 && manager.plugins.length > 0
        && <Alert type="info" showIcon message={t('plugin.market.sources_none_enabled')} />}
      {updates.checked && !updates.loading && !updates.failed && updates.updates.size === 0 && updates.sources.length > 0 && manager.plugins.length > 0
        && <Typography.Text type="secondary">{t('plugin.update.up_to_date')}</Typography.Text>}
      {manager.loading ? <div className="plugin-library-state" aria-busy="true"><Spin /></div>
        : !manager.error && manager.plugins.length === 0 ? <div className="plugin-library-state">
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('plugin.manager.empty')}>
            <Button type="primary" onClick={() => setActiveTab('market')}>{t('plugin.market.title')}</Button>
          </Empty>
        </div> : null}
      <div className="plugin-installed-grid">
        {manager.plugins.slice((currentPage - 1) * 10, currentPage * 10).map((plugin) => <PluginCard key={plugin.manifest.id} plugin={plugin} manager={manager}
          update={updates.updates.has(plugin.manifest.id) ? { version: updates.updates.get(plugin.manifest.id)!.plugin.version, sourceLabel: updates.updates.get(plugin.manifest.id)!.source.baseUrl } : undefined}
          updateDisabled={!manager.runtime.managementAllowed || Boolean(manager.busy[plugin.manifest.id]) || updates.loading}
          onUpdate={() => { const update = updates.updates.get(plugin.manifest.id); if (update && manager.runtime.managementAllowed && !updates.loading && !manager.busy[plugin.manifest.id] && update.installedVersion === plugin.manifest.version) { setExpandedId(null); setSelectedUpdate(update); } }}
          expanded={expandedId === plugin.manifest.id} onToggle={() => setExpandedId(expandedId === plugin.manifest.id ? null : plugin.manifest.id)} />)}
      </div>
      {manager.plugins.length > 10 && <Pagination current={currentPage} pageSize={10} total={manager.plugins.length} onChange={setPage} showSizeChanger={false} />}
    </section>
    <LocalInstallPanel allowed={manager.runtime.managementAllowed} onInstalled={installedChanged}
      installedIds={new Set(manager.plugins.map((plugin) => plugin.manifest.id))} />
  </div>;
  return <section className="plugin-manager">
    <header className="plugin-manager-heading"><Typography.Title level={4}>{t('plugin.manager.title')}</Typography.Title>
      <Typography.Paragraph type="secondary">{t('plugin.manager.description')}</Typography.Paragraph></header>
    {manager.runtime.safeMode && <Alert showIcon type="warning" message={t('plugin.manager.safe_mode')} />}
    {!manager.loading && !manager.error && !manager.runtime.managementAllowed && <Alert showIcon type="info"
      message={t(manager.runtime.webRuntime === true ? 'plugin.manager.read_only_web' : 'plugin.manager.read_only')} />}
    <Tabs className="plugin-manager-tabs" size="small" tabBarGutter={0} activeKey={activeTab} onChange={setActiveTab} destroyInactiveTabPane items={[
      { key: 'installed', label: t('plugin.manager.installed'), children: installed },
      { key: 'market', label: t('plugin.market.title'), children: <PluginMarketPanel allowed={manager.runtime.managementAllowed} onInstalled={installedChanged} /> },
    ]} />
    {selectedUpdate && <MarketDetailDrawer scoped id={selectedUpdate.plugin.id} source={selectedUpdate.source.baseUrl}
      sourceId={selectedUpdate.source.sourceId} trustedOfficial={selectedUpdate.source.trustedOfficial}
      initialVersion={selectedUpdate.plugin.version} installedVersion={selectedUpdate.installedVersion}
      allowed={manager.runtime.managementAllowed} onClose={() => setSelectedUpdate(null)}
      onInstalled={installedChanged} />}
  </section>;
}
