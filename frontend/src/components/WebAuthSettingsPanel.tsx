import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Input, Spin, message } from 'antd';
import { useI18n } from '../i18n/provider';
import WebAuthUsersPanel, { type WebAuthUserSummary } from './WebAuthUsersPanel';
import WebAuthTOTPPanel from './WebAuthTOTPPanel';

type WebAuthSettingsSummary = {
  configured: boolean;
  totpEnabled: boolean;
  recoveryCodesRemaining: number;
  sessionIdleMinutes: number;
  sessionAbsoluteHours: number;
  sessionRememberDays: number;
  updatedAt?: string;
  passwordManagedByEnvironment: boolean;
  currentPasswordManaged?: boolean;
  currentTotpEnabled?: boolean;
  currentUser?: string;
  currentRole?: string;
  users?: WebAuthUserSummary[];
};

type WebAuthSettingsPanelProps = {
  darkMode: boolean;
  dividerColor: string;
  mutedColor: string;
  titleColor: string;
};

type PasswordFormState = {
  currentPassword: string;
  newPassword: string;
  confirmPassword: string;
  code: string;
};

const createEmptyPasswordFormState = (): PasswordFormState => ({
  currentPassword: '',
  newPassword: '',
  confirmPassword: '',
  code: '',
});

const sectionStyle = (dividerColor: string): React.CSSProperties => ({
  display: 'grid',
  gap: 16,
  padding: '4px 0 18px',
  borderBottom: `1px solid ${dividerColor}`,
});

