import { Alert, Collapse, Space } from 'antd';
import { dismissDriverNetworkNotice } from './driverNetworkNoticeState';
import { t } from '../../i18n';
import { Text, resolveDriverNetworkProbeLabel } from './driverManagerModel';
import type { DriverManagerNetworkSummaryApi } from './driverManagerNetworkSummary';
import type { DriverManagerStateApi } from './useDriverManagerState';

export interface DriverManagerNetworkNoticeProps {
  usingFallback: DriverManagerNetworkSummaryApi['usingFallback'];
  setDismissedNetworkNotices: DriverManagerStateApi['setDismissedNetworkNotices'];
  networkSummaryText: DriverManagerNetworkSummaryApi['networkSummaryText'];
  networkStatus: NonNullable<DriverManagerStateApi['networkStatus']>;
  proxyEnvEntries: DriverManagerNetworkSummaryApi['proxyEnvEntries'];
  listSeparator: DriverManagerNetworkSummaryApi['listSeparator'];
}

export const DriverManagerNetworkNotice = ({
  usingFallback,
  setDismissedNetworkNotices,
  networkSummaryText,
  networkStatus,
  proxyEnvEntries,
  listSeparator,
}: DriverManagerNetworkNoticeProps) => (
  <Alert
    className="driver-manager-network-notice"
    type={usingFallback ? 'warning' : 'success'}
    showIcon
    closable
    onClose={() => setDismissedNetworkNotices((prev) => dismissDriverNetworkNotice(prev, 'fallback'))}
    message={networkSummaryText}
    description={(
      <Collapse
        size="small"
        items={[
          {
            key: 'checks',
            label: t('driver_manager.network.details_label'),
            children: (
              <Space direction="vertical" size={4} style={{ width: '100%' }}>
                {(networkStatus?.checks || []).length > 0
                  ? (networkStatus?.checks || []).map((probe, index) => {
                      const latency = probe.httpLatencyMs ?? probe.latencyMs ?? probe.tcpLatencyMs;
                      return (
                        <Text key={`${probe.probeCode || probe.url || 'probe'}-${index}`} type="secondary">
                          {t('driver_manager.network.probe_latency', {
                            name: resolveDriverNetworkProbeLabel(probe),
                            status: probe.reachable
                              ? t('driver_manager.network.reachable')
                              : t('driver_manager.network.unreachable'),
                            latency: latency !== undefined
                              ? t('driver_manager.network.latency_value', { latency })
                              : '',
                            detail: probe.error
                              ? t('driver_manager.network.error_value', { detail: probe.error })
                              : '',
                          })}
                        </Text>
                      );
                    })
                  : <Text type="secondary">{t('driver_manager.network.no_result')}</Text>}
                {proxyEnvEntries.length > 0 ? (
                  <Text type="secondary">
                    {t('driver_manager.network.proxy_env_detected', { keys: proxyEnvEntries.map(([key]) => key).join(listSeparator) })}
                  </Text>
                ) : (
                  <Text type="secondary">{t('driver_manager.network.no_proxy_env')}</Text>
                )}
              </Space>
            ),
          },
        ]}
      />
    )}
  />
);
