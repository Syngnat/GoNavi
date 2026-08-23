package ssh

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"

	"golang.org/x/crypto/ssh/knownhosts"
)

func TestConnectSSHUsesDefaultKnownHostsAndReportsProgress(t *testing.T) {
	signer := newTestHostSigner(t)
	server := startTestSSHServer(t, signer)
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)

	knownHostsPath := filepath.Join(home, ".ssh", "known_hosts")
	if err := os.MkdirAll(filepath.Dir(knownHostsPath), 0o700); err != nil {
		t.Fatalf("create .ssh directory: %v", err)
	}
	line := knownhosts.Line(
		[]string{server.address},
		signer.PublicKey(),
	)
	if err := os.WriteFile(knownHostsPath, []byte(line+"\n"), 0o600); err != nil {
		t.Fatalf("write default known_hosts: %v", err)
	}

	var events []connection.SSHProgressEvent
	config := server.config().WithProgressReporter(func(event connection.SSHProgressEvent) {
		events = append(events, event)
	})

	client, err := connectSSH(config)
	if err != nil {
		t.Fatalf("connectSSH() error = %v", err)
	}
	t.Cleanup(func() { _ = client.Close() })

	stages := make([]string, 0, len(events))
	for _, event := range events {
		stages = append(stages, event.Stage)
	}
	for _, expected := range []string{
		"tcp_connecting",
		"tcp_connected",
		"host_key_verifying",
		"host_key_verified",
		"authenticating",
		"authenticated",
	} {
		if !containsSSHProgressStage(stages, expected) {
			t.Fatalf("missing SSH progress stage %q in %v", expected, stages)
		}
	}
	if config.KnownHostsPath != "" {
		t.Fatalf("test must exercise automatic default known_hosts resolution, got explicit path %q", config.KnownHostsPath)
	}
	if !containsSSHProgressStage(stages, "known_hosts_default") {
		t.Fatalf("expected default known_hosts discovery to be reported, got %v", stages)
	}
	if stageIndex(stages, "known_hosts_default") <= stageIndex(stages, "tcp_connected") {
		t.Fatalf("default known_hosts must be reported after TCP connects, got %v", stages)
	}
	if eventStatus(events, "known_hosts_default") != "running" {
		t.Fatalf("default known_hosts discovery must not be reported as verification success, got %#v", events)
	}
}

func containsSSHProgressStage(stages []string, expected string) bool {
	for _, stage := range stages {
		if strings.TrimSpace(stage) == expected {
			return true
		}
	}
	return false
}

func stageIndex(stages []string, expected string) int {
	for index, stage := range stages {
		if strings.TrimSpace(stage) == expected {
			return index
		}
	}
	return -1
}

func eventStatus(events []connection.SSHProgressEvent, expectedStage string) string {
	for _, event := range events {
		if event.Stage == expectedStage {
			return event.Status
		}
	}
	return ""
}
