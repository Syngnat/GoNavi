package app

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	stdRuntime "runtime"
	"strings"
)

func buildOptionalDriverAgentFromSource(parentCtx context.Context, definition driverDefinition, executablePath string, selectedVersion string) (string, error) {
	if parentCtx == nil {
		parentCtx = context.Background()
	}
	if parentCtx.Err() != nil {
		return "", driverDownloadCanceledError(parentCtx)
	}
	driverType := normalizeDriverType(definition.Type)
	displayName := resolveDriverDisplayName(definition)
	goPath, lookErr := resolveGoBinaryPath()
	if lookErr != nil {
		return "", newLocalizedDriverBackendError("driver_manager.backend.error.go_not_found_prebuilt_missing", map[string]any{"name": displayName}, lookErr)
	}

	tagName, tagErr := optionalDriverBuildTags(driverType, selectedVersion)
	if tagErr != nil {
		return "", tagErr
	}

	projectRoot, rootErr := locateProjectRootForAgentBuild()
	if rootErr != nil {
		return "", rootErr
	}
	buildArgs := []string{"build", "-tags", tagName, "-trimpath", "-ldflags", "-s -w"}
	cleanupModOverride := func() {}
	if modOverride, modErr := prepareOptionalDriverBuildModOverride(projectRoot, driverType, selectedVersion); modErr != nil {
		return "", modErr
	} else if modOverride != nil {
		buildArgs = append(buildArgs, "-modfile", modOverride.modFile)
		cleanupModOverride = modOverride.cleanup
	}
	defer cleanupModOverride()
	env := append([]string{}, os.Environ()...)
	env = withEnvValue(env, "GOTOOLCHAIN", "auto")
	var duckDBLibDir string
	var cleanupDuckDBLib func()
	if normalizeDriverType(driverType) == "duckdb" {
		env = withEnvValue(env, "CGO_ENABLED", "1")
	}
	if shouldUseDuckDBWindowsDynamicLibrary(driverType) {
		var toolchainErr error
		env, toolchainErr = configureDuckDBWindowsCGOToolchainEnv(env)
		if toolchainErr != nil {
			return "", newLocalizedDriverBackendError("driver_manager.backend.error.source_build_duckdb_windows_cgo_toolchain_prepare_failed", nil, toolchainErr)
		}
		libDir, cleanup, prepErr := prepareDuckDBWindowsDynamicLibraryForBuild()
		if prepErr != nil {
			return "", newLocalizedDriverBackendError("driver_manager.backend.error.source_build_duckdb_windows_dynamic_library_prepare_failed", nil, prepErr)
		}
		duckDBLibDir = libDir
		cleanupDuckDBLib = cleanup
		defer cleanupDuckDBLib()
		env = withEnvValue(env, "CGO_LDFLAGS", duckDBWindowsDynamicLibraryCGOLDFlags(duckDBLibDir))
		env = prependPathEnv(env, duckDBLibDir)
	}
	buildArgs = append(buildArgs, "-o", executablePath, "./cmd/optional-driver-agent")
	ctx, cancel := context.WithTimeout(parentCtx, optionalDriverSourceBuildTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, goPath, buildArgs...)
	cmd.Dir = projectRoot
	cmd.Env = env
	output, buildErr := cmd.CombinedOutput()
	if parentCtx.Err() != nil {
		// The user canceled the task: the build process was killed on purpose.
		return "", driverDownloadCanceledError(parentCtx)
	}
	if ctx.Err() == context.DeadlineExceeded {
		return "", newLocalizedDriverBackendError("driver_manager.backend.error.source_build_timeout", map[string]any{"name": displayName, "timeout": optionalDriverSourceBuildTimeout}, nil)
	}
	if buildErr != nil {
		return "", newLocalizedDriverBackendError("driver_manager.backend.error.source_build_command_failed", map[string]any{
			"name":   displayName,
			"detail": buildErr.Error(),
			"output": strings.TrimSpace(string(output)),
		}, buildErr)
	}
	if strings.TrimSpace(duckDBLibDir) != "" {
		if copyErr := copyOptionalDriverSupportFilesFromDirectory(driverType, duckDBLibDir, filepath.Dir(executablePath)); copyErr != nil {
			return "", newLocalizedDriverBackendError("driver_manager.backend.error.copy_runtime_dependency_failed", map[string]any{"name": displayName}, copyErr)
		}
	}
	if chmodErr := os.Chmod(executablePath, 0o755); chmodErr != nil && stdRuntime.GOOS != "windows" {
		return "", newLocalizedDriverBackendError("driver_manager.backend.error.named_chmod_agent_failed", map[string]any{"name": displayName}, chmodErr)
	}
	hash, hashErr := hashFileSHA256(executablePath)
	if hashErr != nil {
		return "", newLocalizedDriverBackendError("driver_manager.backend.error.named_agent_hash_failed", map[string]any{"name": displayName}, hashErr)
	}
	return hash, nil
}

