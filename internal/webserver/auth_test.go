package webserver

import (
	"errors"
	"os"
	"strings"
	"testing"
	"time"
)

func TestHashPasswordAndVerify(t *testing.T) {
	hash, err := hashPassword("strong-password-123")
	if err != nil {
		t.Fatalf("hashPassword failed: %v", err)
	}
	if !verifyPassword(hash, "strong-password-123") {
		t.Fatalf("expected password verification to succeed")
	}
	if verifyPassword(hash, "wrong-password") {
		t.Fatalf("expected password verification to fail for wrong password")
	}
}

func TestTOTPValidationAcceptsCurrentWindow(t *testing.T) {
	secret := "JBSWY3DPEHPK3PXP"
	now := time.Unix(1_720_000_000, 0).UTC()
	code, err := generateTOTPCodeAt(secret, now)
	if err != nil {
		t.Fatalf("generateTOTPCodeAt failed: %v", err)
	}
	if !validateTOTPCode(secret, code, now) {
		t.Fatalf("expected TOTP validation to accept current time window")
	}
	if validateTOTPCode(secret, "000000", now) {
		t.Fatalf("expected TOTP validation to reject invalid code")
	}
}

func TestConsumeRecoveryCodeRemovesUsedCode(t *testing.T) {
	cfg := normalizeWebAuthConfig(webAuthConfig{
		Enabled: true,
		Users: []webAuthUser{{
			Username:           webDefaultAdminUsername,
			PasswordHash:       "hash",
			Role:               webRoleAdmin,
			TOTPEnabled:        true,
			TOTPSecret:         "JBSWY3DPEHPK3PXP",
			RecoveryCodeHashes: []string{hashRecoveryCode("ABCD-EFGH-IJKL"), hashRecoveryCode("MNOP-QRST-UVWX")},
		}},
	})

	next, consumed := consumeUserRecoveryCode(cfg, webDefaultAdminUsername, "abcd efgh ijkl")
	if !consumed {
		t.Fatalf("expected recovery code to be consumed")
	}
	if len(next.Users[0].RecoveryCodeHashes) != 1 {
		t.Fatalf("expected one recovery code to remain, got %d", len(next.Users[0].RecoveryCodeHashes))
	}
	if next.Users[0].RecoveryCodeHashes[0] != hashRecoveryCode("MNOP-QRST-UVWX") {
		t.Fatalf("unexpected remaining recovery code hash: %q", next.Users[0].RecoveryCodeHashes[0])
	}
}

func TestWebSessionManagerExpiresIdleAndAbsolute(t *testing.T) {
	manager := newWebSessionManager()
	cfg := normalizeWebAuthConfig(webAuthConfig{
		Enabled:              true,
		PasswordHash:         "hash",
		SessionIdleMinutes:   5,
		SessionAbsoluteHours: 1,
		SessionRememberDays:  1,
	})
	start := time.Unix(1_720_000_000, 0).UTC()
	sessionID, err := manager.Create(cfg, webDefaultAdminUsername, webRoleAdmin, start)
	if err != nil {
		t.Fatalf("create session failed: %v", err)
	}
	if _, ok := manager.Authenticate(sessionID, cfg, start.Add(4*time.Minute)); !ok {
		t.Fatalf("expected session to remain valid before idle timeout")
	}
	if _, ok := manager.Authenticate(sessionID, cfg, start.Add(10*time.Minute)); ok {
		t.Fatalf("expected session to expire after idle timeout")
	}

	sessionID, err = manager.Create(cfg, webDefaultAdminUsername, webRoleAdmin, start)
	if err != nil {
		t.Fatalf("create session failed: %v", err)
	}
	if _, ok := manager.Authenticate(sessionID, cfg, start.Add(2*time.Hour)); ok {
		t.Fatalf("expected session to expire after absolute timeout")
	}
}

func TestGenerateQRCodeDataURL(t *testing.T) {
	dataURL, err := generateQRCodeDataURL("otpauth://totp/GoNavi:admin%40localhost?secret=JBSWY3DPEHPK3PXP&issuer=GoNavi")
	if err != nil {
		t.Fatalf("generateQRCodeDataURL failed: %v", err)
	}
	if !strings.HasPrefix(dataURL, "data:image/png;base64,") {
		t.Fatalf("unexpected QR code data URL prefix: %q", dataURL)
	}
}

