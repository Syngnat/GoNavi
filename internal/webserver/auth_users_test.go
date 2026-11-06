package webserver

import (
	"reflect"
	"strings"
	"testing"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/webidentity"
)

func TestNormalizeWebAuthConfigMigratesLegacyAdmin(t *testing.T) {
	legacyHash, err := hashPassword("legacy-password")
	if err != nil {
		t.Fatalf("hashPassword failed: %v", err)
	}
	cfg := normalizeWebAuthConfig(webAuthConfig{
		Enabled:            true,
		PasswordHash:       legacyHash,
		TOTPEnabled:        true,
		TOTPSecret:         "JBSWY3DPEHPK3PXP",
		RecoveryCodeHashes: []string{"recovery"},
	})
	if !cfg.IsConfigured() {
		t.Fatal("expected migrated config to remain configured")
	}
	if len(cfg.Users) != 1 || cfg.Users[0].Username != webDefaultAdminUsername {
		t.Fatalf("unexpected migrated users: %+v", cfg.Users)
	}
	if cfg.Users[0].Role != webRoleAdmin || !cfg.Users[0].TOTPEnabled {
		t.Fatalf("expected migrated admin role and TOTP, got %+v", cfg.Users[0])
	}
	if cfg.PasswordHash != "" || cfg.TOTPSecret != "" || cfg.RecoveryCodeHashes != nil {
		t.Fatal("legacy fields must be cleared after migration")
	}
	if !verifyPassword(cfg.Users[0].PasswordHash, "legacy-password") {
		t.Fatal("expected migrated password to keep validating")
	}
}

func TestWebSessionManagerPersistsAcrossRestart(t *testing.T) {
	root := t.TempDir()
	cfg := normalizeWebAuthConfig(webAuthConfig{
		Enabled:              true,
		PasswordHash:         "hash",
		SessionIdleMinutes:   30,
		SessionAbsoluteHours: 24,
		SessionRememberDays:  7,
	})
	now := time.Unix(1_720_000_400, 0).UTC()
	manager := newWebSessionManagerWithStore(root)
	sessionID, err := manager.Create(cfg, "alice", webRoleViewer, now)
	if err != nil {
		t.Fatalf("Create failed: %v", err)
	}

	restarted := newWebSessionManagerWithStore(root)
	session, ok := restarted.Authenticate(sessionID, cfg, now.Add(2*time.Minute))
	if !ok {
		t.Fatal("expected persisted session to authenticate after restart")
	}
	if session.Username != "alice" || session.Role != webRoleViewer {
		t.Fatalf("unexpected restored session: %+v", session)
	}
}

func TestWebAuthManagerLoginByUsernameAndRole(t *testing.T) {
	manager, err := newWebAuthManager(t.TempDir())
	if err != nil {
		t.Fatalf("newWebAuthManager failed: %v", err)
	}
	now := time.Unix(1_720_000_500, 0).UTC()
	manager.now = func() time.Time { return now }
	setup, err := manager.BeginSetup("127.0.0.1", manager.SetupToken())
	if err != nil {
		t.Fatalf("BeginSetup failed: %v", err)
	}
	if _, _, err := manager.CompleteSetup(setup.SetupToken, "alice", "password-123", "", false, 30, 24, 7); err != nil {
		t.Fatalf("CompleteSetup failed: %v", err)
	}
	if _, err := manager.MutateUser("alice", webAuthUserMutation{
		Action: "create", Username: "Bob", Password: "password-456", Role: webRoleViewer,
	}); err != nil {
		t.Fatalf("create viewer failed: %v", err)
	}

	cfg, sessionID, _, _, err := manager.Login("bob", "password-456", "", "10.0.0.1")
	if err != nil {
		t.Fatalf("viewer login failed: %v", err)
	}
	session, ok := manager.sessions.Authenticate(sessionID, cfg, now)
	if !ok {
		t.Fatal("expected viewer session to authenticate")
	}
	if session.Username != "bob" || session.Role != webRoleViewer {
		t.Fatalf("unexpected viewer session: %+v", session)
	}
	if _, _, _, _, err := manager.Login("alice", "wrong-password", "", "10.0.0.2"); err == nil {
		t.Fatal("expected wrong password to fail")
	}
}

