package app

import (
	"net/url"
	"strings"
)

// connectionLogHost keeps URI-in-host workflows from putting JDBC credentials,
// HTTP query tokens or control characters into connection progress/error logs.
func connectionLogHost(host string) string {
	raw := strings.TrimSpace(host)
	if strings.ContainsAny(raw, "\r\n\t") {
		return "<redacted endpoint>"
	}
	if strings.HasPrefix(strings.ToLower(raw), "jdbc:") {
		raw = raw[len("jdbc:"):]
	}
	if strings.Contains(raw, "://") {
		parsed, err := url.Parse(raw)
		if err != nil || parsed.Hostname() == "" {
			return "<redacted endpoint>"
		}
		return parsed.Hostname()
	}
	if strings.ContainsAny(raw, "@/;?#") {
		return "<redacted endpoint>"
	}
	return raw
}
