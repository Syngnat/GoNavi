package db

var postgresConnectionParamNames = newConnectionParamNameMap(
	"host",
	"hostaddr",
	"port",
	"user",
	"password",
	"passfile",
	"dbname",
	"database",
	"options",
	"application_name",
	"fallback_application_name",
	"sslmode",
	"sslnegotiation",
	"sslcert",
	"sslkey",
	"sslrootcert",
	"sslsni",
	"sslinline",
	"krbsrvname",
	"krbspn",
	"connect_timeout",
	"binary_parameters",
	"disable_prepared_binary_result",
	"client_encoding",
	"datestyle",
	"tz",
	"geqo",
	"target_session_attrs",
	"load_balance_hosts",
	"search_path",
	"work_mem",
	"statement_timeout",
	"lock_timeout",
	"idle_in_transaction_session_timeout",
	"default_transaction_read_only",
	"default_transaction_isolation",
	"TimeZone",
)

var highGoConnectionParamNames = newConnectionParamNameMap(
	"host",
	"port",
	"user",
	"password",
	"dbname",
	"application_name",
	"fallback_application_name",
	"sslmode",
	"sslcert",
	"sslkey",
	"sslrootcert",
	"sslsni",
	"sslinline",
	"krbsrvname",
	"krbspn",
	"connect_timeout",
	"binary_parameters",
	"disable_prepared_binary_result",
	"search_path",
	"work_mem",
	"statement_timeout",
	"lock_timeout",
	"idle_in_transaction_session_timeout",
	"default_transaction_read_only",
	"default_transaction_isolation",
	"TimeZone",
)

var kingbaseConnectionParamNames = makeKingbaseConnectionParamNames()

func makeKingbaseConnectionParamNames() map[string]string {
	names := newConnectionParamNameMap(
		"host",
		"port",
		"user",
		"password",
		"dbname",
		"application_name",
		"fallback_application_name",
		"sslmode",
		"sslcert",
		"sslkey",
		"sslrootcert",
		"krbsrvname",
		"krbspn",
		"connect_timeout",
		"binary_parameters",
		"disable_prepared_binary_result",
		"search_path",
		"work_mem",
		"statement_timeout",
		"lock_timeout",
		"idle_in_transaction_session_timeout",
		"default_transaction_read_only",
		"default_transaction_isolation",
		"TimeZone",
	)
	// Kingbase accepts the PostgreSQL-compatible `database` spelling as an
	// alias for `dbname`, including copied URI/query parameters.
	addConnectionParamAlias(names, "database", "dbname")
	return names
}

var sqlServerConnectionParamNames = makeSQLServerConnectionParamNames()

func makeSQLServerConnectionParamNames() map[string]string {
	names := newConnectionParamNameMap(
		"database",
		"encrypt",
		"password",
		"change password",
		"user id",
		"port",
		"trustservercertificate",
		"certificate",
		"servercertificate",
		"tlsmin",
		"packet size",
		"log",
		"connection timeout",
		"hostnameincertificate",
		"keepalive",
		"serverspn",
		"workstation id",
		"app name",
		"applicationintent",
		"failoverpartner",
		"failoverport",
		"disableretry",
		"server",
		"protocol",
		"dial timeout",
		"pipe",
		"multisubnetfailover",
		"notraceid",
		"guid conversion",
		"timezone",
		"columnencryption",
	)
	addConnectionParamAlias(names, "application name", "app name")
	addConnectionParamAlias(names, "data source", "server")
	addConnectionParamAlias(names, "network address", "server")
	addConnectionParamAlias(names, "address", "server")
	addConnectionParamAlias(names, "addr", "server")
	addConnectionParamAlias(names, "user", "user id")
	addConnectionParamAlias(names, "uid", "user id")
	addConnectionParamAlias(names, "pwd", "password")
	addConnectionParamAlias(names, "initial catalog", "database")
	addConnectionParamAlias(names, "column encryption setting", "columnencryption")
	addConnectionParamAlias(names, "trust server certificate", "trustservercertificate")
	addConnectionParamAlias(names, "multi subnet failover", "multisubnetfailover")
	addConnectionParamAlias(names, "application intent", "applicationintent")
	return names
}

