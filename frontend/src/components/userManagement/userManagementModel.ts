import type {
  PrincipalKind,
  PrincipalRef,
  UMApplyReport,
  UMChoice,
  UMDropImpact,
  UMGrant,
  UMKindDescriptor,
  UMMembership,
  UMNotice,
  UMNoticeLevel,
  UMOptionDescriptor,
  UMOptionType,
  UMOverview,
  UMPlan,
  UMPrincipal,
  UMPrincipalDetail,
  UMPrivilegeDescriptor,
  UMRisk,
  UMServerProfile,
} from './userManagementTypes';

type Raw = Record<string, unknown>;

const asRecord = (value: unknown): Raw => (value && typeof value === 'object' && !Array.isArray(value) ? value as Raw : {});
const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const str = (value: unknown): string => (value === undefined || value === null ? '' : String(value));
const bool = (value: unknown): boolean => value === true;
const num = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};
const strings = (value: unknown): string[] => asArray(value).map(str).filter(Boolean);
const stringMap = (value: unknown): Record<string, string> => {
  const out: Record<string, string> = {};
  Object.entries(asRecord(value)).forEach(([key, item]) => { out[key] = str(item); });
  return out;
};

const KINDS: PrincipalKind[] = ['user', 'role', 'login', 'dbuser'];
const OPTION_TYPES: UMOptionType[] = ['string', 'bool', 'int', 'enum', 'multi', 'list', 'datetime', 'text'];

const normalizeKind = (value: unknown): PrincipalKind => {
  const kind = str(value) as PrincipalKind;
  return KINDS.includes(kind) ? kind : 'user';
};

export const normalizeRef = (value: unknown): PrincipalRef => {
  const raw = asRecord(value);
  const ref: PrincipalRef = { kind: normalizeKind(raw.kind), name: str(raw.name) };
  if (str(raw.host)) ref.host = str(raw.host);
  if (str(raw.database)) ref.database = str(raw.database);
  return ref;
};

const normalizeLevel = (value: unknown): UMNoticeLevel => {
  const level = str(value);
  return level === 'warning' || level === 'danger' ? level : 'info';
};

export const normalizeNotices = (value: unknown): UMNotice[] => asArray(value).map((item) => {
  const raw = asRecord(item);
  return { code: str(raw.code), level: normalizeLevel(raw.level), params: stringMap(raw.params), text: str(raw.text) };
});

const normalizeChoice = (value: unknown): UMChoice => {
  const raw = asRecord(value);
  return {
    value: str(raw.value),
    label: str(raw.label) || undefined,
    disabled: bool(raw.disabled),
    deprecated: bool(raw.deprecated),
    hint: str(raw.hint) || undefined,
  };
};

const normalizeOption = (value: unknown): UMOptionDescriptor => {
  const raw = asRecord(value);
  const type = str(raw.type) as UMOptionType;
  return {
    id: str(raw.id),
    type: OPTION_TYPES.includes(type) ? type : 'string',
    tab: str(raw.tab) || 'general',
    kinds: asArray(raw.kinds).map(normalizeKind),
    choices: asArray(raw.choices).map(normalizeChoice),
    default: str(raw.default) || undefined,
    min: raw.min === undefined ? undefined : num(raw.min),
    max: raw.max === undefined ? undefined : num(raw.max),
    createOnly: bool(raw.createOnly),
    readOnly: bool(raw.readOnly),
    required: bool(raw.required),
    hint: str(raw.hint) || undefined,
  };
};

const normalizeKindDescriptor = (value: unknown): UMKindDescriptor => {
  const raw = asRecord(value);
  return {
    kind: normalizeKind(raw.kind),
    creatable: bool(raw.creatable),
    identityFields: strings(raw.identityFields),
    renamable: bool(raw.renamable),
    supportsPassword: bool(raw.supportsPassword),
    editorTabs: strings(raw.editorTabs),
  };
};

const normalizePrivilege = (value: unknown): UMPrivilegeDescriptor => {
  const raw = asRecord(value);
  return { name: str(raw.name), scopes: strings(raw.scopes), group: str(raw.group) || undefined, dynamic: bool(raw.dynamic), deprecated: bool(raw.deprecated) };
};

export const normalizeProfile = (value: unknown): UMServerProfile => {
  const raw = asRecord(value);
  const policy = asRecord(raw.passwordPolicy);
  const permissions = asRecord(raw.permissions);
  const reason = raw.unsupportedReason ? normalizeNotices([raw.unsupportedReason])[0] : undefined;
  const features: Record<string, boolean> = {};
  Object.entries(asRecord(raw.features)).forEach(([key, item]) => { features[key] = item === true; });
  return {
    supported: bool(raw.supported),
    readOnly: bool(raw.readOnly),
    unsupportedReason: reason,
    family: str(raw.family),
    flavor: str(raw.flavor),
    versionText: str(raw.versionText),
    banner: str(raw.banner),
    currentUser: str(raw.currentUser),
    topology: str(raw.topology) || undefined,
    experimental: bool(raw.experimental),
    features,
    kinds: asArray(raw.kinds).map(normalizeKindDescriptor),
    editorTabs: strings(raw.editorTabs),
    options: asArray(raw.options).map(normalizeOption).filter((option) => option.id),
    privileges: asArray(raw.privileges).map(normalizePrivilege).filter((item) => item.name),
    objectScopes: strings(raw.objectScopes),
    assignableRoles: asArray(raw.assignableRoles).map(normalizeRef),
    passwordPolicy: {
      minLength: num(policy.minLength),
      maxLength: num(policy.maxLength),
      requireUpper: bool(policy.requireUpper),
      requireLower: bool(policy.requireLower),
      requireDigit: bool(policy.requireDigit),
      requireSpecial: bool(policy.requireSpecial),
      minCategories: num(policy.minCategories),
      forbiddenChars: str(policy.forbiddenChars) || undefined,
      disallowUsername: bool(policy.disallowUsername),
      source: str(policy.source) || undefined,
    },
    permissions: {
      canList: permissions.canList !== false,
      canCreate: permissions.canCreate !== false,
      canAlter: permissions.canAlter !== false,
      canDrop: permissions.canDrop !== false,
      canGrant: permissions.canGrant !== false,
    },
    notices: normalizeNotices(raw.notices),
  };
};

