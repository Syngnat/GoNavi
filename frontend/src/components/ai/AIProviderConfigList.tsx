import React from 'react';
import { Button, Popconfirm } from 'antd';
import { PlusOutlined } from '@ant-design/icons';

import type { AIProviderConfig } from '../../types';
import AIProviderLogo from './AIProviderLogo';

export interface AIProviderConfigListItem {
  provider: AIProviderConfig;
  presetKey: string;
  presetLabel: string;
  name: string;
  isDefault: boolean;
  isPending: boolean;
}

interface AIProviderConfigListProps {
  title: string;
  addLabel: string;
  emptyLabel: string;
  defaultLabel: string;
  setDefaultLabel: string;
  editLabel: string;
  deleteLabel: string;
  confirmDelete: string;
  cancelLabel: string;
  items: AIProviderConfigListItem[];
  loadError?: string;
  loading?: boolean;
  loadingLabel: string;
  retryLabel: string;
  disabled?: boolean;
  dark?: boolean;
  onAdd: () => void;
  onReload?: () => void;
  onEdit: (provider: AIProviderConfig) => void;
  onDelete: (id: string) => void;
  onSetDefault: (id: string) => void;
}

const AIProviderConfigList: React.FC<AIProviderConfigListProps> = ({
  title, addLabel, emptyLabel, defaultLabel, setDefaultLabel, editLabel, deleteLabel,
  confirmDelete, cancelLabel, items, loadError, loading, loadingLabel, retryLabel,
  disabled, dark, onAdd, onReload, onEdit, onDelete, onSetDefault,
}) => (
  <div className="gonavi-ai-provider-config-list">
    <div className="gonavi-ai-provider-config-list-heading">
      <h3>{title}</h3>
      <Button size="small" icon={<PlusOutlined />} onClick={onAdd} disabled={disabled}>{addLabel}</Button>
    </div>
    {loadError && <div role="alert">{loadError} {onReload && <Button type="link" onClick={onReload}>{retryLabel}</Button>}</div>}
    {loading && <div role="status">{loadingLabel}</div>}
    {!loading && !loadError && items.length === 0 && <div className="gonavi-ai-provider-config-empty">
      <p>{emptyLabel}</p>
      <Button size="small" icon={<PlusOutlined />} onClick={onAdd} disabled={disabled}>{addLabel}</Button>
    </div>}
    {items.length > 0 && <div className="gonavi-ai-provider-config-cards">
      {items.map((item) => (
        <div key={item.provider.id} className={`gonavi-ai-provider-config-card${item.isDefault ? ' is-default' : ''}`}>
          <div className="gonavi-ai-provider-config-card-main">
            <AIProviderLogo presetKey={item.presetKey} label={item.presetLabel} dark={dark} />
            <div>
              <div className="gonavi-ai-provider-config-card-title">
                <span className="gonavi-ai-provider-config-card-name">{item.name}</span>
                {item.isDefault && <span className="gonavi-ai-provider-current">{defaultLabel}</span>}
              </div>
              <div className="gonavi-ai-provider-config-card-preset">{item.presetLabel}</div>
            </div>
          </div>
          <div className="gonavi-ai-provider-config-card-actions">
            {!item.isDefault && <Button type="text" size="small" disabled={disabled || item.isPending}
              onClick={() => onSetDefault(item.provider.id)}>{setDefaultLabel}</Button>}
            <Button type="text" size="small" disabled={disabled}
              aria-label={`${editLabel}: ${item.name}`} onClick={() => onEdit(item.provider)}>{editLabel}</Button>
            <Popconfirm title={confirmDelete} onConfirm={() => onDelete(item.provider.id)}
              disabled={disabled} okButtonProps={{ danger: true }} okText={deleteLabel} cancelText={cancelLabel}>
              <Button type="text" size="small" danger disabled={disabled}
                aria-label={`${deleteLabel}: ${item.name}`}>{deleteLabel}</Button>
            </Popconfirm>
          </div>
        </div>
      ))}
    </div>}
  </div>
);

export default AIProviderConfigList;
