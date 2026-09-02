package provider

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestLookupLocalCLICommandPrefersPATHOverNvm(t *testing.T) {
	pathBin := t.TempDir()
	nvmDir := writeNvmNodeFixture(t, "v24.14.0", "codex")
	pathCodex := filepath.Join(pathBin, "codex")
	writeExecutable(t, pathCodex, "#!/bin/sh\n")
	nvmCodex := filepath.Join(nvmDir, "versions", "node", "v24.14.0", "bin", "codex")

	path, err := LookupLocalCLICommandUsing(CLILookupHooks{
		LookPath: func(name string) (string, error) {
			if name == "codex" || name == pathCodex {
				return pathCodex, nil
			}
			return "", exec.ErrNotFound
		},
		NvmDir:          func() string { return nvmDir },
		ShellCandidates: func() []string { t.Fatal("PATH hit must not use login shell"); return nil },
		GOOS:            "darwin",
	}, "codex")
	if err != nil || path != pathCodex {
		t.Fatalf("PATH must win over nvm: path=%q err=%v nvm=%s", path, err, nvmCodex)
	}
}

func TestLookupLocalCLICommandUsesNvmWhenPATHMisses(t *testing.T) {
	nvmDir := writeNvmNodeFixture(t, "v24.14.0", "codex")
	want := filepath.Join(nvmDir, "versions", "node", "v24.14.0", "bin", "codex")

	path, err := LookupLocalCLICommandUsing(CLILookupHooks{
		LookPath: func(name string) (string, error) {
			if name == want {
				return want, nil
			}
			return "", exec.ErrNotFound
		},
		NvmDir:          func() string { return nvmDir },
		ShellCandidates: func() []string { t.Fatal("nvm hit must not use login shell"); return nil },
		GOOS:            "darwin",
	}, "codex")
	if err != nil || path != want {
		t.Fatalf("nvm fallback path=%q err=%v want=%s", path, err, want)
	}
}

func TestLookupLocalCLICommandUsesNewestNvmWhenAliasMissing(t *testing.T) {
	nvmDir := t.TempDir()
	writeNvmNodeVersion(t, nvmDir, "v20.0.0", "node")
	writeNvmNodeVersion(t, nvmDir, "v24.14.0", "node")
	want := filepath.Join(nvmDir, "versions", "node", "v24.14.0", "bin", "node")

	path, err := LookupLocalCLICommandUsing(CLILookupHooks{
		LookPath: func(name string) (string, error) {
			if name == want {
				return want, nil
			}
			return "", exec.ErrNotFound
		},
		NvmDir:          func() string { return nvmDir },
		ShellCandidates: func() []string { t.Fatal("newest nvm hit must not use login shell"); return nil },
		GOOS:            "darwin",
	}, "node")
	if err != nil || path != want {
		t.Fatalf("newest nvm path=%q err=%v want=%s", path, err, want)
	}
}

func TestLookupLocalCLICommandFallsBackToLoginShellAfterNvmMiss(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("login-shell PATH fallback is Unix-only")
	}
	shellPath := filepath.Join(t.TempDir(), "claude")
	writeExecutable(t, shellPath, "#!/bin/sh\n")

	path, err := LookupLocalCLICommandUsing(CLILookupHooks{
		LookPath: func(name string) (string, error) {
			if name == "claude" {
				return "", exec.ErrNotFound
			}
			if name == shellPath {
				return shellPath, nil
			}
			return "", exec.ErrNotFound
		},
		NvmDir:          func() string { return t.TempDir() },
		ShellCandidates: func() []string { return []string{"/bin/zsh"} },
		ShellOutput: func(ctx context.Context, shell string, lookupCommand string) ([]byte, error) {
			if shell != "/bin/zsh" || lookupCommand != "command -v -- 'claude'" {
				t.Fatalf("shell=%q lookup=%q", shell, lookupCommand)
			}
			return []byte("notice\n/usr/bin/ls\n" + shellPath + "\n"), nil
		},
		Timeout: time.Second,
		GOOS:    "darwin",
	}, "claude")
	if err != nil || path != shellPath {
		t.Fatalf("login-shell fallback path=%q err=%v", path, err)
	}
}

func TestLookupLocalCLICommandRejectsUnsafeNameBeforeNvmAndShell(t *testing.T) {
	_, err := LookupLocalCLICommandUsing(CLILookupHooks{
		LookPath: func(name string) (string, error) {
			if name != "claude; touch /tmp/pwned" {
				t.Fatalf("unexpected lookup %q", name)
			}
			return "", exec.ErrNotFound
		},
		NvmDir: func() string { t.Fatal("unsafe name must not inspect nvm"); return "" },
		ShellCandidates: func() []string {
			t.Fatal("unsafe name must not invoke a shell")
			return nil
		},
		GOOS: "darwin",
	}, "claude; touch /tmp/pwned")
	if err == nil {
		t.Fatal("expected unsafe name to fail")
	}
}

