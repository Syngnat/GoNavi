import { useState } from 'react';
import { Alert, Button, Modal, Spin, Typography } from 'antd';
import { useI18n } from '../i18n/provider';
import { PluginInstallPreview } from '../components/pluginManager/PluginInstallPreview';
import { formatBytes } from '../utils/byteSize';
import { useMarketInspection } from './useMarketInspection';
import { MarketInspectionProof } from './MarketInspectionProof';
import { MarketTypedConfirmation } from './MarketTypedConfirmation';
import { marketInstallConfirmationMatches, marketInstallIdentity } from './installIdentity';
import type { MarketInspectionRequest, MarketPlugin, MarketSource } from './types';

interface Props {
  request: MarketInspectionRequest;
  plugin: MarketPlugin;
  source: MarketSource;
  allowed: boolean;
  installedVersion?: string;
  onClose: () => void;
  onInstalled: () => void;
}

export function MarketPluginInstallConsent({ request, plugin, source, allowed, installedVersion, onClose, onInstalled }: Props) {
  const { t } = useI18n();
  const inspection = useMarketInspection(request, allowed);
  const [name, setName] = useState('');
  const [repository, setRepository] = useState('');
  const close = () => { inspection.cancel(); onClose(); };
  const manifest = inspection.quote?.inspection.manifest;
  const expected = marketInstallIdentity(manifest?.name ?? '', plugin, source.baseUrl);
  const matched = marketInstallConfirmationMatches(expected, name, repository);
  if (!inspection.quote) return <Modal open title={t('plugin.market.inspect_title')} onCancel={close}
    footer={<Button onClick={close}>{t('common.cancel')}</Button>}>
    <div className="plugin-stack">
      {inspection.loading && <Spin />}
      <Typography.Paragraph>{t('plugin.market.inspect_description')}</Typography.Paragraph>
      {request.sizeBytes ? <Typography.Text type="secondary" className="plugin-package-size"
        title={t('plugin.label.bytes', { count: request.sizeBytes.toLocaleString() })}>
        {t('plugin.label.size')} · {formatBytes(request.sizeBytes)}
      </Typography.Text> : null}
      {inspection.error && <Alert showIcon type="error" message={inspection.error} />}
    </div>
  </Modal>;
  return <PluginInstallPreview key={inspection.quoteRevision} inspection={inspection.quote.inspection} allowed={inspection.canInstall}
    replace={Boolean(installedVersion)} confirmText={t('plugin.market.install_submit')} requireTrust={false} showTrust={false}
    digestLabel={t('plugin.market.content_digest')}
    details={<MarketInspectionProof quote={inspection.quote} source={source.baseUrl} error={inspection.error} consumed={inspection.consumed} installing={inspection.installing} />}
    confirmation={<MarketTypedConfirmation expected={expected} name={name} repository={repository} matched={matched}
      onNameChange={setName} onRepositoryChange={setRepository} />}
    confirmationReady={matched} onCancel={close}
    onInstall={async () => {
      try { await inspection.commit(); onClose(); }
      finally { onInstalled(); }
    }} />;
}