func TestWebAuthManagerDisabledUserSessionInvalidated(t *testing.T) {
	manager, err := newWebAuthManager(t.TempDir())
	if err != nil {
		t.Fatalf("newWebAuthManager failed: %v", err)
	}
	now := time.Unix(1_720_000_600, 0).UTC()
	manager.now = func() time.Time { return now }
	setup, err := manager.BeginSetup("127.0.0.1", manager.SetupToken())
	if err != nil {
		t.Fatalf("BeginSetup failed: %v", err)
	}
	if _, _, err := manager.CompleteSetup(setup.SetupToken, "alice", "password-123", "", false, 30, 24, 7); err != nil {
		t.Fatalf("CompleteSetup failed: %v", err)
	}
	if _, err := manager.MutateUser("alice", webAuthUserMutation{
		Action: "create", Username: "bob", Password: "password-456", Role: webRoleViewer,
	}); err != nil {
		t.Fatalf("create viewer failed: %v", err)
	}
	cfg, sessionID, _, _, err := manager.Login("bob", "password-456", "", "10.0.0.1")
	if err != nil {
		t.Fatalf("viewer login failed: %v", err)
	}
	if _, ok := manager.sessions.Authenticate(sessionID, cfg, now); !ok {
		t.Fatal("expected viewer session before disable")
	}
	if _, err := manager.MutateUser("alice", webAuthUserMutation{
		Action: "update", Username: "bob", Role: webRoleViewer, Disabled: true,
	}); err != nil {
		t.Fatalf("disable viewer failed: %v", err)
	}
	status := manager.Status(sessionID)
	if status.Authenticated {
		t.Fatal("disabled user session must no longer authenticate")
	}
	if _, _, _, _, err := manager.Login("bob", "password-456", "", "10.0.0.1"); err == nil {
		t.Fatal("disabled user must not be able to log in")
	}
}

func TestMutateUserProtectsLastAdministrator(t *testing.T) {
	manager, err := newWebAuthManager(t.TempDir())
	if err != nil {
		t.Fatalf("newWebAuthManager failed: %v", err)
	}
	setup, err := manager.BeginSetup("127.0.0.1", manager.SetupToken())
	if err != nil {
		t.Fatalf("BeginSetup failed: %v", err)
	}
	if _, _, err := manager.CompleteSetup(setup.SetupToken, "alice", "password-123", "", false, 30, 24, 7); err != nil {
		t.Fatalf("CompleteSetup failed: %v", err)
	}
	if _, err := manager.MutateUser("alice", webAuthUserMutation{
		Action: "update", Username: "alice", Role: webRoleViewer,
	}); err == nil || !strings.Contains(err.Error(), "last enabled administrator") {
		t.Fatalf("expected demoting the last admin to fail, got %v", err)
	}
	if _, err := manager.MutateUser("alice", webAuthUserMutation{
		Action: "delete", Username: "alice",
	}); err == nil {
		t.Fatal("expected deleting the current user to fail")
	}
}

func TestEnforceViewerPolicyBlocksWritesAndForcesReadOnly(t *testing.T) {
	configValue := reflect.New(reflect.TypeOf(connection.ConnectionConfig{})).Elem()
	configValue.Set(reflect.ValueOf(connection.ConnectionConfig{Type: "mysql"}))
	if err := enforceViewerPolicy(webidentity.Actor{Username: "bob", Role: webidentity.RoleViewer}, "app", "DBQueryMultiWithOptions", []reflect.Value{configValue}); err != nil {
		t.Fatalf("expected read query to be allowed: %v", err)
	}
	got := configValue.Interface().(connection.ConnectionConfig)
	if !got.ReadOnly || !got.Protection.RestrictDataEdit || !got.Protection.RestrictStructureEdit {
		t.Fatalf("expected viewer connection to be forced read-only, got %+v", got)
	}

	if err := enforceViewerPolicy(webidentity.Actor{Username: "bob", Role: webidentity.RoleViewer}, "app", "SaveConnection", nil); err == nil {
		t.Fatal("expected mutating method to be blocked for viewer")
	}
	if err := enforceViewerPolicy(webidentity.Actor{Username: "bob", Role: webidentity.RoleViewer}, "aiservice", "Chat", nil); err == nil {
		t.Fatal("expected non-app namespace to be blocked for viewer")
	}

	unsupportedValue := reflect.New(reflect.TypeOf(connection.ConnectionConfig{})).Elem()
	unsupportedValue.Set(reflect.ValueOf(connection.ConnectionConfig{Type: "custom"}))
	if err := enforceViewerPolicy(webidentity.Actor{Username: "bob", Role: webidentity.RoleViewer}, "app", "DBQuery", []reflect.Value{unsupportedValue}); err == nil {
		t.Fatal("expected unsupported data source to be blocked for viewer")
	}
}

