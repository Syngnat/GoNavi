import { useCallback, useMemo, useState } from 'react';
import type { SavedConnection } from '../../types';
import { buildRpcConnectionConfig } from '../../utils/connectionRpcConfig';
import { buildDropRequest } from './userManagementDraft';
import { normalizePlan } from './userManagementModel';
import {
  requireUserManagementMethod,
  resolveUserManagementErrorMessage,
  unwrapUserManagementResult,
  type UserManagementBackend,
} from './userManagementRpc';
import { collectApplyRiskReasons, detectSelfImpact, isSelfPrincipal } from './userManagementRisk';
import type { PrincipalKind, PrincipalRef, UMDropOptions, UMPrincipal } from './userManagementTypes';
import { usePrincipalDraft } from './usePrincipalDraft';
import { confirmUserManagementRisk, useUserManagementApply, type UserManagementApplyOutcome } from './useUserManagementApply';
import { usePrincipalDetail, useUserManagementOverview } from './useUserManagementData';
import { useUserManagementPreview } from './useUserManagementPreview';

type Translate = (key: string, params?: Record<string, string | number>) => string;

export interface UserManagementSelection {
  ref: PrincipalRef | null;
  creating: PrincipalKind | null;
}

/** 工作台编排：选择、按库作用域、草稿、预览、执行与删除。组件只负责渲染。 */
export const useUserManagementConsole = (
  connection: SavedConnection,
  backend: UserManagementBackend,
  t: Translate,
) => {
  const config = useMemo(() => buildRpcConnectionConfig(connection.config), [connection.config]);
  const [database, setDatabase] = useState(String(connection.config?.database || ''));
  const [selection, setSelection] = useState<UserManagementSelection>({ ref: null, creating: null });
  const [outcome, setOutcome] = useState<UserManagementApplyOutcome | null>(null);
  const [passwordSyncValue, setPasswordSyncValue] = useState('');

  const overviewState = useUserManagementOverview(backend, config, database, t);
  const profile = overviewState.overview?.profile ?? null;
  const principals = useMemo(() => overviewState.overview?.principals ?? [], [overviewState.overview]);
  const detailState = usePrincipalDetail(backend, config, selection.ref, database, t);
  const draftState = usePrincipalDraft(profile, detailState.detail, selection.creating, database);
  const writable = Boolean(profile?.supported && !profile.readOnly && !detailState.detail?.principal.readOnly);
  // 名称为空时（新建尚未填写）不请求预览，避免必然失败的后端往返。
  const previewEnabled = writable && draftState.changeCount > 0 && Boolean(draftState.draft?.name.trim());
  const preview = useUserManagementPreview(backend, config, draftState.previewRequest, previewEnabled, t);
  const { apply, applying } = useUserManagementApply(backend, config, t);

  const selectedPrincipal: UMPrincipal | null = useMemo(() => {
    if (!selection.ref) return null;
    const key = JSON.stringify(selection.ref);
    return principals.find((item) => JSON.stringify(item.ref) === key) ?? detailState.detail?.principal ?? null;
  }, [detailState.detail, principals, selection.ref]);

  const select = useCallback((ref: PrincipalRef) => {
    setOutcome(null);
    setSelection({ ref, creating: null });
  }, []);

  const startCreate = useCallback((kind: PrincipalKind) => {
    setOutcome(null);
    setSelection({ ref: null, creating: kind });
  }, []);

  const refreshAll = useCallback(() => {
    overviewState.reload();
    detailState.reload();
  }, [detailState, overviewState]);

  const riskReasonsFor = useCallback((request: ReturnType<typeof draftState.buildApplyRequest>, plan = preview.plan) => {
    const targetName = request?.target.name || '';
    const selfImpact = detectSelfImpact(request, isSelfPrincipal(selectedPrincipal, connection, targetName));
    return collectApplyRiskReasons({ connection, plan, selfImpact, request });
  }, [connection, draftState, preview.plan, selectedPrincipal]);

  /** 执行当前草稿；返回是否已执行（取消确认返回 false）。 */
  const applyDraft = useCallback(async (): Promise<boolean> => {
    const request = draftState.buildApplyRequest();
    if (!request || !preview.plan) return false;
    const approved = await confirmUserManagementRisk(riskReasonsFor(request), connection, t);
    if (!approved) return false;
    const result = await apply(request, preview.plan.fingerprint);
    setOutcome(result);
    if (!result.success) return true;
    const self = isSelfPrincipal(selectedPrincipal, connection, request.target.name);
    if (request.password?.set && request.password.password && self) setPasswordSyncValue(request.password.password);
    const nextRef = request.rename ?? request.target;
    overviewState.reload();
    setSelection({ ref: nextRef, creating: null });
    detailState.reload();
    return true;
  }, [apply, connection, detailState, draftState, overviewState, preview.plan, riskReasonsFor, selectedPrincipal, t]);

  /** 删除主体：先向后端预览拿指纹，再走风险确认与执行。 */
  const dropPrincipal = useCallback(async (ref: PrincipalRef, dropOptions: UMDropOptions): Promise<UserManagementApplyOutcome | null> => {
    const request = buildDropRequest(ref, dropOptions);
    try {
      const previewCall = requireUserManagementMethod(backend, 'UserMgmtPreview');
      const plan = normalizePlan(unwrapUserManagementResult(await previewCall(config, request)));
      const approved = await confirmUserManagementRisk(riskReasonsFor(request, plan), connection, t);
      if (!approved) return null;
      const result = await apply(request, plan.fingerprint);
      if (result.success) {
        setSelection({ ref: null, creating: null });
        overviewState.reload();
      }
      return result;
    } catch (err) {
      return { success: false, message: resolveUserManagementErrorMessage(err, t('user_management.error.apply_failed')), report: null };
    }
  }, [apply, backend, config, connection, overviewState, riskReasonsFor, t]);

  return {
    config,
    database,
    setDatabase,
    selection,
    select,
    startCreate,
    refreshAll,
    overviewState,
    profile,
    principals,
    detailState,
    draftState,
    writable,
    preview,
    applying,
    applyDraft,
    dropPrincipal,
    outcome,
    clearOutcome: () => setOutcome(null),
    selectedPrincipal,
    passwordSyncValue,
    clearPasswordSync: () => setPasswordSyncValue(''),
  };
};

export type UserManagementConsoleState = ReturnType<typeof useUserManagementConsole>;
