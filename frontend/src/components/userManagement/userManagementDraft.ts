import type {
  PrincipalKind,
  PrincipalRef,
  UMChangeRequest,
  UMGrant,
  UMMembership,
  UMPrincipalDetail,
  UMServerProfile,
} from './userManagementTypes';

export interface PasswordDraft {
  set: boolean;
  value: string;
  confirm: string;
  current: string;
  retainCurrent: boolean;
  remove: boolean;
}

/** 编辑器草稿：身份、属性、口令、期望的完整授权与角色集合。 */
export interface PrincipalDraft {
  mode: 'create' | 'edit';
  kind: PrincipalKind;
  name: string;
  host: string;
  database: string;
  options: Record<string, string>;
  password: PasswordDraft;
  grants: UMGrant[];
  memberOf: UMMembership[];
}

export const emptyPasswordDraft = (): PasswordDraft => ({
  set: false, value: '', confirm: '', current: '', retainCurrent: false, remove: false,
});

const optionsForKind = (profile: UMServerProfile, kind: PrincipalKind) => profile.options.filter(
  (option) => option.kinds.length === 0 || option.kinds.includes(kind),
);

/**
 * 新建草稿：字段取描述符默认值，MySQL 主机默认 %；按库区分的主体（SQL Server 数据库用户、
 * Mongo 用户）默认落在当前选择的库，Mongo 未选择时默认认证库 admin。
 */
export const buildNewDraft = (profile: UMServerProfile, kind: PrincipalKind, defaultDatabase = ''): PrincipalDraft => {
  const options: Record<string, string> = {};
  optionsForKind(profile, kind).forEach((option) => {
    if (option.readOnly) return;
    if (option.default !== undefined) options[option.id] = option.default;
    else if (option.type === 'bool') options[option.id] = 'false';
  });
  const descriptor = profile.kinds.find((item) => item.kind === kind);
  const hasHost = descriptor?.identityFields.includes('host') ?? false;
  const hasDatabase = descriptor?.identityFields.includes('database') ?? false;
  const database = hasDatabase ? (defaultDatabase || (profile.family === 'mongodb' ? 'admin' : '')) : '';
  return {
    mode: 'create',
    kind,
    name: '',
    host: hasHost ? '%' : '',
    database,
    options,
    password: { ...emptyPasswordDraft(), set: descriptor?.supportsPassword === true },
    grants: [],
    memberOf: [],
  };
};

export const buildDraftFromDetail = (detail: UMPrincipalDetail): PrincipalDraft => ({
  mode: 'edit',
  kind: detail.principal.ref.kind,
  name: detail.principal.ref.name,
  host: detail.principal.ref.host || '',
  database: detail.principal.ref.database || '',
  options: { ...detail.options },
  password: emptyPasswordDraft(),
  // 继承而来的权限只读展示，不参与 diff。
  grants: detail.grants.filter((grant) => !grant.inherited).map((grant) => ({ ...grant })),
  memberOf: detail.memberOf.map((membership) => ({ ...membership, role: { ...membership.role } })),
});

/** 与后端 dbuser.GrantKey 一致的授权键（不含 withGrantOption）。 */
export const grantKey = (grant: UMGrant): string => [
  grant.scope, grant.database || '', grant.schema || '', grant.object || '', grant.column || '',
  (grant.objectType || '').toUpperCase(), grant.node || '', grant.privilege.toUpperCase(),
].join('\u001f');

const membershipKey = (membership: UMMembership): string => [
  membership.role.name, membership.role.host || '', membership.role.database || '',
].join('\u001f');

const membershipSignature = (membership: UMMembership): string => [
  membershipKey(membership), membership.adminOption ? '1' : '0',
  membership.inherit === undefined ? '' : String(membership.inherit),
  membership.set === undefined ? '' : String(membership.set),
].join('|');

const draftRef = (draft: PrincipalDraft): PrincipalRef => {
  const ref: PrincipalRef = { kind: draft.kind, name: draft.name.trim() };
  if (draft.host.trim()) ref.host = draft.host.trim();
  if (draft.database.trim()) ref.database = draft.database.trim();
  return ref;
};