func TestWebAuthManagerEnforcesSixCharacterPasswords(t *testing.T) {
	if _, err := normalizeWebAuthPassword("密码"); err == nil {
		t.Fatal("expected two visible characters to remain below the six-character minimum")
	}
	if _, err := normalizeWebAuthPassword("密码设置安全"); err != nil {
		t.Fatalf("expected six Unicode characters to satisfy the password minimum, got %v", err)
	}

	manager, err := newWebAuthManager(t.TempDir())
	if err != nil {
		t.Fatalf("newWebAuthManager failed: %v", err)
	}
	setup, err := manager.BeginSetup("127.0.0.1:34116", manager.SetupToken())
	if err != nil {
		t.Fatalf("BeginSetup failed: %v", err)
	}

	if _, _, err := manager.CompleteSetup(setup.SetupToken, webDefaultAdminUsername, "12345", "", false, 30, 24, 7); err == nil || !strings.Contains(err.Error(), "at least 6") {
		t.Fatalf("expected five-character setup password to be rejected, got %v", err)
	}
	cfg, _, err := manager.CompleteSetup(setup.SetupToken, webDefaultAdminUsername, "123456", "", false, 30, 24, 7)
	if err != nil {
		t.Fatalf("expected six-character setup password to succeed, got %v", err)
	}
	if !verifyPassword(cfg.Users[0].PasswordHash, "123456") {
		t.Fatal("expected six-character setup password to be persisted")
	}

	if _, _, _, err := manager.ChangePassword(webDefaultAdminUsername, "123456", "", "65432"); err == nil || !strings.Contains(err.Error(), "at least 6") {
		t.Fatalf("expected five-character replacement password to be rejected, got %v", err)
	}
	if !verifyPassword(manager.currentConfig().Users[0].PasswordHash, "123456") {
		t.Fatal("expected rejected password change to preserve the current password")
	}
	nextCfg, _, _, err := manager.ChangePassword(webDefaultAdminUsername, "123456", "", "654321")
	if err != nil {
		t.Fatalf("expected six-character replacement password to succeed, got %v", err)
	}
	if !verifyPassword(nextCfg.Users[0].PasswordHash, "654321") {
		t.Fatal("expected six-character replacement password to be persisted")
	}
}

func TestNewWebAuthManagerFromEnvironmentInitializesPassword(t *testing.T) {
	root := t.TempDir()
	t.Setenv(webAuthPasswordEnvName, "123456")

	manager, err := newWebAuthManagerFromEnvironment(root)
	if err != nil {
		t.Fatalf("newWebAuthManagerFromEnvironment failed: %v", err)
	}
	if status := manager.Status(""); !status.Configured {
		t.Fatalf("expected environment password to configure web auth, got %+v", status)
	}
	settings, err := manager.Settings()
	if err != nil {
		t.Fatalf("read environment-managed settings failed: %v", err)
	}
	if !settings.PasswordManagedByEnvironment {
		t.Fatal("expected settings to report that the password is managed by environment")
	}
	if _, _, _, _, err := manager.Login(webDefaultAdminUsername, "123456", "", "127.0.0.1"); err != nil {
		t.Fatalf("expected login with environment password to succeed, got %v", err)
	}
	if _, _, _, err := manager.ChangePassword(webDefaultAdminUsername, "123456", "", "654321"); !errors.Is(err, errWebAuthPasswordManaged) {
		t.Fatalf("expected environment-managed password change to be rejected, got %v", err)
	}
	payload, err := os.ReadFile(manager.store.path)
	if err != nil {
		t.Fatalf("read persisted web auth config failed: %v", err)
	}
	if strings.Contains(string(payload), "123456") {
		t.Fatal("environment password must not be persisted in plaintext")
	}

	t.Setenv(webAuthPasswordEnvName, "")
	restarted, err := newWebAuthManagerFromEnvironment(root)
	if err != nil {
		t.Fatalf("restart after clearing environment password failed: %v", err)
	}
	settings, err = restarted.Settings()
	if err != nil {
		t.Fatalf("read settings after clearing environment password failed: %v", err)
	}
	if settings.PasswordManagedByEnvironment {
		t.Fatal("expected password management to return to the settings UI after clearing the environment variable")
	}
	if _, _, _, _, err := restarted.Login(webDefaultAdminUsername, "123456", "", "127.0.0.1"); err != nil {
		t.Fatalf("expected the last synchronized password to remain active, got %v", err)
	}
}

