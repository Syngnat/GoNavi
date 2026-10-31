import { useEffect, useState } from 'react';
import { Alert, Button, Drawer, Spin, Typography } from 'antd';
import { SafetyCertificateOutlined } from '@ant-design/icons';
import { useI18n } from '../i18n/provider';
import { useMarketDetail } from './useMarketDetail';
import { MarketDetailOverview } from './MarketDetailOverview';
import { useMarketVersions } from './useMarketVersions';
import { MarketVersionSelector } from './MarketVersionSelector';
import { MarketDowngradeConfirm } from './MarketDowngradeConfirm';
import { isMarketDowngrade } from './versionChoices';
import { MarketRatingsPanel } from './MarketRatingsPanel';
import { marketPluginWebsiteURL } from './marketWebsite';
import { MarketInstallConsent } from './MarketInstallConsent';
import type { MarketInspectionRequest } from './types';
import './marketDetail.css';

interface Props { installedVersion?: string; initialVersion?: string; scoped?: boolean; id: string; source: string; allowed: boolean; trustedOfficial: boolean; sourceId?: string; onClose: () => void; onInstalled: () => void }
export function MarketDetailDrawer({ id, source, allowed, trustedOfficial, sourceId, scoped = false, installedVersion, initialVersion, onClose, onInstalled }: Props) {
  const { t } = useI18n();
  const detail = useMarketDetail(id, sourceId, scoped);
  const [request, setRequest] = useState<MarketInspectionRequest | null>(null);
  const [installError, setInstallError] = useState('');
  const versions = useMarketVersions(id, sourceId, scoped, Boolean(detail.plugin), initialVersion);
  const [downgradeOpen, setDowngradeOpen] = useState(false);
  const plugin = versions.selected?.plugin ?? detail.plugin;
  const artifact = plugin?.artifact;
  const canPreview = Boolean(versions.selected?.compatible && !versions.loading && !versions.error && plugin && artifact && artifact.version === plugin.version && plugin.id === id
    && sourceId && /^[a-f0-9]{64}$/.test(sourceId) && plugin.sourceId === sourceId);
  const sameVersionInstalled = Boolean(plugin && installedVersion === plugin.version);
  useEffect(() => { setRequest(null); setDowngradeOpen(false); }, [id, sourceId, plugin?.version, artifact?.sha256, installedVersion]);
  const beginPreview = () => { if (canPreview && plugin && artifact && sourceId) { setInstallError(''); setRequest({ id, version: plugin.version, artifactDigest: artifact.sha256, sourceId, sizeBytes: artifact.sizeBytes }); } };
  const footer = plugin ? <div className="market-detail-actions">
    <Typography.Text type="secondary">{t('plugin.market.detail_install_hint')}</Typography.Text>
    <Button type="primary" icon={<SafetyCertificateOutlined aria-hidden />} disabled={!allowed || !canPreview || sameVersionInstalled || detail.loading || Boolean(request)} onClick={() => {
      if (sameVersionInstalled) return;
      if (isMarketDowngrade(plugin.version, installedVersion)) setDowngradeOpen(true); else beginPreview();
    }}>{sameVersionInstalled ? t('plugin.market.versions.installed') : installedVersion && !isMarketDowngrade(plugin.version, installedVersion) ? t('plugin.update.action', { version: plugin.version }) : t('plugin.market.preview_install')}</Button>
  </div> : null;
  return <Drawer open rootClassName="plugin-market-detail" width="min(720px, 100vw)" title={t('plugin.market.detail_title')} footer={footer} onClose={onClose}>
    <div className="market-detail-content">
      {detail.loading && <div className="market-detail-loading"><Spin /></div>}
      {installError && <Alert type="error" showIcon message={installError} />}
      {detail.error && <Alert type="error" showIcon message={t('plugin.market.unavailable')} description={detail.error}
        action={<Button onClick={() => void detail.load()}>{t('plugin.action.refresh')}</Button>} />}
      {plugin && <>
        <MarketDetailOverview plugin={plugin} source={source} trustedOfficial={trustedOfficial} />
        <MarketVersionSelector versions={versions.versions} selectedVersion={versions.selectedVersion} recommended={versions.recommended} installedVersion={installedVersion} loading={versions.loading} error={versions.error} warning={versions.warning} source={source} onChange={versions.choose} onRetry={() => void versions.reload()} />
        {!artifact && <Alert type="warning" showIcon message={t('plugin.market.no_artifact')} />}
        {detail.ratingsError && <Alert type="warning" showIcon message={t('plugin.market.ratings_unavailable')} description={detail.ratingsError} />}
        <MarketRatingsPanel ratings={detail.ratings} websiteURL={marketPluginWebsiteURL(source, id)} />
      </>}
      {downgradeOpen && plugin && installedVersion && <MarketDowngradeConfirm from={installedVersion} to={plugin.version} onCancel={() => setDowngradeOpen(false)} onConfirm={() => { setDowngradeOpen(false); beginPreview(); }} />}
      {request && <MarketInstallConsent request={request} source={source} allowed={allowed} replace={Boolean(installedVersion)} onClose={() => setRequest(null)}
        onInstalled={onInstalled} onInstallError={setInstallError} />}
    </div>
  </Drawer>;
}
