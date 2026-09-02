package provider

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"
)

// CLILookupHooks 让探测与执行共用同一条解析链，测试仍可替换第一跳与 login-shell。
type CLILookupHooks struct {
	LookPath        func(string) (string, error)
	NvmDir          func() string
	ShellCandidates func() []string
	ShellOutput     func(ctx context.Context, shell string, lookupCommand string) ([]byte, error)
	Timeout         time.Duration
	GOOS            string
}

var defaultCLILookupTimeout = 2 * time.Second

// lookupLocalCLICommand 是供应商 CLI 与 MCP 探测的默认解析：
// LookPath 优先（保住 /usr/local/bin 的既有 node/codex 引入），然后 nvm default/newest，
// Unix 再退到 login-shell。绝不 EvalSymlinks 后再 exec，以免把 nvm-aware shim 解析成 _nvm-shim。
func lookupLocalCLICommand(name string) (string, error) {
	return LookupLocalCLICommandUsing(CLILookupHooks{}, name)
}

// LookupLocalCLICommandUsing 供 MCP 探测注入既有测试钩子，保持缓存键语义不变。
func LookupLocalCLICommandUsing(hooks CLILookupHooks, name string) (string, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return "", exec.ErrNotFound
	}
	hooks = normalizeCLILookupHooks(hooks)

	if path, err := hooks.LookPath(name); err == nil {
		if cleaned := strings.TrimSpace(path); cleaned != "" {
			return filepath.Clean(cleaned), nil
		}
	}
	if !isSafeCLICommandName(name) {
		return "", exec.ErrNotFound
	}
	if path, ok := lookupNvmCLICommand(hooks, name); ok {
		return path, nil
	}
	if hooks.GOOS == "windows" {
		return "", exec.ErrNotFound
	}
	if path, ok := lookupCLICommandFromLoginShell(hooks, name); ok {
		return path, nil
	}
	return "", exec.ErrNotFound
}

func normalizeCLILookupHooks(hooks CLILookupHooks) CLILookupHooks {
	if hooks.LookPath == nil {
		hooks.LookPath = exec.LookPath
	}
	if hooks.NvmDir == nil {
		hooks.NvmDir = defaultNvmDir
	}
	if hooks.ShellCandidates == nil {
		hooks.ShellCandidates = defaultCLIShellCandidates
	}
	if hooks.ShellOutput == nil {
		hooks.ShellOutput = defaultCLIShellOutput
	}
	if hooks.Timeout <= 0 {
		hooks.Timeout = defaultCLILookupTimeout
	}
	if strings.TrimSpace(hooks.GOOS) == "" {
		hooks.GOOS = runtime.GOOS
	}
	return hooks
}

func defaultNvmDir() string {
	if dir := strings.TrimSpace(os.Getenv("NVM_DIR")); dir != "" {
		return dir
	}
	home, err := os.UserHomeDir()
	if err != nil || strings.TrimSpace(home) == "" {
		return ""
	}
	return filepath.Join(home, ".nvm")
}

func lookupNvmCLICommand(hooks CLILookupHooks, name string) (string, bool) {
	if hooks.GOOS == "windows" {
		return "", false
	}
	nvmDir := strings.TrimSpace(hooks.NvmDir())
	if nvmDir == "" {
		return "", false
	}
	version := resolveNvmNodeVersion(nvmDir)
	if version == "" {
		return "", false
	}
	candidate := filepath.Join(nvmDir, "versions", "node", version, "bin", name)
	return acceptCLICommandPath(hooks, candidate, name)
}

func resolveNvmNodeVersion(nvmDir string) string {
	seen := make(map[string]struct{}, 8)
	alias := "default"
	for i := 0; i < 10; i++ {
		if _, loop := seen[alias]; loop {
			break
		}
		seen[alias] = struct{}{}
		body, err := os.ReadFile(filepath.Join(nvmDir, "alias", alias))
		if err != nil {
			break
		}
		alias = strings.TrimSpace(string(body))
		if alias == "" {
			break
		}
		if isNvmNodeVersion(alias) && nvmNodeBinExists(nvmDir, alias) {
			return alias
		}
	}
	return newestInstalledNvmNodeVersion(nvmDir)
}

func isNvmNodeVersion(value string) bool {
	if len(value) < 2 || value[0] != 'v' {
		return false
	}
	for _, char := range value[1:] {
		if (char >= '0' && char <= '9') || char == '.' {
			continue
		}
		return false
	}
	return strings.ContainsAny(value[1:], "0123456789")
}

func nvmNodeBinExists(nvmDir, version string) bool {
	info, err := os.Stat(filepath.Join(nvmDir, "versions", "node", version, "bin"))
	return err == nil && info.IsDir()
}

func newestInstalledNvmNodeVersion(nvmDir string) string {
	entries, err := os.ReadDir(filepath.Join(nvmDir, "versions", "node"))
	if err != nil {
		return ""
	}
	newest := ""
	var newestParts []int
	for _, entry := range entries {
		name := entry.Name()
		if !entry.IsDir() || !isNvmNodeVersion(name) || !nvmNodeBinExists(nvmDir, name) {
			continue
		}
		parts := nvmVersionParts(name)
		if newest == "" || compareNvmVersionParts(parts, newestParts) > 0 {
			newest = name
			newestParts = parts
		}
	}
	return newest
}

func nvmVersionParts(version string) []int {
	fields := strings.Split(strings.TrimPrefix(version, "v"), ".")
	parts := make([]int, 0, len(fields))
	for _, field := range fields {
		n, err := strconv.Atoi(field)
		if err != nil {
			n = 0
		}
		parts = append(parts, n)
	}
	return parts
}

