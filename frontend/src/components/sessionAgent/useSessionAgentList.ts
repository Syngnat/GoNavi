import React from 'react';
import { message } from 'antd';
import { t } from '../../i18n';
import { useStore } from '../../store';
import { sessionAgentErrorText, type SessionAgentApi, type SessionAgentItem } from './sessionAgentApi';

const readPreference = (key: string, fallback: string): string => {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
};

// 列表扫描、筛选和分组状态；详情加载由独立 hook 负责。
export const useSessionAgentList = (api: SessionAgentApi, agentIntegrationId?: string) => {
  const [items, setItems] = React.useState<SessionAgentItem[]>([]);
  const [scopeTotal, setScopeTotal] = React.useState(0);
  const [loading, setLoading] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const [appliedQuery, setAppliedQuery] = React.useState('');
  const [providerFilter, setProviderFilter] = React.useState(() =>
    agentIntegrationId || readPreference('gonavi.sessionAgent.provider', ''));
  const [groupMode, setGroupMode] = React.useState(() =>
    readPreference('gonavi.sessionAgent.groupMode', 'project'));
  const agentIntegrations = useStore((state) => state.agentIntegrations);
  const agentIntegrationsLoaded = useStore((state) => state.agentIntegrationsLoaded);
  const agentKinds = React.useMemo(
    () => agentIntegrations.map((item) => item.integrationId).join(','),
    [agentIntegrations],
  );
  const providerOptions = React.useMemo(() => [
    { value: '', label: t('session_agent.list.filter_all') },
    ...agentIntegrations.map((item) => ({
      value: item.integrationId,
      label: item.displayName || item.integrationId,
    })),
  ], [agentIntegrations]);

  React.useEffect(() => {
    const timer = window.setTimeout(() => setAppliedQuery(query), 350);
    return () => window.clearTimeout(timer);
  }, [query]);

  React.useEffect(() => {
    try {
      localStorage.setItem('gonavi.sessionAgent.provider', providerFilter);
      localStorage.setItem('gonavi.sessionAgent.groupMode', groupMode);
    } catch {
      // 存储不可用时只保留当前页面状态。
    }
  }, [providerFilter, groupMode]);

  React.useEffect(() => {
    if (!agentIntegrationsLoaded || !providerFilter) return;
    if (providerOptions.some((option) => option.value === providerFilter)) return;
    setProviderFilter('');
  }, [agentIntegrationsLoaded, providerOptions, providerFilter]);

  const reload = React.useCallback(async () => {
    setLoading(true);
    try {
      const list = await api.list(providerFilter, appliedQuery);
      setItems(list);
      if (!appliedQuery.trim()) setScopeTotal(list.length);
    } catch (err) {
      message.error(sessionAgentErrorText(err, 'session_agent.error.list_failed'));
    } finally {
      setLoading(false);
    }
  }, [api, providerFilter, appliedQuery, agentKinds]);

  React.useEffect(() => {
    void reload();
  }, [reload]);

  return {
    items,
    loading,
    query,
    setQuery,
    appliedQuery,
    providerFilter,
    setProviderFilter,
    providerOptions,
    groupMode,
    setGroupMode,
    reload,
    filtering: appliedQuery.trim().length > 0,
    scopeTotal,
  };
};
