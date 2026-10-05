import { Space, Tag, Button, Switch, Popconfirm } from 'antd';
import { ReloadOutlined, PlusOutlined, DownOutlined, RightOutlined } from '@ant-design/icons';
import { formatNacosInstanceEndpoint, getNacosInstanceMetadataEntries } from './nacosServiceModel';
import type { NacosServiceViewerStateApi } from './hooks/useNacosServiceViewerState';
import type {
  NacosServiceViewerInstanceActionsApi,
} from './hooks/useNacosServiceViewerInstanceActions';

export interface NacosServiceDetailPaneProps {
  selectedServiceRaw: NacosServiceViewerStateApi['selectedServiceRaw'];
  selectedParsed: NacosServiceViewerStateApi['selectedParsed'];
  workbenchTheme: NacosServiceViewerStateApi['workbenchTheme'];
  selectedServiceDetail: NacosServiceViewerStateApi['selectedServiceDetail'];
  tr: NacosServiceViewerStateApi['tr'];
  loadingInstances: NacosServiceViewerStateApi['loadingInstances'];
  loadInstances: NacosServiceViewerStateApi['loadInstances'];
  dataEditRestricted: NacosServiceViewerStateApi['dataEditRestricted'];
  openRegisterInstance: NacosServiceViewerInstanceActionsApi['openRegisterInstance'];
  instances: NacosServiceViewerStateApi['instances'];
  expandedInstanceKeys: NacosServiceViewerStateApi['expandedInstanceKeys'];
  toggleInstanceDetails: NacosServiceViewerStateApi['toggleInstanceDetails'];
  updatingInstanceKeys: NacosServiceViewerStateApi['updatingInstanceKeys'];
  handleToggleEnabled: NacosServiceViewerInstanceActionsApi['handleToggleEnabled'];
  canUpdateInstanceHealth: NacosServiceViewerInstanceActionsApi['canUpdateInstanceHealth'];
  handleToggleHealth: NacosServiceViewerInstanceActionsApi['handleToggleHealth'];
  openEditInstance: NacosServiceViewerInstanceActionsApi['openEditInstance'];
  handleDeregister: NacosServiceViewerInstanceActionsApi['handleDeregister'];
}

