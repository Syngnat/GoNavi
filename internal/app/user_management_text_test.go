package app

import (
	"testing"

	"GoNavi-Wails/internal/dbuser"
	"GoNavi-Wails/internal/secretstore"
)

// userMgmtKnownNoticeCodes 列出各 Provider 使用的提示码；新增提示码必须同时补 i18n 并登记到这里。
var userMgmtKnownNoticeCodes = []string{
	"connection_protected", "experimental_flavor", "missing_create_user_privilege",
	"mysql_native_unavailable", "mysql_caching_sha2_clients", "mysql_db_wildcard", "mysql_legacy_account_syntax",
	"pg_server_side_hash", "pg_md5_deprecated", "pg_per_database_grants", "pg_missing_createrole", "opengauss_user_schema",
	"sqlserver_azure_database", "sqlserver_limited_visibility", "sqlserver_legacy_membership",
	"oracle_cdb_root", "oracle_pdb", "oracle_no_dba_views", "oracle_logon_version", "dameng_separation_of_duty",
	"clickhouse_no_rbac", "clickhouse_config_users", "clickhouse_config_managed", "clickhouse_double_sha1", "clickhouse_on_cluster",
	"mongo_auth_disabled", "mongo_managed_service", "mongo_scram_sha256_clients",
	"redis_no_acl", "redis_cluster_each_node", "redis_sentinel_master_only", "redis_acl_not_persistent", "redis_pubsub_default",
	"redis_acl_persist_file", "redis_acl_persist_config", "redis_acl_drift", "redis_multiple_passwords",
	dbuser.NoticeOptionalStatementFailed, dbuser.NoticeRollbackFailed, dbuser.NoticeTransactionFallback,
}

var userMgmtKnownErrorCodes = []string{
	dbuser.ErrCodeUnsupported, dbuser.ErrCodeReadOnly, dbuser.ErrCodeNothingToApply, dbuser.ErrCodeInvalidName,
	dbuser.ErrCodeNameTooLong, dbuser.ErrCodeInvalidHost, dbuser.ErrCodeInvalidOption, dbuser.ErrCodeUnknownOption,
	dbuser.ErrCodeInvalidPrivilege, dbuser.ErrCodeInvalidObject, dbuser.ErrCodePasswordRequired, dbuser.ErrCodePasswordInvalidChar,
	dbuser.ErrCodePasswordPolicy, dbuser.ErrCodeCurrentPassword, dbuser.ErrCodeKindNotSupported, dbuser.ErrCodeFeatureUnavailable,
	dbuser.ErrCodeRenameUnsupported, dbuser.ErrCodeReservedAccount, dbuser.ErrCodePlanChanged, dbuser.ErrCodeSessionUnavailable,
	dbuser.ErrCodeTargetMissing, "operation_failed", "apply_failed", "password_sync_failed", "password_sync_opaque",
}

var userMgmtKnownImpactKeys = []string{
	"definer_objects", "active_sessions", "owned_objects", "owned_objects_in_database",
	"acl_entries", "acl_entries_in_database", "owned_schemas", "owned_schemas_in_database",
}

func TestUserMgmtCodesAreLocalizedInEveryShippedLanguage(t *testing.T) {
	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	keys := make([]string, 0, 96)
	for _, code := range userMgmtKnownNoticeCodes {
		keys = append(keys, userMgmtNoticeKey(code))
	}
	for _, code := range userMgmtKnownErrorCodes {
		keys = append(keys, userMgmtErrorKey(code))
	}
	for _, code := range userMgmtKnownImpactKeys {
		keys = append(keys, "user_management.backend.impact."+code)
	}
	for _, rule := range []string{"min_length", "max_length", "upper", "lower", "digit", "special", "categories", "username"} {
		keys = append(keys, userMgmtErrorKey(dbuser.ErrCodePasswordPolicy)+"."+rule)
	}
	keys = append(keys, "user_management.backend.message.applied", "user_management.backend.message.password_synced", userMgmtProtectionAction)
	for _, language := range []string{"zh-CN", "en-US"} {
		app.SetLanguage(language)
		for _, key := range keys {
			if text := app.appText(key, nil); text == "" || text == key {
				t.Errorf("[%s] missing translation for %s", language, key)
			}
		}
	}
}
