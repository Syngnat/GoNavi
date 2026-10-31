import { Alert, Button, Modal, Spin, Typography } from 'antd';
import { useI18n } from '../i18n/provider';
import { PluginInstallPreview } from '../components/pluginManager/PluginInstallPreview';
import { pluginErrorText } from '../plugins/apiResult';
import { formatBytes } from '../utils/byteSize';
import { useMarketInspection } from './useMarketInspection';
import { MarketInspectionProof } from './MarketInspectionProof';
import type { MarketInspectionRequest } from './types';

interface Props {
  request: MarketInspectionRequest;
  source: string;
  allowed: boolean;
  replace?: boolean;
  onClose: () => void;
  onInstalled: () => void;
  onInstallError: (message: string) => void;
}
export function MarketInstallConsent({ request, source, allowed, replace, onClose, onInstalled, onInstallError }: Props) {
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
  return <PluginInstallPreview key={inspection.quoteRevision} inspection={inspection.quote.inspection} allowed={inspection.canInstall} replace={replace} onCancel={close}
    digestLabel={t('plugin.market.content_digest')}
    details={<MarketInspectionProof quote={inspection.quote} source={source} error={inspection.error} consumed={inspection.consumed} installing={inspection.installing} />}
    onInstall={async () => {
      try { await inspection.commit(); onClose(); }
      catch (cause) { onInstallError(pluginErrorText(cause)); throw cause; }
      finally { onInstalled(); }
    }} />;
}
