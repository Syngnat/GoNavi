//go:build !bindings && !wails3

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"testing"

	"GoNavi-Wails/internal/app"
	"GoNavi-Wails/internal/cli"
)

func TestPluginDesktopCLIExitContract(t *testing.T) {
	t.Setenv("GONAVI_DATA_ROOT", t.TempDir())
	oldVersion := cli.Version
	t.Cleanup(func() { cli.Version = oldVersion })
	var out, diagnostic bytes.Buffer
	err := runDesktopPluginCLIWithIO(context.Background(), []string{"plugin", "disable", "missing.plugin"}, &out, &diagnostic)
	var exit *desktopCLIExit
	if !errors.As(err, &exit) || exit.code != cli.ExitExecution {
		t.Fatalf("wrong CLI exit: %v", err)
	}
	decoder := json.NewDecoder(&diagnostic)
	var report map[string]any
	if err := decoder.Decode(&report); err != nil {
		t.Fatal(err)
	}
	if err := decoder.Decode(&report); err != io.EOF {
		t.Fatalf("trailing non-JSON diagnostics: %v", err)
	}
	if cli.Version != app.CurrentVersion() {
		t.Fatal("desktop CLI did not use authoritative host version")
	}
}

func TestPluginDesktopGlobalDataRootRoute(t *testing.T) {
	if !hasDesktopCLIPrefix([]string{"--data-root", "root", "plugin", "list"}) || !hasDesktopCLIPrefix([]string{"--data-root=root", "plugin", "list"}) {
		t.Fatal("global CLI root is not routed")
	}
	if hasDesktopCLIPrefix(nil) || hasDesktopCLIPrefix([]string{"--web-server"}) {
		t.Fatal("unrelated modes routed as CLI")
	}
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	command := exec.Command(executable, "-test.run=^TestPluginDesktopMainHelper$", "--", "--data-root", t.TempDir(), "plugin", "disable", "missing.plugin")
	command.Env = append(os.Environ(), "GONAVI_TEST_PLUGIN_MAIN=1")
	var out, diagnostic bytes.Buffer
	command.Stdout, command.Stderr = &out, &diagnostic
	err = command.Run()
	var exit *exec.ExitError
	if !errors.As(err, &exit) || exit.ExitCode() != cli.ExitExecution {
		t.Fatalf("actual main exit: %v; stderr=%s", err, diagnostic.String())
	}
	decoder := json.NewDecoder(&diagnostic)
	var report map[string]any
	if err = decoder.Decode(&report); err != nil {
		t.Fatal(err)
	}
	if err = decoder.Decode(&report); err != io.EOF {
		t.Fatalf("main appended diagnostics: %v", err)
	}
}

func TestPluginDesktopMainHelper(t *testing.T) {
	if os.Getenv("GONAVI_TEST_PLUGIN_MAIN") != "1" {
		return
	}
	for i, arg := range os.Args {
		if arg == "--" {
			os.Args = append([]string{os.Args[0]}, os.Args[i+1:]...)
			main()
			os.Exit(0)
		}
	}
	os.Exit(97)
}

func TestPluginBridgeAssetsExistInBuiltBundle(t *testing.T) {
	runtimeAssets, err := pluginWindowAssets()
	if err != nil {
		t.Fatal(err)
	}
	file, err := runtimeAssets.Open("runtime.js")
	if err != nil {
		t.Skip("build frontend/plugin-window before native asset smoke:", err)
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || info.Size() == 0 {
		t.Fatalf("invalid bridge asset: %v", err)
	}
}