func TestNewWebAuthManagerFromEnvironmentOverridesPasswordAndPreservesSettings(t *testing.T) {
	root := t.TempDir()
	manager, err := newWebAuthManager(root)
	if err != nil {
		t.Fatalf("newWebAuthManager failed: %v", err)
	}
	now := time.Unix(1_720_000_321, 0).UTC()
	manager.now = func() time.Time { return now }
	setup, err := manager.BeginSetup("127.0.0.1:34116", manager.SetupToken())
	if err != nil {
		t.Fatalf("BeginSetup failed: %v", err)
	}
	code, err := generateTOTPCodeAt(setup.Secret, now)
	if err != nil {
		t.Fatalf("generateTOTPCodeAt failed: %v", err)
	}
	original, _, err := manager.CompleteSetup(setup.SetupToken, webDefaultAdminUsername, "old-password", code, true, 45, 48, 14)
	if err != nil {
		t.Fatalf("CompleteSetup failed: %v", err)
	}

	t.Setenv(webAuthPasswordEnvName, "654321")
	restarted, err := newWebAuthManagerFromEnvironment(root)
	if err != nil {
		t.Fatalf("restart with environment password failed: %v", err)
	}
	updated := restarted.currentConfig()
	if verifyPassword(updated.Users[0].PasswordHash, "old-password") || !verifyPassword(updated.Users[0].PasswordHash, "654321") {
		t.Fatal("expected environment password to replace the persisted password")
	}
	if !updated.Users[0].TOTPEnabled || updated.Users[0].TOTPSecret != original.Users[0].TOTPSecret || len(updated.Users[0].RecoveryCodeHashes) != len(original.Users[0].RecoveryCodeHashes) {
		t.Fatal("expected environment password update to preserve TOTP settings")
	}
	if updated.SessionIdleMinutes != 45 || updated.SessionAbsoluteHours != 48 || updated.SessionRememberDays != 14 {
		t.Fatalf("expected environment password update to preserve session settings, got %+v", updated)
	}
	settings, err := restarted.Settings()
	if err != nil || !settings.PasswordManagedByEnvironment {
		t.Fatalf("expected restarted settings to report environment management, settings=%+v err=%v", settings, err)
	}

	before, err := os.ReadFile(restarted.store.path)
	if err != nil {
		t.Fatalf("read updated web auth config failed: %v", err)
	}
	if _, err := newWebAuthManagerFromEnvironment(root); err != nil {
		t.Fatalf("restart with unchanged environment password failed: %v", err)
	}
	after, err := os.ReadFile(restarted.store.path)
	if err != nil {
		t.Fatalf("read unchanged web auth config failed: %v", err)
	}
	if string(before) != string(after) {
		t.Fatal("unchanged environment password must not rewrite the persisted config")
	}
}

func TestNewWebAuthManagerFromEnvironmentRejectsShortPassword(t *testing.T) {
	t.Setenv(webAuthPasswordEnvName, "12345")

	_, err := newWebAuthManagerFromEnvironment(t.TempDir())
	if err == nil || !strings.Contains(err.Error(), webAuthPasswordEnvName) || !strings.Contains(err.Error(), "at least 6") {
		t.Fatalf("expected short environment password error, got %v", err)
	}
	if strings.Contains(err.Error(), "12345") {
		t.Fatal("environment password error must not expose the password")
	}
}

