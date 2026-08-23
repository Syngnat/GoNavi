import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Button,
  Form,
  Input,
  InputNumber,
  Modal,
  Pagination,
  Popconfirm,
  Space,
  Switch,
  Table,
  Tag,
  message,
} from 'antd';
import {
  DeleteOutlined,
  DownOutlined,
  PlusOutlined,
  ReloadOutlined,
  RightOutlined,
} from '@ant-design/icons';
import RedisResizableDivider from './RedisResizableDivider';
import { buildRedisWorkbenchTheme } from './redisViewerWorkbenchTheme';
import { useStore } from '../store';
import {
  isMacLikePlatform,
  normalizeBlurForPlatform,
  normalizeOpacityForPlatform,
  resolveAppearanceValues,
} from '../utils/appearance';
import { buildRpcConnectionConfig } from '../utils/connectionRpcConfig';
import { t, type I18nParams } from '../i18n';
import { useOptionalI18n } from '../i18n/provider';
import { noAutoCapInputProps } from '../utils/inputAutoCap';
import { parseNacosServiceName } from './nacosServiceName';
import { confirmProductionMutation } from '../utils/productionRiskConfirm';

type ServicePage = {
  count: number;
  serviceNames: string[];
  pageNo?: number;
  pageSize?: number;
};

type NacosInstance = {
  instanceId?: string;
  ip: string;
  port: number;
  weight?: number;
  healthy: boolean;
  enabled: boolean;
  ephemeral: boolean;
  clusterName?: string;
  serviceName?: string;
  metadata?: Record<string, string>;
};

type InstanceList = {
  name?: string;
  groupName?: string;
  hosts: NacosInstance[];
};

type NacosServiceDetail = {
  name?: string;
  groupName?: string;
  ephemeral: boolean;
  clusters?: Array<{
    name?: string;
    healthChecker?: Record<string, unknown>;
  }>;
};

type NacosServiceViewerProps = {
  connectionId: string;
  namespaceId: string;
  namespaceName?: string;
  initialGroup?: string;
  isActive?: boolean;
};

type NacosServiceRow = {
  rawName: string;
  serviceName: string;
  groupName: string;
};

type NacosContextToken = {
  connectionId: string;
  namespaceId: string;
  rpcConfig: unknown;
};

type ServiceViewContext = {
  requestId: number;
  page: number;
  pageSize: number;
  group: string;
};

type NacosLoadOptions = {
  silent?: boolean;
};

type LoadServices = (
  page?: number,
  requestedGroup?: string,
  requestedPageSize?: number,
  options?: NacosLoadOptions,
) => Promise<void>;

type LoadInstances = (rawServiceName: string, options?: NacosLoadOptions) => Promise<void>;

const formatNacosInstanceEndpoint = (ip: string, port: number): string => {
  const host = String(ip || '').trim();
  const displayHost = host.includes(':') && !(host.startsWith('[') && host.endsWith(']'))
    ? `[${host}]`
    : host;
  return `${displayHost}:${port}`;
};

const getNacosInstanceMetadataEntries = (
  metadata?: Record<string, string>,
): Array<[string, string]> => Object.entries(metadata || {})
  .filter(([key]) => key.trim().length > 0)
  .map(([key, value]): [string, string] => [key, String(value ?? '')])
  .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey));

const NACOS_SERVICES_CHANGED_EVENT = 'gonavi:nacos-services-changed';
export const NACOS_AUTO_REFRESH_INTERVAL_MS = 5_000;

