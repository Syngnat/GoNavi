import { Space, Tag, Input, Button, Pagination } from 'antd';
import { ReloadOutlined, PlusOutlined } from '@ant-design/icons';
import { noAutoCapInputProps } from '../../utils/inputAutoCap';
import NacosServiceTable from '../nacos/NacosServiceTable';
import type { NacosServiceViewerStateApi } from './hooks/useNacosServiceViewerState';
import type {
  NacosServiceViewerInstanceActionsApi,
} from './hooks/useNacosServiceViewerInstanceActions';

export interface NacosServiceListPaneProps {
  leftPanelRef: NacosServiceViewerStateApi['leftPanelRef'];
  namespaceLabel: NacosServiceViewerInstanceActionsApi['namespaceLabel'];
  tr: NacosServiceViewerStateApi['tr'];
  groupFilter: NacosServiceViewerStateApi['groupFilter'];
  setGroupFilter: NacosServiceViewerStateApi['setGroupFilter'];
  loadServices: NacosServiceViewerStateApi['loadServices'];
  serviceFilter: NacosServiceViewerStateApi['serviceFilter'];
  setServiceFilter: NacosServiceViewerStateApi['setServiceFilter'];
  pageSize: NacosServiceViewerStateApi['pageSize'];
  loadingServices: NacosServiceViewerStateApi['loadingServices'];
  structureRestricted: NacosServiceViewerStateApi['structureRestricted'];
  openCreateService: NacosServiceViewerStateApi['openCreateService'];
  serviceRows: NacosServiceViewerStateApi['serviceRows'];
  serviceStatistics: NacosServiceViewerStateApi['serviceStatistics'];
  selectedServiceRaw: NacosServiceViewerStateApi['selectedServiceRaw'];
  workbenchTheme: NacosServiceViewerStateApi['workbenchTheme'];
  handleSelectService: NacosServiceViewerStateApi['handleSelectService'];
  handleDeleteService: NacosServiceViewerInstanceActionsApi['handleDeleteService'];
  serviceTotal: NacosServiceViewerStateApi['serviceTotal'];
  serviceRangeStart: NacosServiceViewerInstanceActionsApi['serviceRangeStart'];
  serviceRangeEnd: NacosServiceViewerInstanceActionsApi['serviceRangeEnd'];
  pageNo: NacosServiceViewerStateApi['pageNo'];
}

export const NacosServiceListPane = ({
  leftPanelRef, namespaceLabel, tr, groupFilter, setGroupFilter, loadServices, serviceFilter,
  setServiceFilter, pageSize, loadingServices, structureRestricted, openCreateService, serviceRows,
  serviceStatistics, selectedServiceRaw, workbenchTheme, handleSelectService, handleDeleteService,
  serviceTotal, serviceRangeStart, serviceRangeEnd, pageNo,
}: NacosServiceListPaneProps) => (
  <div
    ref={leftPanelRef}
    className={'gn-v2-nacos-list-pane'}
    style={
      { minHeight: 0, overflow: 'hidden' }
    }
  >
    <div
      className={'gn-v2-nacos-pane-header'}
      style={undefined}
    >
      <Space wrap size={[8, 8]}>
        <Tag color="cyan">{namespaceLabel}</Tag>
        <Input
          allowClear
          {...noAutoCapInputProps}
          style={{ width: 160 }}
          placeholder={tr('nacos_service.field.group')}
          value={groupFilter}
          onChange={(event) => setGroupFilter(event.target.value)}
          onPressEnter={() => void loadServices(1)}
        />
        <Input
          allowClear
          {...noAutoCapInputProps}
          style={{ width: 180 }}
          placeholder={tr('nacos_service.field.service')}
          value={serviceFilter}
          onChange={(event) => setServiceFilter(event.target.value)}
          onPressEnter={() => void loadServices(1, groupFilter.trim(), pageSize, serviceFilter.trim())}
        />
        <Button icon={<ReloadOutlined />} loading={loadingServices} onClick={() => void loadServices(1)}>
          {tr('nacos_viewer.action.refresh')}
        </Button>
        <Button
          icon={<PlusOutlined />}
          disabled={structureRestricted}
          onClick={openCreateService}
        >
          {tr('nacos_service.action.create_service')}
        </Button>
      </Space>
    </div>
    <div
      className={
        'gn-v2-nacos-pane-body gn-nacos-service-list-body'
      }
      data-testid="nacos-service-list-body"
      style={{
        flex: 1,
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        padding: undefined,
      }}
    >
      <div
        className="gn-nacos-service-list-scroll"
        data-testid="nacos-service-list-scroll"
        style={{ flex: '1 1 0', minHeight: 0, overflow: 'auto' }}
      >
        <NacosServiceTable
          rows={serviceRows}
          statistics={serviceStatistics}
          loading={loadingServices}
          selectedRaw={selectedServiceRaw}
          structureRestricted={structureRestricted}
          mutedColor={workbenchTheme.textMuted}
          tr={tr}
          onSelect={handleSelectService}
          onDelete={(raw) => void handleDeleteService(raw)}
        />
      </div>
      <div
        className="gn-nacos-service-list-footer"
        data-testid="nacos-service-list-footer"
        style={{
          flexShrink: 0,
          borderTop: `1px solid ${workbenchTheme.divider}`,
        }}
      >
        <span
          className="gn-nacos-service-list-footer__summary"
          style={{ color: workbenchTheme.textMuted }}
          aria-live="polite"
        >
          {serviceTotal > 0
            ? tr('nacos_viewer.pagination.range', {
                from: serviceRangeStart,
                to: serviceRangeEnd,
                total: serviceTotal,
              })
            : tr('nacos_viewer.pagination.empty')}
        </span>
        <Pagination
          current={pageNo}
          pageSize={pageSize}
          total={serviceTotal}
          size="small"
          showLessItems
          showSizeChanger={{
            showSearch: false,
            popupMatchSelectWidth: false,
            placement: 'topRight',
          }}
          pageSizeOptions={['20', '50', '100', '200']}
          onChange={(page, nextPageSize) => {
            const size = nextPageSize || pageSize;
            if (size !== pageSize) {
              void loadServices(1, groupFilter.trim(), size, serviceFilter.trim());
              return;
            }
            void loadServices(page, groupFilter.trim(), size, serviceFilter.trim());
          }}
        />
      </div>
    </div>
  </div>
);
