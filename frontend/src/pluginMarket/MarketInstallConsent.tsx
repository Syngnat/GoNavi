import { Alert, Button, Modal, Spin, Typography } from 'antd';
import { useI18n } from '../i18n/provider';
import { pluginErrorText } from '../plugins/apiResult';
import { formatBytes } from '../utils/byteSize';
import { useMarketInspection } from './useMarketInspection';
import { MarketInstallReview } from './MarketInstallReview';
import type { MarketInspectionRequest, MarketPlugin } from './types';

interface Props {
  request: MarketInspectionRequest;
  plugin: MarketPlugin;
  source: string;
  trustedOfficial: boolean;
  allowed: boolean;
  replace?: boolean;
  onClose: () => void;
  onInstalled: () => void;
  onInstallError: (message: string) => void;
}
export function MarketInstallConsent({ request, plugin, source, trustedOfficial, allowed, replace, onClose, onInstalled, onInstallError }: Props) {
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
    sourceBaseUrl={source} trustedOfficial={trustedOfficial} allowed={inspection.canInstall} replace={replace}
    confirmText={replace ? t('plugin.install.replace_confirm') : t('plugin.market.install_submit')}
    error={inspection.error} consumed={inspection.consumed} installing={inspection.installing} onCancel={close}
    onInstall={async () => {
      try { await inspection.commit(); onClose(); }
      catch (cause) { onInstallError(pluginErrorText(cause)); throw cause; }
      finally { onInstalled(); }
    }} />;
}
