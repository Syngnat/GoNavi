import React, { useCallback, useEffect, useState } from 'react';
import { Button, message } from 'antd';

import type { ai } from '../../../wailsjs/go/models';
import { waitForAIService } from './aiSettingsModalConfig';
import {
  AI_PROVIDER_CHANGED_EVENT,
  builtinAIStatusMessageKey,
  openBuiltinAIVerificationURL,
  type BuiltinAILoginService,
} from './builtinAILogin';
import { useBuiltinAILogin } from './useBuiltinAILogin';
import BuiltinAITermsModal from './builtinTerms/BuiltinAITermsModal';

interface BuiltinAICardProps {
  copy: (key: string, params?: Record<string, string | number>) => string;
  /** Called after the sign-in state changed so the provider list can be re-read. */
  onChanged?: () => void | Promise<void>;
}

const getService = async (): Promise<BuiltinAILoginService | null> =>
  (await waitForAIService() as BuiltinAILoginService | undefined) ?? null;

/**
 * The GoNavi AI provider has nothing to configure: its card shows who is signed
 * in, the live state of the service, and the quota, with sign-in / retry / sign-out.
 */
export const BuiltinAICard: React.FC<BuiltinAICardProps> = ({ copy, onChanged }) => {
  const [status, setStatus] = useState<ai.BuiltinAIStatus | null>(null);
  const { loading, pending, login, logout, refreshStatus } = useBuiltinAILogin({
    getService,
    openURL: openBuiltinAIVerificationURL,
    notify: message,
    translate: copy,
    onStatus: setStatus,
    onChanged,
  });

  useEffect(() => { void refreshStatus(); }, [refreshStatus]);
  // A sign-in completed elsewhere (the chat composer) changes what this card shows.
  const refresh = useCallback(() => { void refreshStatus(); }, [refreshStatus]);
  useEffect(() => {
    window.addEventListener(AI_PROVIDER_CHANGED_EVENT, refresh);
    return () => window.removeEventListener(AI_PROVIDER_CHANGED_EVENT, refresh);
  }, [refresh]);

  const showDetail = Boolean(status?.message) && status?.state !== 'ready' && status?.state !== 'login_required';
  const primaryLabel = !status?.authenticated
    ? 'ai_settings.provider_preset.gonavi_ai.sign_in'
    : status.state === 'ready'
      ? 'ai_settings.provider_preset.gonavi_ai.refresh_login'
      : 'ai_settings.provider_preset.gonavi_ai.retry';

  return (
    <div className="gonavi-ai-provider-builtin-card" role="status">
      <BuiltinAITermsModal />
      <strong>{copy('ai_settings.provider_preset.gonavi_ai.label')}</strong>
      <span>{copy(builtinAIStatusMessageKey(status))}</span>
      {showDetail && <small className="gonavi-ai-provider-builtin-detail">{status?.message}</small>}
      {pending && (
        <small className="gonavi-ai-provider-builtin-pending" data-pending-code={pending.userCode}>
          {copy('ai_settings.provider_preset.gonavi_ai.waiting_browser', { code: pending.userCode })}
          {pending.verificationURL && (
            <Button type="link" size="small" onClick={() => openBuiltinAIVerificationURL(pending.verificationURL)}>
              {copy('ai_settings.provider_preset.gonavi_ai.reopen_browser')}
            </Button>
          )}
        </small>
      )}
      {status?.quota && <small>{copy('ai_settings.provider_preset.gonavi_ai.quota', {
        dailyUsed: status.quota.dailyTokensUsed,
        dailyLimit: status.quota.dailyTokenLimit,
        rollingUsed: status.quota.rolling5hTokensUsed,
        rollingLimit: status.quota.rolling5hTokenLimit,
      })}</small>}
      <div className="gonavi-ai-provider-builtin-actions">
        <Button size="middle" type="primary" onClick={() => void login()} loading={loading}>{copy(primaryLabel)}</Button>
        {status?.authenticated && <Button size="middle" onClick={() => void logout()}>
          {copy('ai_settings.provider_preset.gonavi_ai.sign_out')}
        </Button>}
      </div>
    </div>
  );
};

export default BuiltinAICard;
