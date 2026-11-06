import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Checkbox, Input, Select, Tag, message } from 'antd';
import { useI18n } from '../i18n/provider';
import { GetSavedConnections } from '../../wailsjs/go/app/App';
import type { SavedConnection } from '../types';

export type WebAuthUserSummary = {
  username: string;
  role: string;
  allowedConnectionIds?: string[];
  totpEnabled: boolean;
  disabled: boolean;
  createdAt?: string;
  updatedAt?: string;
  passwordManagedByEnvironment?: boolean;
};

type WebAuthUsersPanelProps = {
  darkMode: boolean;
  dividerColor: string;
  mutedColor: string;
  titleColor: string;
  users: WebAuthUserSummary[];
  currentUser?: string;
  onUsersChanged: (users: WebAuthUserSummary[]) => void;
};

type UserDraft = {
  username: string;
  password: string;
  role: string;
  disabled: boolean;
  allowedConnectionIds: string[];
};

type RowDraft = {
  password: string;
  role: string;
  disabled: boolean;
  allowedConnectionIds: string[];
};

const emptyCreateDraft = (): UserDraft => ({
  username: '',
  password: '',
  role: 'viewer',
  disabled: false,
  allowedConnectionIds: [],
});

async function readErrorMessage(response: Response, fallback: string): Promise<string> {
  try {
    const payload = await response.json();
    if (payload && typeof payload.error === 'string' && payload.error.trim() !== '') {
      return payload.error.trim();
    }
  } catch {
    // ignore
  }
  return fallback;
}

