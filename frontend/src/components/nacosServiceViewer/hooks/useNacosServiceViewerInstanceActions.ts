import { message } from 'antd';
import { useCallback } from 'react';
import { confirmProductionMutation } from '../../../utils/productionRiskConfirm';
import { parseNacosServiceName } from '../../nacosServiceName';
import { type NacosInstance, formatNacosInstanceEndpoint } from '../nacosServiceModel';
import type { NacosServiceViewerStateApi } from './useNacosServiceViewerState';
import type { NacosServiceViewerProps } from '../nacosServiceModel';

export interface UseNacosServiceViewerInstanceActionsInput {
  connectionId: NacosServiceViewerProps['connectionId'];
  namespaceId: NacosServiceViewerProps['namespaceId'];
  rpcConfig: NacosServiceViewerStateApi['rpcConfig'];
  structureRestricted: NacosServiceViewerStateApi['structureRestricted'];
  serviceSavingRef: NacosServiceViewerStateApi['serviceSavingRef'];
  serviceModalGenerationRef: NacosServiceViewerStateApi['serviceModalGenerationRef'];
  serviceViewRef: NacosServiceViewerStateApi['serviceViewRef'];
  setSavingService: NacosServiceViewerStateApi['setSavingService'];
  serviceForm: NacosServiceViewerStateApi['serviceForm'];
  isActiveContext: NacosServiceViewerStateApi['isActiveContext'];
  connection: NacosServiceViewerStateApi['connection'];
  tr: NacosServiceViewerStateApi['tr'];
  notifyServiceGroupsChanged: NacosServiceViewerStateApi['notifyServiceGroupsChanged'];
  closeServiceModal: NacosServiceViewerStateApi['closeServiceModal'];
  loadServices: NacosServiceViewerStateApi['loadServices'];
  serviceTotal: NacosServiceViewerStateApi['serviceTotal'];
  selectedServiceRawRef: NacosServiceViewerStateApi['selectedServiceRawRef'];
  instanceRequestIdRef: NacosServiceViewerStateApi['instanceRequestIdRef'];
  setSelectedServiceRaw: NacosServiceViewerStateApi['setSelectedServiceRaw'];
  setSelectedServiceDetail: NacosServiceViewerStateApi['setSelectedServiceDetail'];
  setInstances: NacosServiceViewerStateApi['setInstances'];
  setLoadingInstances: NacosServiceViewerStateApi['setLoadingInstances'];
  closeInstanceModal: NacosServiceViewerStateApi['closeInstanceModal'];
  selectedParsed: NacosServiceViewerStateApi['selectedParsed'];
  selectedServiceDetail: NacosServiceViewerStateApi['selectedServiceDetail'];
  instanceModalGenerationRef: NacosServiceViewerStateApi['instanceModalGenerationRef'];
  instanceModalTargetServiceRawRef: NacosServiceViewerStateApi['instanceModalTargetServiceRawRef'];
  setEditingInstance: NacosServiceViewerStateApi['setEditingInstance'];
  instanceForm: NacosServiceViewerStateApi['instanceForm'];
  setInstanceModalOpen: NacosServiceViewerStateApi['setInstanceModalOpen'];
  dataEditRestricted: NacosServiceViewerStateApi['dataEditRestricted'];
  editingInstance: NacosServiceViewerStateApi['editingInstance'];
  instanceSavingRef: NacosServiceViewerStateApi['instanceSavingRef'];
  setSavingInstance: NacosServiceViewerStateApi['setSavingInstance'];
  loadInstances: NacosServiceViewerStateApi['loadInstances'];
  updatingInstanceTokensRef: NacosServiceViewerStateApi['updatingInstanceTokensRef'];
  setUpdatingInstanceKeys: NacosServiceViewerStateApi['setUpdatingInstanceKeys'];
  namespaceName: NacosServiceViewerProps['namespaceName'];
  pageNo: NacosServiceViewerStateApi['pageNo'];
  pageSize: NacosServiceViewerStateApi['pageSize'];
}

