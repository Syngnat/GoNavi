//go:build gonavi_full_drivers || gonavi_clickhouse_driver

package db

import (
	"strings"
	"unicode"
	"unicode/utf8"

	"GoNavi-Wails/internal/connection"

	clickhouse "github.com/ClickHouse/clickhouse-go/v2"
)

func detectClickHouseProtocol(config connection.ConnectionConfig) clickhouse.Protocol {
	switch normalizeClickHouseProtocol(config.ClickHouseProtocol) {
	case clickHouseProtocolHTTP:
		return clickhouse.HTTP
	case clickHouseProtocolNative:
		return clickhouse.Native
	}
	if hasClickHouseHTTPScheme(config.URI) || hasClickHouseHTTPScheme(config.Host) {
		return clickhouse.HTTP
	}
	uriText := strings.ToLower(strings.TrimSpace(config.URI))
	if strings.HasPrefix(uriText, "http://") || strings.HasPrefix(uriText, "https://") {
		return clickhouse.HTTP
	}
	if isClickHouseHTTPPort(config.Port) {
		return clickhouse.HTTP
	}
	return clickhouse.Native
}

func normalizeClickHouseProtocol(raw string) string {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case clickHouseProtocolHTTP, "https":
		return clickHouseProtocolHTTP
	case clickHouseProtocolNative, "tcp":
		return clickHouseProtocolNative
	default:
		return clickHouseProtocolAuto
	}
}

func hasClickHouseHTTPScheme(raw string) bool {
	text := strings.ToLower(strings.TrimSpace(raw))
	return strings.HasPrefix(text, "http://") || strings.HasPrefix(text, "https://")
}

func isClickHouseHTTPPort(port int) bool {
	switch port {
	case 8123, 8125, 8132, 8443:
		return true
	default:
		return false
	}
}

func isClickHouseProtocolMismatch(err error) bool {
	if err == nil {
		return false
	}
	text := strings.ToLower(strings.TrimSpace(err.Error()))
	if text == "" {
		return false
	}
	return strings.Contains(text, "unexpected packet [72]") ||
		(strings.Contains(text, "unexpected packet") && strings.Contains(text, "handshake")) ||
		(strings.Contains(text, "cannot parse input") && strings.Contains(text, "expected '('")) ||
		strings.Contains(text, "http response to https client") ||
		strings.Contains(text, "malformed http response")
}

func isClickHouseHTTPClientProtocolVersionUnsupported(err error) bool {
	if err == nil {
		return false
	}
	text := strings.ToLower(strings.TrimSpace(err.Error()))
	if text == "" || !strings.Contains(text, "client_protocol_version") {
		return false
	}
	return strings.Contains(text, "unknown setting") ||
		strings.Contains(text, "unknown_setting") ||
		strings.Contains(text, "code: 115")
}

// isClickHouseHTTPServerInfoFunctionUnsupported 识别 clickhouse-go 在 HTTP 握手阶段
// 执行 "SELECT displayName(), version(), revision(), timezone()" 时，旧版本服务端
// （如 ClickHouse 22.8）因不存在 displayName() 函数而返回的 Code 46 / UNKNOWN_FUNCTION 错误。
func isClickHouseHTTPServerInfoFunctionUnsupported(err error) bool {
	if err == nil {
		return false
	}
	text := strings.ToLower(strings.TrimSpace(err.Error()))
	if text == "" || !strings.Contains(text, "displayname") {
		return false
	}
	return strings.Contains(text, "unknown function") ||
		strings.Contains(text, "unknown_function") ||
		strings.Contains(text, "code: 46")
}

// shouldRetryClickHouseHTTPCompatibility 判断 HTTP 协议下的失败是否可以通过
// HTTP 兼容模式（移除 client_protocol_version 并改写握手探测查询）重试解决。
func shouldRetryClickHouseHTTPCompatibility(err error) bool {
	return isClickHouseHTTPClientProtocolVersionUnsupported(err) ||
		isClickHouseHTTPServerInfoFunctionUnsupported(err)
}

func isClickHouseNativeHandshakeTimeout(err error) bool {
	if err == nil {
		return false
	}
	text := strings.ToLower(strings.TrimSpace(err.Error()))
	if !strings.Contains(text, "handshake") {
		return false
	}
	return strings.Contains(text, "i/o timeout") ||
		strings.Contains(text, "context deadline exceeded") ||
		strings.Contains(text, "deadline exceeded")
}

func shouldTryNextClickHouseProtocol(protocol clickhouse.Protocol, err error) bool {
	return isClickHouseProtocolMismatch(err) ||
		(protocol == clickhouse.Native && isClickHouseNativeHandshakeTimeout(err)) ||
		(protocol == clickhouse.HTTP && shouldRetryClickHouseHTTPCompatibility(err))
}

