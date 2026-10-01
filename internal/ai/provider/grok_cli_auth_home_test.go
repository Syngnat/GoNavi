package provider

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestPinGrokAPIKeyAuthAppendsMissingSection(t *testing.T) {
	got := pinGrokAPIKeyAuth("model = \"grok-4.6\"\n")
	if !strings.Contains(got, "model = \"grok-4.6\"") {
		t.Fatalf("original config was dropped: %s", got)
	}
	if strings.Count(got, `preferred_method = "api_key"`) != 1 {
		t.Fatalf("auth pin = %s", got)
	}
}

func TestPinGrokAPIKeyAuthReplacesExistingMethod(t *testing.T) {
	got := pinGrokAPIKeyAuth("[auth]\npreferred_method = \"oidc\"\n\n[cli]\nfoo = 1\n")
	if strings.Contains(got, "oidc") {
		t.Fatalf("oidc preference remained: %s", got)
	}
	if strings.Count(got, "[auth]") != 1 || strings.Count(got, `preferred_method = "api_key"`) != 1 {
		t.Fatalf("auth section = %s", got)
	}
	if !strings.Contains(got, "foo = 1") {
		t.Fatalf("following section was dropped: %s", got)
	}
}

func TestPrepareGrokCLIAPIKeyHomeDoesNotCopyLogin(t *testing.T) {
	dir := t.TempDir()
	source := filepath.Join(dir, "config.toml")
	if err := os.WriteFile(source, []byte("api_key = \"test-key\"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	home, cleanup, err := prepareGrokCLIAPIKeyHome(source)
	if err != nil {
		t.Fatal(err)
	}
	defer cleanup()
	if _, err := os.Stat(filepath.Join(home, "auth.json")); !os.IsNotExist(err) {
		t.Fatal("isolated home must not carry the OIDC login file")
	}
	body, err := os.ReadFile(filepath.Join(home, "config.toml"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(body), `preferred_method = "api_key"`) || !strings.Contains(string(body), "test-key") {
		t.Fatalf("isolated config = %s", body)
	}
	info, err := os.Stat(filepath.Join(home, "config.toml"))
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("config mode = %o", info.Mode().Perm())
	}
}

func TestWithGrokCLIAuthSelectsCredentialMode(t *testing.T) {
	baseConfig := "[models]\ndefault = \"grok-4.6\"\n\n[model.\"grok-4.6\"]\napi_key = \"fixture-key\"\n\n[model.\"grok-4.7\"]\nmodel = \"grok-4.7\"\n"
	for _, test := range []struct {
		name     string
		config   string
		model    string
		extraEnv []string
		method   string
		copyAuth bool
	}{
		{
			name:     "subscription model copies OAuth login",
			config:   baseConfig,
			model:    "grok-4.7",
			method:   "oidc",
			copyAuth: true,
		},
		{
			name:   "model API key remains isolated",
			config: baseConfig,
			model:  "grok-4.6",
			method: "api_key",
		},
		{
			name: "model env key alias remains isolated",
			config: `[model."gateway-grok"]
model = "grok-4.7"
env_key = ["MISSING_GROK_KEY", "GROK_FIXTURE_KEY"]
`,
			model:    "grok-4.7",
			extraEnv: []string{"GROK_FIXTURE_KEY=fixture-key"},
			method:   "api_key",
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			dir := t.TempDir()
			if err := os.WriteFile(filepath.Join(dir, "config.toml"), []byte(test.config), 0o600); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(dir, "auth.json"), []byte(`{"account":"fixture-oauth"}`), 0o600); err != nil {
				t.Fatal(err)
			}

			env := append([]string{"GROK_HOME=" + dir}, test.extraEnv...)
			isolatedEnv, cleanup := withGrokCLIAuth(env, test.model)
			defer cleanup()
			isolatedHome := envValue(isolatedEnv, "GROK_HOME")
			if isolatedHome == "" || isolatedHome == dir {
				t.Fatalf("expected an isolated home, got %q", isolatedHome)
			}
			body, err := os.ReadFile(filepath.Join(isolatedHome, "config.toml"))
			if err != nil {
				t.Fatal(err)
			}
			wantMethod := `preferred_method = "` + test.method + `"`
			if !strings.Contains(string(body), wantMethod) {
				t.Fatalf("auth preference missing: %s", body)
			}

			authPath := filepath.Join(isolatedHome, "auth.json")
			if !test.copyAuth {
				if _, err := os.Stat(authPath); !os.IsNotExist(err) {
					t.Fatalf("API-key home must not copy OAuth login, stat error=%v", err)
				}
				return
			}
			auth, err := os.ReadFile(authPath)
			if err != nil {
				t.Fatalf("OAuth login was not copied: %v", err)
			}
			if string(auth) != `{"account":"fixture-oauth"}` {
				t.Fatalf("unexpected copied OAuth login: %s", auth)
			}
			info, err := os.Stat(authPath)
			if err != nil {
				t.Fatal(err)
			}
			if info.Mode().Perm() != 0o600 {
				t.Fatalf("auth mode = %o", info.Mode().Perm())
			}
		})
	}
}
