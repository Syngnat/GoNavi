import { Alert, Button, Modal, Spin, Typography } from 'antd';
import { useI18n } from '../i18n/provider';
import { formatBytes } from '../utils/byteSize';
import { useMarketInspection } from './useMarketInspection';
import { MarketInstallReview } from './MarketInstallReview';
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
  const close = () => { inspection.cancel(); onClose(); };
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
  return <MarketInstallReview key={inspection.quoteRevision} inspection={inspection.quote.inspection} plugin={plugin}
    sourceBaseUrl={source.baseUrl} trustedOfficial={source.trustedOfficial} allowed={inspection.canInstall}
    replace={Boolean(installedVersion)} confirmText={t('plugin.market.install_submit')} error={inspection.error}
    consumed={inspection.consumed} installing={inspection.installing} onCancel={close}
    onInstall={async () => {
      try { await inspection.commit(); onClose(); }
      finally { onInstalled(); }
    }} />;
}