var oracleConnectionParamNames = makeOracleConnectionParamNames()

func makeOracleConnectionParamNames() map[string]string {
	names := newConnectionParamNameMap(
		"CID",
		"connStr",
		"SERVER",
		"SERVICE NAME",
		"SID",
		"INSTANCE NAME",
		"WALLET",
		"WALLET PASSWORD",
		"AUTH TYPE",
		"OS USER",
		"OS PASS",
		"OS PASSWORD",
		"OS HASH",
		"OS PASSHASH",
		"OS PASSWORD HASH",
		"DOMAIN",
		"AUTH SERV",
		"ENCRYPTION",
		"DATA INTEGRITY",
		"SSL",
		"SSL VERIFY",
		"DBA PRIVILEGE",
		"TIMEOUT",
		"READ TIMEOUT",
		"SOCKET TIMEOUT",
		"CONNECT TIMEOUT",
		"CONNECTION TIMEOUT",
		"TRACE FILE",
		"TRACE DIR",
		"TRACE FOLDER",
		"TRACE DIRECTORY",
		"USE_OOB",
		"ENABLE_OOB",
		"ENABLE URGENT DATA TRANSPORT",
		"PREFETCH_ROWS",
		"UNIX SOCKET",
		"PROXY CLIENT NAME",
		"LOB FETCH",
		"LANGUAGE",
		"TERRITORY",
		"CHARSET",
		"CLIENT CHARSET",
		"PROGRAM",
		"SERVER LOCATION",
	)
	addConnectionParamAlias(names, "SERVICE_NAME", "SERVICE NAME")
	addConnectionParamAlias(names, "INSTANCE_NAME", "INSTANCE NAME")
	addConnectionParamAlias(names, "WALLET_PASSWORD", "WALLET PASSWORD")
	addConnectionParamAlias(names, "AUTH_TYPE", "AUTH TYPE")
	addConnectionParamAlias(names, "AUTH_SERV", "AUTH SERV")
	addConnectionParamAlias(names, "DATA_INTEGRITY", "DATA INTEGRITY")
	addConnectionParamAlias(names, "SSL_VERIFY", "SSL VERIFY")
	addConnectionParamAlias(names, "DBA_PRIVILEGE", "DBA PRIVILEGE")
	addConnectionParamAlias(names, "READ_TIMEOUT", "READ TIMEOUT")
	addConnectionParamAlias(names, "SOCKET_TIMEOUT", "SOCKET TIMEOUT")
	addConnectionParamAlias(names, "CONNECT_TIMEOUT", "CONNECT TIMEOUT")
	addConnectionParamAlias(names, "CONNECTION_TIMEOUT", "CONNECTION TIMEOUT")
	addConnectionParamAlias(names, "TRACE_FILE", "TRACE FILE")
	addConnectionParamAlias(names, "TRACE_DIR", "TRACE DIR")
	addConnectionParamAlias(names, "TRACE_FOLDER", "TRACE FOLDER")
	addConnectionParamAlias(names, "TRACE_DIRECTORY", "TRACE DIRECTORY")
	addConnectionParamAlias(names, "UNIX_SOCKET", "UNIX SOCKET")
	addConnectionParamAlias(names, "PROXY_CLIENT_NAME", "PROXY CLIENT NAME")
	addConnectionParamAlias(names, "LOB_FETCH", "LOB FETCH")
	addConnectionParamAlias(names, "CLIENT_CHARSET", "CLIENT CHARSET")
	addConnectionParamAlias(names, "SERVER_LOCATION", "SERVER LOCATION")
	return names
}

var damengConnectionParamNames = makeDamengConnectionParamNames()

