package db

import (
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	"GoNavi-Wails/internal/connection"
)

var mysqlCompatibleURISchemes = []string{
	"mysql",
	"mariadb",
	"doris",
	"diros",
	"oceanbase",
	"starrocks",
	"goldendb",
	"greatdb",
	"gdb",
}

func parseMySQLCompatibleURI(raw string, allowedSchemes ...string) (*url.URL, bool) {
	return parseConnectionURI(raw, allowedSchemes...)
}

func resolveMySQLCompatibleDefaultPort(config connection.ConnectionConfig) int {
	if config.Port > 0 {
		return config.Port
	}
	switch strings.ToLower(strings.TrimSpace(config.Type)) {
	case "goldendb", "greatdb", "gdb":
		return defaultGoldenDBPort
	default:
		return defaultMySQLPort
	}
}

func mysqlConnectionParamsFromText(raw string) url.Values {
	return connectionParamsFromText(raw)
}

func parseMySQLBoolParam(raw string) (bool, bool) {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "1", "true", "yes", "on":
		return true, true
	case "0", "false", "no", "off":
		return false, true
	default:
		return false, false
	}
}

func normalizeMySQLDurationParam(raw string, unit time.Duration) string {
	text := strings.TrimSpace(raw)
	if text == "" {
		return text
	}
	if n, err := strconv.Atoi(text); err == nil && n >= 0 {
		return (time.Duration(n) * unit).String()
	}
	return text
}

func normalizeMySQLCharsetParam(raw string) string {
	text := strings.TrimSpace(raw)
	if text == "" {
		return ""
	}
	lower := strings.ToLower(text)
	switch lower {
	case "utf-8", "utf_8", "unicode":
		return "utf8mb4"
	case "utf8", "utf8mb4", "latin1", "gbk", "gb2312", "gb18030", "big5", "sjis", "cp932":
		return lower
	case "iso-8859-1", "iso8859-1", "iso88591":
		return "latin1"
	default:
		return text
	}
}

func normalizeMySQLServerTimezoneParam(raw string) (string, bool) {
	text := strings.TrimSpace(raw)
	if text == "" {
		return "", false
	}
	compact := strings.ToUpper(strings.ReplaceAll(text, " ", ""))
	switch compact {
	case "LOCAL":
		return "Local", true
	case "UTC", "Z", "GMT", "GMT+0", "GMT-0", "GMT+00", "GMT-00", "GMT+00:00", "GMT-00:00",
		"UTC+0", "UTC-0", "UTC+00", "UTC-00", "UTC+00:00", "UTC-00:00":
		return "UTC", true
	case "GMT+8", "GMT+08", "GMT+08:00", "UTC+8", "UTC+08", "UTC+08:00",
		"ASIA/SHANGHAI", "PRC", "CTT":
		return "Asia/Shanghai", true
	}
	if strings.Contains(text, "/") {
		if _, err := time.LoadLocation(text); err == nil {
			return text, true
		}
	}
	return "", false
}

var mysqlSupportedDriverParamNames = map[string]string{
	"allowallfiles":            "allowAllFiles",
	"allowcleartextpasswords":  "allowCleartextPasswords",
	"allowfallbacktoplaintext": "allowFallbackToPlaintext",
	"allownativepasswords":     "allowNativePasswords",
	"allowoldpasswords":        "allowOldPasswords",
	"checkconnliveness":        "checkConnLiveness",
	"clientfoundrows":          "clientFoundRows",
	"charset":                  "charset",
	"collation":                "collation",
	"columnswithalias":         "columnsWithAlias",
	"compress":                 "compress",
	// connectionAttributes 透传 mysql CLIENT_CONNECT_ATTRS（key1:value1,key2:value2 格式）。
	// OceanBase Oracle 租户 MySQL wire 路径用它注入 OBClient 私有 capability attribute；
	// 普通 mysql/mariadb 用户也能在此声明 program_name 等元数据。
	"connectionattributes": "connectionAttributes",
	"interpolateparams":    "interpolateParams",
	"loc":                  "loc",
	"maxallowedpacket":     "maxAllowedPacket",
	"multistatements":      "multiStatements",
	"parsetime":            "parseTime",
	"readtimeout":          "readTimeout",
	"rejectreadonly":       "rejectReadOnly",
	"serverpubkey":         "serverPubKey",
	"sql_mode":             "sql_mode",
	"timetruncate":         "timeTruncate",
	"timeout":              "timeout",
	"tls":                  "tls",
	"writetimeout":         "writeTimeout",
}