export const normalizePrincipal = (value: unknown): UMPrincipal => {
  const raw = asRecord(value);
  return {
    ref: normalizeRef(raw.ref),
    system: bool(raw.system),
    locked: bool(raw.locked),
    expired: bool(raw.expired),
    canLogin: bool(raw.canLogin),
    superuser: bool(raw.superuser),
    readOnly: bool(raw.readOnly),
    readOnlyReason: str(raw.readOnlyReason) || undefined,
    authMethod: str(raw.authMethod) || undefined,
    tags: strings(raw.tags),
    current: bool(raw.current),
  };
};

export const normalizeGrant = (value: unknown): UMGrant => {
  const raw = asRecord(value);
  const grant: UMGrant = { privilege: str(raw.privilege), scope: str(raw.scope) };
  (['database', 'schema', 'object', 'column', 'objectType', 'inherited', 'node'] as const).forEach((key) => {
    if (str(raw[key])) grant[key] = str(raw[key]);
  });
  if (bool(raw.withGrantOption)) grant.withGrantOption = true;
  if (bool(raw.deny)) grant.deny = true;
  return grant;
};

const normalizeMembership = (value: unknown): UMMembership => {
  const raw = asRecord(value);
  const membership: UMMembership = { role: normalizeRef(raw.role) };
  if (bool(raw.adminOption)) membership.adminOption = true;
  if (typeof raw.inherit === 'boolean') membership.inherit = raw.inherit;
  if (typeof raw.set === 'boolean') membership.set = raw.set;
  return membership;
};

export const normalizeDetail = (value: unknown): UMPrincipalDetail => {
  const raw = asRecord(value);
  return {
    principal: normalizePrincipal(raw.principal),
    options: stringMap(raw.options),
    grants: asArray(raw.grants).map(normalizeGrant),
    memberOf: asArray(raw.memberOf).map(normalizeMembership),
    members: asArray(raw.members).map(normalizeRef),
    notices: normalizeNotices(raw.notices),
  };
};

export const normalizeOverview = (value: unknown): UMOverview => {
  const raw = asRecord(value);
  return { profile: normalizeProfile(raw.profile), principals: asArray(raw.principals).map(normalizePrincipal) };
};

const normalizeRisk = (value: unknown): UMRisk => {
  const risk = str(value);
  return risk === 'high' || risk === 'danger' ? risk : 'normal';
};

export const normalizePlan = (value: unknown): UMPlan => {
  const raw = asRecord(value);
  return {
    statements: asArray(raw.statements).map((item) => {
      const statement = asRecord(item);
      return {
        display: str(statement.display),
        database: str(statement.database) || undefined,
        risk: normalizeRisk(statement.risk),
        eachNode: bool(statement.eachNode),
        optional: bool(statement.optional),
      };
    }),
    notices: normalizeNotices(raw.notices),
    transactional: bool(raw.transactional),
    fingerprint: str(raw.fingerprint),
  };
};

export const normalizeReport = (value: unknown): UMApplyReport => {
  const raw = asRecord(value);
  return {
    results: asArray(raw.results).map((item) => {
      const result = asRecord(item);
      return {
        index: num(result.index),
        display: str(result.display),
        success: bool(result.success),
        skipped: bool(result.skipped),
        error: str(result.error) || undefined,
        node: str(result.node) || undefined,
      };
    }),
    executedCount: num(raw.executedCount),
    failedIndex: num(raw.failedIndex),
    rolledBack: bool(raw.rolledBack),
    notices: normalizeNotices(raw.notices),
  };
};

export const normalizeImpact = (value: unknown): UMDropImpact => {
  const raw = asRecord(value);
  return {
    items: asArray(raw.items).map((item) => {
      const impact = asRecord(item);
      return {
        code: str(impact.code),
        count: num(impact.count),
        database: str(impact.database) || undefined,
        samples: strings(impact.samples),
        text: str(impact.text) || undefined,
      };
    }),
    cascadeSupported: bool(raw.cascadeSupported),
    reassignSupported: bool(raw.reassignSupported),
    blocking: bool(raw.blocking),
    notices: normalizeNotices(raw.notices),
  };
};

/** 主体的稳定键，用于列表选中与去重。 */
export const principalKey = (ref: PrincipalRef): string => [ref.kind, ref.name, ref.host || '', ref.database || ''].join('\u001f');

/** 主体的展示名：MySQL 为 user@host，Mongo 为 user（db），其他为名称。 */
export const principalDisplayName = (ref: PrincipalRef): string => {
  if (ref.host !== undefined && ref.host !== '') return `${ref.name}@${ref.host}`;
  if (ref.database) return `${ref.name} (${ref.database})`;
  return ref.name;
};

/** 角色键：与后端 defaultRoles 取值一致（MySQL name@host，其余 name）。 */
export const roleKey = (ref: PrincipalRef): string => (ref.host ? `${ref.name}@${ref.host}` : ref.name);