func TestWebAuthStatusReportsCurrentRole(t *testing.T) {
	manager, err := newWebAuthManager(t.TempDir())
	if err != nil {
		t.Fatalf("newWebAuthManager failed: %v", err)
	}
	now := time.Unix(1_720_000_700, 0).UTC()
	manager.now = func() time.Time { return now }
	setup, err := manager.BeginSetup("127.0.0.1", manager.SetupToken())
	if err != nil {
		t.Fatalf("BeginSetup failed: %v", err)
	}
	_, sessionID, err := manager.CompleteSetup(setup.SetupToken, "alice", "password-123", "", false, 30, 24, 7)
	if err != nil {
		t.Fatalf("CompleteSetup failed: %v", err)
	}
	if _, err := manager.MutateUser("alice", webAuthUserMutation{
		Action: "create", Username: "root2", Password: "password-456", Role: webRoleAdmin,
	}); err != nil {
		t.Fatalf("create second admin failed: %v", err)
	}
	if _, err := manager.MutateUser("alice", webAuthUserMutation{
		Action: "update", Username: "alice", Role: webRoleViewer,
	}); err != nil {
		t.Fatalf("demote alice failed: %v", err)
	}
	status := manager.Status(sessionID)
	if status.Authenticated {
		// MutateUser destroys the affected user's sessions, so the old session must die.
		t.Fatal("expected demoted user session to be invalidated")
	}
	if _, _, _, _, err := manager.Login("alice", "password-123", "", "10.0.0.9"); err != nil {
		t.Fatalf("demoted user login failed: %v", err)
	}
}

func TestViewerConnectionAllowlistRejectsOtherConnections(t *testing.T) {
	actor := webidentity.Actor{
		Username:             "bob",
		Role:                 webidentity.RoleViewer,
		AllowedConnectionIDs: []string{"conn-allowed"},
	}
	allowedValue := reflect.New(reflect.TypeOf(connection.ConnectionConfig{})).Elem()
	allowedValue.Set(reflect.ValueOf(connection.ConnectionConfig{Type: "mysql", ID: "conn-allowed"}))
	if err := enforceViewerPolicy(actor, "app", "DBQuery", []reflect.Value{allowedValue}); err != nil {
		t.Fatalf("allowed connection was rejected: %v", err)
	}

	deniedValue := reflect.New(reflect.TypeOf(connection.ConnectionConfig{})).Elem()
	deniedValue.Set(reflect.ValueOf(connection.ConnectionConfig{Type: "mysql", ID: "conn-other"}))
	if err := enforceViewerPolicy(actor, "app", "DBQuery", []reflect.Value{deniedValue}); err == nil {
		t.Fatal("expected connection outside the allowlist to be rejected")
	}

	adHocValue := reflect.New(reflect.TypeOf(connection.ConnectionConfig{})).Elem()
	adHocValue.Set(reflect.ValueOf(connection.ConnectionConfig{Type: "mysql"}))
	if err := enforceViewerPolicy(actor, "app", "DBQuery", []reflect.Value{adHocValue}); err == nil {
		t.Fatal("expected ad-hoc connection without an ID to be rejected")
	}
}

func TestMutateUserPersistsConnectionAllowlist(t *testing.T) {
	manager, err := newWebAuthManager(t.TempDir())
	if err != nil {
		t.Fatalf("newWebAuthManager failed: %v", err)
	}
	setup, err := manager.BeginSetup("127.0.0.1", manager.SetupToken())
	if err != nil {
		t.Fatalf("BeginSetup failed: %v", err)
	}
	if _, _, err := manager.CompleteSetup(setup.SetupToken, "alice", "password-123", "", false, 30, 24, 7); err != nil {
		t.Fatalf("CompleteSetup failed: %v", err)
	}
	if _, err := manager.MutateUser("alice", webAuthUserMutation{
		Action:               "create",
		Username:             "bob",
		Password:             "password-456",
		Role:                 webRoleViewer,
		AllowedConnectionIDs: []string{"conn-1", "conn-1", " conn-2 "},
	}); err != nil {
		t.Fatalf("create viewer failed: %v", err)
	}
	acl := manager.ConnectionACL("bob")
	if len(acl) != 2 || acl[0] != "conn-1" || acl[1] != "conn-2" {
		t.Fatalf("allowlist = %v, want [conn-1 conn-2]", acl)
	}
	if acl := manager.ConnectionACL("alice"); acl != nil {
		t.Fatalf("admin allowlist must stay unrestricted, got %v", acl)
	}
}
