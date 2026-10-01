import type { SavedConnection } from '../../types';
import { normalizeConnectionEnvironmentType } from '../../utils/connectionEnvironment';
import type { UMChangeRequest, UMPlan, UMPrincipal } from './userManagementTypes';

// 系统保留/超级账号：删除、锁定或改名会导致实例不可管理，需要强提示。
const RESERVED_ACCOUNTS = new Set([
  'root', 'sa', 'sys', 'system', 'postgres', 'sysdba', 'sysauditor', 'syssso', 'sysdbo',
  'default', 'admin', '__system', 'mysql.sys', 'mysql.session', 'mysql.infoschema', 'mariadb.sys',
  'omm', 'gaussdb', 'elastic',
]);

export const isReservedAccount = (name: string): boolean => RESERVED_ACCOUNTS.has(String(name || '').trim().toLowerCase());

export type SelfImpact = 'drop' | 'lock' | 'password' | 'rename' | 'revoke';

const LOCKING_OPTIONS: Array<[string, string]> = [
  ['accountLocked', 'true'],
  ['loginEnabled', 'false'],
  ['canLogin', 'false'],
  ['noAuthentication', 'true'],
];

/** 该变更是否作用于本连接自身使用的登录账号（当前会话用户或连接配置用户）。 */
export const isSelfPrincipal = (principal: UMPrincipal | null | undefined, connection: SavedConnection | null | undefined, targetName: string): boolean => {
  if (principal?.current) return true;
  const configUser = String(connection?.config?.user || '').trim().toLowerCase();
  return Boolean(configUser) && configUser === String(targetName || '').trim().toLowerCase();
};

/** 识别会影响本连接登录的变更，按严重程度返回第一项。 */
export const detectSelfImpact = (request: UMChangeRequest | null, isSelf: boolean): SelfImpact | null => {
  if (!request || !isSelf || request.action === 'create') return null;
  if (request.action === 'drop') return 'drop';
  const options = request.options || {};
  if (LOCKING_OPTIONS.some(([id, value]) => options[id] === value)) return 'lock';
  if (request.rename) return 'rename';
  if (request.password?.set) return 'password';
  if ((request.grantsRevoke?.length || 0) > 0 || (request.membershipsRemove?.length || 0) > 0) return 'revoke';
  return null;
};

export type ApplyRiskReason = 'production' | 'danger' | 'self' | 'reserved';

/** 汇总需要倒计时确认的原因；为空表示评审弹窗本身即足够的确认。 */
export const collectApplyRiskReasons = (options: {
  connection: SavedConnection | null | undefined;
  plan: UMPlan | null;
  selfImpact: SelfImpact | null;
  request: UMChangeRequest | null;
}): ApplyRiskReason[] => {
  const reasons: ApplyRiskReason[] = [];
  // 用户管理属安全敏感操作：生产环境一律倒计时，不因连接配置了其他保护项而跳过。
  if (normalizeConnectionEnvironmentType(options.connection?.environmentType) === 'production') reasons.push('production');
  if (options.plan?.statements.some((statement) => statement.risk === 'danger')) reasons.push('danger');
  if (options.selfImpact) reasons.push('self');
  const request = options.request;
  const touchesReserved = request && request.action !== 'create' && isReservedAccount(request.target.name);
  const destructive = request && (request.action === 'drop' || Boolean(request.rename)
    || LOCKING_OPTIONS.some(([id, value]) => request.options?.[id] === value));
  if (touchesReserved && destructive) reasons.push('reserved');
  return reasons;
};
