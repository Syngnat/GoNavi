package app

import (
	"context"
	"errors"
	"strings"
	"testing"

	"GoNavi-Wails/internal/plugin"
)

type recordingInstaller struct {
	installs, replaces int
	received           plugin.InstallRequest
	err                error
}

func (r *recordingInstaller) Install(_ context.Context, request plugin.InstallRequest) (plugin.Status, error) {
	r.installs++
	r.received = request
	return plugin.Status{Manifest: plugin.Manifest{Version: "1.0.0"}}, r.err
}

func (r *recordingInstaller) ReplacePackage(_ context.Context, request plugin.InstallRequest) (plugin.Status, error) {
	r.replaces++
	r.received = request
	return plugin.Status{Manifest: plugin.Manifest{Version: "2.0.0"}, DesiredEnabled: true}, r.err
}

// A market update of an installed plugin has to keep the enable intent; a fresh install must not
// route through the replacement path.
func TestMarketInstallChoosesReplaceOnlyForInstalledPlugins(t *testing.T) {
	request := plugin.InstallRequest{Path: "package", Digest: strings.Repeat("a", 64), Trusted: true}
	installer := &recordingInstaller{}
	status, err := installMarketPackage(context.Background(), installer, request, false)
	if err != nil || installer.installs != 1 || installer.replaces != 0 {
		t.Fatalf("fresh install: installs=%d replaces=%d err=%v", installer.installs, installer.replaces, err)
	}
	if installer.received != request || status.Manifest.Version != "1.0.0" {
		t.Fatalf("fresh install passed %+v", installer.received)
	}
	installer = &recordingInstaller{}
	status, err = installMarketPackage(context.Background(), installer, request, true)
	if err != nil || installer.installs != 0 || installer.replaces != 1 {
		t.Fatalf("update: installs=%d replaces=%d err=%v", installer.installs, installer.replaces, err)
	}
	if installer.received != request || !status.DesiredEnabled {
		t.Fatalf("update passed %+v status=%+v", installer.received, status)
	}
	failure := &recordingInstaller{err: plugin.ErrBusy}
	if _, err = installMarketPackage(context.Background(), failure, request, true); !errors.Is(err, plugin.ErrBusy) {
		t.Fatalf("error swallowed: %v", err)
	}
}

type installedStatusManager struct{ items []plugin.Status }

func (m installedStatusManager) List() []plugin.Status { return m.items }

func TestMarketInstallAlreadyCurrentMatchesIDAndVersion(t *testing.T) {
	manager := installedStatusManager{items: []plugin.Status{{Manifest: plugin.Manifest{ID: "com.example.plugin", Version: "1.0.1"}}}}
	if !marketInstallAlreadyCurrent(manager, "com.example.plugin", "1.0.1") {
		t.Fatal("expected exact installed version to be rejected")
	}
	if marketInstallAlreadyCurrent(manager, "com.example.plugin", "1.0.2") {
		t.Fatal("a different version must remain installable")
	}
	if marketInstallAlreadyCurrent(manager, "com.example.other", "1.0.1") {
		t.Fatal("another plugin id must not match")
	}
}
