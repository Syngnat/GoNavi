import { useEffect, useRef, useState } from 'react';
import type { RpcConnectionConfig } from '../../utils/connectionRpcConfig';
import { normalizePlan } from './userManagementModel';
import {
  requireUserManagementMethod,
  resolveUserManagementErrorMessage,
  unwrapUserManagementResult,
  type UserManagementBackend,
} from './userManagementRpc';
import type { UMChangeRequest, UMPlan } from './userManagementTypes';

export const PREVIEW_DEBOUNCE_MS = 400;

type Translate = (key: string, params?: Record<string, string | number>) => string;

/**
 * 草稿变化后防抖请求后端生成预览。请求中不含口令明文（见 usePrincipalDraft）。
 * 预览指纹用于 Apply 时的一致性校验。
 */
export const useUserManagementPreview = (
  backend: UserManagementBackend,
  config: RpcConnectionConfig | null,
  request: UMChangeRequest | null,
  enabled: boolean,
  t: Translate,
) => {
  const [plan, setPlan] = useState<UMPlan | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const requestRef = useRef(0);
  const serialized = request ? JSON.stringify(request) : '';

  useEffect(() => {
    const requestId = requestRef.current + 1;
    requestRef.current = requestId;
    if (!enabled || !config || !serialized) {
      setPlan(null);
      setError('');
      setLoading(false);
      return undefined;
    }
    setLoading(true);
    const timer = setTimeout(() => {
      const load = async () => {
        try {
          const call = requireUserManagementMethod(backend, 'UserMgmtPreview');
          const data = unwrapUserManagementResult(await call(config, JSON.parse(serialized) as UMChangeRequest));
          if (requestRef.current !== requestId) return;
          setPlan(normalizePlan(data));
          setError('');
        } catch (err) {
          if (requestRef.current !== requestId) return;
          setPlan(null);
          setError(resolveUserManagementErrorMessage(err, t('user_management.error.preview_failed')));
        } finally {
          if (requestRef.current === requestId) setLoading(false);
        }
      };
      void load();
    }, PREVIEW_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [backend, config, enabled, serialized, t]);

  return { plan, error, loading };
};
