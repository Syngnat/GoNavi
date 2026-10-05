package webserver

import (
	"fmt"

	"GoNavi-Wails/shared/i18n"
)

func renderSetupBody(localizer *i18n.Localizer) string {
	return `
<div id="error" class="error"></div>
<div class="intro">` + webAuthHTML(localizer, "web_auth.page.setup.intro", nil) + `</div>
<div class="wizard-nav" id="setup-steps">
  <button type="button" class="wizard-step is-active" data-step-target="0" aria-current="step">
    <span class="wizard-step-head">
      <span class="wizard-step-index">1</span>
      <span class="wizard-step-copy">
        <span class="wizard-step-title">` + webAuthHTML(localizer, "web_auth.page.setup.step_admin_title", nil) + `</span>
        <span class="wizard-step-description">` + webAuthHTML(localizer, "web_auth.page.setup.step_admin_description", nil) + `</span>
      </span>
    </span>
  </button>
  <button type="button" class="wizard-step" data-step-target="1" disabled>
    <span class="wizard-step-head">
      <span class="wizard-step-index">2</span>
      <span class="wizard-step-copy">
        <span class="wizard-step-title">` + webAuthHTML(localizer, "web_auth.page.setup.step_totp_title", nil) + `</span>
        <span class="wizard-step-description">` + webAuthHTML(localizer, "web_auth.page.setup.step_totp_description", nil) + `</span>
      </span>
    </span>
  </button>
  <button type="button" class="wizard-step" data-step-target="2" disabled>
    <span class="wizard-step-head">
      <span class="wizard-step-index">3</span>
      <span class="wizard-step-copy">
        <span class="wizard-step-title">` + webAuthHTML(localizer, "web_auth.page.setup.step_session_title", nil) + `</span>
        <span class="wizard-step-description">` + webAuthHTML(localizer, "web_auth.page.setup.step_session_description", nil) + `</span>
      </span>
    </span>
  </button>
</div>
<form id="setup-form" class="page-form">
  <div class="section lead wizard-panel" data-step-panel="0">
    <h2>` + webAuthHTML(localizer, "web_auth.page.setup.admin_title", nil) + `</h2>
    <div class="section-copy">` + webAuthHTML(localizer, "web_auth.page.setup.step_admin_hint", nil) + `</div>
    <label>
      ` + webAuthHTML(localizer, "web_auth.page.setup.password_label", nil) + `
      <input id="password" type="password" autocomplete="new-password" placeholder="` + webAuthHTML(localizer, "web_auth.page.setup.password_placeholder", nil) + `">
    </label>
    <label>
      ` + webAuthHTML(localizer, "web_auth.page.setup.confirm_label", nil) + `
      <input id="confirm-password" type="password" autocomplete="new-password" placeholder="` + webAuthHTML(localizer, "web_auth.page.setup.confirm_placeholder", nil) + `">
    </label>
    <label class="checkbox">
      <input id="enable-totp" type="checkbox" checked>
      ` + webAuthHTML(localizer, "web_auth.page.setup.enable_totp", nil) + `
    </label>
  </div>
  <div class="section wizard-panel" data-step-panel="1" hidden>
    <h2>` + webAuthHTML(localizer, "web_auth.page.setup.totp_title", nil) + `</h2>
    <div class="section-copy">` + webAuthHTML(localizer, "web_auth.page.setup.step_totp_hint", nil) + `</div>
    <div id="totp-config" class="grid">
      <div class="section-copy">` + webAuthHTML(localizer, "web_auth.page.setup.totp_description", nil) + `</div>
      <div class="qr-shell">
        <img id="totp-qr-code" alt="` + webAuthHTML(localizer, "web_auth.page.setup.qr_alt", nil) + `">
        <div class="qr-copy">
          <div class="muted">` + webAuthHTML(localizer, "web_auth.page.setup.totp_clients", nil) + `</div>
          <div class="muted">` + webAuthHTML(localizer, "web_auth.page.setup.totp_naming", nil) + `</div>
        </div>
      </div>
      <div class="grid two">
        <label>
          ` + webAuthHTML(localizer, "web_auth.page.setup.issuer_label", nil) + `
          <input id="issuer" type="text" readonly>
        </label>
        <label>
          ` + webAuthHTML(localizer, "web_auth.page.setup.account_label", nil) + `
          <input id="account-name" type="text" readonly>
        </label>
      </div>
      <label>
        ` + webAuthHTML(localizer, "web_auth.page.setup.secret_label", nil) + `
        <input id="secret" type="text" readonly>
      </label>
      <div class="inline-actions">
        <button id="copy-secret" type="button" class="secondary">` + webAuthHTML(localizer, "web_auth.page.setup.copy_secret", nil) + `</button>
        <button id="copy-uri" type="button" class="secondary">` + webAuthHTML(localizer, "web_auth.page.setup.copy_uri", nil) + `</button>
      </div>
      <label>
        ` + webAuthHTML(localizer, "web_auth.page.setup.otpauth_label", nil) + `
        <textarea id="otpauth-url" readonly></textarea>
      </label>
      <label>
        ` + webAuthHTML(localizer, "web_auth.page.setup.first_code_label", nil) + `
        <input id="code" type="text" inputmode="numeric" autocomplete="one-time-code" placeholder="` + webAuthHTML(localizer, "web_auth.page.setup.first_code_placeholder", nil) + `">
      </label>
      <div>
        <div class="muted">` + webAuthHTML(localizer, "web_auth.page.setup.recovery_intro", nil) + `</div>
        <ul id="recovery-codes" class="code-list"></ul>
      </div>
    </div>
    <div id="totp-disabled-note" class="step-note" hidden>` + webAuthHTML(localizer, "web_auth.page.setup.totp_disabled_note", nil) + `</div>
  </div>
  <div class="section wizard-panel" data-step-panel="2" hidden>
    <h2>` + webAuthHTML(localizer, "web_auth.page.setup.session_title", nil) + `</h2>
    <div class="section-copy">` + webAuthHTML(localizer, "web_auth.page.setup.step_session_hint", nil) + `</div>
    <div class="grid two">
      <label>
        ` + webAuthHTML(localizer, "web_auth.page.setup.idle_label", nil) + `
        <input id="idle-minutes" type="number" min="5" max="1440" value="30">
      </label>
      <label>
        ` + webAuthHTML(localizer, "web_auth.page.setup.absolute_label", nil) + `
        <input id="absolute-hours" type="number" min="1" max="720" value="168">
      </label>
    </div>
    <label>
      ` + webAuthHTML(localizer, "web_auth.page.setup.remember_label", nil) + `
      <input id="remember-days" type="number" min="1" max="30" value="7">
    </label>
    <div class="footer-note">` + webAuthHTML(localizer, "web_auth.page.setup.footer_note", nil) + `</div>
  </div>
  <div class="step-actions">
    <button id="back-step" type="button" class="secondary" hidden>` + webAuthHTML(localizer, "web_auth.page.setup.back", nil) + `</button>
    <div class="step-action-main">
      <button id="next-step" type="button">` + webAuthHTML(localizer, "web_auth.page.setup.next", nil) + `</button>
      <button id="submit" type="submit" hidden>` + webAuthHTML(localizer, "web_auth.page.setup.submit", nil) + `</button>
    </div>
  </div>
</form>`
}

