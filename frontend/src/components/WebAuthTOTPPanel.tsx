import React, { useCallback, useState } from 'react';
import { Button, Input, Tag, message } from 'antd';
import { useI18n } from '../i18n/provider';

type WebAuthTOTPPanelProps = {
  dividerColor: string;
  mutedColor: string;
  titleColor: string;
  enabled: boolean;
  onChanged: () => Promise<void> | void;
};

type TOTPSetupPayload = {
  setupToken: string;
  secret: string;
  otpauthUrl: string;
  qrCodeDataUrl?: string;
  recoveryCodes?: string[];
};

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

const WebAuthTOTPPanel: React.FC<WebAuthTOTPPanelProps> = ({
  dividerColor,
  mutedColor,
  titleColor,
  enabled,
  onChanged,
}) => {
  const { t } = useI18n();
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [setup, setSetup] = useState<TOTPSetupPayload | null>(null);
  const [disablePassword, setDisablePassword] = useState('');
  const [disableCode, setDisableCode] = useState('');
  const [busy, setBusy] = useState('');

  const beginSetup = useCallback(async () => {
    setBusy('begin');
    try {
      const response = await fetch('/__gonavi/auth/settings/totp/begin', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      if (!response.ok) {
        throw new Error(await readErrorMessage(response, t('app.settings.web_auth.totp.save_failed')));
      }
      const payload = await response.json() as TOTPSetupPayload;
      setSetup(payload);
      setPassword('');
      setCode('');
    } catch (error) {
      void message.error(String(error instanceof Error ? error.message : error || t('app.settings.web_auth.totp.save_failed')));
    } finally {
      setBusy('');
    }
  }, [password, t]);

  const confirmEnable = useCallback(async () => {
    if (!setup) return;
    setBusy('enable');
    try {
      const response = await fetch('/__gonavi/auth/settings/totp/enable', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ setupToken: setup.setupToken, code }),
      });
      if (!response.ok) {
        throw new Error(await readErrorMessage(response, t('app.settings.web_auth.totp.save_failed')));
      }
      setSetup(null);
      setCode('');
      void message.success(t('app.settings.web_auth.totp.enabled_success'));
      await onChanged();
    } catch (error) {
      void message.error(String(error instanceof Error ? error.message : error || t('app.settings.web_auth.totp.save_failed')));
    } finally {
      setBusy('');
    }
  }, [code, onChanged, setup, t]);

  const disable = useCallback(async () => {
    setBusy('disable');
    try {
      const response = await fetch('/__gonavi/auth/settings/totp/disable', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: disablePassword, code: disableCode }),
      });
      if (!response.ok) {
        throw new Error(await readErrorMessage(response, t('app.settings.web_auth.totp.save_failed')));
      }
      setDisablePassword('');
      setDisableCode('');
      void message.success(t('app.settings.web_auth.totp.disabled_success'));
      await onChanged();
    } catch (error) {
      void message.error(String(error instanceof Error ? error.message : error || t('app.settings.web_auth.totp.save_failed')));
    } finally {
      setBusy('');
    }
  }, [disableCode, disablePassword, onChanged, t]);

  return (
    <section style={{ display: 'grid', gap: 14, padding: '4px 0 18px', borderBottom: `1px solid ${dividerColor}` }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <div style={{ fontSize: 'var(--gn-settings-font-body, var(--gn-font-size, 14px))', fontWeight: 700, color: titleColor }}>
          {t('app.settings.web_auth.totp.title')}
        </div>
        <Tag color={enabled ? 'green' : undefined}>
          {enabled ? t('app.settings.web_auth.totp.enabled') : t('app.settings.web_auth.totp.disabled')}
        </Tag>
      </div>
      <div style={{ color: mutedColor, fontSize: 'var(--gn-settings-font-secondary, var(--gn-font-size-sm, 12px))', lineHeight: 1.6 }}>
        {t('app.settings.web_auth.totp.description')}
      </div>

      {!enabled && !setup ? (
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <Input.Password
            value={password}
            autoComplete="current-password"
            placeholder={t('app.settings.web_auth.totp.password_placeholder')}
            style={{ minWidth: 220 }}
            onChange={(event) => setPassword(event.target.value)}
          />
          <Button type="primary" loading={busy === 'begin'} disabled={!password} onClick={() => { void beginSetup(); }}>
            {t('app.settings.web_auth.totp.enable')}
          </Button>
        </div>
      ) : null}

      {setup ? (
        <div style={{ display: 'grid', gap: 12 }}>
          <div style={{ color: mutedColor, fontSize: 'var(--gn-settings-font-secondary, var(--gn-font-size-sm, 12px))' }}>
            {t('app.settings.web_auth.totp.scan_hint')}
          </div>
          {setup.qrCodeDataUrl ? (
            <img
              src={setup.qrCodeDataUrl}
              alt={t('app.settings.web_auth.totp.qr_alt')}
              style={{ width: 180, height: 180, background: '#fff', padding: 6, borderRadius: 8 }}
            />
          ) : null}
          <div style={{ display: 'grid', gap: 4 }}>
            <span style={{ color: mutedColor, fontSize: 'var(--gn-settings-font-caption, var(--gn-font-size-xs, 11px))' }}>
              {t('app.settings.web_auth.totp.secret_label')}
            </span>
            <code style={{ color: titleColor, wordBreak: 'break-all' }}>{setup.secret}</code>
          </div>
          <div style={{ display: 'grid', gap: 4 }}>
            <span style={{ color: mutedColor, fontSize: 'var(--gn-settings-font-caption, var(--gn-font-size-xs, 11px))' }}>
              {t('app.settings.web_auth.totp.recovery_title')}
            </span>
            <div style={{ color: titleColor, fontFamily: 'monospace', display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {(setup.recoveryCodes || []).map((item) => <span key={item}>{item}</span>)}
            </div>
            <span style={{ color: mutedColor, fontSize: 'var(--gn-settings-font-caption, var(--gn-font-size-xs, 11px))' }}>
              {t('app.settings.web_auth.totp.recovery_hint')}
            </span>
          </div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            <Input
              value={code}
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder={t('app.settings.web_auth.totp.code_placeholder')}
              style={{ minWidth: 180 }}
              onChange={(event) => setCode(event.target.value)}
            />
            <Button type="primary" loading={busy === 'enable'} disabled={!code} onClick={() => { void confirmEnable(); }}>
              {t('app.settings.web_auth.totp.confirm')}
            </Button>
            <Button onClick={() => setSetup(null)}>{t('common.cancel')}</Button>
          </div>
        </div>
      ) : null}

      {enabled ? (
        <div style={{ display: 'grid', gap: 10 }}>
          <div style={{ color: mutedColor, fontSize: 'var(--gn-settings-font-secondary, var(--gn-font-size-sm, 12px))' }}>
            {t('app.settings.web_auth.totp.disable_hint')}
          </div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            <Input.Password
              value={disablePassword}
              autoComplete="current-password"
              placeholder={t('app.settings.web_auth.totp.password_placeholder')}
              style={{ minWidth: 200 }}
              onChange={(event) => setDisablePassword(event.target.value)}
            />
            <Input
              value={disableCode}
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder={t('app.settings.web_auth.totp.code_placeholder')}
              style={{ minWidth: 160 }}
              onChange={(event) => setDisableCode(event.target.value)}
            />
            <Button danger loading={busy === 'disable'} disabled={!disablePassword || !disableCode} onClick={() => { void disable(); }}>
              {t('app.settings.web_auth.totp.disable')}
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  );
};

export default WebAuthTOTPPanel;
