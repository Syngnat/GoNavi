package db

import (
	"fmt"
	"net/url"
	"strings"
)

func hiveJDBCProperties(params, query url.Values, fragment string) error {
	for key, values := range query {
		if hiveKnownParameter(key) {
			hiveMergeParams(params, url.Values{key: values})
			continue
		}
		if !isSafeConnectionParamKey(key) || strings.Contains(key, " ") {
			return fmt.Errorf("invalid Hive JDBC configuration name")
		}
		normalized := strings.ToLower(strings.ReplaceAll(strings.ReplaceAll(key, "_", ""), "-", ""))
		if strings.Contains(normalized, "initfile") || normalized == "initsql" {
			return fmt.Errorf("Hive automatic initialization scripts are not supported")
		}
		if len(values) > 0 {
			params.Set("session.set:hiveconf:"+key, values[len(values)-1])
		}
	}
	if fragment == "" {
		return nil
	}
	variables, err := url.ParseQuery(strings.ReplaceAll(fragment, ";", "&"))
	if err != nil {
		return fmt.Errorf("invalid Hive JDBC variables")
	}
	for key, values := range variables {
		if !isSafeConnectionParamKey(key) || strings.Contains(key, " ") {
			return fmt.Errorf("invalid Hive JDBC variable name")
		}
		if len(values) > 0 {
			params.Set("session.set:hivevar:"+key, values[len(values)-1])
		}
	}
	return nil
}
func hiveKnownParameter(key string) bool {
	switch strings.ToLower(key) {
	case "hivefamily", "transportmode", "authmode", "auth", "httppath", "principal", "realm", "keytab", "krb5config", "credentialcache", "saslqop", "fetchsize", "pollintervalms", "ssl", "user", "password", "database", "servicediscoverymode", "initfile", "initsql":
		return true
	}
	return strings.HasPrefix(strings.ToLower(key), "session.")
}
