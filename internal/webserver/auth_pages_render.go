package webserver

import (
	"html"

	"GoNavi-Wails/shared/i18n"
)

func renderAuthPage(language i18n.Language, title string, subtitle string, body string, script string) string {
	return `<!doctype html>
<html lang="` + html.EscapeString(string(language)) + `">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>` + html.EscapeString(title) + `</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #141618;
      --panel: #1b1f24;
      --panel-header: #20252b;
      --panel-border: rgba(229, 231, 235, 0.1);
      --panel-rule: rgba(229, 231, 235, 0.08);
      --text: #f3f4f6;
      --muted: #a4adb6;
      --accent: #34d399;
      --accent-strong: #10b981;
      --accent-soft: rgba(52, 211, 153, 0.16);
      --danger: #f87171;
      --field-bg: rgba(255, 255, 255, 0.03);
      --field-border: rgba(229, 231, 235, 0.1);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      font-family: Inter, "PingFang SC", "Microsoft YaHei", sans-serif;
      background: var(--bg);
      color: var(--text);
      display: grid;
      place-items: center;
      padding: 24px;
    }
    .shell {
      width: min(720px, 100%);
      border: 1px solid var(--panel-border);
      background: var(--panel);
      border-radius: 16px;
      box-shadow: 0 28px 70px rgba(0, 0, 0, 0.34);
      overflow: hidden;
    }
    .header {
      padding: 28px 28px 14px;
      border-bottom: 1px solid var(--panel-rule);
      background: var(--panel-header);
    }
    .header h1 {
      margin: 0 0 10px;
      font-size: 24px;
      line-height: 1.2;
    }
    .header p {
      margin: 0;
      color: var(--muted);
      font-size: 14px;
      line-height: 1.6;
    }
    .body {
      padding: 24px 28px 28px;
      display: grid;
      gap: 20px;
    }
    .grid {
      display: grid;
      gap: 14px;
    }
    .page-form {
      display: grid;
      gap: 18px;
    }
    .grid.two {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
    .intro {
      padding-bottom: 18px;
      color: var(--muted);
      font-size: 14px;
      line-height: 1.7;
    }
    label {
      display: grid;
      gap: 8px;
      font-size: 13px;
      color: var(--muted);
    }
    input, textarea, button {
      font: inherit;
    }
    input, textarea {
      width: 100%;
      border: 1px solid var(--field-border);
      background: var(--field-bg);
      border-radius: 10px;
      color: var(--text);
      padding: 12px 14px;
      outline: none;
    }
    textarea {
      min-height: 96px;
      resize: vertical;
    }
    input:focus, textarea:focus {
      border-color: rgba(52, 211, 153, 0.56);
      box-shadow: 0 0 0 3px var(--accent-soft);
    }
    button {
      border: none;
      border-radius: 10px;
      padding: 12px 16px;
      background: var(--accent);
      color: #06281f;
      font-weight: 700;
      cursor: pointer;
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.16);
    }
    button.secondary {
      background: rgba(255, 255, 255, 0.04);
      color: var(--text);
      border: 1px solid rgba(255, 255, 255, 0.08);
    }
    button:disabled {
      cursor: wait;
      opacity: 0.65;
    }
    .inline-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
    }
    .section {
      display: grid;
      gap: 14px;
      padding-top: 20px;
      border-top: 1px solid var(--panel-rule);
      background: transparent;
    }
    .section h2 {
      margin: 0;
      font-size: 16px;
    }
    .section.lead {
      padding-top: 0;
      border-top: none;
    }
    .wizard-nav {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 12px;
    }
    .wizard-step {
      display: grid;
      gap: 12px;
      padding: 14px 16px;
      text-align: left;
      border: 1px solid var(--panel-rule);
      border-radius: 12px;
      background: rgba(255, 255, 255, 0.02);
      color: var(--text);
      box-shadow: none;
    }
    .wizard-step:hover:not(:disabled) {
      border-color: rgba(52, 211, 153, 0.26);
      background: rgba(255, 255, 255, 0.04);
    }
    .wizard-step:disabled {
      cursor: default;
      opacity: 0.82;
    }
    .wizard-step.is-active {
      border-color: rgba(52, 211, 153, 0.42);
      background: rgba(52, 211, 153, 0.1);
    }
    .wizard-step.is-completed:not(.is-active) {
      border-color: rgba(52, 211, 153, 0.22);
      background: rgba(255, 255, 255, 0.035);
    }
    .wizard-step-head {
      display: flex;
      align-items: center;
      gap: 12px;
      min-width: 0;
    }
    .wizard-step-index {
      width: 28px;
      height: 28px;
      border-radius: 999px;
      border: 1px solid rgba(255, 255, 255, 0.16);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      color: var(--muted);
      font-size: 13px;
      font-weight: 700;
      flex-shrink: 0;
    }
    .wizard-step.is-active .wizard-step-index {
      color: var(--text);
      border-color: rgba(52, 211, 153, 0.46);
      background: rgba(52, 211, 153, 0.18);
    }
    .wizard-step.is-completed .wizard-step-index {
      color: #06281f;
      border-color: transparent;
      background: var(--accent);
    }
    .wizard-step-copy {
      display: grid;
      gap: 4px;
      min-width: 0;
    }
    .wizard-step-title {
      color: var(--text);
      font-size: 14px;
      font-weight: 700;
      line-height: 1.4;
    }
    .wizard-step-description {
      color: var(--muted);
      font-size: 12px;
      line-height: 1.5;
    }
    .wizard-step.is-active .wizard-step-description {
      color: rgba(243, 244, 246, 0.78);
    }
    .wizard-panel {
      padding-top: 0;
      border-top: none;
    }
    .wizard-panel[hidden] {
      display: none;
    }
    .step-actions {
      display: flex;
      align-items: center;
      gap: 12px;
      padding-top: 18px;
      border-top: 1px solid var(--panel-rule);
    }
    .step-action-main {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-left: auto;
    }
    .step-note {
      padding: 12px 14px;
      border-radius: 10px;
      border: 1px solid rgba(255, 255, 255, 0.08);
      background: rgba(255, 255, 255, 0.03);
      color: var(--muted);
      font-size: 13px;
      line-height: 1.6;
    }
    .section-copy {
      color: var(--muted);
      font-size: 13px;
      line-height: 1.7;
    }
    .qr-shell {
      display: grid;
      grid-template-columns: minmax(180px, 232px) minmax(0, 1fr);
      gap: 18px;
      align-items: center;
    }
    .qr-shell img {
      width: min(232px, 100%);
      aspect-ratio: 1;
      object-fit: contain;
      border-radius: 10px;
      background: #ffffff;
      padding: 12px;
      justify-self: center;
      box-shadow: 0 12px 28px rgba(0, 0, 0, 0.18);
    }
    .qr-copy {
      display: grid;
      gap: 10px;
      align-content: start;
    }
    .muted {
      color: var(--muted);
      font-size: 13px;
      line-height: 1.6;
    }
    .error {
      display: none;
      padding: 12px 14px;
      border-radius: 10px;
      border: 1px solid rgba(248, 113, 113, 0.28);
      background: rgba(127, 29, 29, 0.22);
      color: #fecaca;
      font-size: 13px;
      line-height: 1.5;
    }
    .info-list {
      margin: 0;
      padding-left: 18px;
      color: var(--muted);
      font-size: 13px;
      line-height: 1.7;
    }
    .code-list {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px;
      margin: 0;
      padding: 0;
      list-style: none;
    }
    .code-item {
      border-radius: 10px;
      border: 1px solid rgba(255, 255, 255, 0.08);
      background: rgba(255, 255, 255, 0.03);
      padding: 10px 12px;
      font-family: Consolas, "SFMono-Regular", monospace;
      letter-spacing: 0;
    }
    .checkbox {
      display: flex;
      align-items: center;
      gap: 10px;
      color: var(--text);
      font-size: 14px;
    }
    .checkbox input {
      width: 16px;
      height: 16px;
      margin: 0;
      padding: 0;
      accent-color: var(--accent);
    }
    .footer-note {
      color: var(--muted);
      font-size: 12px;
      line-height: 1.6;
    }
    @media (max-width: 760px) {
      body { padding: 16px; }
      .grid.two, .code-list, .qr-shell, .wizard-nav { grid-template-columns: 1fr; }
      .step-actions { align-items: stretch; flex-direction: column-reverse; }
      .step-action-main { width: 100%; margin-left: 0; }
      .step-action-main button, .step-actions > button { width: 100%; }
      .header, .body { padding-left: 18px; padding-right: 18px; }
      .qr-shell img { width: min(220px, 100%); }
    }
  </style>
</head>
<body>
  <main class="shell">
    <header class="header">
      <h1>` + html.EscapeString(title) + `</h1>
      <p>` + html.EscapeString(subtitle) + `</p>
    </header>
    <section class="body">` + body + `</section>
  </main>
  <script>` + renderAuthBootstrapScript(language) + script + `</script>
</body>
</html>`
}