func clickHouseProtocolName(protocol clickhouse.Protocol) string {
	if protocol == clickhouse.HTTP {
		return "HTTP"
	}
	return "Native"
}

func sanitizeClickHouseErrorMessage(err error) string {
	if err == nil {
		return ""
	}
	text := strings.ToValidUTF8(err.Error(), "�")
	var b strings.Builder
	lastSpace := false
	for _, r := range text {
		if r == utf8.RuneError || r == '�' {
			if !lastSpace {
				b.WriteByte(' ')
				lastSpace = true
			}
			continue
		}
		if unicode.IsControl(r) {
			if !lastSpace {
				b.WriteByte(' ')
				lastSpace = true
			}
			continue
		}
		b.WriteRune(r)
		lastSpace = unicode.IsSpace(r)
	}
	sanitized := strings.Join(strings.Fields(b.String()), " ")
	if len(sanitized) > 320 {
		return sanitized[:320] + "..."
	}
	return sanitized
}

func clickHouseAttemptFailureMessage(protocol clickhouse.Protocol, err error) string {
	if protocol == clickhouse.HTTP && isClickHouseHTTPClientProtocolVersionUnsupported(err) {
		return localizedDriverRuntimeText("db.backend.error.clickhouse_http_client_protocol_version_unsupported", nil)
	}
	if protocol == clickhouse.HTTP && isClickHouseHTTPServerInfoFunctionUnsupported(err) {
		return "当前 ClickHouse HTTP 端口不支持 displayName() 握手探测函数（常见于 ClickHouse 22.8），将使用 HTTP 兼容模式重试；如仍失败请确认连接协议和端口"
	}
	if isClickHouseProtocolMismatch(err) {
		if protocol == clickhouse.Native {
			return localizedDriverRuntimeText("db.backend.error.clickhouse_native_protocol_mismatch", nil)
		}
		return localizedDriverRuntimeText("db.backend.error.clickhouse_http_protocol_mismatch", nil)
	}
	message := sanitizeClickHouseErrorMessage(err)
	if message == "" {
		return localizedDriverRuntimeText("db.backend.error.clickhouse_unknown_error", nil)
	}
	return message
}

func clickHouseTLSConfigFailedMessage(attempt int, protocol string, err error) string {
	return localizedDriverRuntimeText("db.backend.error.clickhouse_attempt_tls_config_failed", map[string]any{
		"attempt":  attempt,
		"protocol": protocol,
		"detail":   err,
	})
}

func clickHouseAttemptValidationFailedMessage(attempt int, protocol string, detail string) string {
	return localizedDriverRuntimeText("db.backend.error.clickhouse_attempt_validation_failed", map[string]any{
		"attempt":  attempt,
		"protocol": protocol,
		"detail":   detail,
	})
}

func clickHouseConnectFailureSummary(config connection.ConnectionConfig, failures []string) string {
	protocolMode := normalizeClickHouseProtocol(config.ClickHouseProtocol)
	detail := strings.Join(failures, "; ")
	if strings.TrimSpace(detail) == "" {
		detail = localizedDriverRuntimeText("db.backend.error.clickhouse_driver_detail_missing", nil)
	}
	if protocolMode != clickHouseProtocolAuto {
		return localizedDriverRuntimeText("db.backend.error.clickhouse_validation_failed_manual", map[string]any{
			"protocol": strings.ToUpper(protocolMode),
			"host":     config.Host,
			"port":     config.Port,
			"detail":   detail,
		})
	}
	return localizedDriverRuntimeText("db.backend.error.clickhouse_validation_failed_auto", map[string]any{
		"httpPorts": clickHouseHTTPPortHint,
		"detail":    detail,
	})
}

func withClickHouseProtocol(config connection.ConnectionConfig, protocol clickhouse.Protocol) connection.ConnectionConfig {
	next := config
	switch protocol {
	case clickhouse.HTTP:
		next.ClickHouseProtocol = clickHouseProtocolHTTP
		if next.Port == 0 {
			next.Port = 8123
		}
	default:
		next.ClickHouseProtocol = clickHouseProtocolNative
		if next.Port == 0 {
			next.Port = defaultClickHousePort
		}
	}
	return next
}

func clickHouseProtocolsForAttempt(config connection.ConnectionConfig) []clickhouse.Protocol {
	primaryProtocol := detectClickHouseProtocol(config)
	if normalizeClickHouseProtocol(config.ClickHouseProtocol) != clickHouseProtocolAuto {
		return []clickhouse.Protocol{primaryProtocol}
	}
	if primaryProtocol == clickhouse.Native {
		return []clickhouse.Protocol{primaryProtocol, clickhouse.HTTP}
	}
	return []clickhouse.Protocol{primaryProtocol, clickhouse.Native}
}