func renderSetupScript(localizer *i18n.Localizer) string {
	return `
const i18n = ` + mustJSON(map[string]string{
		"initFailed":              webAuthText(localizer, "web_auth.error.init_failed", nil),
		"initInfoFailed":          webAuthText(localizer, "web_auth.error.init_info_failed", nil),
		"setupInfoExpired":        webAuthText(localizer, "web_auth.error.setup_info_expired", nil),
		"copyManual":              webAuthText(localizer, "web_auth.error.copy_manual", nil),
		"passwordRequired":        webAuthText(localizer, "web_auth.error.password_required", nil),
		"passwordTooShort":        webAuthText(localizer, "web_auth.error.password_min_length", map[string]any{"count": webMinPasswordLength}),
		"passwordConfirmMismatch": webAuthText(localizer, "web_auth.error.password_confirmation_mismatch", nil),
		"totpCodeRequired":        webAuthText(localizer, "web_auth.error.totp_code_required", nil),
	}) + `;
const errorEl = document.getElementById('error');
const setupFormEl = document.getElementById('setup-form');
const passwordEl = document.getElementById('password');
const confirmPasswordEl = document.getElementById('confirm-password');
const codeEl = document.getElementById('code');
const submitEl = document.getElementById('submit');
const nextStepEl = document.getElementById('next-step');
const backStepEl = document.getElementById('back-step');
const enableTotpEl = document.getElementById('enable-totp');
const totpConfigEl = document.getElementById('totp-config');
const totpDisabledNoteEl = document.getElementById('totp-disabled-note');
const stepButtons = Array.from(document.querySelectorAll('[data-step-target]'));
const stepPanels = Array.from(document.querySelectorAll('[data-step-panel]'));
` + authSafeNextTargetScript + `
const nextTarget = safeNextTarget(new URLSearchParams(window.location.search).get('next'));
let bootstrapState = null;
let currentStep = 0;
const lastStepIndex = stepPanels.length - 1;

function showError(message) {
  errorEl.textContent = message || i18n.initFailed;
  errorEl.style.display = 'block';
}

function clearError() {
  errorEl.textContent = '';
  errorEl.style.display = 'none';
}

function toggleTotpSection() {
  const enabled = enableTotpEl.checked;
  totpConfigEl.hidden = !enabled;
  totpDisabledNoteEl.hidden = enabled;
}

function getWizardPath() {
  return enableTotpEl.checked ? [0, 1, 2] : [0, 2];
}

function normalizeCurrentStep() {
  const path = getWizardPath();
  if (path.includes(currentStep)) {
    return;
  }
  currentStep = path.find((step) => step > currentStep) ?? path[path.length - 1];
}

function getPathIndex(step) {
  return getWizardPath().indexOf(step);
}

function getAdjacentStep(step, direction) {
  const path = getWizardPath();
  const currentIndex = path.indexOf(step);
  if (currentIndex === -1) {
    return path[0];
  }
  const targetIndex = Math.max(0, Math.min(path.length - 1, currentIndex + direction));
  return path[targetIndex];
}

async function copyText(value) {
  const text = String(value || '');
  if (!text) return;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  window.prompt(i18n.copyManual, text);
}

function updateWizard() {
  normalizeCurrentStep();
  const path = getWizardPath();
  const currentPathIndex = getPathIndex(currentStep);
  const lastActiveStep = path[path.length - 1];
  let visibleStepIndex = 1;
  stepPanels.forEach((panel) => {
    const step = Number(panel.dataset.stepPanel || 0);
    panel.hidden = step !== currentStep;
  });
  stepButtons.forEach((button) => {
    const step = Number(button.dataset.stepTarget || 0);
    const inPath = path.includes(step);
    const stepIndexEl = button.querySelector('.wizard-step-index');
    button.hidden = !inPath;
    if (!inPath) {
      button.disabled = true;
      button.classList.remove('is-active', 'is-completed');
      button.removeAttribute('aria-current');
      return;
    }
    if (stepIndexEl) {
      stepIndexEl.textContent = String(visibleStepIndex);
    }
    visibleStepIndex += 1;
    const pathIndex = getPathIndex(step);
    button.disabled = pathIndex > currentPathIndex;
    button.classList.toggle('is-active', step === currentStep);
    button.classList.toggle('is-completed', pathIndex < currentPathIndex);
    if (step === currentStep) {
      button.setAttribute('aria-current', 'step');
    } else {
      button.removeAttribute('aria-current');
    }
  });
  backStepEl.hidden = currentStep === 0;
  nextStepEl.hidden = currentStep >= lastActiveStep;
  submitEl.hidden = currentStep !== lastActiveStep;
}

function validateStep(stepIndex) {
  if (stepIndex === 0) {
    const password = String(passwordEl.value || '').trim();
    const confirmPassword = String(confirmPasswordEl.value || '').trim();
    if (!password) {
      showError(i18n.passwordRequired);
      return false;
    }
    if (Array.from(password).length < ` + fmt.Sprintf("%d", webMinPasswordLength) + `) {
      showError(i18n.passwordTooShort);
      return false;
    }
    if (password !== confirmPassword) {
      showError(i18n.passwordConfirmMismatch);
      return false;
    }
  }
  if (stepIndex === 1 && enableTotpEl.checked && !String(codeEl.value || '').trim()) {
    showError(i18n.totpCodeRequired);
    return false;
  }
  return true;
}

function goToStep(nextStep, options) {
  const validateCurrent = !options || options.validateCurrent !== false;
  const path = getWizardPath();
  const requestedStep = Number(nextStep || 0);
  const boundedStep = path.includes(requestedStep) ? requestedStep : (path.find((step) => step >= requestedStep) ?? path[path.length - 1]);
  if (boundedStep > currentStep && validateCurrent && !validateStep(currentStep)) {
    return;
  }
  clearError();
  currentStep = boundedStep;
  updateWizard();
}

async function bootstrapSetup() {
  try {
    clearError();
    const statusResponse = await fetch('` + internalRoutePrefix + `/auth/status', {
      credentials: 'same-origin',
      cache: 'no-store'
    });
    const statusPayload = await statusResponse.json().catch(() => ({}));
    if (statusPayload.configured) {
      const target = statusPayload.authenticated ? nextTarget : '/login?next=' + encodeURIComponent(nextTarget);
      window.location.replace(target);
      return;
    }
    const response = await fetch('` + internalRoutePrefix + `/auth/setup/bootstrap', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json'
      },
      body: '{}'
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.error) {
      showError(payload.error || i18n.initInfoFailed);
      return;
    }
    bootstrapState = payload;
    document.getElementById('issuer').value = payload.issuer || '';
    document.getElementById('account-name').value = payload.accountName || '';
    document.getElementById('secret').value = payload.secret || '';
    document.getElementById('otpauth-url').value = payload.otpauthUrl || '';
    document.getElementById('totp-qr-code').src = payload.qrCodeDataUrl || '';
    document.getElementById('idle-minutes').value = String(payload.sessionIdleMinutes || 30);
    document.getElementById('absolute-hours').value = String(payload.sessionAbsoluteHours || 168);
    document.getElementById('remember-days').value = String(payload.sessionRememberDays || 7);
    const codesEl = document.getElementById('recovery-codes');
    codesEl.innerHTML = '';
    (payload.recoveryCodes || []).forEach((item) => {
      const li = document.createElement('li');
      li.className = 'code-item';
      li.textContent = item;
      codesEl.appendChild(li);
    });
    updateWizard();
  } catch (_) {
    showError(i18n.initInfoFailed);
    return;
  }
}

document.getElementById('copy-secret').addEventListener('click', () => {
  void copyText(document.getElementById('secret').value);
});

document.getElementById('copy-uri').addEventListener('click', () => {
  void copyText(document.getElementById('otpauth-url').value);
});

enableTotpEl.addEventListener('change', () => {
  toggleTotpSection();
  updateWizard();
});
stepButtons.forEach((button) => {
  button.addEventListener('click', () => {
    const targetStep = Number(button.dataset.stepTarget || 0);
    if (getPathIndex(targetStep) !== -1 && getPathIndex(targetStep) <= getPathIndex(currentStep)) {
      goToStep(targetStep, { validateCurrent: false });
    }
  });
});
backStepEl.addEventListener('click', () => {
  goToStep(getAdjacentStep(currentStep, -1), { validateCurrent: false });
});
nextStepEl.addEventListener('click', () => {
  goToStep(getAdjacentStep(currentStep, 1));
});
toggleTotpSection();
updateWizard();

setupFormEl.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (currentStep !== getWizardPath()[getWizardPath().length - 1]) {
    goToStep(getAdjacentStep(currentStep, 1));
    return;
  }
  clearError();
  if (!validateStep(0)) {
    currentStep = 0;
    updateWizard();
    return;
  }
  if (!validateStep(1)) {
    currentStep = 1;
    updateWizard();
    return;
  }
  if (!bootstrapState || !bootstrapState.setupToken) {
    showError(i18n.setupInfoExpired);
    return;
  }
  submitEl.disabled = true;
  try {
    const response = await fetch('` + internalRoutePrefix + `/auth/setup/complete', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        setupToken: bootstrapState.setupToken,
        password: document.getElementById('password').value || '',
        confirmPassword: document.getElementById('confirm-password').value || '',
        code: document.getElementById('code').value || '',
        enableTotp: enableTotpEl.checked,
        sessionIdleMinutes: Number(document.getElementById('idle-minutes').value || 30),
        sessionAbsoluteHours: Number(document.getElementById('absolute-hours').value || 168),
        sessionRememberDays: Number(document.getElementById('remember-days').value || 7)
      })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.error) {
      showError(payload.error || i18n.initFailed);
      submitEl.disabled = false;
      return;
    }
    window.location.replace(nextTarget);
  } catch (_) {
    showError(i18n.initFailed);
    submitEl.disabled = false;
  }
});

void bootstrapSetup();`
}
