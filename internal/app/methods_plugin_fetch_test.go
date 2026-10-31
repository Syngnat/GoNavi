package app

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"GoNavi-Wails/internal/pluginfetch"
)

func TestPluginRemoteInspectRejectsInvalidSpec(t *testing.T) {
	app := &App{}
	result := app.PluginRemoteInspect("C:\\not\\a\\remote\\spec")
	if result.Success {
		t.Fatalf("local path specs must not be accepted")
	}
	if code, ok := result.Data.(map[string]any)["code"].(string); !ok || code != "spec_invalid" {
		t.Fatalf("code = %v, want spec_invalid", result.Data)
	}
}

func TestPluginRemoteInstallRequiresTrusted(t *testing.T) {
	app := &App{}
	result := app.PluginRemoteInstall("abc", false, "token")
	if result.Success {
		t.Fatalf("untrusted install must be rejected")
	}
	if code, ok := result.Data.(map[string]any)["code"].(string); !ok || code != "invalid_request" {
		t.Fatalf("code = %v, want invalid_request", result.Data)
	}
}

func TestPluginRemoteInstallConsumesApprovalOnce(t *testing.T) {
	app := &App{}
	ctx := context.Background()
	cleaned := false
	approval := &fetchedInstallApproval{
		spec:          "github:owner/repo",
		pluginID:      "demo.example",
		path:          t.TempDir(),
		contentDigest: "digest-1",
		cleanup:       func() { cleaned = true },
	}
	token, err := app.registerFetchApproval(ctx, approval)
	if err != nil {
		t.Fatalf("registerFetchApproval: %v", err)
	}

	// 错 digest 不消费令牌。
	if _, err = app.takeFetchApproval(ctx, "other-digest", token); !errors.Is(err, errFetchApprovalUnavailable) {
		t.Fatalf("mismatched digest error = %v", err)
	}
	if cleaned {
		t.Fatalf("mismatched take must not dispose the approval")
	}

	taken, err := app.takeFetchApproval(ctx, "digest-1", token)
	if err != nil {
		t.Fatalf("takeFetchApproval: %v", err)
	}
	if taken.pluginID != "demo.example" || taken.contentDigest != "digest-1" {
		t.Fatalf("taken approval = %+v", taken)
	}
	// 一次性：第二次取用必须失败。
	if _, err = app.takeFetchApproval(ctx, "digest-1", token); !errors.Is(err, errFetchApprovalUnavailable) {
		t.Fatalf("second take error = %v", err)
	}
	taken.dispose()
	if !cleaned {
		t.Fatalf("dispose must run the cleanup once")
	}
}

func TestPluginRemoteInstallExpiredApproval(t *testing.T) {
	app := &App{}
	approval := &fetchedInstallApproval{contentDigest: "digest-1", cleanup: func() {}}
	token, err := app.registerFetchApproval(context.Background(), approval)
	if err != nil {
		t.Fatalf("registerFetchApproval: %v", err)
	}
	approval.expires = time.Now().Add(-time.Minute)
	if _, err = app.takeFetchApproval(context.Background(), "digest-1", token); !errors.Is(err, errFetchApprovalExpired) {
		t.Fatalf("expired take error = %v", err)
	}
}

func TestPluginFetchFailureMapping(t *testing.T) {
	app := &App{}
	tests := []struct {
		name string
		err  error
		code string
	}{
		{name: "spec", err: pluginfetch.ErrSpecInvalid, code: "spec_invalid"},
		{name: "release", err: pluginfetch.ErrReleaseNotFound, code: "release_not_found"},
		{name: "npm", err: pluginfetch.ErrNPMNotFound, code: "npm_not_found"},
		{name: "ambiguous", err: &pluginfetch.AmbiguityError{Names: []string{"a.zip", "b.tgz"}}, code: "asset_ambiguous"},
		{name: "fetch", err: pluginfetch.ErrFetchFailed, code: "fetch_failed"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			result := app.pluginFetchFailure(test.err)
			if result.Success {
				t.Fatalf("failure must not succeed")
			}
			code, _ := result.Data.(map[string]any)["code"].(string)
			if code != test.code {
				t.Fatalf("code = %q, want %q", code, test.code)
			}
			if test.name == "ambiguous" && strings.TrimSpace(result.Message) == "" {
				t.Fatalf("ambiguous message must not be empty")
			}
		})
	}
}

func TestSafeRemoteFileName(t *testing.T) {
	tests := []struct{ raw, want string }{
		{raw: "gonavi-demo-1.0.0.zip", want: "gonavi-demo-1.0.0.zip"},
		{raw: "https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz", want: "lodash-4.17.21.tgz"},
		{raw: "https://github.com/o/r/releases/download/v1/x.tgz?sig=abc", want: "x.tgz"},
		{raw: "..\\..\\evil.tgz", want: "evil.tgz"},
		{raw: "we ird name.tar.gz", want: "weirdname.tar.gz"},
		{raw: "", want: "plugin-package"},
	}
	for _, test := range tests {
		if got := safeRemoteFileName(test.raw); got != test.want {
			t.Errorf("safeRemoteFileName(%q) = %q, want %q", test.raw, got, test.want)
		}
	}
}