export const NacosServiceDetailPane = ({
  selectedServiceRaw, selectedParsed, workbenchTheme, selectedServiceDetail, tr, loadingInstances,
  loadInstances, dataEditRestricted, openRegisterInstance, instances, expandedInstanceKeys,
  toggleInstanceDetails, updatingInstanceKeys, handleToggleEnabled, canUpdateInstanceHealth,
  handleToggleHealth, openEditInstance, handleDeregister,
}: NacosServiceDetailPaneProps) => (
  <div
    className={'gn-v2-nacos-detail-pane'}
    style={
      { minHeight: 0, overflow: 'hidden' }
    }
  >
    <div
      className={'gn-v2-nacos-pane-header'}
      style={undefined}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        <Space wrap size={[8, 8]}>
          {selectedServiceRaw ? (
            <>
              <Tag color="blue">{selectedParsed?.groupName}</Tag>
              <strong style={{ color: workbenchTheme.textPrimary }}>{selectedParsed?.serviceName}</strong>
              {selectedServiceDetail ? (
                <Tag color={selectedServiceDetail.ephemeral ? 'orange' : 'green'}>
                  {selectedServiceDetail.ephemeral
                    ? tr('nacos_service.field.ephemeral')
                    : tr('nacos_service.field.persistent')}
                </Tag>
              ) : null}
            </>
          ) : (
            <span style={{ color: workbenchTheme.textMuted }}>{tr('nacos_service.message.select_service')}</span>
          )}
        </Space>
        <Space wrap size={[8, 8]}>
          <Button
            size="small"
            icon={<ReloadOutlined />}
            loading={loadingInstances}
            disabled={!selectedServiceRaw}
            onClick={() => selectedServiceRaw && void loadInstances(selectedServiceRaw)}
          >
            {tr('nacos_viewer.action.refresh')}
          </Button>
          <Button
            type="primary"
            icon={<PlusOutlined />}
            disabled={
              dataEditRestricted
              || !selectedServiceRaw
              || !selectedServiceDetail
              || selectedServiceDetail.ephemeral
            }
            title={
              selectedServiceDetail?.ephemeral
                ? tr('nacos_service.message.ephemeral_registration_unavailable')
                : undefined
            }
            onClick={openRegisterInstance}
          >
            {tr('nacos_service.action.register_instance')}
          </Button>
        </Space>
      </div>
    </div>
    <div
      className={'gn-v2-nacos-pane-body'}
      style={{
        flex: 1,
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        padding: undefined,
        overflow: 'hidden',
      }}
    >
    {!selectedServiceRaw ? (
      <div style={{ flex: 1, display: 'grid', placeItems: 'center', color: workbenchTheme.textMuted }}>
        {tr('nacos_service.message.select_service')}
      </div>
    ) : (
      <>
        <div
          className="gn-nacos-instance-inspector"
          data-testid="nacos-instance-inspector"
          role="list"
          aria-busy={loadingInstances}
          aria-label={
            selectedParsed?.serviceName || tr('nacos_service.title.service_explorer')
          }
        >
          {!loadingInstances && instances.length === 0 ? (
            <div className="gn-nacos-instance-inspector__empty" role="status">
              {tr('data_grid.view.empty_result')}
            </div>
          ) : null}
          {instances.map((instance) => {
            const endpoint = formatNacosInstanceEndpoint(instance.ip, instance.port);
            const instanceKey = `${endpoint}:${instance.clusterName || ''}`;
            const detailsExpanded = expandedInstanceKeys.has(instanceKey);
            const metadataEntries = getNacosInstanceMetadataEntries(instance.metadata);
            return (
              <article
                key={instanceKey}
                className="gn-nacos-instance-row"
                data-instance-endpoint={endpoint}
                data-instance-details-expanded={detailsExpanded ? 'true' : 'false'}
                role="listitem"
              >
                <div className="gn-nacos-instance-row__main">
                  <div className="gn-nacos-instance-row__identity">
                    <Button
                      type="text"
                      size="small"
                      className="gn-nacos-instance-row__details-toggle"
                      icon={detailsExpanded ? <DownOutlined /> : <RightOutlined />}
                      data-instance-action="toggle-details"
                      aria-expanded={detailsExpanded}
                      aria-label={`${tr(
                        detailsExpanded
                          ? 'nacos_service.action.collapse_instance_details'
                          : 'nacos_service.action.expand_instance_details',
                      )} ${endpoint}`}
                      onClick={() => toggleInstanceDetails(instanceKey)}
                    />
                    <span
                      className={[
                        'gn-nacos-instance-row__health-dot',
                        instance.healthy
                          ? 'gn-nacos-instance-row__health-dot--healthy'
                          : 'gn-nacos-instance-row__health-dot--unhealthy',
                      ].join(' ')}
                      aria-hidden="true"
                    />
                    <strong className="gn-nacos-instance-row__endpoint">
                      {endpoint}
                    </strong>
                    <div className="gn-nacos-instance-row__enabled-control">
                      <span>
                        {tr(
                          instance.enabled
                            ? 'nacos_service.status.online'
                            : 'nacos_service.status.offline',
                        )}
                      </span>
                      <Switch
                        size="small"
                        checked={!!instance.enabled}
                        loading={updatingInstanceKeys.has(instanceKey)}
                        disabled={dataEditRestricted || updatingInstanceKeys.has(instanceKey)}
                        data-instance-action="toggle-enabled"
                        aria-label={`${tr(
                          instance.enabled
                            ? 'nacos_service.action.take_offline'
                            : 'nacos_service.action.bring_online',
                        )} ${endpoint}`}
                        onChange={(checked) => void handleToggleEnabled(instance, checked)}
                      />
                    </div>
                  </div>
                  <div className="gn-nacos-instance-row__health-control">
                    <span>{tr('nacos_service.field.healthy')}</span>
                    <Switch
                      size="small"
                      checked={!!instance.healthy}
                      disabled={!canUpdateInstanceHealth(instance)}
                      aria-label={`${tr('nacos_service.field.healthy')} ${endpoint}`}
                      onChange={(checked) => void handleToggleHealth(instance, checked)}
                    />
                  </div>
                  <div className="gn-nacos-instance-row__actions">
                    <Button
                      type="text"
                      size="small"
                      data-instance-action="edit"
                      aria-label={`${tr('nacos_service.action.edit_instance')} ${endpoint}`}
                      disabled={dataEditRestricted}
                      onClick={() => openEditInstance(instance)}
                    >
                      {tr('nacos_service.action.edit_instance')}
                    </Button>
                    <Popconfirm
                      title={tr('nacos_service.message.confirm_deregister', {
                        ip: instance.ip,
                        port: instance.port,
                      })}
                      disabled={dataEditRestricted}
                      onConfirm={() => void handleDeregister(instance)}
                    >
                      <Button
                        type="text"
                        size="small"
                        danger
                        data-instance-action="deregister"
                        aria-label={`${tr('nacos_service.action.deregister')} ${endpoint}`}
                        disabled={dataEditRestricted}
                      >
                        {tr('nacos_service.action.deregister')}
                      </Button>
                    </Popconfirm>
                  </div>
                  <dl className="gn-nacos-instance-row__metadata">
                    <div>
                      <dt>{tr('nacos_service.field.cluster')}</dt>
                      <dd>{instance.clusterName || 'DEFAULT'}</dd>
                    </div>
                    <div>
                      <dt>{tr('nacos_service.field.weight')}</dt>
                      <dd>{instance.weight ?? 1}</dd>
                    </div>
                    <div>
                      <dt>{tr('nacos_service.field.type')}</dt>
                      <dd>
                        {instance.ephemeral
                          ? tr('nacos_service.field.ephemeral')
                          : tr('nacos_service.field.persistent')}
                      </dd>
                    </div>
                  </dl>
                  {detailsExpanded ? (
                    <section
                      className="gn-nacos-instance-row__metadata-panel"
                      aria-label={tr('nacos_service.field.instance_metadata')}
                    >
                      <div className="gn-nacos-instance-row__metadata-header">
                        <span>{tr('nacos_service.field.instance_metadata')}</span>
                        <span className="gn-nacos-instance-row__metadata-count">
                          {tr('nacos_service.field.metadata_count', {
                            count: metadataEntries.length,
                          })}
                        </span>
                      </div>
                      {metadataEntries.length > 0 ? (
                        <ul className="gn-nacos-instance-row__metadata-list">
                          {metadataEntries.map(([key, value]) => (
                            <li key={key} className="gn-nacos-instance-row__metadata-item">
                              <span
                                className="gn-nacos-instance-row__metadata-key"
                                title={key}
                              >
                                {key}
                              </span>
                              <span
                                className="gn-nacos-instance-row__metadata-value"
                                title={value}
                              >
                                {value || '—'}
                              </span>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <span className="gn-nacos-instance-row__metadata-empty">
                          {tr('nacos_service.message.instance_metadata_empty')}
                        </span>
                      )}
                    </section>
                  ) : null}
                </div>
              </article>
            );
          })}
        </div>
      </>
    )}
    </div>
  </div>
);