const diffGrants = (original: UMGrant[], next: UMGrant[]) => {
  const before = new Map(original.map((grant) => [grantKey(grant), grant]));
  const after = new Map(next.map((grant) => [grantKey(grant), grant]));
  const grantsAdd: UMGrant[] = [];
  const grantsRevoke: UMGrant[] = [];
  after.forEach((grant, key) => {
    const previous = before.get(key);
    if (!previous) {
      grantsAdd.push(grant);
    } else if (Boolean(previous.withGrantOption) !== Boolean(grant.withGrantOption)) {
      // 仅授予权变化：开启则带 WITH GRANT OPTION 重新授予，关闭则只撤销授予权。
      if (grant.withGrantOption) grantsAdd.push(grant);
      else grantsRevoke.push({ ...previous, withGrantOption: true });
    } else if (Boolean(previous.deny) !== Boolean(grant.deny)) {
      grantsAdd.push(grant);
    }
  });
  before.forEach((grant, key) => {
    if (!after.has(key)) grantsRevoke.push({ ...grant, withGrantOption: false });
  });
  return { grantsAdd, grantsRevoke };
};

const diffMemberships = (original: UMMembership[], next: UMMembership[]) => {
  const before = new Map(original.map((item) => [membershipKey(item), item]));
  const after = new Map(next.map((item) => [membershipKey(item), item]));
  const membershipsAdd: UMMembership[] = [];
  const membershipsRemove: UMMembership[] = [];
  after.forEach((item, key) => {
    const previous = before.get(key);
    if (!previous) {
      membershipsAdd.push(item);
    } else if (membershipSignature(previous) !== membershipSignature(item)) {
      // 选项变化（如 ADMIN OPTION）统一按「先撤后授」处理，兼容所有方言。
      membershipsRemove.push(previous);
      membershipsAdd.push(item);
    }
  });
  before.forEach((item, key) => {
    if (!after.has(key)) membershipsRemove.push(item);
  });
  return { membershipsAdd, membershipsRemove };
};

const passwordChange = (draft: PrincipalDraft, includeSecrets: boolean) => {
  const password = draft.password;
  if (!password.set && !password.remove) return undefined;
  return {
    set: password.set || password.remove,
    remove: password.remove || undefined,
    retainCurrent: password.retainCurrent || undefined,
    password: includeSecrets && password.set ? password.value : undefined,
    currentPassword: includeSecrets && password.current ? password.current : undefined,
  };
};

const isEmptyChange = (request: UMChangeRequest): boolean => (
  !request.rename
  && !request.password
  && Object.keys(request.options || {}).length === 0
  && !(request.grantsAdd?.length)
  && !(request.grantsRevoke?.length)
  && !(request.membershipsAdd?.length)
  && !(request.membershipsRemove?.length)
);

/**
 * 计算草稿相对原始详情的结构化变更；无变化返回 null。
 * includeSecrets=false 用于预览：口令字段只保留 set 标记，明文不出组件。
 */
export const buildChangeRequest = (
  original: PrincipalDraft | null,
  draft: PrincipalDraft,
  options: { includeSecrets: boolean; database?: string },
): UMChangeRequest | null => {
  const target = draftRef(draft);
  if (draft.mode === 'create' || !original) {
    const createOptions: Record<string, string> = {};
    Object.entries(draft.options).forEach(([key, value]) => {
      if (value !== '') createOptions[key] = value;
    });
    return {
      action: 'create',
      target,
      options: createOptions,
      password: passwordChange(draft, options.includeSecrets),
      grantsAdd: draft.grants,
      membershipsAdd: draft.memberOf,
      database: options.database || undefined,
    };
  }
  const originalRef = draftRef(original);
  const changedOptions: Record<string, string> = {};
  Object.entries(draft.options).forEach(([key, value]) => {
    if ((original.options[key] ?? '') !== value) changedOptions[key] = value;
  });
  const renamed = originalRef.name !== target.name || (originalRef.host || '') !== (target.host || '');
  const request: UMChangeRequest = {
    action: 'alter',
    target: originalRef,
    rename: renamed ? target : undefined,
    options: changedOptions,
    password: passwordChange(draft, options.includeSecrets),
    ...diffGrants(original.grants, draft.grants),
    ...diffMemberships(original.memberOf, draft.memberOf),
    database: options.database || undefined,
  };
  return isEmptyChange(request) ? null : request;
};

/** 变更项计数，用于底栏「未保存变更 N 项」。 */
export const countChanges = (request: UMChangeRequest | null): number => {
  if (!request) return 0;
  if (request.action === 'create') return 1;
  return (request.rename ? 1 : 0)
    + (request.password ? 1 : 0)
    + Object.keys(request.options || {}).length
    + (request.grantsAdd?.length || 0)
    + (request.grantsRevoke?.length || 0)
    + (request.membershipsAdd?.length || 0)
    + (request.membershipsRemove?.length || 0);
};

export const buildDropRequest = (ref: PrincipalRef, drop: UMChangeRequest['drop']): UMChangeRequest => ({
  action: 'drop',
  target: ref,
  drop,
});