type optionalDriverBuildModOverride struct {
	modFile string
	cleanup func()
}

func prepareOptionalDriverBuildModOverride(projectRoot string, driverType string, selectedVersion string) (*optionalDriverBuildModOverride, error) {
	modulePath := strings.TrimSpace(driverGoModulePathMap[normalizeDriverType(driverType)])
	versionText := normalizeVersion(strings.TrimSpace(selectedVersion))
	if strings.EqualFold(normalizeDriverType(driverType), "tdengine") && modulePath != "" && versionText != "" {
		return buildVersionedDriverModOverride(projectRoot, modulePath, versionText)
	}
	return nil, nil
}

func buildVersionedDriverModOverride(projectRoot string, modulePath string, version string) (*optionalDriverBuildModOverride, error) {
	goModPath := filepath.Join(projectRoot, "go.mod")
	goSumPath := filepath.Join(projectRoot, "go.sum")
	modBytes, err := os.ReadFile(goModPath)
	if err != nil {
		return nil, newLocalizedDriverBackendError("driver_manager.backend.error.source_build_go_mod_read_failed", nil, err)
	}

	replaced, changed, err := rewriteRequiredModuleVersion(modBytes, modulePath, version)
	if err != nil {
		return nil, err
	}
	if !changed {
		return nil, newLocalizedDriverBackendError("driver_manager.backend.error.source_build_module_dependency_missing", map[string]any{"modulePath": modulePath}, nil)
	}

	workDir, err := os.MkdirTemp("", "gonavi-driver-mod-*")
	if err != nil {
		return nil, newLocalizedDriverBackendError("driver_manager.backend.error.source_build_temp_directory_create_failed", nil, err)
	}
	cleanup := func() {
		_ = os.RemoveAll(workDir)
	}

	modFile := filepath.Join(workDir, "go.mod")
	sumFile := filepath.Join(workDir, "go.sum")
	if err := os.WriteFile(modFile, replaced, 0o644); err != nil {
		cleanup()
		return nil, newLocalizedDriverBackendError("driver_manager.backend.error.source_build_temp_go_mod_write_failed", nil, err)
	}
	if sumBytes, readErr := os.ReadFile(goSumPath); readErr == nil {
		if writeErr := os.WriteFile(sumFile, sumBytes, 0o644); writeErr != nil {
			cleanup()
			return nil, newLocalizedDriverBackendError("driver_manager.backend.error.source_build_temp_go_sum_write_failed", nil, writeErr)
		}
	}

	return &optionalDriverBuildModOverride{
		modFile: modFile,
		cleanup: cleanup,
	}, nil
}

func rewriteRequiredModuleVersion(goMod []byte, modulePath string, version string) ([]byte, bool, error) {
	trimmedModule := strings.TrimSpace(modulePath)
	trimmedVersion := normalizeVersion(strings.TrimSpace(version))
	if trimmedModule == "" || trimmedVersion == "" {
		return nil, false, newLocalizedDriverBackendError("driver_manager.backend.error.source_build_module_or_version_empty", nil, nil)
	}

	pattern := fmt.Sprintf(`(?m)^(?P<prefix>\s*%s\s+)v[^\s]+(?P<suffix>\s*(//.*)?)$`, regexp.QuoteMeta(trimmedModule))
	re := regexp.MustCompile(pattern)
	changed := false
	replaced := re.ReplaceAllFunc(goMod, func(line []byte) []byte {
		match := re.FindSubmatch(line)
		if len(match) == 0 {
			return line
		}
		changed = true
		text := string(line)
		submatches := re.FindStringSubmatch(text)
		if len(submatches) == 0 {
			return line
		}
		prefix := submatches[1]
		suffix := ""
		if len(submatches) > 2 {
			suffix = submatches[2]
		}
		return []byte(prefix + "v" + trimmedVersion + suffix)
	})
	return replaced, changed, nil
}

func resolveMongoDriverMajorFromVersion(version string) int {
	trimmed := strings.TrimSpace(version)
	trimmed = strings.TrimPrefix(trimmed, "v")
	if strings.HasPrefix(trimmed, "1.") || trimmed == "1" {
		return 1
	}
	return 2
}

