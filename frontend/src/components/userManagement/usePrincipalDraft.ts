import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  buildChangeRequest,
  buildDraftFromDetail,
  buildNewDraft,
  countChanges,
  emptyPasswordDraft,
  type PasswordDraft,
  type PrincipalDraft,
} from './userManagementDraft';
import type {
  PrincipalKind,
  UMGrant,
  UMMembership,
  UMPrincipalDetail,
  UMServerProfile,
} from './userManagementTypes';

export type PrincipalDraftController = ReturnType<typeof usePrincipalDraft>;

/**
 * 编辑器草稿状态。口令只存在于此组件级 state，从不进入全局 store；
 * 切换主体、应用成功或卸载时都会被清空。
 */
export const usePrincipalDraft = (
  profile: UMServerProfile | null,
  detail: UMPrincipalDetail | null,
  creatingKind: PrincipalKind | null,
  database: string,
) => {
  const original = useMemo<PrincipalDraft | null>(() => (detail ? buildDraftFromDetail(detail) : null), [detail]);
  const [draft, setDraft] = useState<PrincipalDraft | null>(null);

  useEffect(() => {
    if (creatingKind && profile) {
      setDraft(buildNewDraft(profile, creatingKind, database));
      return;
    }
    setDraft(original ? { ...original, password: emptyPasswordDraft() } : null);
  }, [creatingKind, database, original, profile]);

  useEffect(() => () => setDraft(null), []);

  const update = useCallback((patch: Partial<PrincipalDraft>) => {
    setDraft((current) => (current ? { ...current, ...patch } : current));
  }, []);

  const setOption = useCallback((id: string, value: string) => {
    setDraft((current) => (current ? { ...current, options: { ...current.options, [id]: value } } : current));
  }, []);

  const setPassword = useCallback((patch: Partial<PasswordDraft>) => {
    setDraft((current) => (current ? { ...current, password: { ...current.password, ...patch } } : current));
  }, []);

  const setGrants = useCallback((grants: UMGrant[]) => update({ grants }), [update]);
  const setMemberOf = useCallback((memberOf: UMMembership[]) => update({ memberOf }), [update]);

  const reset = useCallback(() => {
    if (creatingKind && profile) setDraft(buildNewDraft(profile, creatingKind, database));
    else setDraft(original ? { ...original, password: emptyPasswordDraft() } : null);
  }, [creatingKind, database, original, profile]);

  // 预览请求不带口令明文。
  const previewRequest = useMemo(
    () => (draft ? buildChangeRequest(original, draft, { includeSecrets: false, database }) : null),
    [database, draft, original],
  );

  const buildApplyRequest = useCallback(
    () => (draft ? buildChangeRequest(original, draft, { includeSecrets: true, database }) : null),
    [database, draft, original],
  );

  return {
    original,
    draft,
    update,
    setOption,
    setPassword,
    setGrants,
    setMemberOf,
    reset,
    previewRequest,
    buildApplyRequest,
    changeCount: countChanges(previewRequest),
  };
};
