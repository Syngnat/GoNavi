import React, { useCallback, useState } from 'react';
import type { SavedConnection } from '../../types';
import type { RpcConnectionConfig } from '../../utils/connectionRpcConfig';
import { normalizeReport } from './userManagementModel';
import { requireUserManagementMethod, type UserManagementBackend } from './userManagementRpc';
import type { ApplyRiskReason } from './userManagementRisk';
import type { UMApplyReport, UMChangeRequest } from './userManagementTypes';

type Translate = (key: string, params?: Record<string, string | number>) => string;

export interface UserManagementApplyOutcome {
  success: boolean;
  message: string;
  report: UMApplyReport | null;
}

/** 有风险原因时弹出倒计时确认；无风险直接放行（评审弹窗已是显式确认）。 */
export const confirmUserManagementRisk = async (
  reasons: ApplyRiskReason[],
  connection: SavedConnection | null | undefined,
  t: Translate,
): Promise<boolean> => {
  if (reasons.length === 0) return true;
  const { showCountdownDangerConfirm } = await import('../common/countdownDangerConfirm');
  const target = [connection?.name, connection?.config?.host].filter(Boolean).join(' / ');
  const reasonText: Record<ApplyRiskReason, string> = {
    production: t('user_management.risk.production', { target }),
    danger: t('user_management.risk.danger'),
    self: t('user_management.risk.self'),
    reserved: t('user_management.risk.reserved'),
  };
  return new Promise((resolve) => {
    let settled = false;
    const settle = (approved: boolean) => {
      if (settled) return;
      settled = true;
      resolve(approved);
    };
    showCountdownDangerConfirm({
      title: t('user_management.risk.title'),
      content: React.createElement('ul', { className: 'gn-user-mgmt-risk-list' },
        reasons.map((reason) => React.createElement('li', { key: reason }, reasonText[reason]))),
      confirmText: t('user_management.apply.confirm'),
      onOk: () => settle(true),
      onCancel: () => settle(false),
      afterClose: () => settle(false),
    });
  });
};

/**
 * 执行变更。后端 success=false 时仍返回执行报告（部分成功需要逐条展示），
 * 因此这里不走 unwrap，而是直接读取 data。
 */
export const useUserManagementApply = (
  backend: UserManagementBackend,
  config: RpcConnectionConfig | null,
  t: Translate,
) => {
  const [applying, setApplying] = useState(false);

  const apply = useCallback(async (request: UMChangeRequest, fingerprint: string): Promise<UserManagementApplyOutcome> => {
    if (!config) return { success: false, message: t('user_management.error.apply_failed'), report: null };
    setApplying(true);
    try {
      const call = requireUserManagementMethod(backend, 'UserMgmtApply');
      const result = await call(config, request, fingerprint);
      const report = result?.data ? normalizeReport(result.data) : null;
      return {
        success: result?.success !== false,
        message: String(result?.message || '').trim() || (result?.success === false ? t('user_management.error.apply_failed') : ''),
        report,
      };
    } catch {
      return { success: false, message: t('user_management.error.apply_failed'), report: null };
    } finally {
      setApplying(false);
    }
  }, [backend, config, t]);

  return { apply, applying };
};
