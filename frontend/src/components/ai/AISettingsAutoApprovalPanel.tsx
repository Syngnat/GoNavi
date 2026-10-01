import React from 'react';
import { Alert, Button, Switch } from 'antd';

import { t as catalogTranslate } from '../../i18n/catalog';
import { useOptionalI18n } from '../../i18n/provider';
import type { I18nParams } from '../../i18n/types';
import type { OverlayWorkbenchTheme } from '../../utils/overlayWorkbenchTheme';
import { useAIAutoApprovalSettings } from './useAIAutoApprovalSettings';

interface AISettingsAutoApprovalPanelProps {
  overlayTheme: OverlayWorkbenchTheme;
  cardBorder: string;
}

/**
 * "Always approve" for tool calls that change data or external state. The
 * global switch mirrors the "Always approve everywhere" entry on the approval
 * card; per-session grants are made there and can be revoked here.
 */
const AISettingsAutoApprovalPanel: React.FC<AISettingsAutoApprovalPanelProps> = ({ overlayTheme, cardBorder }) => {
  const i18n = useOptionalI18n();
  const copy = (key: string, params?: I18nParams) => (
    i18n?.t ?? ((catalogKey, catalogParams) => catalogTranslate('en-US', catalogKey, catalogParams))
  )(key, params);
  const { settings, loading, busy, failed, setGlobal, clearSessions } = useAIAutoApprovalSettings();

  // Nothing to configure when the Go service is unreachable (plain browser preview).
  if (!loading && !settings && !failed) return null;

  const sessionCount = settings?.sessionIds.length ?? 0;
  return (
    <div data-testid="ai-auto-approval-panel" style={{ borderTop: `1px solid ${cardBorder}`, marginTop: 20, paddingTop: 18 }}>
      <div style={{ fontSize: 'var(--gn-font-size-sm, 12px)', fontWeight: 600, color: overlayTheme.titleText }}>
        {copy('ai_settings.safety.auto_approve.title')}
      </div>
      <div style={{ fontSize: 'var(--gn-font-size-xs, 11px)', lineHeight: '17px', color: overlayTheme.mutedText, marginTop: 4, marginBottom: 12 }}>
        {copy('ai_settings.safety.auto_approve.description')}
      </div>
      {failed && (
        <Alert type="error" showIcon message={copy('ai_settings.safety.auto_approve.save_failed')} style={{ marginBottom: 12 }} />
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Switch
          checked={settings?.global === true}
          disabled={loading || busy || !settings}
          onChange={(enabled) => { void setGlobal(enabled); }}
        />
        <span style={{ fontSize: 'var(--gn-font-size-sm, 12px)', color: overlayTheme.titleText }}>
          {copy('ai_settings.safety.auto_approve.global.label')}
        </span>
      </div>
      <div style={{ fontSize: 'var(--gn-font-size-xs, 11px)', lineHeight: '17px', color: overlayTheme.mutedText, marginTop: 4 }}>
        {copy('ai_settings.safety.auto_approve.global.desc')}
      </div>
      {settings?.global === true && (
        <Alert type="warning" showIcon message={copy('ai_settings.safety.auto_approve.global.warning')} style={{ marginTop: 10 }} />
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12, fontSize: 'var(--gn-font-size-xs, 11px)', color: overlayTheme.mutedText }}>
        <span>
          {sessionCount > 0
            ? copy('ai_settings.safety.auto_approve.sessions.count', { count: sessionCount })
            : copy('ai_settings.safety.auto_approve.sessions.none')}
        </span>
        {sessionCount > 0 && (
          <Button type="link" size="small" disabled={busy} onClick={() => { void clearSessions(); }} style={{ padding: 0 }}>
            {copy('ai_settings.safety.auto_approve.sessions.clear')}
          </Button>
        )}
      </div>
    </div>
  );
};

export default AISettingsAutoApprovalPanel;
