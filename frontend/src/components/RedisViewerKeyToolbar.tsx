import React from 'react';
import { Button, Input, Popconfirm, Radio, Space, Tag } from 'antd';
import type { RadioChangeEvent } from 'antd';
import { DeleteOutlined, PlusOutlined, ReloadOutlined, SearchOutlined } from '@ant-design/icons';

import type { SavedConnection } from '../types';
import { t, type I18nParams } from '../i18n';
import { useOptionalI18n } from '../i18n/provider';
import { noAutoCapInputProps } from '../utils/inputAutoCap';
import type { RedisSearchMode } from '../utils/redisSearchPattern';

const { Search } = Input;

const normalizeText = (value: unknown): string => String(value || '').trim();

const normalizeRedisTopology = (connection?: SavedConnection): 'single' | 'cluster' | 'sentinel' => {
  const topology = normalizeText(connection?.config?.topology).toLowerCase();
  if (topology === 'sentinel') return 'sentinel';
  if (topology === 'cluster') return 'cluster';
  const extraHosts = Array.isArray(connection?.config?.hosts) ? connection.config.hosts.filter(Boolean) : [];
  return extraHosts.length > 0 ? 'cluster' : 'single';
};

const buildRedisSeedAddresses = (connection?: SavedConnection): string[] => {
  if (!connection) return [];
  const config = connection.config || {};
  const port = Number.isFinite(Number(config.port)) ? Number(config.port) : 6379;
  const primary = normalizeText(config.host) ? `${normalizeText(config.host)}:${port}` : '';
  const extraHosts = Array.isArray(config.hosts)
    ? config.hosts.map((host) => normalizeText(host)).filter(Boolean)
    : [];
  return [primary, ...extraHosts].filter(Boolean);
};

const getRedisTopologyLabel = (
  topology: 'single' | 'cluster' | 'sentinel',
  tr: (key: string, params?: I18nParams) => string,
): string => {
  if (topology === 'cluster') return tr('redis_viewer.topology.cluster');
  if (topology === 'sentinel') return tr('redis_viewer.topology.sentinel');
  return tr('redis_viewer.topology.single');
};

type RedisViewerKeyToolbarProps = {
  isV2Ui: boolean;
  redisDB: number;
  connection?: SavedConnection;
  keyCount: number;
  selectedKeyCount: number;
  searchMode: RedisSearchMode;
  searchInput: string;
  canLoadAll?: boolean;
  loadingAllKeys?: boolean;
  mutedPillTagStyle: React.CSSProperties;
  actionButtonStyle: React.CSSProperties;
  primaryActionButtonStyle: React.CSSProperties;
  dangerActionButtonStyle: React.CSSProperties;
  textMutedColor: string;
  textPrimaryColor: string;
  onSearchModeChange: (event: RadioChangeEvent) => void;
  onSearchInputChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
  onSearch: (value: string) => void;
  onRefresh: () => void;
  onCreateKey: () => void;
  onSelectAllLoadedKeys: () => void;
  onLoadAllKeys: () => void;
  onClearAllSelectedKeys: () => void;
  onDeleteSelectedKeys: () => void;
};

