// 与 internal/dbuser 的 JSON 契约一一对应。后端经 QueryResult.data 返回（类型为 any），
// 因此这里手写镜像类型，并由 userManagementModel 做防御式归一化。

export type PrincipalKind = 'user' | 'role' | 'login' | 'dbuser';

export type UMFamily =
  | 'mysql' | 'postgres' | 'opengauss' | 'sqlserver' | 'oracle'
  | 'dameng' | 'clickhouse' | 'tdengine' | 'mongodb' | 'redis';

export type UMNoticeLevel = 'info' | 'warning' | 'danger';

export interface UMNotice {
  code: string;
  level: UMNoticeLevel;
  params?: Record<string, string>;
  text?: string;
}

export interface PrincipalRef {
  kind: PrincipalKind;
  name: string;
  host?: string;
  database?: string;
}

export type UMOptionType = 'string' | 'bool' | 'int' | 'enum' | 'multi' | 'list' | 'datetime' | 'text';

export interface UMChoice {
  value: string;
  label?: string;
  disabled?: boolean;
  deprecated?: boolean;
  hint?: string;
}

export interface UMOptionDescriptor {
  id: string;
  type: UMOptionType;
  tab: string;
  kinds: PrincipalKind[];
  choices: UMChoice[];
  default?: string;
  min?: number;
  max?: number;
  createOnly?: boolean;
  readOnly?: boolean;
  required?: boolean;
  hint?: string;
}

export interface UMKindDescriptor {
  kind: PrincipalKind;
  creatable: boolean;
  identityFields: string[];
  renamable: boolean;
  supportsPassword: boolean;
  editorTabs: string[];
}

export interface UMPrivilegeDescriptor {
  name: string;
  scopes: string[];
  group?: string;
  dynamic?: boolean;
  deprecated?: boolean;
}

export interface UMPasswordPolicy {
  minLength: number;
  maxLength: number;
  requireUpper: boolean;
  requireLower: boolean;
  requireDigit: boolean;
  requireSpecial: boolean;
  minCategories: number;
  forbiddenChars?: string;
  disallowUsername: boolean;
  source?: string;
}

export interface UMPermissions {
  canList: boolean;
  canCreate: boolean;
  canAlter: boolean;
  canDrop: boolean;
  canGrant: boolean;
}

export interface UMServerProfile {
  supported: boolean;
  readOnly: boolean;
  unsupportedReason?: UMNotice;
  family: UMFamily | string;
  flavor: string;
  versionText: string;
  banner: string;
  currentUser: string;
  topology?: string;
  experimental?: boolean;
  features: Record<string, boolean>;
  kinds: UMKindDescriptor[];
  editorTabs: string[];
  options: UMOptionDescriptor[];
  privileges: UMPrivilegeDescriptor[];
  objectScopes: string[];
  assignableRoles: PrincipalRef[];
  passwordPolicy: UMPasswordPolicy;
  permissions: UMPermissions;
  notices: UMNotice[];
}

export interface UMPrincipal {
  ref: PrincipalRef;
  system: boolean;
  locked: boolean;
  expired: boolean;
  canLogin: boolean;
  superuser: boolean;
  readOnly: boolean;
  readOnlyReason?: string;
  authMethod?: string;
  tags: string[];
  current: boolean;
}

export interface UMGrant {
  privilege: string;
  scope: string;
  database?: string;
  schema?: string;
  object?: string;
  column?: string;
  objectType?: string;
  withGrantOption?: boolean;
  deny?: boolean;
  inherited?: string;
  node?: string;
}

export interface UMMembership {
  role: PrincipalRef;
  adminOption?: boolean;
  inherit?: boolean;
  set?: boolean;
}

export interface UMPrincipalDetail {
  principal: UMPrincipal;
  options: Record<string, string>;
  grants: UMGrant[];
  memberOf: UMMembership[];
  members: PrincipalRef[];
  notices: UMNotice[];
}

export interface UMOverview {
  profile: UMServerProfile;
  principals: UMPrincipal[];
}

export interface UMPasswordChange {
  set: boolean;
  password?: string;
  currentPassword?: string;
  remove?: boolean;
  retainCurrent?: boolean;
}

export interface UMDropOptions {
  cascade?: boolean;
  reassignTo?: string;
  dropOwned?: boolean;
}

export type UMChangeAction = 'create' | 'alter' | 'drop';

export interface UMChangeRequest {
  action: UMChangeAction;
  target: PrincipalRef;
  rename?: PrincipalRef;
  options?: Record<string, string>;
  password?: UMPasswordChange;
  grantsAdd?: UMGrant[];
  grantsRevoke?: UMGrant[];
  membershipsAdd?: UMMembership[];
  membershipsRemove?: UMMembership[];
  drop?: UMDropOptions;
  database?: string;
}

export type UMRisk = 'normal' | 'high' | 'danger';

export interface UMStatement {
  display: string;
  database?: string;
  risk: UMRisk;
  eachNode?: boolean;
  optional?: boolean;
}

export interface UMPlan {
  statements: UMStatement[];
  notices: UMNotice[];
  transactional: boolean;
  fingerprint: string;
}

export interface UMStatementResult {
  index: number;
  display: string;
  success: boolean;
  skipped?: boolean;
  error?: string;
  node?: string;
}

export interface UMApplyReport {
  results: UMStatementResult[];
  executedCount: number;
  failedIndex: number;
  rolledBack: boolean;
  notices: UMNotice[];
}

export interface UMImpactItem {
  code: string;
  count: number;
  database?: string;
  samples?: string[];
  text?: string;
}

export interface UMDropImpact {
  items: UMImpactItem[];
  cascadeSupported: boolean;
  reassignSupported: boolean;
  blocking: boolean;
  notices: UMNotice[];
}
