package app

import (
	"archive/zip"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	stdRuntime "runtime"
	"sort"
	"strings"

	"GoNavi-Wails/internal/buildutil"
)

func locateProjectRootForAgentBuild() (string, error) {
	wd, err := os.Getwd()
	if err != nil {
		return "", newLocalizedDriverBackendError("driver_manager.backend.error.source_build_workdir_unavailable", nil, err)
	}
	dir := wd
	for {
		if fileExists(filepath.Join(dir, "go.mod")) && fileExists(filepath.Join(dir, "cmd", "optional-driver-agent", "main.go")) {
			return dir, nil
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}
	return "", newLocalizedDriverBackendError("driver_manager.backend.error.source_build_project_root_missing", nil, nil)
}

func fileExists(path string) bool {
	info, err := os.Stat(path)
	return err == nil && !info.IsDir()
}

func withEnvValue(env []string, key string, value string) []string {
	normalizedKey := strings.ToUpper(strings.TrimSpace(key))
	entry := normalizedKey + "=" + value
	for i, item := range env {
		name, _, ok := strings.Cut(item, "=")
		if ok && strings.ToUpper(strings.TrimSpace(name)) == normalizedKey {
			env[i] = entry
			return env
		}
	}
	return append(env, entry)
}

func duckDBWindowsDynamicLibraryCGOLDFlags(libDir string) string {
	normalizedDir := strings.ReplaceAll(filepath.ToSlash(strings.TrimSpace(libDir)), `\`, `/`)
	parts := []string{
		// cgo 会把每个 CGO_LDFLAGS 片段转成 //go:cgo_ldflag，带引号的 -L 在 windows/amd64 上会被当成非法参数。
		fmt.Sprintf("-L%s", normalizedDir),
		"-lduckdb",
		"-lstdc++",
		"-lm",
		"-lws2_32",
		"-lwsock32",
		"-lrstrtmgr",
	}
	return strings.Join(parts, " ")
}

func envValue(env []string, key string) string {
	normalizedKey := strings.ToUpper(strings.TrimSpace(key))
	for _, item := range env {
		name, value, ok := strings.Cut(item, "=")
		if ok && strings.ToUpper(strings.TrimSpace(name)) == normalizedKey {
			return value
		}
	}
	return ""
}

func prependPathEnv(env []string, dir string) []string {
	trimmedDir := strings.TrimSpace(dir)
	if trimmedDir == "" {
		return env
	}
	currentPath := envValue(env, "PATH")
	return withEnvValue(env, "PATH", trimmedDir+string(os.PathListSeparator)+currentPath)
}

func configureDuckDBWindowsCGOToolchainEnv(env []string) ([]string, error) {
	if stdRuntime.GOOS != "windows" || stdRuntime.GOARCH != "amd64" {
		return env, nil
	}
	binDir, err := resolveDuckDBWindowsCGOToolchainBin()
	if err != nil {
		return env, err
	}
	env = withEnvValue(env, "CC", filepath.Join(binDir, "gcc.exe"))
	env = withEnvValue(env, "CXX", filepath.Join(binDir, "g++.exe"))
	env = prependPathEnv(env, binDir)
	return env, nil
}

func resolveDuckDBWindowsCGOToolchainBin() (string, error) {
	candidates := duckDBWindowsCGOToolchainBinCandidates()
	return resolveDuckDBWindowsCGOToolchainBinFromCandidates(candidates)
}

func resolveDuckDBWindowsCGOToolchainBinFromCandidates(candidates []string) (string, error) {
	seen := make(map[string]struct{}, len(candidates))
	checked := make([]string, 0, len(candidates))
	for _, candidate := range candidates {
		binDir := strings.TrimSpace(candidate)
		if binDir == "" {
			continue
		}
		cleaned := filepath.Clean(binDir)
		key := strings.ToLower(cleaned)
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		checked = append(checked, cleaned)
		if fileExists(filepath.Join(cleaned, "gcc.exe")) && fileExists(filepath.Join(cleaned, "g++.exe")) {
			return cleaned, nil
		}
	}

	installHint := localizedDriverBackendText(nil, "driver_manager.backend.error.source_build_duckdb_windows_toolchain_install_hint", nil)
	if len(checked) == 0 {
		return "", newLocalizedDriverBackendError("driver_manager.backend.error.source_build_duckdb_windows_gcc_not_found", map[string]any{"hint": installHint}, nil)
	}
	return "", newLocalizedDriverBackendError("driver_manager.backend.error.source_build_duckdb_windows_gcc_not_found_with_checked", map[string]any{
		"checked": strings.Join(checked, ", "),
		"hint":    installHint,
	}, nil)
}

func duckDBWindowsCGOToolchainBinCandidates() []string {
	candidates := make([]string, 0, 12)
	if ccDir := executableEnvDir("CC"); ccDir != "" {
		candidates = append(candidates, ccDir)
	}
	if cxxDir := executableEnvDir("CXX"); cxxDir != "" {
		candidates = append(candidates, cxxDir)
	}
	if gccPath, err := exec.LookPath("gcc"); err == nil {
		candidates = append(candidates, filepath.Dir(gccPath))
	}
	if gxxPath, err := exec.LookPath("g++"); err == nil {
		candidates = append(candidates, filepath.Dir(gxxPath))
	}
	if prefix := strings.TrimSpace(os.Getenv("MSYSTEM_PREFIX")); prefix != "" {
		candidates = append(candidates, filepath.Join(prefix, "bin"))
	}
	if msys2Location := strings.TrimSpace(os.Getenv("MSYS2_LOCATION")); msys2Location != "" {
		candidates = append(candidates, filepath.Join(msys2Location, "ucrt64", "bin"))
	}
	candidates = append(candidates, `C:\msys64\ucrt64\bin`, `C:\tools\msys64\ucrt64\bin`)
	if localAppData := strings.TrimSpace(os.Getenv("LOCALAPPDATA")); localAppData != "" {
		candidates = append(candidates, filepath.Join(localAppData, "Programs", "msys64", "ucrt64", "bin"))
	}
	if programFiles := strings.TrimSpace(os.Getenv("ProgramFiles")); programFiles != "" {
		candidates = append(candidates, filepath.Join(programFiles, "msys64", "ucrt64", "bin"))
	}
	if programFilesX86 := strings.TrimSpace(os.Getenv("ProgramFiles(x86)")); programFilesX86 != "" {
		candidates = append(candidates, filepath.Join(programFilesX86, "msys64", "ucrt64", "bin"))
	}
	return candidates
}

func executableEnvDir(key string) string {
	raw := strings.TrimSpace(os.Getenv(key))
	if raw == "" {
		return ""
	}
	if filepath.IsAbs(raw) {
		return filepath.Dir(raw)
	}
	resolved, err := exec.LookPath(raw)
	if err != nil {
		return ""
	}
	return filepath.Dir(resolved)
}

func prepareDuckDBWindowsDynamicLibraryForBuild() (string, func(), error) {
	workDir, err := os.MkdirTemp("", "gonavi-duckdb-lib-*")
	if err != nil {
		return "", nil, err
	}
	cleanup := func() {
		_ = os.RemoveAll(workDir)
	}

	archivePath := filepath.Join(workDir, "libduckdb-windows-amd64.zip")
	if _, err := downloadFileWithHash(duckDBWindowsLibraryArchiveURL, archivePath, nil); err != nil {
		cleanup()
		return "", nil, err
	}

	reader, err := zip.OpenReader(archivePath)
	if err != nil {
		cleanup()
		return "", nil, err
	}
	defer reader.Close()

	required := map[string]bool{
		"duckdb.dll": false,
	}
	for _, file := range reader.File {
		baseName := strings.ToLower(filepath.Base(filepath.ToSlash(file.Name)))
		if _, ok := required[baseName]; !ok {
			continue
		}
		if err := extractZipFileToPath(file, filepath.Join(workDir, baseName)); err != nil {
			cleanup()
			return "", nil, err
		}
		required[baseName] = true
	}
	var missing []string
	for name, found := range required {
		if !found {
			missing = append(missing, name)
		}
	}
	if len(missing) > 0 {
		sort.Strings(missing)
		cleanup()
		return "", nil, newLocalizedDriverBackendError("driver_manager.backend.error.source_build_duckdb_windows_dynamic_library_missing_files", map[string]any{
			"files": strings.Join(missing, ", "),
		}, nil)
	}

	toolchainBin, err := resolveDuckDBWindowsCGOToolchainBin()
	if err != nil {
		cleanup()
		return "", nil, newLocalizedDriverBackendError("driver_manager.backend.error.source_build_duckdb_windows_dlltool_resolve_failed", nil, err)
	}
	dllPath := filepath.Join(workDir, "duckdb.dll")
	importLibPath := filepath.Join(workDir, "libduckdb.dll.a")
	if err := buildutil.GenerateWindowsImportLibraryFromDLL(
		dllPath,
		filepath.Join(toolchainBin, "dlltool.exe"),
		importLibPath,
	); err != nil {
		cleanup()
		return "", nil, err
	}
	if err := copyOptionalDriverSupportFile(importLibPath, filepath.Join(workDir, "libduckdb.a")); err != nil {
		cleanup()
		return "", nil, err
	}

	return workDir, cleanup, nil
}
