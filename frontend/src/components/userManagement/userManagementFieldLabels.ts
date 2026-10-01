type Translate = (key: string, params?: Record<string, string | number>) => string;

// 每个字段 ID 对应一个字面量 t() 调用，使 keyResolution 测试能逐一校验文案存在；
// 字段 ID 与 internal/dbuser/option_contract.json 保持一致（见 userManagementFieldLabels.test.ts）。
export const userManagementOptionLabel = (id: string, t: Translate): string => {
  switch (id) {
    case 'canLogin': return t('user_management.option.canLogin');
    case 'accountLocked': return t('user_management.option.accountLocked');
    case 'loginEnabled': return t('user_management.option.loginEnabled');
    case 'expirePasswordNow': return t('user_management.option.expirePasswordNow');
    case 'authPlugin': return t('user_management.option.authPlugin');
    case 'authType': return t('user_management.option.authType');
    case 'passwordEncryption': return t('user_management.option.passwordEncryption');
    case 'mechanisms': return t('user_management.option.mechanisms');
    case 'comment': return t('user_management.option.comment');
    case 'validUntil': return t('user_management.option.validUntil');
    case 'validBegin': return t('user_management.option.validBegin');
    case 'connectionLimit': return t('user_management.option.connectionLimit');
    case 'passwordExpirePolicy': return t('user_management.option.passwordExpirePolicy');
    case 'passwordLifetimeDays': return t('user_management.option.passwordLifetimeDays');
    case 'passwordHistory': return t('user_management.option.passwordHistory');
    case 'passwordReuseDays': return t('user_management.option.passwordReuseDays');
    case 'passwordRequireCurrent': return t('user_management.option.passwordRequireCurrent');
    case 'failedLoginAttempts': return t('user_management.option.failedLoginAttempts');
    case 'passwordLockDays': return t('user_management.option.passwordLockDays');
    case 'maxQueriesPerHour': return t('user_management.option.maxQueriesPerHour');
    case 'maxUpdatesPerHour': return t('user_management.option.maxUpdatesPerHour');
    case 'maxConnectionsPerHour': return t('user_management.option.maxConnectionsPerHour');
    case 'maxUserConnections': return t('user_management.option.maxUserConnections');
    case 'requireSsl': return t('user_management.option.requireSsl');
    case 'superuser': return t('user_management.option.superuser');
    case 'createDb': return t('user_management.option.createDb');
    case 'createRole': return t('user_management.option.createRole');
    case 'inherit': return t('user_management.option.inherit');
    case 'replication': return t('user_management.option.replication');
    case 'bypassRls': return t('user_management.option.bypassRls');
    case 'sysAdmin': return t('user_management.option.sysAdmin');
    case 'auditAdmin': return t('user_management.option.auditAdmin');
    case 'monAdmin': return t('user_management.option.monAdmin');
    case 'oprAdmin': return t('user_management.option.oprAdmin');
    case 'polAdmin': return t('user_management.option.polAdmin');
    case 'loginType': return t('user_management.option.loginType');
    case 'checkPolicy': return t('user_management.option.checkPolicy');
    case 'checkExpiration': return t('user_management.option.checkExpiration');
    case 'mustChange': return t('user_management.option.mustChange');
    case 'defaultDatabase': return t('user_management.option.defaultDatabase');
    case 'defaultLanguage': return t('user_management.option.defaultLanguage');
    case 'dbUserType': return t('user_management.option.dbUserType');
    case 'loginName': return t('user_management.option.loginName');
    case 'defaultSchema': return t('user_management.option.defaultSchema');
    case 'defaultTablespace': return t('user_management.option.defaultTablespace');
    case 'temporaryTablespace': return t('user_management.option.temporaryTablespace');
    case 'tablespaceQuota': return t('user_management.option.tablespaceQuota');
    case 'profile': return t('user_management.option.profile');
    case 'noAuthentication': return t('user_management.option.noAuthentication');
    case 'caseSensitiveName': return t('user_management.option.caseSensitiveName');
    case 'hosts': return t('user_management.option.hosts');
    case 'settingsProfile': return t('user_management.option.settingsProfile');
    case 'onCluster': return t('user_management.option.onCluster');
    case 'sysInfo': return t('user_management.option.sysInfo');
    case 'privilegeLevel': return t('user_management.option.privilegeLevel');
    case 'customData': return t('user_management.option.customData');
    case 'clientSources': return t('user_management.option.clientSources');
    case 'serverAddresses': return t('user_management.option.serverAddresses');
    case 'noPass': return t('user_management.option.noPass');
    case 'aclKeys': return t('user_management.option.aclKeys');
    case 'aclChannels': return t('user_management.option.aclChannels');
    case 'aclCommands': return t('user_management.option.aclCommands');
    case 'aclSelectors': return t('user_management.option.aclSelectors');
    case 'aclPersist': return t('user_management.option.aclPersist');
    case 'defaultRoles': return t('user_management.option.defaultRoles');
    default: return id;
  }
};

