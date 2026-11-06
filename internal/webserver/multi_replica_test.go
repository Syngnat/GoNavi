package webserver

import (
	"testing"
	"time"
)

func TestWebSessionsAreSharedAcrossReplicas(t *testing.T) {
	root := t.TempDir()
	cfg := normalizeWebAuthConfig(webAuthConfig{
		Enabled:              true,
		PasswordHash:         "hash",
		SessionIdleMinutes:   30,
		SessionAbsoluteHours: 24,
		SessionRememberDays:  7,
	})
	now := time.Unix(1_720_002_000, 0).UTC()
	replicaA := newWebSessionManagerWithStore(root)
	replicaB := newWebSessionManagerWithStore(root)

	sessionID, err := replicaA.Create(cfg, "alice", webRoleViewer, now)
	if err != nil {
		t.Fatalf("Create failed: %v", err)
	}
	session, ok := replicaB.Authenticate(sessionID, cfg, now)
	if !ok || session.Username != "alice" {
		t.Fatalf("replica B did not see replica A's session: %+v ok=%v", session, ok)
	}

	replicaB.Destroy(sessionID)
	if _, ok := replicaA.Authenticate(sessionID, cfg, now.Add(6*time.Second)); ok {
		t.Fatal("replica A must drop the session after replica B deleted it")
	}
}

func TestWebAuthConfigReloadsAcrossReplicas(t *testing.T) {
	root := t.TempDir()
	replicaA, err := newWebAuthManager(root)
	if err != nil {
		t.Fatalf("newWebAuthManager A failed: %v", err)
	}
	setup, err := replicaA.BeginSetup("127.0.0.1", replicaA.SetupToken())
	if err != nil {
		t.Fatalf("BeginSetup failed: %v", err)
	}
	if _, _, err := replicaA.CompleteSetup(setup.SetupToken, "alice", "password-123", "", false, 30, 24, 7); err != nil {
		t.Fatalf("CompleteSetup failed: %v", err)
	}
	replicaB, err := newWebAuthManager(root)
	if err != nil {
		t.Fatalf("newWebAuthManager B failed: %v", err)
	}

	if _, err := replicaA.MutateUser("alice", webAuthUserMutation{
		Action: "create", Username: "bob", Password: "password-456", Role: webRoleViewer,
	}); err != nil {
		t.Fatalf("create user failed: %v", err)
	}
	time.Sleep(10 * time.Millisecond)

	users, err := replicaB.Users()
	if err != nil {
		t.Fatalf("replica B Users failed: %v", err)
	}
	found := false
	for _, user := range users {
		if user.Username == "bob" {
			found = true
		}
	}
	if !found {
		t.Fatalf("replica B did not reload the new user: %+v", users)
	}
	if _, _, _, _, err := replicaB.Login("bob", "password-456", "", "10.0.0.1"); err != nil {
		t.Fatalf("replica B could not log in the new user: %v", err)
	}
}
