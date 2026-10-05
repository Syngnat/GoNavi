import React from 'react';
import {
  Form,
  Input,
  InputNumber,
  Modal,
} from 'antd';
import RedisResizableDivider from './RedisResizableDivider';
import { noAutoCapInputProps } from '../utils/inputAutoCap';
import { type NacosServiceViewerProps } from './nacosServiceViewer/nacosServiceModel';
import { useNacosServiceViewerState } from './nacosServiceViewer/hooks/useNacosServiceViewerState';
import {
  useNacosServiceViewerInstanceActions,
} from './nacosServiceViewer/hooks/useNacosServiceViewerInstanceActions';
import { NacosServiceListPane } from './nacosServiceViewer/NacosServiceListPane';
import { NacosServiceDetailPane } from './nacosServiceViewer/NacosServiceDetailPane';
import { NacosInstanceModal } from './nacosServiceViewer/NacosInstanceModal';
export { NACOS_AUTO_REFRESH_INTERVAL_MS } from './nacosServiceViewer/nacosServiceConstants';

const NacosServiceViewer: React.FC<NacosServiceViewerProps> = ({
  connectionId,
  namespaceId,
  namespaceName,
  initialGroup,
  isActive = true,
}) => {
  const {
    tr, workbenchTheme, connection, dataEditRestricted, structureRestricted, rpcConfig,
    loadingServices, loadingInstances, setLoadingInstances, serviceStatistics, serviceTotal, pageNo,
    pageSize, groupFilter, setGroupFilter, serviceFilter, setServiceFilter, selectedServiceRaw,
    setSelectedServiceRaw, selectedServiceDetail, setSelectedServiceDetail, instances, setInstances,
    updatingInstanceKeys, setUpdatingInstanceKeys, expandedInstanceKeys, serviceModalOpen,
    savingService, setSavingService, serviceForm, instanceModalOpen, setInstanceModalOpen,
    savingInstance, setSavingInstance, instanceForm, editingInstance, setEditingInstance,
    leftPanelWidth, setLeftPanelWidth, leftPanelRef, instanceRequestIdRef, selectedServiceRawRef,
    serviceModalGenerationRef, serviceSavingRef, instanceSavingRef, updatingInstanceTokensRef,
    instanceModalGenerationRef, instanceModalTargetServiceRawRef, serviceViewRef, selectedParsed,
    toggleInstanceDetails, serviceRows, notifyServiceGroupsChanged, isActiveContext,
    closeServiceModal, openCreateService, closeInstanceModal, handleSelectService, loadServices,
    loadInstances,
  } = useNacosServiceViewerState({ connectionId, initialGroup, namespaceId, isActive });

  const {
    handleCreateService, handleDeleteService, openRegisterInstance, openEditInstance,
    canUpdateInstanceHealth, handleSaveInstance, handleToggleEnabled, handleDeregister,
    handleToggleHealth, namespaceLabel, serviceRangeStart, serviceRangeEnd,
  } = useNacosServiceViewerInstanceActions({
    connectionId, namespaceId, rpcConfig, structureRestricted, serviceSavingRef,
    serviceModalGenerationRef, serviceViewRef, setSavingService, serviceForm, isActiveContext,
    connection, tr, notifyServiceGroupsChanged, closeServiceModal, loadServices, serviceTotal,
    selectedServiceRawRef, instanceRequestIdRef, setSelectedServiceRaw, setSelectedServiceDetail,
    setInstances, setLoadingInstances, closeInstanceModal, selectedParsed, selectedServiceDetail,
    instanceModalGenerationRef, instanceModalTargetServiceRawRef, setEditingInstance, instanceForm,
    setInstanceModalOpen, dataEditRestricted, editingInstance, instanceSavingRef, setSavingInstance,
    loadInstances, updatingInstanceTokensRef, setUpdatingInstanceKeys, namespaceName, pageNo,
    pageSize,
  });

  return (
    <div
      className={'gn-v2-nacos-workbench'}
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        minHeight: 0,
        padding: 0,
        gap: 0,
        boxSizing: 'border-box',
        background: undefined,
        color: workbenchTheme.textPrimary,
      }}
    >
      <div
        className={'gn-v2-nacos-split'}
        style={{
          display: undefined,
          minHeight: 0,
          flex: 1,
          overflow: 'hidden',
          ...({
                ['--gn-nacos-sidebar-width' as string]:
                  typeof leftPanelWidth === 'number' ? `${leftPanelWidth}px` : leftPanelWidth,
              }),
        }}
      >
        <NacosServiceListPane
          leftPanelRef={leftPanelRef} namespaceLabel={namespaceLabel} tr={tr}
          groupFilter={groupFilter} setGroupFilter={setGroupFilter} loadServices={loadServices}
          serviceFilter={serviceFilter} setServiceFilter={setServiceFilter} pageSize={pageSize}
          loadingServices={loadingServices} structureRestricted={structureRestricted}
          openCreateService={openCreateService} serviceRows={serviceRows}
          serviceStatistics={serviceStatistics} selectedServiceRaw={selectedServiceRaw}
          workbenchTheme={workbenchTheme} handleSelectService={handleSelectService}
          handleDeleteService={handleDeleteService} serviceTotal={serviceTotal}
          serviceRangeStart={serviceRangeStart} serviceRangeEnd={serviceRangeEnd} pageNo={pageNo}
        />

        <RedisResizableDivider
          targetRef={leftPanelRef}
          onResizeEnd={setLeftPanelWidth}
          minWidth={260}
          maxReservedWidth={321}
          containerWidthCssVariable={'--gn-nacos-sidebar-width'}
          title={tr('redis_viewer.tooltip.resize_panels')}
        />

        <NacosServiceDetailPane
          selectedServiceRaw={selectedServiceRaw} selectedParsed={selectedParsed}
          workbenchTheme={workbenchTheme} selectedServiceDetail={selectedServiceDetail} tr={tr}
          loadingInstances={loadingInstances} loadInstances={loadInstances}
          dataEditRestricted={dataEditRestricted} openRegisterInstance={openRegisterInstance}
          instances={instances} expandedInstanceKeys={expandedInstanceKeys}
          toggleInstanceDetails={toggleInstanceDetails}
          updatingInstanceKeys={updatingInstanceKeys} handleToggleEnabled={handleToggleEnabled}
          canUpdateInstanceHealth={canUpdateInstanceHealth}
          handleToggleHealth={handleToggleHealth} openEditInstance={openEditInstance}
          handleDeregister={handleDeregister}
        />
      </div>

      <Modal
        title={tr('nacos_service.action.create_service')}
        open={serviceModalOpen}
        confirmLoading={savingService}
        onCancel={closeServiceModal}
        onOk={() => void handleCreateService()}
        destroyOnHidden
      >
        <Form form={serviceForm} layout="vertical" initialValues={{ groupName: 'DEFAULT_GROUP' }}>
          <Form.Item
            name="serviceName"
            label={tr('nacos_service.field.service')}
            rules={[{ required: true }]}
          >
            <Input {...noAutoCapInputProps} />
          </Form.Item>
          <Form.Item name="groupName" label={tr('nacos_service.field.group')}>
            <Input {...noAutoCapInputProps} />
          </Form.Item>
          <Form.Item name="protectThreshold" label={tr('nacos_service.field.protect_threshold')}>
            <InputNumber min={0} max={1} step={0.1} style={{ width: '100%' }} />
          </Form.Item>
        </Form>
      </Modal>

      <NacosInstanceModal
        editingInstance={editingInstance} tr={tr} instanceModalOpen={instanceModalOpen}
        savingInstance={savingInstance} closeInstanceModal={closeInstanceModal}
        handleSaveInstance={handleSaveInstance} instanceForm={instanceForm}
        canUpdateInstanceHealth={canUpdateInstanceHealth}
      />
    </div>
  );
};

export default NacosServiceViewer;