const RedisViewerKeyToolbar: React.FC<RedisViewerKeyToolbarProps> = ({
  isV2Ui,
  redisDB,
  connection,
  keyCount,
  selectedKeyCount,
  searchMode,
  searchInput,
  canLoadAll = false,
  loadingAllKeys = false,
  mutedPillTagStyle,
  actionButtonStyle,
  primaryActionButtonStyle,
  dangerActionButtonStyle,
  textMutedColor,
  textPrimaryColor,
  onSearchModeChange,
  onSearchInputChange,
  onSearch,
  onRefresh,
  onCreateKey,
  onSelectAllLoadedKeys,
  onLoadAllKeys,
  onClearAllSelectedKeys,
  onDeleteSelectedKeys,
}) => {
  const i18n = useOptionalI18n();
  const i18nLanguage = i18n?.language;
  const tr = (key: string, params?: I18nParams) => t(key, params, i18nLanguage);
  const topology = normalizeRedisTopology(connection);
  const seedAddresses = buildRedisSeedAddresses(connection);
  const sentinelMaster = topology === 'sentinel'
    ? normalizeText(connection?.config?.redisSentinelMaster)
    : '';

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, marginBottom: 12 }}>
        <div>
          <div style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: '.08em', color: textMutedColor, fontWeight: 600 }}>{tr('redis_viewer.title.key_explorer')}</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 4 }}>
            <div style={{ fontSize: 24, fontWeight: 700, color: textPrimaryColor }}>db{redisDB}</div>
            <Tag style={mutedPillTagStyle}>{getRedisTopologyLabel(topology, tr)}</Tag>
            {topology !== 'single' && (
              <Tag style={mutedPillTagStyle}>{tr('redis_viewer.label.node_count', { count: seedAddresses.length || 1 })}</Tag>
            )}
            {sentinelMaster && (
              <Tag style={mutedPillTagStyle}>master: {sentinelMaster}</Tag>
            )}
          </div>
        </div>
        <Tag style={mutedPillTagStyle}>{tr('redis_viewer.label.keys_count', { count: keyCount })}</Tag>
      </div>
      <Space.Compact style={{ width: '100%' }}>
        <Radio.Group
          value={searchMode}
          onChange={onSearchModeChange}
          buttonStyle="solid"
          style={{ flexShrink: 0 }}
        >
          <Radio.Button value="prefix">{tr('redis_viewer.search.prefix')}</Radio.Button>
          <Radio.Button value="exact">{tr('redis_viewer.search.exact')}</Radio.Button>
        </Radio.Group>
        <Search
          {...noAutoCapInputProps}
          style={{ flex: 1 }}
          placeholder={searchMode === 'exact' ? tr('redis_viewer.placeholder.search_exact') : tr('redis_viewer.placeholder.search_prefix')}
          value={searchInput}
          onChange={onSearchInputChange}
          onSearch={onSearch}
          allowClear
          enterButton={<SearchOutlined />}
        />
      </Space.Compact>
      <div className={isV2Ui ? 'gn-v2-redis-toolbar' : undefined} style={{ marginTop: 12, display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <Space wrap size={8}>
          <Button size="small" style={actionButtonStyle} icon={<ReloadOutlined />} onClick={onRefresh}>{tr('redis_viewer.action.refresh')}</Button>
          <Button size="small" style={actionButtonStyle} icon={<PlusOutlined />} onClick={onCreateKey}>{tr('redis_viewer.action.new_key')}</Button>
          <Button size="small" style={primaryActionButtonStyle} onClick={onSelectAllLoadedKeys} disabled={keyCount === 0}>{tr('redis_viewer.action.select_all_loaded')}</Button>
          <Button size="small" style={actionButtonStyle} onClick={onLoadAllKeys} disabled={!canLoadAll} loading={loadingAllKeys}>{tr('redis_viewer.action.load_all')}</Button>
          <Button size="small" style={actionButtonStyle} onClick={onClearAllSelectedKeys} disabled={selectedKeyCount === 0}>{tr('redis_viewer.action.clear_selection')}</Button>
        </Space>
        <Popconfirm
          title={tr('redis_viewer.confirm.delete_selected', { count: selectedKeyCount })}
          onConfirm={onDeleteSelectedKeys}
          disabled={selectedKeyCount === 0}
        >
          <Button size="small" style={dangerActionButtonStyle} icon={<DeleteOutlined />} disabled={selectedKeyCount === 0}>
            {tr('redis_viewer.action.delete_selected', { count: selectedKeyCount })}
          </Button>
        </Popconfirm>
      </div>
    </div>
  );
};

export default RedisViewerKeyToolbar;
