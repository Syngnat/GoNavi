import { useState } from 'react';
import { Alert } from 'antd';
import { useI18n } from '../i18n/provider';
import { PluginInstallPreview } from '../components/pluginManager/PluginInstallPreview';
import type { PluginInspection } from '../plugins/types';
import { MarketInspectionNotices } from './MarketInspectionNotices';
import { MarketInstallPermissions } from './MarketInstallPermissions';
import { MarketPackageSummary } from './MarketPackageSummary';
import { MarketTypedConfirmation } from './MarketTypedConfirmation';
import { marketInstallConfirmationMatches, marketInstallIdentity } from './installIdentity';
import type { MarketPlugin } from './types';

interface Props {
  inspection: PluginInspection;
  plugin: MarketPlugin;
  sourceBaseUrl: string;
  trustedOfficial: boolean;
  allowed: boolean;
  replace?: boolean;
  confirmText: string;
  error: string;
  consumed: boolean;
  installing: boolean;
  onCancel: () => void;
  onInstall: () => Promise<void>;
}

export function MarketInstallReview({
  inspection,
  plugin,
  sourceBaseUrl,
  trustedOfficial,
  allowed,
  replace,
  confirmText,
  error,
  consumed,
  installing,
  onCancel,
  onInstall,
}: Props) {
  const { t } = useI18n();
  const expected = marketInstallIdentity(plugin, sourceBaseUrl);
  const [repository, setRepository] = useState('');
  const [trusted, setTrusted] = useState(false);
  const matched = marketInstallConfirmationMatches(expected, repository);
  const ready = matched && trusted;

  return (
    <PluginInstallPreview
      inspection={inspection}
      allowed={allowed}
      replace={replace}
      confirmText={confirmText}
      title={t('plugin.market.install_confirm_title')}
      width={760}
      summary={<MarketPackageSummary inspection={inspection} official={trustedOfficial && Boolean(plugin.official)} />}
      warning={<Alert showIcon type="warning" message={t('plugin.market.install_warning')} description={t('plugin.install.warning')} />}
      details={<MarketInspectionNotices error={error} consumed={consumed} installing={installing} />}
      permissions={<MarketInstallPermissions manifest={inspection.manifest} />}
      confirmation={<MarketTypedConfirmation expected={expected} repository={repository} matched={matched}
        trusted={trusted} onRepositoryChange={setRepository} onTrustedChange={setTrusted} />}
      confirmationReady={ready}
      requireTrust={false}
      showTrust={false}
      onCancel={onCancel}
      onInstall={onInstall}
    />
  );
}