func shouldForceSourceBuildForResolvedDownload(_ string, _ string, _ string) bool {
	return false
}

func shouldPreferSourceBuildBeforeDownload(driverType string, selectedVersion string) bool {
	return shouldPreferSourceBuildBeforeDownloadForBuildType("", driverType, selectedVersion)
}

func shouldPreferSourceBuildBeforeDownloadForBuildType(buildType string, driverType string, selectedVersion string) bool {
	_ = selectedVersion
	_ = buildType
	return shouldUseDuckDBWindowsDynamicLibrary(driverType)
}

func shouldRequireSourceBuildBeforeDownloadForBuildType(buildType string, driverType string, selectedVersion string) bool {
	_ = selectedVersion
	_ = buildType
	_ = driverType
	return false
}

func shouldSkipReusableAgentCandidate(driverType string, selectedVersion string) bool {
	_ = selectedVersion
	switch normalizeDriverType(driverType) {
	case "mongodb", "kingbase":
		return true
	default:
		return shouldUseDuckDBWindowsDynamicLibrary(driverType)
	}
}

func shouldUseDuckDBWindowsDynamicLibrary(driverType string) bool {
	return normalizeDriverType(driverType) == "duckdb" && stdRuntime.GOOS == "windows" && stdRuntime.GOARCH == "amd64"
}

func shouldPreferPublishedOptionalDriverDownloads(driverType string) bool {
	return shouldUseDuckDBWindowsDynamicLibrary(driverType)
}

func shouldSkipDirectOptionalDriverDownloads(driverType string) bool {
	return shouldUseDuckDBWindowsDynamicLibrary(driverType)
}

func optionalDriverSupportFileNames(driverType string) []string {
	if shouldUseDuckDBWindowsDynamicLibrary(driverType) {
		return []string{duckDBWindowsSupportDLLName}
	}
	return nil
}

func optionalDriverBuildTag(driverType string, selectedVersion string) (string, error) {
	switch normalizeDriverType(driverType) {
	case "mysql":
		return "gonavi_mysql_driver", nil
	case "mariadb":
		return "gonavi_mariadb_driver", nil
	case "oceanbase":
		return "gonavi_oceanbase_driver", nil
	case "diros":
		return "gonavi_diros_driver", nil
	case "starrocks":
		return "gonavi_starrocks_driver", nil
	case "sphinx":
		return "gonavi_sphinx_driver", nil
	case "sqlserver":
		return "gonavi_sqlserver_driver", nil
	case "sqlite":
		return "gonavi_sqlite_driver", nil
	case "duckdb":
		return "gonavi_duckdb_driver", nil
	case "dameng":
		return "gonavi_dameng_driver", nil
	case "kingbase":
		return "gonavi_kingbase_driver", nil
	case "highgo":
		return "gonavi_highgo_driver", nil
	case "vastbase":
		return "gonavi_vastbase_driver", nil
	case "opengauss":
		return "gonavi_opengauss_driver", nil
	case "gaussdb":
		return "gonavi_gaussdb_driver", nil
	case "iris":
		return "gonavi_iris_driver", nil
	case "cache":
		return "gonavi_cache_driver", nil
	case "mongodb":
		if resolveMongoDriverMajorFromVersion(selectedVersion) == 1 {
			return "gonavi_mongodb_driver_v1", nil
		}
		return "gonavi_mongodb_driver", nil
	case "tdengine":
		return "gonavi_tdengine_driver", nil
	case "iotdb":
		return "gonavi_iotdb_driver", nil
	case "clickhouse":
		return "gonavi_clickhouse_driver", nil
	case "elasticsearch":
		return "gonavi_elasticsearch_driver", nil
	case "trino":
		return "gonavi_trino_driver", nil
	case "kafka":
		return "gonavi_kafka_driver", nil
	case "rocketmq":
		return "gonavi_rocketmq_driver", nil
	case "pulsar":
		return "gonavi_pulsar_driver", nil
	default:
		if tag, ok := registryDriverBuildTag(driverType); ok {
			return tag, nil
		}
		return "", newLocalizedDriverBackendError("driver_manager.backend.error.source_build_tag_unconfigured", map[string]any{"driverType": driverType}, nil)
	}
}

func optionalDriverBuildTags(driverType string, selectedVersion string) (string, error) {
	tagName, err := optionalDriverBuildTag(driverType, selectedVersion)
	if err != nil {
		return "", err
	}
	if shouldUseDuckDBWindowsDynamicLibrary(driverType) {
		return strings.TrimSpace(tagName + " duckdb_use_lib"), nil
	}
	return tagName, nil
}
