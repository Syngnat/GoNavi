package webserver

import (
	"testing"
	"time"
)

func TestUserCanEnableAndDisableTOTP(t *testing.T) {
	manager, err := newWebAuthManager(t.TempDir())
	if err != nil {
		t.Fatalf("newWebAuthManager failed: %v", err)
	}
	now := time.Unix(1_720_001_000, 0).UTC()
	manager.now = func() time.Time { return now }
	setup, err := manager.BeginSetup("127.0.0.1", manager.SetupToken())
	if err != nil {
		t.Fatalf("BeginSetup failed: %v", err)
	}
	if _, _, err := manager.CompleteSetup(setup.SetupToken, "alice", "password-123", "", false, 30, 24, 7); err != nil {
		t.Fatalf("CompleteSetup failed: %v", err)
	}

	pending, err := manager.BeginTOTPSetup("alice", "password-123", "gonavi.example")
	if err != nil {
		t.Fatalf("BeginTOTPSetup failed: %v", err)
	}
	if pending.Secret == "" || pending.QRCodeDataURL == "" || len(pending.RecoveryCodes) != 8 {
		t.Fatalf("unexpected TOTP setup payload: %+v", pending)
	}
	if manager.UserTOTPEnabled("alice") {
		t.Fatal("TOTP must stay disabled until the first code is confirmed")
	}
	if _, err := manager.BeginTOTPSetup("alice", "wrong-password", "gonavi.example"); err == nil {
		t.Fatal("expected wrong password to be rejected")
	}

	code, err := generateTOTPCodeAt(pending.Secret, now)
	if err != nil {
		t.Fatalf("generateTOTPCodeAt failed: %v", err)
	}
	if _, err := manager.CompleteTOTPSetup("alice", pending.SetupToken, code); err != nil {
		t.Fatalf("CompleteTOTPSetup failed: %v", err)
	}
	if !manager.UserTOTPEnabled("alice") {
		t.Fatal("expected TOTP to be enabled")
	}
	if _, _, _, _, err := manager.Login("alice", "password-123", "", "127.0.0.1"); err == nil {
		t.Fatal("expected login without a TOTP code to fail")
	}
	loginCode, err := generateTOTPCodeAt(pending.Secret, now)
	if err != nil {
		t.Fatalf("generateTOTPCodeAt failed: %v", err)
	}
	if _, _, _, _, err := manager.Login("alice", "password-123", loginCode, "127.0.0.1"); err != nil {
		t.Fatalf("expected login with a TOTP code to succeed: %v", err)
	}

	disableCode, err := generateTOTPCodeAt(pending.Secret, now)
	if err != nil {
		t.Fatalf("generateTOTPCodeAt failed: %v", err)
	}
	if _, err := manager.DisableTOTP("alice", "password-123", disableCode); err != nil {
		t.Fatalf("DisableTOTP failed: %v", err)
	}
	if manager.UserTOTPEnabled("alice") {
		t.Fatal("expected TOTP to be disabled")
	}
	if _, _, _, _, err := manager.Login("alice", "password-123", "", "127.0.0.1"); err != nil {
		t.Fatalf("expected login without a code after disabling: %v", err)
	}
}