const WebAuthUsersPanel: React.FC<WebAuthUsersPanelProps> = ({
  darkMode,
  dividerColor,
  mutedColor,
  titleColor,
  users,
  currentUser,
  onUsersChanged,
}) => {
  const { t } = useI18n();
  const [createDraft, setCreateDraft] = useState<UserDraft>(() => emptyCreateDraft());
  const [rowDrafts, setRowDrafts] = useState<Record<string, RowDraft>>({});
  const [submitting, setSubmitting] = useState('');
  const [connections, setConnections] = useState<SavedConnection[]>([]);

  useEffect(() => {
    let disposed = false;
    const loadConnections = async () => {
      try {
        const latest = await GetSavedConnections();
        if (!disposed && Array.isArray(latest)) {
          setConnections(latest as SavedConnection[]);
        }
      } catch {
        // 读取失败时只影响下拉选项，账号编辑仍可用。
      }
    };
    void loadConnections();
    return () => {
      disposed = true;
    };
  }, []);

  const roleOptions = useMemo(() => ([
    { value: 'admin', label: t('app.settings.web_auth.users.role_admin') },
    { value: 'viewer', label: t('app.settings.web_auth.users.role_viewer') },
  ]), [t]);

  const connectionOptions = useMemo(() => connections.map((connection) => ({
    value: connection.id,
    label: connection.name ? `${connection.name} (${connection.id})` : connection.id,
  })), [connections]);

  const rowDraftFor = useCallback((user: WebAuthUserSummary): RowDraft => (
    rowDrafts[user.username] || {
      password: '',
      role: user.role,
      disabled: user.disabled,
      allowedConnectionIds: user.allowedConnectionIds || [],
    }
  ), [rowDrafts]);

  const updateRowDraft = useCallback((username: string, base: RowDraft, patch: Partial<RowDraft>) => {
    setRowDrafts((current) => ({
      ...current,
      [username]: { ...base, ...current[username], ...patch },
    }));
  }, []);

  const mutate = useCallback(async (action: string, payload: Record<string, unknown>, successText: string) => {
    setSubmitting(`${action}:${String(payload.username || '')}`);
    try {
      const response = await fetch('/__gonavi/auth/settings/users', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, ...payload }),
      });
      if (!response.ok) {
        throw new Error(await readErrorMessage(response, t('app.settings.web_auth.users.save_failed')));
      }
      const result = await response.json() as { users?: WebAuthUserSummary[] };
      if (Array.isArray(result.users)) {
        onUsersChanged(result.users);
      }
      void message.success(successText);
      return true;
    } catch (error) {
      void message.error(String(error instanceof Error ? error.message : error || t('app.settings.web_auth.users.save_failed')));
      return false;
    } finally {
      setSubmitting('');
    }
  }, [onUsersChanged, t]);

  const handleCreate = useCallback(async () => {
    const created = await mutate('create', {
      ...createDraft,
      allowedConnectionIds: createDraft.allowedConnectionIds,
    }, t('app.settings.web_auth.users.create_success'));
    if (created) {
      setCreateDraft(emptyCreateDraft());
    }
  }, [createDraft, mutate, t]);

  const handleUpdate = useCallback(async (user: WebAuthUserSummary) => {
    const draft = rowDraftFor(user);
    const updated = await mutate('update', {
      username: user.username,
      password: draft.password,
      role: draft.role,
      disabled: draft.disabled,
      allowedConnectionIds: draft.allowedConnectionIds,
    }, t('app.settings.web_auth.users.update_success'));
    if (updated) {
      setRowDrafts((current) => {
        const next = { ...current };
        delete next[user.username];
        return next;
      });
    }
  }, [mutate, rowDraftFor, t]);

  const handleDelete = useCallback(async (user: WebAuthUserSummary) => {
    const confirmed = window.confirm(t('app.settings.web_auth.users.delete_confirm', { username: user.username }));
    if (!confirmed) {
      return;
    }
    await mutate('delete', { username: user.username }, t('app.settings.web_auth.users.delete_success'));
  }, [mutate, t]);

  return (
    <section style={{ display: 'grid', gap: 14, padding: '4px 0 18px', borderBottom: `1px solid ${dividerColor}` }}>
      <div style={{ fontSize: 'var(--gn-settings-font-body, var(--gn-font-size, 14px))', fontWeight: 700, color: titleColor }}>
        {t('app.settings.web_auth.users.title')}
      </div>
      <div style={{ color: mutedColor, fontSize: 'var(--gn-settings-font-secondary, var(--gn-font-size-sm, 12px))', lineHeight: 1.6 }}>
        {t('app.settings.web_auth.users.description')}
      </div>

      <div style={{ display: 'grid', gap: 10 }}>
        {users.map((user) => {
          const draft = rowDraftFor(user);
          const isCurrent = user.username === currentUser;
          return (
            <div
              key={user.username}
              style={{
                display: 'grid',
                gap: 10,
                padding: '10px 12px',
                borderRadius: 8,
                border: `1px solid ${dividerColor}`,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <strong style={{ color: titleColor }}>{user.username}</strong>
                {isCurrent ? <Tag color="blue">{t('app.settings.web_auth.users.you')}</Tag> : null}
                {user.totpEnabled ? <Tag color="green">TOTP</Tag> : null}
                {user.disabled ? <Tag>{t('app.settings.web_auth.users.disabled')}</Tag> : null}
                {user.passwordManagedByEnvironment ? (
                  <span style={{ color: mutedColor, fontSize: 'var(--gn-settings-font-caption, var(--gn-font-size-xs, 11px))' }}>
                    {t('app.settings.web_auth.users.password_managed')}
                  </span>
                ) : null}
              </div>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
                <Select
                  size="small"
                  value={draft.role}
                  options={roleOptions}
                  style={{ minWidth: 140 }}
                  onChange={(value) => updateRowDraft(user.username, draft, { role: value })}
                />
                {draft.role !== 'admin' ? (
                  <Select
                    mode="multiple"
                    size="small"
                    value={draft.allowedConnectionIds}
                    options={connectionOptions}
                    maxTagCount="responsive"
                    placeholder={t('app.settings.web_auth.users.allowed_connections_hint')}
                    style={{ minWidth: 260, flex: '1 1 260px' }}
                    onChange={(value) => updateRowDraft(user.username, draft, { allowedConnectionIds: value })}
                  />
                ) : null}
                <Input.Password
                  size="small"
                  value={draft.password}
                  placeholder={t('app.settings.web_auth.users.password_optional')}
                  style={{ minWidth: 220, flex: '1 1 220px' }}
                  onChange={(event) => updateRowDraft(user.username, draft, { password: event.target.value })}
                />
                <Checkbox
                  checked={draft.disabled}
                  disabled={isCurrent}
                  onChange={(event) => updateRowDraft(user.username, draft, { disabled: event.target.checked })}
                >
                  {t('app.settings.web_auth.users.disabled')}
                </Checkbox>
                <Button size="small" onClick={() => { void handleUpdate(user); }} loading={submitting === `update:${user.username}`}>
                  {t('app.settings.web_auth.users.save')}
                </Button>
                <Button
                  size="small"
                  danger
                  disabled={isCurrent}
                  onClick={() => { void handleDelete(user); }}
                  loading={submitting === `delete:${user.username}`}
                >
                  {t('app.settings.web_auth.users.delete')}
                </Button>
              </div>
            </div>
          );
        })}
      </div>

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', paddingTop: 4 }}>
        <Input
          size="small"
          value={createDraft.username}
          placeholder={t('app.settings.web_auth.users.username')}
          style={{ minWidth: 180 }}
          onChange={(event) => setCreateDraft((current) => ({ ...current, username: event.target.value }))}
        />
        <Input.Password
          size="small"
          value={createDraft.password}
          placeholder={t('app.settings.web_auth.users.password')}
          style={{ minWidth: 200 }}
          onChange={(event) => setCreateDraft((current) => ({ ...current, password: event.target.value }))}
        />
        <Select
          size="small"
          value={createDraft.role}
          options={roleOptions}
          style={{ minWidth: 140 }}
          onChange={(value) => setCreateDraft((current) => ({ ...current, role: value }))}
        />
        {createDraft.role !== 'admin' ? (
          <Select
            mode="multiple"
            size="small"
            value={createDraft.allowedConnectionIds}
            options={connectionOptions}
            maxTagCount="responsive"
            placeholder={t('app.settings.web_auth.users.allowed_connections_hint')}
            style={{ minWidth: 260, flex: '1 1 260px' }}
            onChange={(value) => setCreateDraft((current) => ({ ...current, allowedConnectionIds: value }))}
          />
        ) : null}
        <Checkbox
          checked={createDraft.disabled}
          onChange={(event) => setCreateDraft((current) => ({ ...current, disabled: event.target.checked }))}
        >
          {t('app.settings.web_auth.users.disabled')}
        </Checkbox>
        <Button
          size="small"
          type="primary"
          onClick={() => { void handleCreate(); }}
          loading={submitting.startsWith('create:')}
          disabled={!createDraft.username.trim() || !createDraft.password}
        >
          {t('app.settings.web_auth.users.add')}
        </Button>
      </div>
    </section>
  );
};

export default WebAuthUsersPanel;
