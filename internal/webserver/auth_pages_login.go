package webserver

import (
	"encoding/json"
	"net/http"

	"GoNavi-Wails/shared/i18n"
)

func renderLoginBody(localizer *i18n.Localizer) string {
	return `
<div id="error" class="error"></div>
<div class="section lead">
  <h2>` + webAuthHTML(localizer, "web_auth.page.login.heading", nil) + `</h2>
  <div class="section-copy">` + webAuthHTML(localizer, "web_auth.page.login.description", nil) + `</div>
  <form id="login-form" class="grid">
    <label>
      ` + webAuthHTML(localizer, "web_auth.page.login.password_label", nil) + `
      <input id="password" type="password" autocomplete="current-password" placeholder="` + webAuthHTML(localizer, "web_auth.page.login.password_placeholder", nil) + `">
    </label>
    <label id="code-wrap">
      ` + webAuthHTML(localizer, "web_auth.page.login.code_label", nil) + `
      <input id="code" type="text" inputmode="numeric" autocomplete="one-time-code" placeholder="` + webAuthHTML(localizer, "web_auth.page.login.code_placeholder", nil) + `">
    </label>
    <button id="submit" type="submit">` + webAuthHTML(localizer, "web_auth.page.login.submit", nil) + `</button>
  </form>
</div>
<div class="section">
  <h2>` + webAuthHTML(localizer, "web_auth.page.login.security_title", nil) + `</h2>
  <ul class="info-list">
    <li>` + webAuthHTML(localizer, "web_auth.page.login.security_cookie", nil) + `</li>
    <li>` + webAuthHTML(localizer, "web_auth.page.login.security_recovery", nil) + `</li>
    <li>` + webAuthHTML(localizer, "web_auth.page.login.security_rate_limit", nil) + `</li>
  </ul>
</div>`
}

// authSafeNextTargetScript 是登录页与初始化页共用的 next 参数归一化脚本。
//
// 这两个页面都在客户端用 location.search 重新读取原始 next，因此服务端
// resolvePostAuthRedirect / buildAuthRedirectURL 的过滤对它们完全无效，必须在客户端再做一次。
// 未归一化时 ?next=javascript:... 会经 window.location.replace(nextTarget) 在页面自身源内执行
// （HTML 规范只阻止跨源的 javascript: 导航，同文档自导航是允许的，且返回 undefined 时页面不跳转，
// 更难察觉），进而可携带会话 Cookie 调用 /__gonavi/api/invoke 读取全部已保存连接并执行任意 SQL。
//
// 用 URL 解析器判定同源而非字符串前缀：javascript:/data: 这类 URL 的 origin 为 "null"，
// 与页面 origin 不等；同时一并挡掉 //evil.com、/\evil.com、https://evil.com。
const authSafeNextTargetScript = `
function safeNextTarget(raw) {
  try {
    const parsed = new URL(String(raw || '/'), window.location.origin);
    if (parsed.origin !== window.location.origin) {
      return '/';
    }
    return parsed.pathname + parsed.search + parsed.hash;
  } catch (err) {
    return '/';
  }
}`

func renderLoginScript(localizer *i18n.Localizer) string {
	return `
const i18n = ` + mustJSON(map[string]string{
		"loginFailed":      webAuthText(localizer, "web_auth.error.login_failed", nil),
		"loadStatusFailed": webAuthText(localizer, "web_auth.error.load_status_failed", nil),
		"retryAfter":       webAuthText(localizer, "web_auth.error.retry_after_seconds", nil),
	}) + `;
const errorEl = document.getElementById('error');
const formEl = document.getElementById('login-form');
const submitEl = document.getElementById('submit');
const codeWrapEl = document.getElementById('code-wrap');
` + authSafeNextTargetScript + `
const nextTarget = safeNextTarget(new URLSearchParams(window.location.search).get('next'));

function showError(message) {
  errorEl.textContent = message || i18n.loginFailed;
  errorEl.style.display = 'block';
}

function clearError() {
  errorEl.textContent = '';
  errorEl.style.display = 'none';
}

async function loadStatus() {
  const response = await fetch('` + internalRoutePrefix + `/auth/status', {
    credentials: 'same-origin',
    cache: 'no-store'
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    showError(payload.error || i18n.loadStatusFailed);
    return;
  }
  if (!payload.configured) {
    window.location.replace('/setup?next=' + encodeURIComponent(nextTarget));
    return;
  }
  codeWrapEl.hidden = payload.totpEnabled !== true;
}

formEl.addEventListener('submit', async (event) => {
  event.preventDefault();
  clearError();
  submitEl.disabled = true;
  try {
    const response = await fetch('` + internalRoutePrefix + `/auth/login', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        password: document.getElementById('password').value || '',
        code: document.getElementById('code').value || ''
      })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.error) {
      const retryAfter = Number(payload.retryAfterSeconds || 0);
      const suffix = retryAfter > 0 ? i18n.retryAfter.replace('{{seconds}}', String(retryAfter)) : '';
      showError((payload.error || i18n.loginFailed) + suffix);
      submitEl.disabled = false;
      return;
    }
    window.location.replace(nextTarget);
  } catch (_) {
    showError(i18n.loginFailed);
    submitEl.disabled = false;
  }
});

void loadStatus();`
}

func mustJSON(value any) string {
	payload, err := json.Marshal(value)
	if err != nil {
		return "{}"
	}
	return string(payload)
}

func withSecurityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "same-origin")
		w.Header().Set("Permissions-Policy", "geolocation=(), microphone=(), camera=()")
		next.ServeHTTP(w, r)
	})
}