var mysqlBoolDriverParamNames = map[string]struct{}{
	"allowAllFiles":            {},
	"allowCleartextPasswords":  {},
	"allowFallbackToPlaintext": {},
	"allowNativePasswords":     {},
	"allowOldPasswords":        {},
	"checkConnLiveness":        {},
	"clientFoundRows":          {},
	"columnsWithAlias":         {},
	"compress":                 {},
	"interpolateParams":        {},
	"multiStatements":          {},
	"parseTime":                {},
	"rejectReadOnly":           {},
}

func canonicalMySQLDriverParamName(name string) (string, bool) {
	canonical, ok := mysqlSupportedDriverParamNames[strings.ToLower(strings.TrimSpace(name))]
	return canonical, ok
}

func setMySQLDriverParam(params url.Values, name string, value string) {
	switch name {
	case "charset":
		if charset := normalizeMySQLCharsetParam(value); charset != "" {
			params.Set("charset", charset)
		}
	case "timeout", "readTimeout", "writeTimeout", "timeTruncate":
		params.Set(name, normalizeMySQLDurationParam(value, time.Second))
	default:
		if _, ok := mysqlBoolDriverParamNames[name]; ok {
			if enabled, ok := parseMySQLBoolParam(value); ok {
				params.Set(name, strconv.FormatBool(enabled))
				return
			}
		}
		params.Set(name, value)
	}
}

func mergeMySQLConnectionParam(params url.Values, key string, value string) {
	name := strings.TrimSpace(key)
	if name == "" {
		return
	}
	lowerName := strings.ToLower(name)
	switch lowerName {
	case "topology":
		return
	case "useunicode", "autoreconnect", "useoldaliasmetadatabehavior", "allowpublickeyretrieval":
		return
	case "characterencoding":
		if charset := normalizeMySQLCharsetParam(value); charset != "" {
			params.Set("charset", charset)
		}
		return
	case "servertimezone":
		if loc, ok := normalizeMySQLServerTimezoneParam(value); ok {
			params.Set("loc", loc)
		}
		return
	case "usessl":
		if enabled, ok := parseMySQLBoolParam(value); ok {
			if enabled {
				params.Set("tls", "true")
			} else {
				params.Set("tls", "false")
			}
		}
		return
	case "verifyservercertificate":
		if verified, ok := parseMySQLBoolParam(value); ok && !verified && params.Get("tls") != "false" {
			params.Set("tls", "skip-verify")
		}
		return
	case "trustservercertificate":
		if trusted, ok := parseMySQLBoolParam(value); ok && trusted && params.Get("tls") != "false" {
			params.Set("tls", "skip-verify")
		}
		return
	case "sslmode":
		switch normalizeSSLModeValue(value) {
		case sslModeDisable:
			params.Set("tls", "false")
		case sslModeRequired:
			params.Set("tls", "true")
		case sslModeSkipVerify:
			params.Set("tls", "skip-verify")
		default:
			params.Set("tls", "preferred")
		}
		return
	case "connecttimeout":
		params.Set("timeout", normalizeMySQLDurationParam(value, time.Millisecond))
		return
	case "sockettimeout":
		params.Set("readTimeout", normalizeMySQLDurationParam(value, time.Millisecond))
		return
	case "allowmultiqueries":
		if enabled, ok := parseMySQLBoolParam(value); ok {
			params.Set("multiStatements", strconv.FormatBool(enabled))
		}
		return
	case "usecompression":
		if enabled, ok := parseMySQLBoolParam(value); ok {
			params.Set("compress", strconv.FormatBool(enabled))
		}
		return
	case "connectioncollation":
		params.Set("collation", value)
		return
	default:
		if canonical, ok := canonicalMySQLDriverParamName(name); ok {
			setMySQLDriverParam(params, canonical, value)
		}
	}
}

func mergeMySQLConnectionParams(params url.Values, values url.Values) {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		lowerName := strings.ToLower(strings.TrimSpace(key))
		if lowerName == "verifyservercertificate" || lowerName == "trustservercertificate" {
			continue
		}
		for _, value := range values[key] {
			mergeMySQLConnectionParam(params, key, value)
		}
	}
	for _, key := range keys {
		lowerName := strings.ToLower(strings.TrimSpace(key))
		if lowerName != "verifyservercertificate" && lowerName != "trustservercertificate" {
			continue
		}
		for _, value := range values[key] {
			mergeMySQLConnectionParam(params, key, value)
		}
	}
}