const sectionTitleStyle = (titleColor: string): React.CSSProperties => ({
  fontSize: 'var(--gn-settings-font-body, var(--gn-font-size, 14px))',
  fontWeight: 700,
  color: titleColor,
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

function redirectToWebAuth(status: number) {
  if (status === 412) {
    window.location.assign('/setup');
    return;
  }
  if (status === 401) {
    window.location.assign('/login');
  }
}

const WebAuthSettingsPanel: React.FC<WebAuthSettingsPanelProps> = ({
  darkMode,
  dividerColor,
  mutedColor,
  titleColor,
}) => {
  const { language, t } = useI18n();
  const [summary, setSummary] = useState<WebAuthSettingsSummary | null>(null);
  const [loadError, setLoadError] = useState('');
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [passwordForm, setPasswordForm] = useState<PasswordFormState>(() => createEmptyPasswordFormState());
  const passwordManagedByEnvironment = summary?.currentPasswordManaged === true;

  const summaryItems = useMemo(() => {
    if (!summary) {
      return [];
    }
    return [
      {
        key: 'status',
        label: t('app.settings.web_auth.status.auth_required'),
        value: summary.configured
          ? t('app.settings.web_auth.state.enabled')
          : t('app.settings.web_auth.state.disabled'),
      },
      {
        key: 'totp',
        label: t('app.settings.web_auth.status.two_factor'),
        value: summary.totpEnabled
          ? t('app.settings.web_auth.state.enabled')
          : t('app.settings.web_auth.state.disabled'),
      },
      {
        key: 'recovery',
        label: t('app.settings.web_auth.status.recovery_codes'),
        value: t('app.settings.web_auth.value.recovery_codes', { count: summary.recoveryCodesRemaining }),
      },
      {
        key: 'idle',
        label: t('app.settings.web_auth.status.idle_timeout'),
        value: t('app.settings.web_auth.value.minutes', { count: summary.sessionIdleMinutes }),
      },
      {
        key: 'absolute',
        label: t('app.settings.web_auth.status.absolute_timeout'),
        value: t('app.settings.web_auth.value.hours', { count: summary.sessionAbsoluteHours }),
      },
      {
        key: 'remember',
        label: t('app.settings.web_auth.status.remember_days'),
        value: t('app.settings.web_auth.value.days', { count: summary.sessionRememberDays }),
      },
      {
        key: 'updatedAt',
        label: t('app.settings.web_auth.status.updated_at'),
        value: summary.updatedAt
          ? new Intl.DateTimeFormat(language, {
              year: 'numeric',
              month: '2-digit',
              day: '2-digit',
              hour: '2-digit',
              minute: '2-digit',
              second: '2-digit',
              hour12: false,
            }).format(new Date(summary.updatedAt))
          : t('common.unknown'),
      },
    ];
  }, [language, summary, t]);

  const loadSettings = useCallback(async () => {
    setLoading(true);
    setLoadError('');
    try {
      const response = await fetch('/__gonavi/auth/settings', {
        method: 'GET',
        credentials: 'same-origin',
      });
      if (!response.ok) {
        redirectToWebAuth(response.status);
        throw new Error(await readErrorMessage(response, t('app.settings.web_auth.load_failed')));
      }
      const payload = await response.json() as WebAuthSettingsSummary;
      setSummary(payload);
    } catch (error) {
      setLoadError(String(error instanceof Error ? error.message : error || t('app.settings.web_auth.load_failed')));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  const updatePasswordField = useCallback((key: keyof PasswordFormState, value: string) => {
    setPasswordForm((current) => ({ ...current, [key]: value }));
  }, []);

  const handleSubmit = useCallback(async () => {
    setSubmitting(true);
    try {
      const response = await fetch('/__gonavi/auth/settings/password', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(passwordForm),
      });
      if (!response.ok) {
        redirectToWebAuth(response.status);
        throw new Error(await readErrorMessage(response, t('app.settings.web_auth.password.save_failed')));
      }
      const payload = await response.json() as {
        success?: boolean;
        settings?: WebAuthSettingsSummary;
      };
      if (payload.settings) {
        setSummary(payload.settings);
      } else {
        await loadSettings();
      }
      setPasswordForm(createEmptyPasswordFormState());
      void message.success(t('app.settings.web_auth.password.save_success'));
    } catch (error) {
      void message.error(String(error instanceof Error ? error.message : error || t('app.settings.web_auth.password.save_failed')));
    } finally {
      setSubmitting(false);
    }
  }, [loadSettings, passwordForm, t]);

  return (
    <div style={{ display: 'grid', gap: 20, padding: '12px 0' }}>
      <section style={sectionStyle(dividerColor)}>
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <Button onClick={() => { void loadSettings(); }} loading={loading}>
            {t('common.refresh')}
          </Button>
        </div>
        {loadError ? (
          <div style={{ color: darkMode ? '#fda4af' : '#b42318', fontSize: 'var(--gn-settings-font-secondary, var(--gn-font-size-sm, 12px))' }}>{loadError}</div>
        ) : null}
        {loading && !summary ? (
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 10, color: mutedColor, fontSize: 'var(--gn-settings-font-secondary, var(--gn-font-size-sm, 12px))' }}>
            <Spin size="small" />
            <span>{t('common.loading')}</span>
          </div>
        ) : null}
        {summary ? (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
              gap: 14,
            }}
          >
            {summaryItems.map((item) => (
              <div key={item.key} style={{ minWidth: 0 }}>
                <div style={{ marginBottom: 6, color: mutedColor, fontSize: 'var(--gn-settings-font-caption, var(--gn-font-size-xs, 11px))' }}>{item.label}</div>
                <div style={{ color: titleColor, fontSize: 'var(--gn-settings-font-body, var(--gn-font-size, 14px))', fontWeight: 600, lineHeight: 1.5 }}>{item.value}</div>
              </div>
            ))}
          </div>
        ) : null}
      </section>

      <section style={sectionStyle(dividerColor)}>
        <div style={{ display: 'grid', gap: 4 }}>
          <div style={sectionTitleStyle(titleColor)}>{t('app.settings.web_auth.password.title')}</div>
          <div style={{ color: mutedColor, fontSize: 'var(--gn-settings-font-secondary, var(--gn-font-size-sm, 12px))', lineHeight: 1.6 }}>
            {passwordManagedByEnvironment
              ? t('app.settings.web_auth.password.managed_by_environment')
              : summary?.totpEnabled
                ? t('app.settings.web_auth.password.description_with_code')
                : t('app.settings.web_auth.password.description')}
          </div>
        </div>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
            gap: 14,
          }}
        >
          <label style={{ display: 'grid', gap: 8 }}>
            <span style={{ color: mutedColor, fontSize: 'var(--gn-settings-font-caption, var(--gn-font-size-xs, 11px))' }}>{t('app.settings.web_auth.password.current_label')}</span>
            <Input.Password
              autoComplete="current-password"
              disabled={passwordManagedByEnvironment}
              value={passwordForm.currentPassword}
              placeholder={t('app.settings.web_auth.password.current_placeholder')}
              onChange={(event) => updatePasswordField('currentPassword', event.target.value)}
            />
          </label>
          {summary?.currentTotpEnabled ? (
            <label style={{ display: 'grid', gap: 8 }}>
              <span style={{ color: mutedColor, fontSize: 'var(--gn-settings-font-caption, var(--gn-font-size-xs, 11px))' }}>{t('app.settings.web_auth.password.code_label')}</span>
              <Input
                autoComplete="one-time-code"
                disabled={passwordManagedByEnvironment}
                inputMode="numeric"
                value={passwordForm.code}
                placeholder={t('app.settings.web_auth.password.code_placeholder')}
                onChange={(event) => updatePasswordField('code', event.target.value)}
              />
            </label>
          ) : null}
          <label style={{ display: 'grid', gap: 8 }}>
            <span style={{ color: mutedColor, fontSize: 'var(--gn-settings-font-caption, var(--gn-font-size-xs, 11px))' }}>{t('app.settings.web_auth.password.new_label')}</span>
            <Input.Password
              autoComplete="new-password"
              disabled={passwordManagedByEnvironment}
              value={passwordForm.newPassword}
              placeholder={t('app.settings.web_auth.password.new_placeholder')}
              onChange={(event) => updatePasswordField('newPassword', event.target.value)}
            />
          </label>
          <label style={{ display: 'grid', gap: 8 }}>
            <span style={{ color: mutedColor, fontSize: 'var(--gn-settings-font-caption, var(--gn-font-size-xs, 11px))' }}>{t('app.settings.web_auth.password.confirm_label')}</span>
            <Input.Password
              autoComplete="new-password"
              disabled={passwordManagedByEnvironment}
              value={passwordForm.confirmPassword}
              placeholder={t('app.settings.web_auth.password.confirm_placeholder')}
              onChange={(event) => updatePasswordField('confirmPassword', event.target.value)}
            />
          </label>
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-start' }}>
          <Button
            type="primary"
            loading={submitting}
            disabled={passwordManagedByEnvironment}
            onClick={() => { void handleSubmit(); }}
          >
            {t('app.settings.web_auth.password.submit')}
          </Button>
        </div>
      </section>

      {summary ? (
        <WebAuthTOTPPanel
          dividerColor={dividerColor}
          mutedColor={mutedColor}
          titleColor={titleColor}
          enabled={summary.currentTotpEnabled === true}
          onChanged={loadSettings}
        />
      ) : null}

      {summary?.currentRole === 'admin' ? (
        <WebAuthUsersPanel
          darkMode={darkMode}
          dividerColor={dividerColor}
          mutedColor={mutedColor}
          titleColor={titleColor}
          users={summary.users || []}
          currentUser={summary.currentUser}
          onUsersChanged={(users) => {
            setSummary((current) => (current ? { ...current, users } : current));
          }}
        />
      ) : null}
    </div>
  );
};

export default WebAuthSettingsPanel;
