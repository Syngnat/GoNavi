import { resolveDriverDownloadSourceMeta } from './driverManagerModel';
import { t } from '../../i18n';
import { formatDriverNetworkSummary } from './driverManagerMessages';
import type { DriverManagerStateApi } from './useDriverManagerState';
import type { DriverManagerModalProps } from '../DriverManagerModal';

export interface BuildDriverManagerNetworkSummaryInput {
  downloadSource: DriverManagerModalProps['downloadSource'];
  networkStatus: DriverManagerStateApi['networkStatus'];
  networkChecking: DriverManagerStateApi['networkChecking'];
}

export const buildDriverManagerNetworkSummary = ({ downloadSource, networkStatus, networkChecking }: BuildDriverManagerNetworkSummaryInput) => {
  const downloadSourceMeta = resolveDriverDownloadSourceMeta(downloadSource);
  const proxyEnvEntries = Object.entries(networkStatus?.proxyEnv || {});
  const downloadRequiredHosts = (networkStatus?.downloadRequiredHosts || []).filter(Boolean);
  const showDownloadChainAlert = networkStatus?.downloadChainReachable === false;
  const networkUnreachable = networkStatus?.reachable === false;
  const usingFallback = networkStatus?.usingFallback === true
    || (networkStatus?.mirrorReachable === false && networkStatus?.fallbackReachable === true);
  const listSeparator = t('driver_manager.punctuation.list_separator');
  const downloadRequiredHostText = (downloadRequiredHosts.length > 0
    ? downloadRequiredHosts
    : [
        'download.syngnat.top',
        'github.com',
        'api.github.com',
        'release-assets.githubusercontent.com',
        'objects.githubusercontent.com',
        'proxy.golang.org',
      ]).join(listSeparator);
  const networkSummaryText = networkStatus ? formatDriverNetworkSummary(networkStatus) : '';
  const networkDotTone = networkChecking
    ? 'checking'
    : networkUnreachable
      ? 'error'
      : networkStatus
        ? (usingFallback ? 'warning' : 'ok')
        : 'idle';
  const networkPillText = networkChecking
    ? t('driver_manager.network.checking')
    : networkUnreachable
      ? t('driver_manager.network.unreachable')
      : networkStatus
        ? networkSummaryText
        : t('driver_manager.network.not_checked');
  const networkTooltipTitle = networkPillText;
  return {
    downloadSourceMeta,
    proxyEnvEntries,
    showDownloadChainAlert,
    networkUnreachable,
    usingFallback,
    listSeparator,
    downloadRequiredHostText,
    networkSummaryText,
    networkDotTone,
    networkPillText,
    networkTooltipTitle,
  };
};

export type DriverManagerNetworkSummaryApi = ReturnType<typeof buildDriverManagerNetworkSummary>;
