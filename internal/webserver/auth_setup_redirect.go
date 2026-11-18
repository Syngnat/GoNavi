package webserver

import (
	"crypto/subtle"
	"net"
	"net/http"
	"net/url"
	"strings"
)

// listenHostIsLoopback 判断监听地址是否只接受本机回环连接。
//
// 0.0.0.0 / :: 在浏览器里也会显示成 127.0.0.1，但局域网仍然连得上。
// 初始化令牌不能放进这种监听的 HTTP 跳转，否则谁先访问谁就能抢注管理员。
func listenHostIsLoopback(addr string) bool {
	host := strings.TrimSpace(addr)
	if parsedHost, _, err := net.SplitHostPort(host); err == nil {
		host = parsedHost
	}
	host = strings.Trim(host, "[]")
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func (s *Server) listenAddr() string {
	if s == nil {
		return ""
	}
	if addr, ok := s.boundAddr.Load().(string); ok && strings.TrimSpace(addr) != "" {
		return addr
	}
	return strings.TrimSpace(s.options.Addr)
}

// localSetupGateToken 只在回环监听且尚未初始化时返回门禁令牌。
func (s *Server) localSetupGateToken() string {
	if s == nil || s.auth == nil || s.auth.Status("").Configured {
		return ""
	}
	if !listenHostIsLoopback(s.listenAddr()) {
		return ""
	}
	return strings.TrimSpace(s.auth.SetupToken())
}

// buildSetupRedirectURL 构造首次初始化跳转。
// 回环监听会带上 setup 令牌，用户自己打开启动地址时不再先看到缺令牌错误。
func (s *Server) buildSetupRedirectURL(next string) string {
	target := buildAuthRedirectURL("/setup", next)
	token := s.localSetupGateToken()
	if token == "" {
		return target
	}
	parsed, err := url.Parse(target)
	if err != nil {
		return target
	}
	query := parsed.Query()
	if strings.TrimSpace(query.Get("setup")) != "" {
		return target
	}
	query.Set("setup", token)
	parsed.RawQuery = query.Encode()
	return parsed.String()
}

// redirectMissingLocalSetupGate 给已经落到 /setup 但没有正确令牌的本机请求补上令牌。
// 根路径会先跳到 /setup?next=/，这正是用户看到缺令牌报错的地址。
func (s *Server) redirectMissingLocalSetupGate(w http.ResponseWriter, r *http.Request) bool {
	token := s.localSetupGateToken()
	if token == "" || r == nil || r.URL == nil {
		return false
	}
	provided := strings.TrimSpace(r.URL.Query().Get("setup"))
	if subtle.ConstantTimeCompare([]byte(provided), []byte(token)) == 1 {
		return false
	}
	next := strings.TrimSpace(r.URL.Query().Get("next"))
	if next == "" {
		next = "/"
	}
	http.Redirect(w, r, s.buildSetupRedirectURL(next), http.StatusSeeOther)
	return true
}
