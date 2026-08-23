package app

import (
	"net/url"
	"strings"
)

// partitionConnectionParams keeps ordinary driver options in connection metadata while
// routing credential-like query parameters to the connection secret bundle. If the
// value cannot be parsed losslessly as a query string, it is treated as secret in its
// entirety: exposing less metadata is safer than accidentally serializing a token.
func partitionConnectionParams(raw string) (public string, sensitive string) {
	normalized := strings.TrimSpace(raw)
	if normalized == "" {
		return "", ""
	}
	normalized = strings.TrimPrefix(normalized, "?")
	values, err := url.ParseQuery(normalized)
	if err != nil {
		return "", raw
	}

	publicValues := make(url.Values)
	sensitiveValues := make(url.Values)
	for key, items := range values {
		target := publicValues
		if isSensitiveConnectionParamKey(key) {
			target = sensitiveValues
		}
		for _, item := range items {
			target.Add(key, item)
		}
	}
	return publicValues.Encode(), sensitiveValues.Encode()
}

// HasSensitiveConnectionParams reports whether raw contains credential-like
// parameters. It intentionally exposes no key or value so command adapters can
// reject argv secrets without retaining or logging them. Malformed input is
// treated as sensitive by partitionConnectionParams and therefore fails closed.
func HasSensitiveConnectionParams(raw string) bool {
	_, sensitive := partitionConnectionParams(raw)
	return strings.TrimSpace(sensitive) != ""
}

func isSensitiveConnectionParamKey(key string) bool {
	compact := strings.ToLower(strings.TrimSpace(key))
	compact = strings.NewReplacer("_", "", "-", "", ".", "", " ", "").Replace(compact)
	if compact == "" {
		return false
	}

	switch compact {
	case "auth", "authorization", "credential", "credentials", "cookie", "sessioncookie", "signature", "sig":
		return true
	}
	return compact == "pwd" ||
		strings.HasSuffix(compact, "password") ||
		strings.HasSuffix(compact, "passwd") ||
		strings.HasSuffix(compact, "token") ||
		strings.HasSuffix(compact, "apikey") ||
		strings.HasSuffix(compact, "secret") ||
		strings.HasSuffix(compact, "secretkey") ||
		strings.HasSuffix(compact, "privatekey") ||
		strings.HasSuffix(compact, "accesskey")
}

func mergeConnectionParams(public string, sensitive string) string {
	public = strings.TrimSpace(public)
	sensitive = strings.TrimSpace(sensitive)
	if public == "" {
		return sensitive
	}
	if sensitive == "" {
		return public
	}

	publicValues, publicErr := url.ParseQuery(strings.TrimPrefix(public, "?"))
	sensitiveValues, sensitiveErr := url.ParseQuery(strings.TrimPrefix(sensitive, "?"))
	if publicErr != nil || sensitiveErr != nil {
		return strings.TrimSuffix(public, "&") + "&" + strings.TrimPrefix(sensitive, "&")
	}
	for key, items := range sensitiveValues {
		publicValues.Del(key)
		for _, item := range items {
			publicValues.Add(key, item)
		}
	}
	return publicValues.Encode()
}
