import { useCallback, useMemo, useState, useRef, useEffect } from 'react';
import { Form, message } from 'antd';
import { useStore } from '../../../store';
import { useOptionalI18n } from '../../../i18n/provider';
import { type I18nParams, t } from '../../../i18n';
import {
  resolveAppearanceValues,
  normalizeBlurForPlatform,
  isMacLikePlatform,
} from '../../../utils/appearance';
import { buildRedisWorkbenchTheme } from '../../redisViewerWorkbenchTheme';
import { buildRpcConnectionConfig } from '../../../utils/connectionRpcConfig';
import { buildNacosServiceStatisticsIndex } from '../../nacos/NacosServiceRowStatus';
import type {
  NacosServiceDetail,
  NacosInstance,
  NacosContextToken,
  LoadServices,
  LoadInstances,
  ServiceViewContext,
  NacosLoadOptions,
  ServicePage,
  InstanceList,
} from '../nacosServiceModel';
import { parseNacosServiceName } from '../../nacosServiceName';
import type { NacosServiceRow } from '../../nacos/NacosServiceTable';
import {
  NACOS_SERVICES_CHANGED_EVENT,
  NACOS_AUTO_REFRESH_INTERVAL_MS,
} from '../nacosServiceConstants';
import type { NacosServiceViewerProps } from '../nacosServiceModel';

export interface UseNacosServiceViewerStateInput {
  connectionId: NacosServiceViewerProps['connectionId'];
  initialGroup: NacosServiceViewerProps['initialGroup'];
  namespaceId: NacosServiceViewerProps['namespaceId'];
  isActive: Exclude<NacosServiceViewerProps['isActive'], undefined>;
}

export const useNacosServiceViewerState = ({ connectionId, initialGroup, namespaceId, isActive }: UseNacosServiceViewerStateInput) => {
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

  const resolvedAppearance = resolveAppearanceValues(appearance);
  const blur = normalizeBlurForPlatform(resolvedAppearance.blur);
  const workbenchTheme = useMemo(
    () => buildRedisWorkbenchTheme({
      darkMode,
      blur,
      disableBackdropFilter: isMacLikePlatform(),
    }),
    [blur, darkMode],
  );
  // v1 keeps raised cards; v2 is flat (same as Redis gn-v2-redis-workbench CSS).
  const workbenchCardStyle = useMemo(() => (
    {
          background: 'transparent',
          border: 'none',
          boxShadow: 'none',
          borderRadius: 0,
        }
  ), [workbenchTheme]);

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
  const [serviceStatistics, setServiceStatistics] = useState<ReturnType<typeof buildNacosServiceStatisticsIndex>>(() => new Map());
  const [serviceTotal, setServiceTotal] = useState(0);
  const [pageNo, setPageNo] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [groupFilter, setGroupFilter] = useState(() => String(initialGroup || '').trim());
  const [serviceFilter, setServiceFilter] = useState('');
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
    serviceName: '',
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

  const handleSelectService = useCallback((rawName: string) => {
    if (selectedServiceRawRef.current !== rawName) {
      closeInstanceModal();
    }
    instanceRequestIdRef.current += 1;
    selectedServiceRawRef.current = rawName;
    setSelectedServiceRaw(rawName);
    setSelectedServiceDetail(null);
    setInstances([]);
    void loadInstancesRef.current(rawName);
  }, [closeInstanceModal]);

  const loadServices = useCallback(
    async (
      page = 1,
      requestedGroup = groupFilter.trim(),
      requestedPageSize = pageSize,
      requestedServiceName = serviceFilter.trim(),
      options?: NacosLoadOptions,
    ) => {
      if (!rpcConfig) return;
      const requestId = ++serviceRequestIdRef.current;
      serviceViewRef.current = {
        requestId,
        page,
        pageSize: requestedPageSize,
        group: requestedGroup,
        serviceName: requestedServiceName,
      };
      setLoadingServices(true);
      try {
        const res = await (window as any).go.app.App.NacosListServices(rpcConfig, {
          namespaceId: namespaceId || '',
          serviceName: requestedServiceName,
          groupName: requestedGroup,
          pageNo: page,
          pageSize: requestedPageSize,
          withStatistics: true,
        });
        if (requestId !== serviceRequestIdRef.current) return;
        if (!res?.success) {
          if (!options?.silent) message.error(res?.message || 'list services failed');
          return;
        }
        const pageData = (res.data || {}) as ServicePage;
        setServiceStatistics(buildNacosServiceStatisticsIndex(pageData));
        const names = Array.isArray(pageData.serviceNames) ? pageData.serviceNames : [];
        const total = Number(pageData.count) || names.length;
        const lastPage = Math.max(1, Math.ceil(total / requestedPageSize));
        if (names.length === 0 && page > lastPage) {
          await loadServices(lastPage, requestedGroup, requestedPageSize, requestedServiceName, options);
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
    [rpcConfig, namespaceId, groupFilter, pageSize, serviceFilter, closeInstanceModal],
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
    setServiceFilter('');
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
    void loadServices(1, requestedGroup, undefined, '');
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
      await loadServicesRef.current(view.page, view.group, view.pageSize, view.serviceName, { silent: true });
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
  return {
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
  };
};

export type NacosServiceViewerStateApi = ReturnType<typeof useNacosServiceViewerState>;