/** 语义化枚举取值的文案；原样值（插件名、表空间名等）返回 undefined，由调用方直接展示。 */
export const userManagementChoiceLabel = (id: string, value: string, t: Translate): string | undefined => {
  switch (`${id}.${value}`) {
    case 'passwordExpirePolicy.default': return t('user_management.choice.passwordExpirePolicy.default');
    case 'passwordExpirePolicy.never': return t('user_management.choice.passwordExpirePolicy.never');
    case 'passwordExpirePolicy.interval': return t('user_management.choice.passwordExpirePolicy.interval');
    case 'requireSsl.none': return t('user_management.choice.requireSsl.none');
    case 'requireSsl.ssl': return t('user_management.choice.requireSsl.ssl');
    case 'requireSsl.x509': return t('user_management.choice.requireSsl.x509');
    case 'requireSsl.specified': return t('user_management.choice.requireSsl.specified');
    case 'passwordRequireCurrent.default': return t('user_management.choice.passwordRequireCurrent.default');
    case 'passwordRequireCurrent.optional': return t('user_management.choice.passwordRequireCurrent.optional');
    case 'passwordRequireCurrent.required': return t('user_management.choice.passwordRequireCurrent.required');
    case 'loginType.sql': return t('user_management.choice.loginType.sql');
    case 'loginType.windows': return t('user_management.choice.loginType.windows');
    case 'dbUserType.login': return t('user_management.choice.dbUserType.login');
    case 'dbUserType.without_login': return t('user_management.choice.dbUserType.without_login');
    case 'dbUserType.password': return t('user_management.choice.dbUserType.password');
    case 'privilegeLevel.read': return t('user_management.choice.privilegeLevel.read');
    case 'privilegeLevel.write': return t('user_management.choice.privilegeLevel.write');
    default: return undefined;
  }
};

export const userManagementKindLabel = (kind: string, t: Translate): string => {
  switch (kind) {
    case 'user': return t('user_management.kind.user');
    case 'role': return t('user_management.kind.role');
    case 'login': return t('user_management.kind.login');
    case 'dbuser': return t('user_management.kind.dbuser');
    default: return kind;
  }
};

export const userManagementEditorTabLabel = (tab: string, t: Translate): string => {
  switch (tab) {
    case 'general': return t('user_management.editor.tab.general');
    case 'advanced': return t('user_management.editor.tab.advanced');
    case 'server-privileges': return t('user_management.editor.tab.server_privileges');
    case 'object-privileges': return t('user_management.editor.tab.object_privileges');
    case 'membership': return t('user_management.editor.tab.membership');
    case 'redis-rules': return t('user_management.editor.tab.redis_rules');
    case 'preview': return t('user_management.editor.tab.preview');
    default: return tab;
  }
};

export const userManagementScopeLabel = (scope: string, t: Translate): string => {
  switch (scope) {
    case 'global': return t('user_management.scope.global');
    case 'database': return t('user_management.scope.database');
    case 'schema': return t('user_management.scope.schema');
    case 'table': return t('user_management.scope.table');
    case 'column': return t('user_management.scope.column');
    case 'routine': return t('user_management.scope.routine');
    case 'sequence': return t('user_management.scope.sequence');
    default: return scope;
  }
};
