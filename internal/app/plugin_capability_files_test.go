package app

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	wailsRuntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

func replacePluginFileDialogs(t *testing.T, file, folder, save string) {
	t.Helper()
	previousFile, previousFolder, previousSave := openPluginFileDialog, openPluginFolderDialog, savePluginFileDialog
	openPluginFileDialog = func(context.Context, wailsRuntime.OpenDialogOptions) (string, error) { return file, nil }
	openPluginFolderDialog = func(context.Context, wailsRuntime.OpenDialogOptions) (string, error) { return folder, nil }
	savePluginFileDialog = func(context.Context, wailsRuntime.SaveDialogOptions) (string, error) { return save, nil }
	t.Cleanup(func() {
		openPluginFileDialog, openPluginFolderDialog, savePluginFileDialog = previousFile, previousFolder, previousSave
	})
}

func pluginFileRequest(raw string) pluginCapabilityRequest {
	return pluginCapabilityRequest{Arguments: json.RawMessage(raw)}
}

func TestPluginCapabilityFilesPickReturnsTheSelectedPath(t *testing.T) {
	a := newPluginTestApp(t)
	replacePluginFileDialogs(t, "/tmp/upload.bin", "/tmp/folder", "/tmp/download.bin")

	value, code := pluginCapabilityFilesPick(context.Background(), a, pluginFileRequest(`{"mode":"file","title":"Pick","extensions":["*.bin"]}`))
	if code != "" {
		t.Fatalf("file pick failed: %s", code)
	}
	if value.(pluginFilesTarget).Path != "/tmp/upload.bin" {
		t.Fatalf("unexpected path: %#v", value)
	}

	value, code = pluginCapabilityFilesPick(context.Background(), a, pluginFileRequest(`{"mode":"folder"}`))
	if code != "" || value.(pluginFilesTarget).Path != "/tmp/folder" {
		t.Fatalf("folder pick failed: %s %#v", code, value)
	}

	value, code = pluginCapabilityFilesSave(context.Background(), a, pluginFileRequest(`{"title":"Save","defaultName":"report.txt","extensions":["*.txt"]}`))
	if code != "" || value.(pluginFilesTarget).Path != "/tmp/download.bin" {
		t.Fatalf("save failed: %s %#v", code, value)
	}
}

func TestPluginCapabilityFilesHonorsCancellation(t *testing.T) {
	a := newPluginTestApp(t)
	replacePluginFileDialogs(t, "", "", "")
	value, code := pluginCapabilityFilesPick(context.Background(), a, pluginFileRequest(`{}`))
	if code != "" {
		t.Fatalf("cancel must not fail: %s", code)
	}
	if value.(pluginFilesTarget).Path != "" {
		t.Fatalf("cancel must return an empty path: %#v", value)
	}
}

func TestPluginCapabilityFilesRejectsUnsafeArguments(t *testing.T) {
	a := newPluginTestApp(t)
	replacePluginFileDialogs(t, "/tmp/x", "/tmp/x", "/tmp/x")
	cases := []string{
		`{"mode":"socket"}`,
		`{"mode":"file","unknown":true}`,
		`{"title":"` + strings.Repeat("x", 300) + `"}`,
		`{"extensions":["../secret"]}`,
		`{"extensions":["*.txt;rm -rf"]}`,
		`{"extensions":["*.txt","*.md","*.log","*.csv","*.json","*.xml","*.yml","*.yaml","*.ini","*.conf","*.cfg","*.env","*.sh","*.bat","*.ps1","*.sql","*.toml"]}`,
	}
	for _, raw := range cases {
		if _, code := pluginCapabilityFilesPick(context.Background(), a, pluginFileRequest(raw)); code != "invalid_arguments" {
			t.Fatalf("unsafe pick arguments accepted: %s -> %s", raw, code)
		}
	}
	if _, code := pluginCapabilityFilesSave(context.Background(), a, pluginFileRequest(`{"defaultName":"../escape.txt"}`)); code != "invalid_arguments" {
		t.Fatal("save accepted a path separator in the suggested name")
	}
	if _, code := pluginCapabilityFilesSave(context.Background(), a, pluginFileRequest(`{"defaultName":"a/b.txt"}`)); code != "invalid_arguments" {
		t.Fatal("save accepted a nested suggested name")
	}
}

func TestPluginCapabilityFilesDeclinesWebRuntime(t *testing.T) {
	a := newPluginTestApp(t)
	a.webRuntime = true
	if _, code := pluginCapabilityFilesPick(context.Background(), a, pluginFileRequest(`{}`)); code != "unsupported" {
		t.Fatalf("web runtime must decline the dialog: %s", code)
	}
}