func renderAuthBootstrapScript(language i18n.Language) string {
	return `
const __gonaviWebAuthPage = ` + mustJSON(map[string]string{
		"language":   string(language),
		"cookieName": webAuthLanguageCookieName,
		"storageKey": webAuthFrontendStorageKey,
	}) + `;

(function syncAuthPageLanguage() {
  const normalizeLanguage = (value) => {
    if (typeof value !== 'string') return null;
    const normalized = value.trim().replace(/_/g, '-').toLowerCase();
    if (!normalized) return null;
    if (normalized === 'zh-tw' || normalized === 'zh-hk' || normalized === 'zh-mo') return 'zh-TW';
    if (normalized === 'zh' || normalized === 'zh-cn' || normalized === 'zh-sg') return 'zh-CN';
    if (normalized === 'en-us' || normalized.startsWith('en-')) return 'en-US';
    if (normalized === 'ja' || normalized.startsWith('ja-')) return 'ja-JP';
    if (normalized === 'de' || normalized.startsWith('de-')) return 'de-DE';
    if (normalized === 'ru' || normalized.startsWith('ru-')) return 'ru-RU';
    return null;
  };

  const resolveStoredLanguage = () => {
    try {
      if (!window.localStorage) return null;
      const payload = window.localStorage.getItem(__gonaviWebAuthPage.storageKey);
      if (!payload) return null;
      const parsed = JSON.parse(payload);
      const state = parsed && typeof parsed === 'object' && parsed.state && typeof parsed.state === 'object'
        ? parsed.state
        : parsed;
      const preference = state && typeof state === 'object' ? state.languagePreference : null;
      if (preference === 'system') {
        const systemLanguages = Array.isArray(navigator.languages) && navigator.languages.length > 0
          ? navigator.languages
          : [navigator.language];
        for (const candidate of systemLanguages) {
          const resolved = normalizeLanguage(candidate);
          if (resolved) return resolved;
        }
        return null;
      }
      return normalizeLanguage(preference);
    } catch (_) {
      return null;
    }
  };

  const syncCookie = (language) => {
    document.cookie = __gonaviWebAuthPage.cookieName + '=' + encodeURIComponent(language) + '; Path=/; Max-Age=31536000; SameSite=Lax';
  };

  const storedLanguage = resolveStoredLanguage();
  if (!storedLanguage || storedLanguage === __gonaviWebAuthPage.language) {
    syncCookie(__gonaviWebAuthPage.language);
    return;
  }

  syncCookie(storedLanguage);
  const url = new URL(window.location.href);
  if (url.searchParams.get('lang') !== storedLanguage) {
    url.searchParams.set('lang', storedLanguage);
    window.location.replace(url.toString());
  }
})();
`
}
