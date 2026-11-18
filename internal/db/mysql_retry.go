package db

import (
	"context"
	"errors"
	"net"
	"strings"
)

// shouldRetryMySQLCompatibilityPlan 判断默认连接计划失败后是否值得用
// multiStatements=false 再试一次。网络、超时、认证、选库和 TLS 错误与
// multiStatements 无关，重复建连只会放大等待和账号/代理压力。
func shouldRetryMySQLCompatibilityPlan(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return false
	}
	var netErr net.Error
	if errors.As(err, &netErr) && netErr.Timeout() {
		return false
	}

	text := strings.ToLower(err.Error())
	noRetryHints := []string{
		"i/o timeout",
		"connection timed out",
		"deadline exceeded",
		"context canceled",
		"connection refused",
		"no route to host",
		"network is unreachable",
		"access denied",
		"password authentication failed",
		"error 1045",
		"28p01",
		"unknown database",
		"error 1049",
		"certificate",
		"x509",
		"tls handshake",
		"invalid connection",
		"unexpected eof",
		"connection reset by peer",
		"broken pipe",
	}
	for _, hint := range noRetryHints {
		if strings.Contains(text, hint) {
			return false
		}
	}
	return true
}