export const useNacosServiceViewerInstanceActions = ({
  connectionId, namespaceId, rpcConfig, structureRestricted, serviceSavingRef,
  serviceModalGenerationRef, serviceViewRef, setSavingService, serviceForm, isActiveContext,
  connection, tr, notifyServiceGroupsChanged, closeServiceModal, loadServices, serviceTotal,
  selectedServiceRawRef, instanceRequestIdRef, setSelectedServiceRaw, setSelectedServiceDetail,
  setInstances, setLoadingInstances, closeInstanceModal, selectedParsed, selectedServiceDetail,
  instanceModalGenerationRef, instanceModalTargetServiceRawRef, setEditingInstance, instanceForm,
  setInstanceModalOpen, dataEditRestricted, editingInstance, instanceSavingRef, setSavingInstance,
  loadInstances, updatingInstanceTokensRef, setUpdatingInstanceKeys, namespaceName, pageNo,
  pageSize,
}: UseNacosServiceViewerInstanceActionsInput) => {
  const handleCreateService = async () => {
    if (!rpcConfig || structureRestricted || serviceSavingRef.current) return;
    const modalGeneration = serviceModalGenerationRef.current;
    const contextToken = { connectionId, namespaceId, rpcConfig };
    const sourceView = serviceViewRef.current;
    serviceSavingRef.current = true;
    setSavingService(true);
    try {
      const values = await serviceForm.validateFields();
      if (
        !isActiveContext(contextToken)
        || modalGeneration !== serviceModalGenerationRef.current
      ) return;
      if (!await confirmProductionMutation(
        connection,
        tr('connection.production_risk.action.modify_service'),
        [namespaceId, values.serviceName, values.groupName].filter(Boolean).join(' / '),
        tr,
      )) return;
      const res = await (window as any).go.app.App.NacosCreateService(rpcConfig, {
        namespaceId: namespaceId || '',
        serviceName: String(values.serviceName || '').trim(),
        groupName: String(values.groupName || 'DEFAULT_GROUP').trim() || 'DEFAULT_GROUP',
        ephemeral: false,
        protectThreshold: Number(values.protectThreshold || 0),
      });
      if (!res?.success) {
        message.error(res?.message || 'create service failed');
        return;
      }
      notifyServiceGroupsChanged();
      if (isActiveContext(contextToken)) {
        if (modalGeneration === serviceModalGenerationRef.current) {
          closeServiceModal();
        }
        const currentView = serviceViewRef.current;
        await loadServices(
          currentView.requestId === sourceView.requestId ? 1 : currentView.page,
          currentView.group,
          currentView.pageSize,
          currentView.serviceName,
        );
      }
      message.success(tr('nacos_service.message.service_create_success'));
    } catch (error: any) {
      if (error?.errorFields) return;
      message.error(error?.message || String(error));
    } finally {
      serviceSavingRef.current = false;
      setSavingService(false);
    }
  };

  const handleDeleteService = async (raw: string) => {
    if (!rpcConfig || structureRestricted) return;
    const contextToken = { connectionId, namespaceId, rpcConfig };
    const sourceView = serviceViewRef.current;
    const sourceTotal = serviceTotal;
    const parsed = parseNacosServiceName(raw);
    try {
      if (!await confirmProductionMutation(
        connection,
        tr('connection.production_risk.action.modify_service'),
        [namespaceId, parsed.serviceName, parsed.groupName].filter(Boolean).join(' / '),
        tr,
      )) return;
      const res = await (window as any).go.app.App.NacosDeleteService(
        rpcConfig,
        namespaceId || '',
        parsed.serviceName,
        parsed.groupName,
      );
      if (!res?.success) {
        message.error(res?.message || 'delete service failed');
        return;
      }
      notifyServiceGroupsChanged();
      if (isActiveContext(contextToken)) {
        if (selectedServiceRawRef.current === raw) {
          instanceRequestIdRef.current += 1;
          selectedServiceRawRef.current = null;
          setSelectedServiceRaw(null);
          setSelectedServiceDetail(null);
          setInstances([]);
          setLoadingInstances(false);
          closeInstanceModal();
        }
        const currentView = serviceViewRef.current;
        let refreshPage = currentView.page;
        if (currentView.requestId === sourceView.requestId) {
          const remainingTotal = Math.max(0, sourceTotal - 1);
          const lastRemainingPage = Math.max(1, Math.ceil(remainingTotal / currentView.pageSize));
          refreshPage = Math.min(sourceView.page, lastRemainingPage);
        }
        await loadServices(refreshPage, currentView.group, currentView.pageSize, currentView.serviceName);
      }
      message.success(tr('nacos_service.message.service_delete_success'));
    } catch (error: any) {
      message.error(error?.message || String(error));
    }
  };

  const openRegisterInstance = () => {
    if (!selectedParsed || !selectedServiceDetail || selectedServiceDetail.ephemeral) return;
    instanceModalGenerationRef.current += 1;
    instanceModalTargetServiceRawRef.current = selectedServiceRawRef.current;
    setEditingInstance(null);
    instanceForm.setFieldsValue({
      serviceName: selectedParsed.serviceName,
      groupName: selectedParsed.groupName,
      ip: '',
      port: 8080,
      weight: 1,
      clusterName: 'DEFAULT',
      enabled: true,
      ephemeral: false,
      healthy: true,
    });
    setInstanceModalOpen(true);
  };

  const openEditInstance = (inst: NacosInstance) => {
    if (!selectedParsed || !selectedServiceRawRef.current) return;
    instanceModalGenerationRef.current += 1;
    instanceModalTargetServiceRawRef.current = selectedServiceRawRef.current;
    setEditingInstance(inst);
    instanceForm.setFieldsValue({
      serviceName: selectedParsed.serviceName,
      groupName: selectedParsed.groupName,
      ip: inst.ip,
      port: inst.port,
      weight: inst.weight ?? 1,
      clusterName: inst.clusterName || 'DEFAULT',
      enabled: inst.enabled,
      ephemeral: inst.ephemeral,
      healthy: inst.healthy,
    });
    setInstanceModalOpen(true);
  };

  const canUpdateInstanceHealth = useCallback(
    (inst: NacosInstance) => {
      if (dataEditRestricted || inst.ephemeral || !selectedServiceDetail) return false;
      const clusterName = String(inst.clusterName || 'DEFAULT').trim() || 'DEFAULT';
      const cluster = selectedServiceDetail.clusters?.find(
        (item) => String(item.name || 'DEFAULT').trim() === clusterName,
      );
      const checker = cluster?.healthChecker;
      const checkerType = String(
        checker?.type ?? checker?.Type ?? checker?.TYPE ?? '',
      ).trim().toUpperCase();
      return checkerType === 'NONE';
    },
    [dataEditRestricted, selectedServiceDetail],
  );

  const handleSaveInstance = async () => {
    const modalGeneration = instanceModalGenerationRef.current;
    const targetServiceRaw = instanceModalTargetServiceRawRef.current;
    const targetEditingInstance = editingInstance;
    if (
      !rpcConfig
      || dataEditRestricted
      || !targetServiceRaw
      || instanceSavingRef.current
    ) return;
    const contextToken = { connectionId, namespaceId, rpcConfig };
    const targetService = parseNacosServiceName(targetServiceRaw);
    instanceSavingRef.current = true;
    setSavingInstance(true);
    try {
      const values = await instanceForm.validateFields();
      if (
        !isActiveContext(contextToken)
        || modalGeneration !== instanceModalGenerationRef.current
        || instanceModalTargetServiceRawRef.current !== targetServiceRaw
      ) return;
      const payload = {
        namespaceId: namespaceId || '',
        serviceName: targetService.serviceName,
        groupName: targetService.groupName,
        ip: String(values.ip || '').trim(),
        port: Number(values.port),
        weight: Number(values.weight ?? 1),
        clusterName: targetEditingInstance
          ? (targetEditingInstance.clusterName || 'DEFAULT')
          : String(values.clusterName || 'DEFAULT').trim(),
        enabled: !!values.enabled,
        ephemeral: targetEditingInstance ? !!targetEditingInstance.ephemeral : false,
        ...(targetEditingInstance
          ? {
              healthy: canUpdateInstanceHealth(targetEditingInstance)
                ? !!values.healthy
                : !!targetEditingInstance.healthy,
              metadata: targetEditingInstance.metadata,
            }
          : {}),
      };
      if (!await confirmProductionMutation(
        connection,
        tr('connection.production_risk.action.modify_service'),
        [namespaceId, targetService.serviceName, targetService.groupName, values.ip, values.port].filter(Boolean).join(' / '),
        tr,
      )) return;
      const res = targetEditingInstance
        ? await (window as any).go.app.App.NacosUpdateInstance(rpcConfig, payload)
        : await (window as any).go.app.App.NacosRegisterInstance(rpcConfig, payload);
      if (!res?.success) {
        message.error(res?.message || 'save instance failed');
        return;
      }
      if (isActiveContext(contextToken)) {
        if (
          modalGeneration === instanceModalGenerationRef.current
          && instanceModalTargetServiceRawRef.current === targetServiceRaw
        ) {
          closeInstanceModal();
        }
        if (selectedServiceRawRef.current === targetServiceRaw) {
          await loadInstances(targetServiceRaw);
        }
      }
      message.success(
        targetEditingInstance
          ? tr('nacos_service.message.instance_update_success')
          : tr('nacos_service.message.instance_register_success'),
      );
    } catch (error: any) {
      if (error?.errorFields) return;
      message.error(error?.message || String(error));
    } finally {
      instanceSavingRef.current = false;
      setSavingInstance(false);
    }
  };

  const handleToggleEnabled = async (inst: NacosInstance, enabled: boolean) => {
    const targetServiceRaw = selectedServiceRawRef.current;
    if (!rpcConfig || dataEditRestricted || !targetServiceRaw) return;
    const contextToken = { connectionId, namespaceId, rpcConfig };
    const targetService = parseNacosServiceName(targetServiceRaw);
    const instanceKey = `${formatNacosInstanceEndpoint(inst.ip, inst.port)}:${inst.clusterName || ''}`;
    if (updatingInstanceTokensRef.current.has(instanceKey)) return;
    const mutationToken = Symbol(instanceKey);
    updatingInstanceTokensRef.current.set(instanceKey, mutationToken);
    setUpdatingInstanceKeys(new Set(updatingInstanceTokensRef.current.keys()));
    try {
      if (!await confirmProductionMutation(
        connection,
        tr('connection.production_risk.action.modify_service'),
        [namespaceId, targetService.serviceName, targetService.groupName, inst.ip, inst.port].filter(Boolean).join(' / '),
        tr,
      )) return;
      if (
        !isActiveContext(contextToken)
        || selectedServiceRawRef.current !== targetServiceRaw
        || updatingInstanceTokensRef.current.get(instanceKey) !== mutationToken
      ) return;
      const res = await (window as any).go.app.App.NacosUpdateInstance(rpcConfig, {
        namespaceId: namespaceId || '',
        serviceName: targetService.serviceName,
        groupName: targetService.groupName,
        ip: inst.ip,
        port: inst.port,
        weight: inst.weight ?? 1,
        clusterName: inst.clusterName || 'DEFAULT',
        enabled,
        healthy: inst.healthy,
        ephemeral: inst.ephemeral,
        metadata: inst.metadata,
      });
      if (!res?.success) {
        message.error(res?.message || 'update instance failed');
        return;
      }
      if (
        isActiveContext(contextToken)
        && selectedServiceRawRef.current === targetServiceRaw
        && updatingInstanceTokensRef.current.get(instanceKey) === mutationToken
      ) {
        setInstances((current) => current.map((item) => {
          const currentKey = `${formatNacosInstanceEndpoint(item.ip, item.port)}:${item.clusterName || ''}`;
          return currentKey === instanceKey ? { ...item, enabled } : item;
        }));
        await loadInstances(targetServiceRaw);
      }
      message.success(tr('nacos_service.message.instance_update_success'));
    } catch (error: any) {
      message.error(error?.message || String(error));
    } finally {
      if (updatingInstanceTokensRef.current.get(instanceKey) === mutationToken) {
        updatingInstanceTokensRef.current.delete(instanceKey);
        setUpdatingInstanceKeys(new Set(updatingInstanceTokensRef.current.keys()));
      }
    }
  };

  const handleDeregister = async (inst: NacosInstance) => {
    const targetServiceRaw = selectedServiceRawRef.current;
    if (!rpcConfig || dataEditRestricted || !targetServiceRaw) return;
    const contextToken = { connectionId, namespaceId, rpcConfig };
    const targetService = parseNacosServiceName(targetServiceRaw);
    try {
      if (!await confirmProductionMutation(
        connection,
        tr('connection.production_risk.action.modify_service'),
        [namespaceId, targetService.serviceName, targetService.groupName, inst.ip, inst.port].filter(Boolean).join(' / '),
        tr,
      )) return;
      const res = await (window as any).go.app.App.NacosDeregisterInstance(rpcConfig, {
        namespaceId: namespaceId || '',
        serviceName: targetService.serviceName,
        groupName: targetService.groupName,
        ip: inst.ip,
        port: inst.port,
        clusterName: inst.clusterName || '',
        ephemeral: inst.ephemeral,
      });
      if (!res?.success) {
        message.error(res?.message || 'deregister failed');
        return;
      }
      if (
        isActiveContext(contextToken)
        && selectedServiceRawRef.current === targetServiceRaw
      ) {
        await loadInstances(targetServiceRaw);
      }
      message.success(tr('nacos_service.message.instance_deregister_success'));
    } catch (error: any) {
      message.error(error?.message || String(error));
    }
  };

  const handleToggleHealth = async (inst: NacosInstance, healthy: boolean) => {
    const targetServiceRaw = selectedServiceRawRef.current;
    if (!rpcConfig || !targetServiceRaw || !canUpdateInstanceHealth(inst)) return;
    const contextToken = { connectionId, namespaceId, rpcConfig };
    const targetService = parseNacosServiceName(targetServiceRaw);
    try {
      if (!await confirmProductionMutation(
        connection,
        tr('connection.production_risk.action.modify_service'),
        [namespaceId, targetService.serviceName, targetService.groupName, inst.ip, inst.port].filter(Boolean).join(' / '),
        tr,
      )) return;
      const res = await (window as any).go.app.App.NacosUpdateInstanceHealth(rpcConfig, {
        namespaceId: namespaceId || '',
        serviceName: targetService.serviceName,
        groupName: targetService.groupName,
        ip: inst.ip,
        port: inst.port,
        clusterName: inst.clusterName || '',
        healthy,
      });
      if (!res?.success) {
        message.error(res?.message || 'update health failed');
        return;
      }
      if (
        isActiveContext(contextToken)
        && selectedServiceRawRef.current === targetServiceRaw
      ) {
        await loadInstances(targetServiceRaw);
      }
      message.success(tr('nacos_service.message.instance_health_success'));
    } catch (error: any) {
      message.error(error?.message || String(error));
    }
  };

  const namespaceLabel = namespaceName || (namespaceId ? namespaceId : 'public');
  const serviceRangeStart = serviceTotal > 0 ? ((pageNo - 1) * pageSize) + 1 : 0;
  const serviceRangeEnd = serviceTotal > 0
    ? Math.min(pageNo * pageSize, serviceTotal)
    : 0;
  return {
    handleCreateService, handleDeleteService, openRegisterInstance, openEditInstance,
    canUpdateInstanceHealth, handleSaveInstance, handleToggleEnabled, handleDeregister,
    handleToggleHealth, namespaceLabel, serviceRangeStart, serviceRangeEnd,
  };
};

export type NacosServiceViewerInstanceActionsApi = ReturnType<typeof useNacosServiceViewerInstanceActions>;