func TestWebAuthManagerChangePasswordRotatesSession(t *testing.T) {
	manager, err := newWebAuthManager(t.TempDir())
	if err != nil {
		t.Fatalf("newWebAuthManager failed: %v", err)
	}
	now := time.Unix(1_720_000_000, 0).UTC()
	manager.now = func() time.Time { return now }

	setup, err := manager.BeginSetup("127.0.0.1:34115", manager.SetupToken())
	if err != nil {
		t.Fatalf("BeginSetup failed: %v", err)
	}
	code, err := generateTOTPCodeAt(setup.Secret, now)
	if err != nil {
		t.Fatalf("generateTOTPCodeAt failed: %v", err)
	}
	cfg, sessionID, err := manager.CompleteSetup(setup.SetupToken, webDefaultAdminUsername, "strong-password-123", code, true, 30, 24, 7)
	if err != nil {
		t.Fatalf("CompleteSetup failed: %v", err)
	}

	summary, err := manager.Settings()
	if err != nil {
		t.Fatalf("Settings failed: %v", err)
	}
	if !summary.Configured || !summary.TOTPEnabled {
		t.Fatalf("unexpected settings summary: %+v", summary)
	}
	if summary.RecoveryCodesRemaining != 8 {
		t.Fatalf("expected 8 recovery codes, got %d", summary.RecoveryCodesRemaining)
	}

	nextCfg, nextSessionID, usedRecoveryCode, err := manager.ChangePassword(webDefaultAdminUsername, "strong-password-123", code, "strong-password-456")
	if err != nil {
		t.Fatalf("ChangePassword failed: %v", err)
	}
	if usedRecoveryCode {
		t.Fatalf("expected TOTP code path instead of recovery code")
	}
	if sessionID == nextSessionID || strings.TrimSpace(nextSessionID) == "" {
		t.Fatalf("expected ChangePassword to rotate the session, old=%q new=%q", sessionID, nextSessionID)
	}
	if _, ok := manager.sessions.Authenticate(sessionID, cfg, now); ok {
		t.Fatalf("expected previous session to be invalidated after password change")
	}
	if _, ok := manager.sessions.Authenticate(nextSessionID, nextCfg, now); !ok {
		t.Fatalf("expected rotated session to remain valid")
	}
	if !verifyPassword(nextCfg.Users[0].PasswordHash, "strong-password-456") {
		t.Fatalf("expected new password hash to validate")
	}
	if verifyPassword(nextCfg.Users[0].PasswordHash, "strong-password-123") {
		t.Fatalf("expected previous password to stop validating")
	}

	if _, _, _, _, err := manager.Login(webDefaultAdminUsername, "strong-password-123", code, ""); !errors.Is(err, errWebAuthInvalidCredentials) {
		t.Fatalf("expected old password login to fail with invalid credentials, got %v", err)
	}
	if _, _, _, _, err := manager.Login(webDefaultAdminUsername, "strong-password-456", code, ""); err != nil {
		t.Fatalf("expected new password login to succeed, got %v", err)
	}
}

func TestWebAuthManagerChangePasswordConsumesRecoveryCode(t *testing.T) {
	manager, err := newWebAuthManager(t.TempDir())
	if err != nil {
		t.Fatalf("newWebAuthManager failed: %v", err)
	}
	now := time.Unix(1_720_000_123, 0).UTC()
	manager.now = func() time.Time { return now }

	setup, err := manager.BeginSetup("127.0.0.1:34115", manager.SetupToken())
	if err != nil {
		t.Fatalf("BeginSetup failed: %v", err)
	}
	code, err := generateTOTPCodeAt(setup.Secret, now)
	if err != nil {
		t.Fatalf("generateTOTPCodeAt failed: %v", err)
	}
	if _, _, err := manager.CompleteSetup(setup.SetupToken, webDefaultAdminUsername, "strong-password-123", code, true, 30, 24, 7); err != nil {
		t.Fatalf("CompleteSetup failed: %v", err)
	}

	_, _, usedRecoveryCode, err := manager.ChangePassword(webDefaultAdminUsername, "strong-password-123", setup.RecoveryCodes[0], "strong-password-456")
	if err != nil {
		t.Fatalf("ChangePassword failed: %v", err)
	}
	if !usedRecoveryCode {
		t.Fatalf("expected recovery code usage to be reported")
	}

	summary, err := manager.Settings()
	if err != nil {
		t.Fatalf("Settings failed: %v", err)
	}
	if summary.RecoveryCodesRemaining != 7 {
		t.Fatalf("expected one recovery code to be consumed, got %d remaining", summary.RecoveryCodesRemaining)
	}
}

func TestConsumeTOTPCodeForLoginRejectsReplayWithinWindow(t *testing.T) {
	manager, err := newWebAuthManager(t.TempDir())
	if err != nil {
		t.Fatalf("newWebAuthManager failed: %v", err)
	}
	secret := "JBSWY3DPEHPK3PXP"
	now := time.Unix(1_720_000_000, 0).UTC()
	code, err := generateTOTPCodeAt(secret, now)
	if err != nil {
		t.Fatalf("generateTOTPCodeAt failed: %v", err)
	}
	if !manager.consumeTOTPCodeForLogin(secret, code, now) {
		t.Fatalf("expected first use of a valid TOTP code to be accepted")
	}
	if manager.consumeTOTPCodeForLogin(secret, code, now) {
		t.Fatalf("expected a replayed TOTP code to be rejected inside the validation window")
	}
	if manager.consumeTOTPCodeForLogin(secret, "000000", now) {
		t.Fatalf("expected an invalid TOTP code to stay rejected")
	}
	// The previous step's code is still inside the ±1 window: accepted once,
	// then rejected on replay, exactly like the current step's code.
	previousCode, err := generateTOTPCodeAt(secret, now.Add(-webTOTPPeriodSeconds*time.Second))
	if err != nil {
		t.Fatalf("generateTOTPCodeAt failed: %v", err)
	}
	if !manager.consumeTOTPCodeForLogin(secret, previousCode, now) {
		t.Fatalf("expected the previous step's code to be accepted once")
	}
	if manager.consumeTOTPCodeForLogin(secret, previousCode, now) {
		t.Fatalf("expected a replayed previous-step code to be rejected")
	}
}