const NacosServiceViewer: React.FC<NacosServiceViewerProps> = ({
  connectionId,
  namespaceId,
  namespaceName,
  initialGroup,
  isActive = true,
}) => {
  const connections = useStore((state) => state.connections);
  const appTheme = useStore((state) => state.theme);
  const appearance = useStore((state) => state.appearance);
  const i18n = useOptionalI18n();
  const i18nLanguage = i18n?.language;
  const tr = useCallback(
    (key: string, params?: I18nParams) => t(key, params, i18nLanguage),
    [i18nLanguage],
  );

  const darkMode = appTheme === 'dark';
  const isV2Ui = appearance.uiVersion === 'v2';
  const resolvedAppearance = resolveAppearanceValues(appearance);
  const opacity = normalizeOpacityForPlatform(resolvedAppearance.opacity);
  const blur = normalizeBlurForPlatform(resolvedAppearance.blur);
  const workbenchTheme = useMemo(
    () => buildRedisWorkbenchTheme({
      darkMode,
      opacity,
      blur,
      disableBackdropFilter: isMacLikePlatform(),
    }),
    [blur, darkMode, opacity, appearance.uiVersion],
  );
  // v1 keeps raised cards; v2 is flat (same as Redis gn-v2-redis-workbench CSS).
  const workbenchCardStyle = useMemo(() => (
    isV2Ui
      ? {
          background: 'transparent',
          border: 'none',
          boxShadow: 'none',
          borderRadius: 0,
        }
      : {
          background: workbenchTheme.panelBg,
          border: workbenchTheme.panelBorder,
          boxShadow: `${workbenchTheme.panelInset}, ${workbenchTheme.shadow}`,
          borderRadius: 12,
          backdropFilter: workbenchTheme.backdropFilter,
          WebkitBackdropFilter: workbenchTheme.backdropFilter,
        }
  ), [isV2Ui, workbenchTheme]);

  const connection = connections.find((item) => item.id === connectionId);
  const connectionProtection = connection?.config?.protection;
  const dataEditRestricted = !!connection?.config?.readOnly
    || connectionProtection?.restrictDataEdit === true;
  const structureRestricted = !!connection?.config?.readOnly
    || connectionProtection?.restrictStructureEdit === true;

  const rpcConfig = useMemo(() => {
    if (!connection?.config) return null;
    return buildRpcConnectionConfig(connection.config as any);
  }, [connection?.config]);

  const [loadingServices, setLoadingServices] = useState(false);
  const [loadingInstances, setLoadingInstances] = useState(false);
  const [serviceNames, setServiceNames] = useState<string[]>([]);
  const [serviceTotal, setServiceTotal] = useState(0);
  const [pageNo, setPageNo] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [groupFilter, setGroupFilter] = useState(() => String(initialGroup || '').trim());
  const [selectedServiceRaw, setSelectedServiceRaw] = useState<string | null>(null);
  const [selectedServiceDetail, setSelectedServiceDetail] = useState<NacosServiceDetail | null>(null);
  const [instances, setInstances] = useState<NacosInstance[]>([]);
  const [updatingInstanceKeys, setUpdatingInstanceKeys] = useState<Set<string>>(
    () => new Set(),
  );
  const [expandedInstanceKeys, setExpandedInstanceKeys] = useState<Set<string>>(
    () => new Set(),
  );

  const [serviceModalOpen, setServiceModalOpen] = useState(false);
  const [savingService, setSavingService] = useState(false);
  const [serviceForm] = Form.useForm();
  const [instanceModalOpen, setInstanceModalOpen] = useState(false);
  const [savingInstance, setSavingInstance] = useState(false);
  const [instanceForm] = Form.useForm();
  const [editingInstance, setEditingInstance] = useState<NacosInstance | null>(null);
  // Left service list pane width; drag divider to adjust (same pattern as Redis).
  const [leftPanelWidth, setLeftPanelWidth] = useState<number | string>('38%');
  const leftPanelRef = useRef<HTMLDivElement>(null);
  const serviceRequestIdRef = useRef(0);
  const instanceRequestIdRef = useRef(0);
  const selectedServiceRawRef = useRef<string | null>(null);
  const serviceModalGenerationRef = useRef(0);
  const serviceSavingRef = useRef(false);
  const instanceSavingRef = useRef(false);
  const updatingInstanceTokensRef = useRef<Map<string, symbol>>(new Map());
  const instanceModalGenerationRef = useRef(0);
  const instanceModalTargetServiceRawRef = useRef<string | null>(null);
  const activeContextRef = useRef<NacosContextToken | null>(null);
  const autoRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoRefreshGenerationRef = useRef(0);
  const loadServicesRef = useRef<LoadServices>(async () => undefined);
  const loadInstancesRef = useRef<LoadInstances>(async () => undefined);
  const serviceViewRef = useRef<ServiceViewContext>({
    requestId: 0,
    page: 1,
    pageSize: 50,
    group: String(initialGroup || '').trim(),
  });
  activeContextRef.current = { connectionId, namespaceId, rpcConfig };

  const selectedParsed = useMemo(
    () => (selectedServiceRaw ? parseNacosServiceName(selectedServiceRaw) : null),
    [selectedServiceRaw],
  );

  useEffect(() => {
    setExpandedInstanceKeys(new Set());
    updatingInstanceTokensRef.current.clear();
    setUpdatingInstanceKeys(new Set());
  }, [connectionId, namespaceId, selectedServiceRaw]);

  const toggleInstanceDetails = useCallback((instanceKey: string) => {
    setExpandedInstanceKeys((current) => {
      const next = new Set(current);
      if (next.has(instanceKey)) {
        next.delete(instanceKey);
      } else {
        next.add(instanceKey);
      }
      return next;
    });
  }, []);
  const serviceRows = useMemo<NacosServiceRow[]>(
    () => serviceNames.map((rawName) => ({ rawName, ...parseNacosServiceName(rawName) })),
    [serviceNames],
  );
  const notifyServiceGroupsChanged = useCallback(() => {
    window.dispatchEvent(new CustomEvent(NACOS_SERVICES_CHANGED_EVENT, {
      detail: {
        connectionId,
        namespaceId: namespaceId || '',
      },
    }));
  }, [connectionId, namespaceId]);
  const isActiveContext = useCallback((expected: NacosContextToken) => {
    const active = activeContextRef.current;
    return !!active
      && active.connectionId === expected.connectionId
      && active.namespaceId === expected.namespaceId
      && active.rpcConfig === expected.rpcConfig;
  }, []);
  const closeServiceModal = useCallback(() => {
    serviceModalGenerationRef.current += 1;
    setServiceModalOpen(false);
  }, []);
  const openCreateService = useCallback(() => {
    serviceModalGenerationRef.current += 1;
    serviceForm.setFieldsValue({
      serviceName: '',
      groupName: 'DEFAULT_GROUP',
      ephemeral: false,
      protectThreshold: 0,
    });
    setServiceModalOpen(true);
  }, [serviceForm]);
  const closeInstanceModal = useCallback(() => {
    instanceModalGenerationRef.current += 1;
    instanceModalTargetServiceRawRef.current = null;
    setInstanceModalOpen(false);
    setEditingInstance(null);
  }, []);

  const loadServices = useCallback(
    async (
      page = 1,
      requestedGroup = groupFilter.trim(),
      requestedPageSize = pageSize,
      options?: NacosLoadOptions,
    ) => {
      if (!rpcConfig) return;
      const requestId = ++serviceRequestIdRef.current;
      serviceViewRef.current = {
        requestId,
        page,
        pageSize: requestedPageSize,
        group: requestedGroup,
      };
      setLoadingServices(true);
      try {
        const res = await (window as any).go.app.App.NacosListServices(rpcConfig, {
          namespaceId: namespaceId || '',
          groupName: requestedGroup,
          pageNo: page,
          pageSize: requestedPageSize,
        });
        if (requestId !== serviceRequestIdRef.current) return;
        if (!res?.success) {
          if (!options?.silent) message.error(res?.message || 'list services failed');
          return;
        }
        const pageData = (res.data || {}) as ServicePage;
        const names = Array.isArray(pageData.serviceNames) ? pageData.serviceNames : [];
        const total = Number(pageData.count) || names.length;
        const lastPage = Math.max(1, Math.ceil(total / requestedPageSize));
        if (names.length === 0 && page > lastPage) {
          await loadServices(lastPage, requestedGroup, requestedPageSize, options);
          return;
        }
        setServiceNames(names);
        setServiceTotal(total);
        setPageNo(Number(pageData.pageNo) || page);
        setPageSize(requestedPageSize);
        const currentSelectedService = selectedServiceRawRef.current;
        if (currentSelectedService && !names.includes(currentSelectedService)) {
          instanceRequestIdRef.current += 1;
          selectedServiceRawRef.current = null;
          setSelectedServiceRaw(null);
          setSelectedServiceDetail(null);
          setInstances([]);
          setLoadingInstances(false);
          closeInstanceModal();
        }
      } catch (error: any) {
        if (requestId !== serviceRequestIdRef.current) return;
        if (!options?.silent) message.error(error?.message || String(error));
      } finally {
        if (requestId === serviceRequestIdRef.current) {
          setLoadingServices(false);
        }
      }
    },
    [rpcConfig, namespaceId, groupFilter, pageSize, closeInstanceModal],
  );

  const loadInstances = useCallback(
    async (rawServiceName: string, options?: NacosLoadOptions) => {
      if (!rpcConfig || selectedServiceRawRef.current !== rawServiceName) return;
      const parsed = parseNacosServiceName(rawServiceName);
      const requestId = ++instanceRequestIdRef.current;
      setLoadingInstances(true);
      setSelectedServiceDetail(null);
      const detailPromise = Promise.resolve()
        .then(() => (window as any).go.app.App.NacosGetService(
          rpcConfig,
          namespaceId || '',
          parsed.serviceName,
          parsed.groupName,
        ))
        .catch((error: any) => ({
          success: false,
          message: error?.message || String(error),
        }));
      let hosts: NacosInstance[] = [];
      try {
        const res = await (window as any).go.app.App.NacosListInstances(rpcConfig, {
          namespaceId: namespaceId || '',
          serviceName: parsed.serviceName,
          groupName: parsed.groupName,
        });
        if (
          requestId !== instanceRequestIdRef.current
          || selectedServiceRawRef.current !== rawServiceName
        ) return;
        if (!res?.success) {
          if (!options?.silent) message.error(res?.message || 'list instances failed');
          return;
        }
        const list = (res.data || {}) as InstanceList;
        hosts = Array.isArray(list.hosts) ? list.hosts : [];
        setInstances(hosts);
      } catch (error: any) {
        if (
          requestId !== instanceRequestIdRef.current
          || selectedServiceRawRef.current !== rawServiceName
        ) return;
        if (!options?.silent) message.error(error?.message || String(error));
        return;
      } finally {
        if (
          requestId === instanceRequestIdRef.current
          && selectedServiceRawRef.current === rawServiceName
        ) {
          setLoadingInstances(false);
        }
      }

      const detailRes = await detailPromise;
      if (
        requestId !== instanceRequestIdRef.current
        || selectedServiceRawRef.current !== rawServiceName
      ) return;
      if (detailRes?.success) {
        setSelectedServiceDetail((detailRes.data || {}) as NacosServiceDetail);
      } else {
        setSelectedServiceDetail(
          hosts.length > 0
            ? { ephemeral: !!hosts[0].ephemeral, clusters: [] }
            : null,
        );
        if (!options?.silent) message.error(detailRes?.message || 'load service detail failed');
      }
    },
    [rpcConfig, namespaceId],
  );
  loadServicesRef.current = loadServices;
  loadInstancesRef.current = loadInstances;

  useEffect(() => {
    const contextToken = { connectionId, namespaceId, rpcConfig };
    activeContextRef.current = contextToken;
    return () => {
      if (isActiveContext(contextToken)) {
        activeContextRef.current = null;
      }
    };
  }, [connectionId, namespaceId, rpcConfig, isActiveContext]);

  useEffect(() => {
    const requestedGroup = String(initialGroup || '').trim();
    serviceRequestIdRef.current += 1;
    instanceRequestIdRef.current += 1;
    selectedServiceRawRef.current = null;
    setGroupFilter(requestedGroup);
    setServiceNames([]);
    setServiceTotal(0);
    setPageNo(1);
    setSelectedServiceRaw(null);
    setSelectedServiceDetail(null);
    setInstances([]);
    closeServiceModal();
    closeInstanceModal();
    setLoadingServices(false);
    setLoadingInstances(false);
    void loadServices(1, requestedGroup);
    return () => {
      serviceRequestIdRef.current += 1;
      instanceRequestIdRef.current += 1;
    };
  }, [connectionId, namespaceId, rpcConfig, initialGroup]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (autoRefreshTimerRef.current !== null) {
      clearTimeout(autoRefreshTimerRef.current);
      autoRefreshTimerRef.current = null;
    }
    const generation = ++autoRefreshGenerationRef.current;
    if (!isActive || !rpcConfig) {
      return () => {
        if (autoRefreshGenerationRef.current === generation) {
          autoRefreshGenerationRef.current += 1;
        }
      };
    }

    let cancelled = false;
    const scheduleNextRefresh = () => {
      if (cancelled || autoRefreshGenerationRef.current !== generation) return;
      autoRefreshTimerRef.current = setTimeout(() => {
        autoRefreshTimerRef.current = null;
        void refresh();
      }, NACOS_AUTO_REFRESH_INTERVAL_MS);
    };
    const refresh = async () => {
      if (cancelled || autoRefreshGenerationRef.current !== generation) return;
      const view = serviceViewRef.current;
      await loadServicesRef.current(view.page, view.group, view.pageSize, { silent: true });
      if (cancelled || autoRefreshGenerationRef.current !== generation) return;
      const selected = selectedServiceRawRef.current;
      if (selected) {
        await loadInstancesRef.current(selected, { silent: true });
      }
      scheduleNextRefresh();
    };
    scheduleNextRefresh();

    return () => {
      cancelled = true;
      if (autoRefreshGenerationRef.current === generation) {
        autoRefreshGenerationRef.current += 1;
      }
      if (autoRefreshTimerRef.current !== null) {
        clearTimeout(autoRefreshTimerRef.current);
        autoRefreshTimerRef.current = null;
      }
    };
  }, [isActive, rpcConfig]);

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
        await loadServices(refreshPage, currentView.group, currentView.pageSize);
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

  return (
    <div
      className={isV2Ui ? 'gn-v2-nacos-workbench' : undefined}
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        minHeight: 0,
        padding: isV2Ui ? 0 : 12,
        gap: isV2Ui ? 0 : 12,
        boxSizing: 'border-box',
        background: isV2Ui ? undefined : workbenchTheme.appBg,
        color: workbenchTheme.textPrimary,
      }}
    >
      <div
        className={isV2Ui ? 'gn-v2-nacos-split' : undefined}
        style={{
          display: isV2Ui ? undefined : 'flex',
          minHeight: 0,
          flex: 1,
          overflow: 'hidden',
          ...(isV2Ui
            ? {
                ['--gn-nacos-sidebar-width' as string]:
                  typeof leftPanelWidth === 'number' ? `${leftPanelWidth}px` : leftPanelWidth,
              }
            : {}),
        }}
      >
        <div
          ref={leftPanelRef}
          className={isV2Ui ? 'gn-v2-nacos-list-pane' : undefined}
          style={
            isV2Ui
              ? { minHeight: 0, overflow: 'hidden' }
              : {
                  ...workbenchCardStyle,
                  width: leftPanelWidth,
                  minWidth: 260,
                  minHeight: 0,
                  display: 'flex',
                  flexDirection: 'column',
                  flexShrink: 0,
                  overflow: 'hidden',
                }
          }
        >
          <div
            className={isV2Ui ? 'gn-v2-nacos-pane-header' : undefined}
            style={isV2Ui ? undefined : { padding: 8, marginBottom: 8 }}
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
              isV2Ui
                ? 'gn-v2-nacos-pane-body gn-nacos-service-list-body'
                : 'gn-nacos-service-list-body'
            }
            data-testid="nacos-service-list-body"
            style={{
              flex: 1,
              minHeight: 0,
              display: 'flex',
              flexDirection: 'column',
              overflow: 'hidden',
              padding: isV2Ui ? undefined : 8,
            }}
          >
            <div
              className="gn-nacos-service-list-scroll"
              data-testid="nacos-service-list-scroll"
              style={{ flex: '1 1 0', minHeight: 0, overflow: 'auto' }}
            >
              <Table
                className="gn-nacos-service-table"
                size="small"
                loading={loadingServices}
                rowKey={(row) => row.rawName}
                dataSource={serviceRows}
                pagination={false}
                onRow={(record) => ({
                  onClick: () => {
                    if (selectedServiceRawRef.current !== record.rawName) {
                      closeInstanceModal();
                    }
                    instanceRequestIdRef.current += 1;
                    selectedServiceRawRef.current = record.rawName;
                    setSelectedServiceRaw(record.rawName);
                    setSelectedServiceDetail(null);
                    setInstances([]);
                    void loadInstances(record.rawName);
                  },
                })}
                rowClassName={(record) =>
                  selectedServiceRaw === record.rawName ? 'ant-table-row-selected' : ''
                }
                columns={[
                  {
                    title: tr('nacos_service.field.service'),
                    dataIndex: 'serviceName',
                    key: 'serviceName',
                    ellipsis: true,
                    render: (_: unknown, row: NacosServiceRow) => (
                      <div style={{ minWidth: 0 }}>
                        <div
                          title={row.serviceName}
                          style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                        >
                          {row.serviceName}
                        </div>
                        <div
                          title={row.groupName}
                          style={{
                            marginTop: 2,
                            color: workbenchTheme.textMuted,
                            fontSize: 12,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {row.groupName}
                        </div>
                      </div>
                    ),
                  },
                  {
                    title: tr('nacos_viewer.action.delete'),
                    key: 'actions',
                    width: 90,
                    render: (_: unknown, row: NacosServiceRow) => (
                      <Popconfirm
                        title={tr('nacos_service.message.confirm_delete_service', { name: row.rawName })}
                        disabled={structureRestricted}
                        onConfirm={() => void handleDeleteService(row.rawName)}
                      >
                        <Button
                          size="small"
                          danger
                          icon={<DeleteOutlined />}
                          disabled={structureRestricted}
                        />
                      </Popconfirm>
                    ),
                  },
                ]}
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
                    void loadServices(1, groupFilter.trim(), size);
                    return;
                  }
                  void loadServices(page, groupFilter.trim(), size);
                }}
              />
            </div>
          </div>
        </div>

        <RedisResizableDivider
          targetRef={leftPanelRef}
          onResizeEnd={setLeftPanelWidth}
          minWidth={260}
          maxReservedWidth={isV2Ui ? 321 : 320}
          containerWidthCssVariable={isV2Ui ? '--gn-nacos-sidebar-width' : undefined}
          title={tr('redis_viewer.tooltip.resize_panels')}
        />

        <div
          className={isV2Ui ? 'gn-v2-nacos-detail-pane' : undefined}
          style={
            isV2Ui
              ? { minHeight: 0, overflow: 'hidden' }
              : {
                  ...workbenchCardStyle,
                  flex: 1,
                  minWidth: 0,
                  minHeight: 0,
                  display: 'flex',
                  flexDirection: 'column',
                  overflow: 'hidden',
                }
          }
        >
          <div
            className={isV2Ui ? 'gn-v2-nacos-pane-header' : undefined}
            style={isV2Ui ? undefined : { padding: 8, marginBottom: 8 }}
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
            className={isV2Ui ? 'gn-v2-nacos-pane-body' : undefined}
            style={{
              flex: 1,
              minHeight: 0,
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
              padding: isV2Ui ? undefined : 12,
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

      <Modal
        title={
          editingInstance
            ? tr('nacos_service.action.edit_instance')
            : tr('nacos_service.action.register_instance')
        }
        open={instanceModalOpen}
        confirmLoading={savingInstance}
        onCancel={closeInstanceModal}
        onOk={() => void handleSaveInstance()}
        destroyOnHidden
      >
        <Form form={instanceForm} layout="vertical">
          <Form.Item name="serviceName" label={tr('nacos_service.field.service')}>
            <Input disabled {...noAutoCapInputProps} />
          </Form.Item>
          <Form.Item name="groupName" label={tr('nacos_service.field.group')}>
            <Input disabled {...noAutoCapInputProps} />
          </Form.Item>
          <Form.Item name="ip" label="IP" rules={[{ required: true }]}>
            <Input disabled={!!editingInstance} {...noAutoCapInputProps} />
          </Form.Item>
          <Form.Item name="port" label="Port" rules={[{ required: true }]}>
            <InputNumber min={1} max={65535} style={{ width: '100%' }} disabled={!!editingInstance} />
          </Form.Item>
          <Form.Item name="clusterName" label={tr('nacos_service.field.cluster')}>
            <Input disabled={!!editingInstance} {...noAutoCapInputProps} />
          </Form.Item>
          <Form.Item name="weight" label={tr('nacos_service.field.weight')}>
            <InputNumber min={0} max={10000} step={0.1} style={{ width: '100%' }} />
          </Form.Item>
          <Space size="large">
            <Form.Item name="enabled" label={tr('nacos_service.field.enabled')} valuePropName="checked">
              <Switch />
            </Form.Item>
            <Form.Item name="ephemeral" label={tr('nacos_service.field.ephemeral')} valuePropName="checked">
              <Switch disabled />
            </Form.Item>
            <Form.Item name="healthy" label={tr('nacos_service.field.healthy')} valuePropName="checked">
              <Switch
                disabled={!editingInstance || !canUpdateInstanceHealth(editingInstance)}
              />
            </Form.Item>
          </Space>
        </Form>
      </Modal>
    </div>
  );
};

export default NacosServiceViewer;