func compareNvmVersionParts(left, right []int) int {
	n := len(left)
	if len(right) > n {
		n = len(right)
	}
	for i := 0; i < n; i++ {
		l, r := 0, 0
		if i < len(left) {
			l = left[i]
		}
		if i < len(right) {
			r = right[i]
		}
		if l != r {
			return l - r
		}
	}
	return 0
}

func lookupCLICommandFromLoginShell(hooks CLILookupHooks, name string) (string, bool) {
	lookupCommand := "command -v -- " + shellQuoteCLICommand(name)
	ctx, cancel := context.WithTimeout(context.Background(), hooks.Timeout)
	defer cancel()
	for _, shell := range hooks.ShellCandidates() {
		shell = strings.TrimSpace(shell)
		if shell == "" {
			continue
		}
		if ctx.Err() != nil {
			break
		}
		output, err := hooks.ShellOutput(ctx, shell, lookupCommand)
		if err != nil || ctx.Err() != nil {
			continue
		}
		for _, line := range strings.Split(string(output), "\n") {
			candidate := strings.TrimSpace(strings.TrimSuffix(line, "\r"))
			if path, ok := acceptCLICommandPath(hooks, candidate, name); ok {
				return path, true
			}
		}
	}
	return "", false
}

func acceptCLICommandPath(hooks CLILookupHooks, candidate, name string) (string, bool) {
	candidate = strings.TrimSpace(candidate)
	if !isCLICommandPathCandidate(candidate, name) {
		return "", false
	}
	resolved, err := hooks.LookPath(candidate)
	resolved = strings.TrimSpace(resolved)
	if err != nil || !isCLICommandPathCandidate(resolved, name) {
		return "", false
	}
	return filepath.Clean(resolved), true
}

func isCLICommandPathCandidate(candidate, name string) bool {
	candidate = strings.TrimSpace(candidate)
	name = strings.TrimSpace(name)
	if candidate == "" || name == "" || !filepath.IsAbs(candidate) {
		return false
	}
	return filepath.Base(candidate) == name
}

func defaultCLIShellCandidates() []string {
	seen := make(map[string]struct{}, 4)
	result := make([]string, 0, 4)
	appendShell := func(value string) {
		value = strings.TrimSpace(value)
		if value == "" {
			return
		}
		if _, ok := seen[value]; ok {
			return
		}
		seen[value] = struct{}{}
		result = append(result, value)
	}
	appendShell(os.Getenv("SHELL"))
	appendShell("/bin/zsh")
	appendShell("/bin/bash")
	appendShell("/bin/sh")
	return result
}

func defaultCLIShellOutput(ctx context.Context, shell string, lookupCommand string) ([]byte, error) {
	return exec.CommandContext(ctx, shell, "-ilc", lookupCommand).Output()
}

func isSafeCLICommandName(name string) bool {
	if name == "" {
		return false
	}
	for _, char := range name {
		if (char >= 'a' && char <= 'z') ||
			(char >= 'A' && char <= 'Z') ||
			(char >= '0' && char <= '9') ||
			char == '.' || char == '_' || char == '-' {
			continue
		}
		return false
	}
	return true
}

func shellQuoteCLICommand(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "'\\''") + "'"
}

// EnrichCLICommandPATH 给子进程补上 CLI 所在目录和 nvm node，让 `#!/usr/bin/env node`
// 在 GUI 极简 PATH 下也能完成第二跳。优先保留已选 node，再补 CLI 目录，不解析符号链接。
func EnrichCLICommandPATH(env []string, commandPath string) []string {
	dirs := make([]string, 0, 2)
	// Preserve the already selected Node runtime (including user shims) before
	// adding a discovered CLI directory that may contain another Node version.
	if nodePath, err := lookupNodeRuntimePath(); err == nil {
		dirs = append(dirs, filepath.Dir(nodePath))
	}
	if filepath.IsAbs(strings.TrimSpace(commandPath)) {
		dirs = append(dirs, filepath.Dir(filepath.Clean(commandPath)))
	}
	return prependPATHDirs(env, dirs...)
}

func lookupNodeRuntimePath() (string, error) {
	hooks := normalizeCLILookupHooks(CLILookupHooks{
		LookPath: exec.LookPath,
		NvmDir:   defaultNvmDir,
		Timeout:  defaultCLILookupTimeout,
		GOOS:     runtime.GOOS,
	})
	if path, err := hooks.LookPath("node"); err == nil {
		if cleaned := strings.TrimSpace(path); cleaned != "" {
			return filepath.Clean(cleaned), nil
		}
	}
	if path, ok := lookupNvmCLICommand(hooks, "node"); ok {
		return path, nil
	}
	return "", exec.ErrNotFound
}

func prependPATHDirs(env []string, dirs ...string) []string {
	current := envValue(env, "PATH")
	parts := make([]string, 0, len(dirs)+8)
	seen := make(map[string]struct{}, 8)
	appendDir := func(dir string) {
		dir = strings.TrimSpace(dir)
		if dir == "" {
			return
		}
		if _, ok := seen[dir]; ok {
			return
		}
		seen[dir] = struct{}{}
		parts = append(parts, dir)
	}
	for _, dir := range dirs {
		appendDir(dir)
	}
	for _, dir := range strings.Split(current, string(os.PathListSeparator)) {
		appendDir(dir)
	}
	if len(parts) == 0 {
		return env
	}
	return upsertEnv(env, "PATH", strings.Join(parts, string(os.PathListSeparator)))
}
