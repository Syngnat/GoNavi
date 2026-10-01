import { useCallback, useEffect, useRef, useState } from 'react';
import type { RpcConnectionConfig } from '../../utils/connectionRpcConfig';
import { normalizeDetail, normalizeOverview } from './userManagementModel';
import {
  requireUserManagementMethod,
  resolveUserManagementErrorMessage,
  unwrapUserManagementResult,
  type UserManagementBackend,
} from './userManagementRpc';
import type { PrincipalRef, UMOverview, UMPrincipalDetail } from './userManagementTypes';

type Translate = (key: string, params?: Record<string, string | number>) => string;

/** 加载探测结果与主体列表；请求序号守卫保证只有最后一次刷新落地。 */
export const useUserManagementOverview = (
  backend: UserManagementBackend,
  config: RpcConnectionConfig | null,
  database: string,
  t: Translate,
) => {
  const [overview, setOverview] = useState<UMOverview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const requestRef = useRef(0);

  useEffect(() => {
    if (!config) return;
    const requestId = requestRef.current + 1;
    requestRef.current = requestId;
    setLoading(true);
    setError('');
    const load = async () => {
      try {
        const call = requireUserManagementMethod(backend, 'UserMgmtOverview');
        const data = unwrapUserManagementResult(await call(config, { database: database || undefined }));
        if (requestRef.current !== requestId) return;
        setOverview(normalizeOverview(data));
      } catch (err) {
        if (requestRef.current !== requestId) return;
        setError(resolveUserManagementErrorMessage(err, t('user_management.error.load_failed')));
      } finally {
        if (requestRef.current === requestId) setLoading(false);
      }
    };
    void load();
  }, [backend, config, database, reloadKey, t]);

  const reload = useCallback(() => setReloadKey((key) => key + 1), []);
  return { overview, loading, error, reload };
};

/** 加载选中主体的详情；ref 为 null（新建或未选中）时清空。 */
export const usePrincipalDetail = (
  backend: UserManagementBackend,
  config: RpcConnectionConfig | null,
  ref: PrincipalRef | null,
  database: string,
  t: Translate,
) => {
  const [detail, setDetail] = useState<UMPrincipalDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const requestRef = useRef(0);
  const refKey = ref ? JSON.stringify(ref) : '';

  useEffect(() => {
    const requestId = requestRef.current + 1;
    requestRef.current = requestId;
    setDetail(null);
    setError('');
    if (!config || !refKey) {
      setLoading(false);
      return;
    }
    setLoading(true);
    const load = async () => {
      try {
        const call = requireUserManagementMethod(backend, 'UserMgmtDescribePrincipal');
        const data = unwrapUserManagementResult(await call(config, {
          ref: JSON.parse(refKey) as PrincipalRef,
          database: database || undefined,
        }));
        if (requestRef.current !== requestId) return;
        setDetail(normalizeDetail(data));
      } catch (err) {
        if (requestRef.current !== requestId) return;
        setError(resolveUserManagementErrorMessage(err, t('user_management.error.detail_failed')));
      } finally {
        if (requestRef.current === requestId) setLoading(false);
      }
    };
    void load();
  }, [backend, config, database, refKey, reloadKey, t]);

  const reload = useCallback(() => setReloadKey((key) => key + 1), []);
  return { detail, loading, error, reload };
};
