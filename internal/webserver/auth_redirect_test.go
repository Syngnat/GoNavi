package webserver

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"GoNavi-Wails/shared/i18n"
)

// TestIsSafeLocalRedirectRejectsOffSiteTargets 覆盖服务端 next 参数的站内判定。
//
// 回归背景：原判定只拒绝 "//host"，漏掉 "/\host"。WHATWG URL 解析器对 http/https 这类
// special scheme 把反斜杠等价于斜杠，因此 "/\evil.com" 会被浏览器解析成 "//evil.com"
// 而变成跨站跳转。
func TestIsSafeLocalRedirectRejectsOffSiteTargets(t *testing.T) {
	safe := []string{"/", "/table/x", "/table/x?a=1#f", "/setup"}
	for _, next := range safe {
		if !isSafeLocalRedirect(next) {
			t.Errorf("isSafeLocalRedirect(%q) = false，期望 true", next)
		}
	}

	unsafe := []string{
		"//evil.com",
		`/\evil.com`,
		"https://evil.com",
		"http://evil.com",
		"javascript:alert(1)",
		"data:text/html,<script>alert(1)</script>",
		"evil.com",
		"",
	}
	for _, next := range unsafe {
		if isSafeLocalRedirect(next) {
			t.Errorf("isSafeLocalRedirect(%q) = true，期望 false", next)
		}
	}
}

// TestResolvePostAuthRedirectNormalizesUnsafeNext 服务端跳转必须归一到 "/"。
func TestResolvePostAuthRedirectNormalizesUnsafeNext(t *testing.T) {
	cases := map[string]string{
		"/table/x":         "/table/x",
		"//evil.com":       "/",
		`/\evil.com`:       "/",
		"javascript:x=1":   "/",
		"https://evil.com": "/",
		"":                 "/",
	}
	for next, want := range cases {
		req := httptest.NewRequest(http.MethodGet, "/login", nil)
		q := req.URL.Query()
		if next != "" {
			q.Set("next", next)
		}
		req.URL.RawQuery = q.Encode()

		if got := resolvePostAuthRedirect(req); got != want {
			t.Errorf("resolvePostAuthRedirect(next=%q) = %q，期望 %q", next, got, want)
		}
	}
}

// TestBuildAuthRedirectURLDropsUnsafeNext 构造跳转链接时不得回传不安全的 next。
func TestBuildAuthRedirectURLDropsUnsafeNext(t *testing.T) {
	if got := buildAuthRedirectURL("/login", `/\evil.com`); got != "/login" {
		t.Errorf(`buildAuthRedirectURL("/login", "/\\evil.com") = %q，期望 "/login"（不应回传不安全 next）`, got)
	}
	if got := buildAuthRedirectURL("/login", "//evil.com"); got != "/login" {
		t.Errorf(`buildAuthRedirectURL 未丢弃 "//evil.com"，得到 %q`, got)
	}
	if got := buildAuthRedirectURL("/login", "/table/x"); !strings.Contains(got, "next=%2Ftable%2Fx") {
		t.Errorf("buildAuthRedirectURL 未保留安全 next，得到 %q", got)
	}
}

// TestAuthPageScriptsNormalizeNextTargetBeforeNavigation 覆盖真正的 sink：
// 两个页面脚本都在客户端用 location.search 重读原始 next，服务端过滤对它们无效，
// 必须经 safeNextTarget 归一化后才能交给 window.location.replace。
func TestAuthPageScriptsNormalizeNextTargetBeforeNavigation(t *testing.T) {
	localizer, err := i18n.NewLocalizer("zh-CN")
	if err != nil {
		t.Fatalf("构造 localizer 失败：%v", err)
	}

	scripts := map[string]string{
		"login": renderLoginScript(localizer),
		"setup": renderSetupScript(localizer),
	}
	for name, script := range scripts {
		if !strings.Contains(script, "function safeNextTarget(") {
			t.Errorf("%s 页脚本缺少 safeNextTarget 归一化函数", name)
		}
		if !strings.Contains(script, "const nextTarget = safeNextTarget(") {
			t.Errorf("%s 页脚本未把 nextTarget 交给 safeNextTarget 归一化", name)
		}
		// 不允许再出现未经归一化的裸读法。
		if strings.Contains(script, "get('next') || '/'") {
			t.Errorf("%s 页脚本仍存在未归一化的 next 裸读", name)
		}
		// 归一化必须用 URL 解析器做同源判定，而非字符串前缀。
		if !strings.Contains(script, "parsed.origin !== window.location.origin") {
			t.Errorf("%s 页脚本未用 origin 比较做同源判定", name)
		}
	}
}