func TestWebAuthManagerTOTPLoginRejectsReplayedCode(t *testing.T) {
	manager, err := newWebAuthManager(t.TempDir())
	if err != nil {
		t.Fatalf("newWebAuthManager failed: %v", err)
	}
	now := time.Unix(1_720_000_123, 0).UTC()
	manager.now = func() time.Time { return now }

	setup, err := manager.BeginSetup("127.0.0.1:34115", manager.SetupToken())
	if err != nil {
		t.Fatalf("BeginSetup failed: %v", err)
	}
	code, err := generateTOTPCodeAt(setup.Secret, now)
	if err != nil {
		t.Fatalf("generateTOTPCodeAt failed: %v", err)
	}
	// Setup keeps using the pure validator: it is a one-time flow, and the very
	// first login typically replays the same code inside the same 30s step.
	if _, _, err := manager.CompleteSetup(setup.SetupToken, webDefaultAdminUsername, "strong-password-123", code, true, 30, 24, 7); err != nil {
		t.Fatalf("CompleteSetup failed: %v", err)
	}

	if _, _, _, _, err := manager.Login(webDefaultAdminUsername, "strong-password-123", code, ""); err != nil {
		t.Fatalf("expected first login with the setup code to succeed, got %v", err)
	}
	if _, _, _, _, err := manager.Login(webDefaultAdminUsername, "strong-password-123", code, ""); !errors.Is(err, errWebAuthInvalidCredentials) {
		t.Fatalf("expected a replayed TOTP code to fail with invalid credentials, got %v", err)
	}
	// The recovery-code fallback must stay intact after a rejected replay.
	if _, _, _, _, err := manager.Login(webDefaultAdminUsername, "strong-password-123", setup.RecoveryCodes[0], ""); err != nil {
		t.Fatalf("expected recovery code login to still succeed, got %v", err)
	}
}

func TestWebAuthManagerTOTPLoginAcceptsNextStepCode(t *testing.T) {
	manager, err := newWebAuthManager(t.TempDir())
	if err != nil {
		t.Fatalf("newWebAuthManager failed: %v", err)
	}
	now := time.Unix(1_720_000_123, 0).UTC()
	manager.now = func() time.Time { return now }

	setup, err := manager.BeginSetup("127.0.0.1:34115", manager.SetupToken())
	if err != nil {
		t.Fatalf("BeginSetup failed: %v", err)
	}
	code, err := generateTOTPCodeAt(setup.Secret, now)
	if err != nil {
		t.Fatalf("generateTOTPCodeAt failed: %v", err)
	}
	if _, _, err := manager.CompleteSetup(setup.SetupToken, webDefaultAdminUsername, "strong-password-123", code, true, 30, 24, 7); err != nil {
		t.Fatalf("CompleteSetup failed: %v", err)
	}
	if _, _, _, _, err := manager.Login(webDefaultAdminUsername, "strong-password-123", code, ""); err != nil {
		t.Fatalf("expected first login to succeed, got %v", err)
	}

	// One step later the authenticator rotates to a fresh code: the replay
	// cache must not reject normal rotation.
	next := now.Add(webTOTPPeriodSeconds * time.Second)
	manager.now = func() time.Time { return next }
	nextCode, err := generateTOTPCodeAt(setup.Secret, next)
	if err != nil {
		t.Fatalf("generateTOTPCodeAt failed: %v", err)
	}
	if _, _, _, _, err := manager.Login(webDefaultAdminUsername, "strong-password-123", nextCode, ""); err != nil {
		t.Fatalf("expected the next step's code to be accepted, got %v", err)
	}
}
