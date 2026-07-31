import React from 'react';
import { Button, Checkbox, Space, Typography } from 'antd';
import type { I18nParams } from '../i18n';

export const CLOUD_BACKUP_CATEGORY_IDS = [
  'connections',
  'saved_queries',
  'ai_settings',
  'proxy_settings',
  'daily_secrets',
  'update_settings',
] as const;

export type CloudBackupCategoryID = typeof CLOUD_BACKUP_CATEGORY_IDS[number];

export type CloudBackupCategoryOption = {
  id: string;
  itemCount?: number;
};

type Translate = (key: string, params?: I18nParams) => string;

type Props = {
  categories: CloudBackupCategoryOption[];
  selected: string[];
  title: string;
  t: Translate;
  disabled?: boolean;
  showCounts?: boolean;
  onChange: (selected: string[]) => void;
};

const fallback = (t: Translate, key: string, value: string, params?: I18nParams): string => {
  const translated = t(key, params);
  return translated === key ? value : translated;
};

const CATEGORY_LABELS: Record<string, { key: string; fallback: string }> = {
  connections: { key: 'app.cloud_backup.category.connections', fallback: 'Saved connections' },
  saved_queries: { key: 'app.cloud_backup.category.saved_queries', fallback: 'Saved queries' },
  ai_settings: { key: 'app.cloud_backup.category.ai_settings', fallback: 'AI settings' },
  proxy_settings: { key: 'app.cloud_backup.category.proxy_settings', fallback: 'Proxy settings' },
  daily_secrets: { key: 'app.cloud_backup.category.daily_secrets', fallback: 'Saved credentials' },
  update_settings: { key: 'app.cloud_backup.category.update_settings', fallback: 'Update settings' },
};

export const getCloudBackupCategoryLabel = (t: Translate, id: string): string => {
  const label = CATEGORY_LABELS[id] || { key: id, fallback: id };
  return fallback(t, label.key, label.fallback);
};

export const getCloudBackupCategoryCountLabel = (
  t: Translate,
  category: CloudBackupCategoryOption,
): string => category.id === 'connections'
  ? fallback(t, 'app.cloud_backup.connection_count', `${category.itemCount || 0} connections`, { count: category.itemCount || 0 })
  : fallback(t, 'app.cloud_backup.file_count', `${category.itemCount || 0} files`, { count: category.itemCount || 0 });

export default function CloudBackupCategorySelector({
  categories,
  selected,
  title,
  t,
  disabled = false,
  showCounts = false,
  onChange,
}: Props) {
  const allCategoryIDs = categories.map((category) => category.id);
  const allSelected = allCategoryIDs.length > 0 && allCategoryIDs.every((category) => selected.includes(category));

  return (
    <div style={{ display: 'grid', gap: 8, minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, minWidth: 0 }}>
        <Typography.Text strong>{title}</Typography.Text>
        <Space size={4}>
          <Button type="link" size="small" disabled={disabled || allSelected} onClick={() => onChange(allCategoryIDs)}>
            {fallback(t, 'app.cloud_backup.selection.select_all', 'Select all')}
          </Button>
          <Button type="link" size="small" disabled={disabled || selected.length === 0} onClick={() => onChange([])}>
            {fallback(t, 'app.cloud_backup.selection.select_none', 'Select none')}
          </Button>
        </Space>
      </div>
      <Checkbox.Group
        value={selected}
        disabled={disabled}
        onChange={(values) => onChange(values.map(String))}
        style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '8px 16px', width: '100%' }}
      >
        {categories.map((category) => {
          const countLabel = getCloudBackupCategoryCountLabel(t, category);
          return (
            <Checkbox key={category.id} value={category.id}>
              <span>{getCloudBackupCategoryLabel(t, category.id)}</span>
              {showCounts ? <Typography.Text type="secondary"> · {countLabel}</Typography.Text> : null}
            </Checkbox>
          );
        })}
      </Checkbox.Group>
    </div>
  );
}
