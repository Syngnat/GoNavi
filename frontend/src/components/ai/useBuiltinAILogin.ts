import { useCallback, useEffect, useRef, useState } from 'react';

import type { ai } from '../../../wailsjs/go/models';
import {
  notifyAIProviderChanged,
  runBuiltinAILogin,
  type BuiltinAILoginPending,
  type BuiltinAILoginService,
} from './builtinAILogin';
import { requestBuiltinAITerms } from './builtinTerms/builtinAITermsStore';

interface BuiltinAILoginNotifier {
  success: (content: string) => unknown;
  error: (content: string) => unknown;
}

interface UseBuiltinAILoginOptions {
  getService: () => Promise<BuiltinAILoginService | null | undefined>;
  openURL: (url: string) => void;
  notify: BuiltinAILoginNotifier;
  translate: (key: string) => string;
  /** Receives every status the backend reports (null when it could not be read). */
  onStatus?: (status: ai.BuiltinAIStatus | null) => void;
  /** Called after the login state changed and the provider list must be re-read. */
  onChanged?: () => void | Promise<void>;
}

/**
 * Login/logout for the GoNavi-hosted AI provider, shared by the settings page
 * and any other surface. The backend owns provider persistence: after a
 * successful login it has already saved the complete provider record, so this
 * hook only refreshes state and announces the change.
 */
export const useBuiltinAILogin = ({ getService, openURL, notify, translate, onStatus, onChanged }: UseBuiltinAILoginOptions) => {
  const [loading, setLoading] = useState(false);
  // While the browser step is open: the code to compare with the page, and the page itself.
  const [pending, setPending] = useState<BuiltinAILoginPending | null>(null);
  const cancelledRef = useRef(false);
  const loadingRef = useRef(false);

  useEffect(() => {
    cancelledRef.current = false;
    return () => {
      cancelledRef.current = true;
    };
  }, []);

  const refreshStatus = useCallback(async (): Promise<ai.BuiltinAIStatus | null> => {
    try {
      const service = await getService();
      if (typeof service?.AIGetBuiltinAIStatus !== 'function') return null;
      const next = await service.AIGetBuiltinAIStatus();
      if (!cancelledRef.current) onStatus?.(next);
      return next;
    } catch {
      if (!cancelledRef.current) onStatus?.(null);
      return null;
    }
  }, [getService, onStatus]);

  const announceChange = useCallback(async () => {
    await onChanged?.();
    notifyAIProviderChanged();
  }, [onChanged]);

  const login = useCallback(async () => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    try {
      const service = await getService();
      if (!service) {
        notify.error(translate('ai_settings.provider_preset.gonavi_ai.login_unavailable'));
        return;
      }
      const outcome = await runBuiltinAILogin(service, {
        openURL,
        isCancelled: () => cancelledRef.current,
        requireTerms: () => requestBuiltinAITerms(),
        onPending: (next) => { if (!cancelledRef.current) setPending(next); },
      });
      switch (outcome.kind) {
        case 'ready':
          onStatus?.(outcome.status);
          notify.success(translate('ai_settings.provider_preset.gonavi_ai.login_success'));
          await announceChange();
          break;
        case 'authorized':
          await refreshStatus();
          notify.success(translate('ai_settings.provider_preset.gonavi_ai.login_success'));
          await announceChange();
          break;
        case 'retry':
          // Signed in, but the Gateway could not be verified: show why, keep the login.
          onStatus?.(outcome.status);
          notify.error(outcome.status.message || translate('ai_settings.provider_preset.gonavi_ai.login_failed'));
          break;
        case 'timeout':
          notify.error(translate('ai_settings.provider_preset.gonavi_ai.login_timeout'));
          break;
        case 'unavailable':
          notify.error(translate('ai_settings.provider_preset.gonavi_ai.login_unavailable'));
          break;
        case 'failed':
          notify.error(outcome.message || translate('ai_settings.provider_preset.gonavi_ai.login_failed'));
          break;
        default:
          break;
      }
    } catch (error) {
      notify.error(String((error as { message?: string } | null)?.message || error));
    } finally {
      loadingRef.current = false;
      if (!cancelledRef.current) {
        setLoading(false);
        setPending(null);
      }
    }
  }, [announceChange, getService, notify, openURL, refreshStatus, translate]);

  const logout = useCallback(async () => {
    try {
      const service = await getService();
      if (typeof service?.AILogoutBuiltinAI !== 'function') {
        notify.error(translate('ai_settings.provider_preset.gonavi_ai.login_unavailable'));
        return;
      }
      await service.AILogoutBuiltinAI();
      await refreshStatus();
      notify.success(translate('ai_settings.provider_preset.gonavi_ai.sign_out_success'));
      await announceChange();
    } catch (error) {
      notify.error(String((error as { message?: string } | null)?.message || error));
    }
  }, [announceChange, getService, notify, refreshStatus, translate]);

  return { loading, pending, login, logout, refreshStatus };
};
