package app

import (
	"os"
	"path/filepath"
	"runtime/debug"
	"strings"
	"testing"
)

func TestBuildStartupVersionLogUsesResolvedRuntimeMetadata(t *testing.T) {
	info := &debug.BuildInfo{
		GoVersion: "go1.25.0",
		Settings: []debug.BuildSetting{
			{Key: "vcs.revision", Value: "abcdef1234567890"},
		},
	}

	got := buildStartupVersionLog("0.9.1", "2026-07-30T09:00:00Z", "linux", "amd64", info)
	for _, expected := range []string{
		"version=0.9.1",
		"buildTime=2026-07-30T09:00:00Z",
		"go=go1.25.0",
		"os=linux",
		"arch=amd64",
		"revision=abcdef123456",
	} {
		if !strings.Contains(got, expected) {
			t.Fatalf("startup version log %q does not contain %q", got, expected)
		}
	}
}

func TestCollectStartupDriverVersionsUsesBuildInfoAndInstalledMetadata(t *testing.T) {
	driverRoot := t.TempDir()
	installedDir := filepath.Join(driverRoot, "dameng")
	if err := os.MkdirAll(installedDir, 0o755); err != nil {
		t.Fatalf("create installed driver directory: %v", err)
	}
	if err := os.WriteFile(filepath.Join(installedDir, "installed.json"), []byte(`{
  "driverType": "dameng",
  "version": "1.8.22",
  "agentRevision": "dm-agent-r3"
}`), 0o600); err != nil {
		t.Fatalf("write installed driver metadata: %v", err)
	}

	info := &debug.BuildInfo{Deps: []*debug.Module{
		{Path: "github.com/go-sql-driver/mysql", Version: "v1.9.3"},
		{Path: "github.com/redis/go-redis/v9", Version: "v9.17.3"},
		{Path: "github.com/example/not-a-driver", Version: "v9.9.9"},
	}}

	got := collectStartupDriverVersions(info, driverRoot)
	want := []startupDriverVersion{
		{Driver: "mysql-compatible", Source: "go-module", Version: "v1.9.3", Module: "github.com/go-sql-driver/mysql"},
		{Driver: "redis", Source: "go-module", Version: "v9.17.3", Module: "github.com/redis/go-redis/v9"},
		{Driver: "dameng", Source: "driver-agent", Version: "1.8.22", AgentRevision: "dm-agent-r3"},
	}
	if len(got) != len(want) {
		t.Fatalf("collectStartupDriverVersions returned %d items, want %d: %#v", len(got), len(want), got)
	}
	for index := range want {
		if got[index] != want[index] {
			t.Fatalf("driver item %d = %#v, want %#v", index, got[index], want[index])
		}
	}
}

func TestFormatStartupDriverVersionLogOmitsEmptyOptionalFields(t *testing.T) {
	got := formatStartupDriverVersionLog(startupDriverVersion{
		Driver:  "dameng",
		Source:  "driver-agent",
		Version: "1.8.22",
	})
	if got != "数据库驱动版本：driver=dameng source=driver-agent version=1.8.22" {
		t.Fatalf("unexpected driver version log: %q", got)
	}
}