func TestLookupLocalCLICommandSkipsNvmAndShellOnWindows(t *testing.T) {
	_, err := LookupLocalCLICommandUsing(CLILookupHooks{
		LookPath: func(string) (string, error) { return "", exec.ErrNotFound },
		NvmDir:   func() string { t.Fatal("windows must not probe nvm"); return "" },
		ShellCandidates: func() []string {
			t.Fatal("windows must not use login shell")
			return nil
		},
		GOOS: "windows",
	}, "codex")
	if err == nil {
		t.Fatal("expected windows lookup without PATH to fail")
	}
}

func TestEnrichCLICommandPATHPutsCommandDirBeforeNvmNode(t *testing.T) {
	t.Setenv("PATH", "/usr/bin:/bin")
	t.Setenv("NVM_DIR", t.TempDir())
	commandDir := t.TempDir()
	env := EnrichCLICommandPATH([]string{"PATH=/usr/bin:/bin", "HOME=/tmp"}, filepath.Join(commandDir, "codex"))
	got := envValue(env, "PATH")
	if !strings.HasPrefix(got, commandDir+string(os.PathListSeparator)) {
		t.Fatalf("command dir must lead PATH, got %q", got)
	}
	if !strings.Contains(got, "/usr/bin") {
		t.Fatalf("original PATH entries must remain, got %q", got)
	}
}

func TestResolveCodexCLICommandUsesNvmNativeBinaryWhenPATHMisses(t *testing.T) {
	nvmDir := writeNvmNodeFixture(t, "v24.14.0", "codex")
	t.Setenv("NVM_DIR", nvmDir)
	t.Setenv("PATH", "/usr/bin:/bin")
	launcher := filepath.Join(nvmDir, "versions", "node", "v24.14.0", "bin", "codex")
	native := filepath.Join(
		nvmDir, "versions", "node", "v24.14.0", "lib", "node_modules", "@openai", "codex",
		"node_modules", "@openai", "codex-darwin-arm64", "vendor", "aarch64-apple-darwin", "bin", "codex",
	)
	if err := os.MkdirAll(filepath.Dir(native), 0o755); err != nil {
		t.Fatal(err)
	}
	writeExecutable(t, native, "native")

	lookPath := func(name string) (string, error) {
		return LookupLocalCLICommandUsing(CLILookupHooks{
			LookPath: func(value string) (string, error) {
				if value == "codex" {
					return "", exec.ErrNotFound
				}
				if value == launcher || value == native {
					return value, nil
				}
				return "", exec.ErrNotFound
			},
			NvmDir:          func() string { return nvmDir },
			ShellCandidates: func() []string { t.Fatal("nvm native resolve must not use login shell"); return nil },
			GOOS:            "darwin",
		}, name)
	}
	command, err := resolveCodexCLICommand("darwin", "arm64", lookPath, fileExists)
	if err != nil || command.Path != native {
		t.Fatalf("arm64 should take nvm vendor binary, got %#v err=%v", command, err)
	}
	fallback, err := resolveCodexCLICommand("darwin", "amd64", lookPath, fileExists)
	if err != nil || fallback.Path != launcher {
		t.Fatalf("amd64 should keep nvm env-node launcher, got %#v err=%v", fallback, err)
	}
}

func TestEnrichCLICommandPATHAddsNvmNodeWhenPATHMisses(t *testing.T) {
	t.Setenv("PATH", "/usr/bin:/bin")
	nvmDir := writeNvmNodeFixture(t, "v24.14.0", "node")
	t.Setenv("NVM_DIR", nvmDir)
	nvmBin := filepath.Join(nvmDir, "versions", "node", "v24.14.0", "bin")
	env := EnrichCLICommandPATH([]string{"PATH=/usr/bin:/bin"}, "")
	got := envValue(env, "PATH")
	if !strings.HasPrefix(got, nvmBin+string(os.PathListSeparator)) {
		t.Fatalf("nvm node bin must be prepended when PATH has no node, got %q", got)
	}
}

func writeNvmNodeFixture(t *testing.T, version, command string) string {
	t.Helper()
	nvmDir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(nvmDir, "alias"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(nvmDir, "alias", "default"), []byte(version+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	writeNvmNodeVersion(t, nvmDir, version, command)
	return nvmDir
}

func writeNvmNodeVersion(t *testing.T, nvmDir, version, command string) {
	t.Helper()
	bin := filepath.Join(nvmDir, "versions", "node", version, "bin")
	if err := os.MkdirAll(bin, 0o755); err != nil {
		t.Fatal(err)
	}
	writeExecutable(t, filepath.Join(bin, command), "#!/bin/sh\n")
}

func writeExecutable(t *testing.T, path, body string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(body), 0o755); err != nil {
		t.Fatal(err)
	}
}
