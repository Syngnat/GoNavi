import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Input, Select, Space, Spin, Typography } from 'antd';
import { ReloadOutlined, SettingOutlined } from '@ant-design/icons';
import { useI18n } from '../i18n/provider';
import { useMarketSources } from './useMarketSources';
import { useInstalledPluginVersions } from './useInstalledPluginVersions';
import { MarketSourceSettings } from './MarketSourceSettings';
import { MarketSourceGroup } from './MarketSourceGroup';
import { MarketSearchFilters } from './MarketSearchFilters';
import { emptyMarketFilters } from './catalogFilters';
import { MarketDetailDrawer } from './MarketDetailDrawer';
import { MarketPluginInstallModal } from './MarketPluginInstallModal';
import { useScrollLock } from './useScrollLock';
import type { MarketPlugin, MarketSource, MarketSort } from './types';
import './pluginMarket.css';

interface Selection { id: string; source: MarketSource }
interface InstallSelection { plugin: MarketPlugin; source: MarketSource }
export function PluginMarketPanel({ allowed, onInstalled }: { allowed: boolean; onInstalled: () => void }) {
  const { t } = useI18n();
  const manager = useMarketSources();
  const [query, setQuery] = useState('');
  const [filters, setFilters] = useState(emptyMarketFilters);
  const [sort, setSort] = useState<MarketSort>('updated');
  const [refresh, setRefresh] = useState(0);
  const [editing, setEditing] = useState(false);
  const [selected, setSelected] = useState<Selection | null>(null);
  const [installing, setInstalling] = useState<InstallSelection | null>(null);
  const scrollAnchor = useRef<HTMLDivElement>(null);
  const { installed, refresh: refreshInstalled } = useInstalledPluginVersions(manager.revision);
  useScrollLock(scrollAnchor, installing !== null);
  const enabled = manager.sources.filter((source) => source.enabled);
  const visible = enabled.filter((source) => filters.sourceIds.length === 0 || filters.sourceIds.includes(source.sourceId));
  useEffect(() => {
    const available = (sourceId: string) => manager.sources.some((source) => source.enabled && source.sourceId === sourceId);
    if (selected && !available(selected.source.sourceId)) setSelected(null);
    if (installing && !available(installing.source.sourceId)) setInstalling(null);
  }, [manager.sources, selected, installing]);
  return <div ref={scrollAnchor} className="plugin-market">
    <div className="plugin-market-overview">
      <div className="plugin-market-overview-text"><Typography.Text strong>{t('plugin.market.sources_summary', { enabled: enabled.length, count: manager.sources.length })}</Typography.Text>
        <Typography.Text type="secondary">{t('plugin.market.groups_hint')}</Typography.Text></div>
      <Space wrap><Button icon={<SettingOutlined aria-hidden />} onClick={() => setEditing(true)} disabled={manager.loading}>{t('plugin.market.source')}</Button>
        <Button icon={<ReloadOutlined aria-hidden />} disabled={manager.loading || manager.busy} onClick={() => { void manager.refresh(); setRefresh((value) => value + 1); }}>{t('plugin.action.refresh')}</Button></Space>
    </div>
    <div className="plugin-market-toolbar">
      <Input.Search aria-label={t('plugin.market.search')} placeholder={t('plugin.market.search')} allowClear value={query} maxLength={200}
        onChange={(event) => setQuery(event.target.value)} onSearch={() => setRefresh((value) => value + 1)} />
      <Select aria-label={t('plugin.market.sort')} value={sort} onChange={setSort} options={[
        { value: 'updated', label: t('plugin.market.sort_updated') }, { value: 'rating', label: t('plugin.market.sort_rating') },
        { value: 'downloads', label: t('plugin.market.sort_downloads') },
      ]} />
    </div>
    <MarketSearchFilters sources={enabled} value={filters} onChange={setFilters} onReset={() => { setFilters(emptyMarketFilters()); setQuery(''); }} />
    {!manager.loading && enabled.length > 0 && visible.length === 0 && <Alert type="info" showIcon message={t('plugin.market.filter_no_sources')} />}
    {manager.error && <Alert type="error" showIcon message={t('plugin.market.unavailable')} description={manager.error} />}
    {manager.loading && manager.sources.length === 0 && <div className="plugin-market-loading"><Spin /></div>}
    {!manager.loading && !manager.error && enabled.length === 0 && <Alert type="info" showIcon message={t('plugin.market.sources_none_enabled')} />}
    {visible.map((source) => <MarketSourceGroup key={source.sourceId} source={source} query={query} sort={sort} filters={filters} revision={manager.revision + refresh}
      allowed={allowed} installed={installed} onClearSearch={() => setQuery('')} onSelect={(plugin, current) => setSelected({ id: plugin.id, source: current })}
      onInstall={(plugin, current) => { setSelected(null); setInstalling({ plugin, source: current }); }} />)}
    {editing && <MarketSourceSettings manager={manager} allowed={allowed} onClose={() => setEditing(false)} />}
    {installing && <MarketPluginInstallModal key={installing.source.sourceId + ':' + installing.plugin.id} plugin={installing.plugin}
      source={installing.source} allowed={allowed} installedVersion={installed.get(installing.plugin.id)}
      onClose={() => setInstalling(null)} onInstalled={() => { refreshInstalled(); onInstalled(); }} />}
    {selected && <MarketDetailDrawer key={selected.source.sourceId + ':' + selected.id} scoped id={selected.id} source={selected.source.baseUrl}
      installedVersion={installed.get(selected.id)} trustedOfficial={selected.source.trustedOfficial} sourceId={selected.source.sourceId} allowed={allowed}
      onClose={() => setSelected(null)} onInstalled={() => { refreshInstalled(); onInstalled(); }} />}
  </div>;
}
