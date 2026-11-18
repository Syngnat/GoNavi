import { useState } from 'react';
import { Alert, Button, Descriptions, Modal } from 'antd';
import { SafetyCertificateOutlined } from '@ant-design/icons';
import { useI18n } from '../i18n/provider';
import { MarketDetailOverview } from './MarketDetailOverview';
import { MarketPluginInstallConsent } from './MarketPluginInstallConsent';
import { MarketDowngradeConfirm } from './MarketDowngradeConfirm';
import { isMarketDowngrade } from './versionChoices';
import { marketInstallRepository, marketInspectionRequest } from './installIdentity';
import { installModalStyles } from '../utils/installModalLayout';
import type { MarketInspectionRequest, MarketPlugin, MarketSource } from './types';
import './marketDetail.css';

interface Props {
  plugin: MarketPlugin;
  source: MarketSource;
  allowed: boolean;
  installedVersion?: string;
  onClose: () => void;
  onInstalled: () => void;
}

export function MarketPluginInstallModal({ plugin, source, allowed, installedVersion, onClose, onInstalled }: Props) {
  const { t } = useI18n();
  const [request, setRequest] = useState<MarketInspectionRequest | null>(null);
  const [downgradeOpen, setDowngradeOpen] = useState(false);
  const pending = marketInspectionRequest(plugin, source.sourceId);
  const sameVersionInstalled = installedVersion !== undefined && installedVersion === plugin.version;
  const downgrade = isMarketDowngrade(plugin.version, installedVersion);
  const repository = marketInstallRepository(plugin, source.baseUrl);
  if (request) return <MarketPluginInstallConsent request={request} plugin={plugin} source={source} allowed={allowed}
    installedVersion={installedVersion} onClose={onClose} onInstalled={onInstalled} />;
  const footer = <div className="market-detail-actions">
    <Button onClick={onClose}>{t('common.cancel')}</Button>
    <Button type="primary" icon={<SafetyCertificateOutlined aria-hidden />} disabled={!allowed || !pending || sameVersionInstalled}
      onClick={() => { if (!pending) return; if (downgrade) setDowngradeOpen(true); else setRequest(pending); }}>{t('plugin.market.install_confirm')}</Button>
  </div>;
  return <><Modal open title={t('plugin.market.install_title')} width={720} footer={footer} onCancel={onClose}
    styles={installModalStyles}>
    <div className="plugin-stack">
      <MarketDetailOverview plugin={plugin} source={source.baseUrl} trustedOfficial={source.trustedOfficial} installedVersion={installedVersion} sourceId={source.sourceId} />
      <Descriptions column={1} size="small" bordered items={[
        { key: 'repository', label: t('plugin.market.install_repository'), children: <code className="plugin-break">{repository}</code> },
      ]} />
      <Alert showIcon type="warning" message={t('plugin.install.warning')} />
      {!allowed && <Alert showIcon type="warning" message={t('plugin.backend.error.management_denied')} />}
      {sameVersionInstalled && <Alert showIcon type="info" message={t('plugin.market.versions.installed')}
        description={t('plugin.market.installed_version', { version: installedVersion ?? '' })} />}
      {!pending && !sameVersionInstalled && <Alert showIcon type="warning" message={t('plugin.market.no_artifact')} />}
    </div>
  </Modal>
  {downgradeOpen && installedVersion && <MarketDowngradeConfirm from={installedVersion} to={plugin.version}
    onCancel={() => setDowngradeOpen(false)} onConfirm={() => { setDowngradeOpen(false); if (pending) setRequest(pending); }} />}
  </>;
}