func makeDamengConnectionParamNames() map[string]string {
	names := newConnectionParamNameMap(
		"timeZone",
		"enRsCache",
		"rsCacheSize",
		"rsRefreshFreq",
		"loginPrimary",
		"loginMode",
		"loginStatus",
		"loginDscCtrl",
		"switchTimes",
		"switchInterval",
		"epSelector",
		"primaryKey",
		"keywords",
		"compress",
		"compressId",
		"loginEncrypt",
		"communicationEncrypt",
		"direct",
		"dec2double",
		"rwSeparate",
		"rwPercent",
		"rwAutoDistribute",
		"compatibleMode",
		"comOra",
		"cipherPath",
		"doSwitch",
		"driverReconnect",
		"cluster",
		"language",
		"dbAliveCheckFreq",
		"rwStandbyRecoverTime",
		"logLevel",
		"logDir",
		"logBufferPoolSize",
		"logBufferSize",
		"logFlusherQueueSize",
		"logFlushFreq",
		"statEnable",
		"statDir",
		"statFlushFreq",
		"statHighFreqSqlCount",
		"statSlowSqlCount",
		"statSqlMaxCount",
		"statSqlRemoveMode",
		"addressRemap",
		"userRemap",
		"connectTimeout",
		"loginCertificate",
		"url",
		"host",
		"port",
		"user",
		"password",
		"dialName",
		"rwStandby",
		"isCompress",
		"rwHA",
		"rwIgnoreSql",
		"appName",
		"osName",
		"mppLocal",
		"socketTimeout",
		"sessionTimeout",
		"continueBatchOnError",
		"batchAllowMaxErrors",
		"escapeProcess",
		"autoCommit",
		"maxRows",
		"rowPrefetch",
		"bufPrefetch",
		"LobMode",
		"StmtPoolSize",
		"AlwayseAllowCommit",
		"batchType",
		"batchNotOnCall",
		"isBdtaRS",
		"clobAsString",
		"sslCertPath",
		"sslKeyPath",
		"sslFilesPath",
		"kerberosLoginConfPath",
		"uKeyName",
		"uKeyPin",
		"columnNameUpperCase",
		"columnNameCase",
		"databaseProductName",
		"osAuthType",
		"schema",
		"catalog",
		"serverOption",
		"clobToBytes",
		"localTimezone",
		"sessEncode",
		"svcConfPath",
		"confPath",
	)
	addConnectionParamAlias(names, "ADDRESS_REMAP", "addressRemap")
	addConnectionParamAlias(names, "ALWAYS_ALLOW_COMMIT", "AlwayseAllowCommit")
	addConnectionParamAlias(names, "APP_NAME", "appName")
	addConnectionParamAlias(names, "AUTO_COMMIT", "autoCommit")
	addConnectionParamAlias(names, "BATCH_ALLOW_MAX_ERRORS", "batchAllowMaxErrors")
	addConnectionParamAlias(names, "BATCH_CONTINUE_ON_ERROR", "continueBatchOnError")
	addConnectionParamAlias(names, "CONTINUE_BATCH_ON_ERROR", "continueBatchOnError")
	addConnectionParamAlias(names, "BATCH_NOT_ON_CALL", "batchNotOnCall")
	addConnectionParamAlias(names, "BATCH_TYPE", "batchType")
	addConnectionParamAlias(names, "BUF_PREFETCH", "bufPrefetch")
	addConnectionParamAlias(names, "CIPHER_PATH", "cipherPath")
	addConnectionParamAlias(names, "COLUMN_NAME_UPPER_CASE", "columnNameUpperCase")
	addConnectionParamAlias(names, "COLUMN_NAME_CASE", "columnNameCase")
	addConnectionParamAlias(names, "COMPATIBLE_MODE", "compatibleMode")
	addConnectionParamAlias(names, "COMPRESS_MSG", "compress")
	addConnectionParamAlias(names, "COMPRESS_ID", "compressId")
	addConnectionParamAlias(names, "CONNECT_TIMEOUT", "connectTimeout")
	addConnectionParamAlias(names, "DO_SWITCH", "doSwitch")
	addConnectionParamAlias(names, "AUTO_RECONNECT", "doSwitch")
	addConnectionParamAlias(names, "ENABLE_RS_CACHE", "enRsCache")
	addConnectionParamAlias(names, "EP_SELECTION", "epSelector")
	addConnectionParamAlias(names, "ESCAPE_PROCESS", "escapeProcess")
	addConnectionParamAlias(names, "IS_BDTA_RS", "isBdtaRS")
	addConnectionParamAlias(names, "KEY_WORDS", "keywords")
	addConnectionParamAlias(names, "LOB_MODE", "LobMode")
	addConnectionParamAlias(names, "LOG_BUFFER_SIZE", "logBufferSize")
	addConnectionParamAlias(names, "LOG_DIR", "logDir")
	addConnectionParamAlias(names, "LOG_FLUSH_FREQ", "logFlushFreq")
	addConnectionParamAlias(names, "LOG_FLUSHER_QUEUESIZE", "logFlusherQueueSize")
	addConnectionParamAlias(names, "LOG_LEVEL", "logLevel")
	addConnectionParamAlias(names, "LOGIN_DSC_CTRL", "loginDscCtrl")
	addConnectionParamAlias(names, "LOGIN_ENCRYPT", "loginEncrypt")
	addConnectionParamAlias(names, "LOGIN_MODE", "loginMode")
	addConnectionParamAlias(names, "LOGIN_STATUS", "loginStatus")
	addConnectionParamAlias(names, "MAX_ROWS", "maxRows")
	addConnectionParamAlias(names, "MPP_LOCAL", "mppLocal")
	addConnectionParamAlias(names, "OS_NAME", "osName")
	addConnectionParamAlias(names, "RS_CACHE_SIZE", "rsCacheSize")
	addConnectionParamAlias(names, "RS_REFRESH_FREQ", "rsRefreshFreq")
	addConnectionParamAlias(names, "RW_HA", "rwHA")
	addConnectionParamAlias(names, "RW_IGNORE_SQL", "rwIgnoreSql")
	addConnectionParamAlias(names, "RW_PERCENT", "rwPercent")
	addConnectionParamAlias(names, "RW_SEPARATE", "rwSeparate")
	addConnectionParamAlias(names, "RW_STANDBY_RECOVER_TIME", "rwStandbyRecoverTime")
	addConnectionParamAlias(names, "SESS_ENCODE", "sessEncode")
	addConnectionParamAlias(names, "SESSION_TIMEOUT", "sessionTimeout")
	addConnectionParamAlias(names, "SOCKET_TIMEOUT", "socketTimeout")
	addConnectionParamAlias(names, "SSL_CERT_PATH", "sslCertPath")
	addConnectionParamAlias(names, "SSL_FILES_PATH", "sslFilesPath")
	addConnectionParamAlias(names, "SSL_KEY_PATH", "sslKeyPath")
	addConnectionParamAlias(names, "STAT_DIR", "statDir")
	addConnectionParamAlias(names, "STAT_ENABLE", "statEnable")
	addConnectionParamAlias(names, "STAT_FLUSH_FREQ", "statFlushFreq")
	addConnectionParamAlias(names, "STAT_HIGH_FREQ_SQL_COUNT", "statHighFreqSqlCount")
	addConnectionParamAlias(names, "STAT_SLOW_SQL_COUNT", "statSlowSqlCount")
	addConnectionParamAlias(names, "STAT_SQL_MAX_COUNT", "statSqlMaxCount")
	addConnectionParamAlias(names, "STAT_SQL_REMOVE_MODE", "statSqlRemoveMode")
	addConnectionParamAlias(names, "SWITCH_INTERVAL", "switchInterval")
	addConnectionParamAlias(names, "SWITCH_TIME", "switchTimes")
	addConnectionParamAlias(names, "SWITCH_TIMES", "switchTimes")
	addConnectionParamAlias(names, "TIME_ZONE", "timeZone")
	addConnectionParamAlias(names, "USER_REMAP", "userRemap")
	addConnectionParamAlias(names, "SERVER_OPTION", "serverOption")
	addConnectionParamAlias(names, "CLOB_TO_BYTES", "clobToBytes")
	return names
}

var tdengineConnectionParamNames = newConnectionParamNameMap(
	"interpolateParams",
	"token",
	"enableCompression",
	"readTimeout",
	"writeTimeout",
	"timezone",
	"bearerToken",
	"totpCode",
)
