package db

import (
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"
)

func TestBuildMySQLCompatibleConnectPlansUsesExplicitLabels(t *testing.T) {
	plans, err := buildMySQLCompatibleConnectPlans(
		connection.ConnectionConfig{Type: "mysql", Host: "localhost", Port: 3306},
		"tcp",
		"localhost:3306",
		"",
	)
	if err != nil {
		t.Fatalf("buildMySQLCompatibleConnectPlans() error = %v", err)
	}
	if len(plans) != 2 {
		t.Fatalf("plan count = %d, want 2", len(plans))
	}
	if !strings.Contains(plans[0].label, "multiStatements=true") {
		t.Fatalf("default plan label = %q, want explicit multiStatements=true", plans[0].label)
	}
	if !strings.Contains(plans[1].label, "multiStatements=false") {
		t.Fatalf("fallback plan label = %q, want explicit multiStatements=false", plans[1].label)
	}
}
