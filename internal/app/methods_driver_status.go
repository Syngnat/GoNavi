package app

import (
	"strings"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
)

func (a *App) GetDriverVersionList(driverType string, repositoryURL string) connection.QueryResult {
	effectivePackages, manifestErr := resolveEffectiveDriverPackages(repositoryURL)
	definition, ok := resolveDriverDefinitionWithPackages(driverType, effectivePackages)
	if !ok {
		return connection.QueryResult{Success: false, Message: a.appText("driver_manager.backend.error.unsupported_driver_type", nil)}
	}
	if definition.BuiltIn {
		return connection.QueryResult{Success: false, Message: a.appText("driver_manager.backend.error.builtin_version_not_required", nil)}
	}
	if err := a.localizeDriverSelectionError(definition, ensureOptionalDriverBuildAvailable(definition)); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	options, err := resolveDriverVersionOptions(definition, repositoryURL, a.appText)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	return connection.QueryResult{
		Success: true,
		Data: map[string]interface{}{
			"driverType":    definition.Type,
			"driverName":    definition.Name,
			"pinnedVersion": definition.PinnedVersion,
			"manifestError": localizedDriverBackendErrorMessage(a, manifestErr),
			"versions":      options,
		},
	}
}

func (a *App) GetDriverVersionPackageSize(driverType string, version string) connection.QueryResult {
	definition, ok := resolveDriverDefinition(driverType)
	if !ok {
		return connection.QueryResult{Success: false, Message: a.appText("driver_manager.backend.error.unsupported_driver_type", nil)}
	}
	if definition.BuiltIn {
		return connection.QueryResult{Success: false, Message: a.appText("driver_manager.backend.error.builtin_package_not_required", nil)}
	}

	normalizedType := normalizeDriverType(definition.Type)
	if normalizedType == "" || !db.IsOptionalGoDriver(normalizedType) {
		return connection.QueryResult{Success: false, Message: a.appText("driver_manager.backend.error.package_size_unsupported", nil)}
	}

	normalizedVersion := normalizeVersion(strings.TrimSpace(version))
	if normalizedVersion == "" {
		return connection.QueryResult{Success: false, Message: a.appText("driver_manager.backend.error.version_empty", nil)}
	}
	if err := a.localizeDriverSelectionError(definition, validateDriverSelectedVersion(definition, normalizedVersion)); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	assetName := optionalDriverReleaseZipAssetNameForVersion(normalizedType, normalizedVersion)
	if strings.TrimSpace(assetName) == "" {
		return connection.QueryResult{Success: false, Message: a.appText("driver_manager.backend.error.asset_name_empty", nil)}
	}

	tag := "v" + normalizedVersion
	sizeBytes := int64(0)
	sizeSource := ""
	if sizeByAsset, _, err := loadReleaseAssetSizesCached("tag:"+tag, func() (*githubRelease, error) {
		return fetchReleaseByTag(tag)
	}); err == nil {
		sizeBytes = resolveOptionalDriverAssetSizeForVersion(sizeByAsset, normalizedType, normalizedVersion)
		if sizeBytes > 0 {
			sizeSource = "tag"
		}
	}
	allowLatestFallback := sameDriverVersion(normalizedVersion, definition.PinnedVersion) || sameDriverVersion(normalizedVersion, latestDriverVersionMap[normalizedType])
	if sizeBytes <= 0 && allowLatestFallback {
		if sizeByAsset, _, err := loadReleaseAssetSizesCached("latest", fetchLatestReleaseForDriverAssets); err == nil {
			sizeBytes = resolveOptionalDriverAssetSizeForVersion(sizeByAsset, normalizedType, normalizedVersion)
			if sizeBytes > 0 {
				sizeSource = "latest"
			}
		}
	}
	data := map[string]interface{}{
		"driverType":       normalizedType,
		"version":          normalizedVersion,
		"packageSizeBytes": sizeBytes,
		"packageSizeText":  "",
		"releaseAssetName": assetName,
		"releaseAssetTag":  tag,
		"sizeSource":       sizeSource,
	}
	if sizeBytes > 0 {
		data["packageSizeText"] = formatSizeMB(sizeBytes)
	}
	return connection.QueryResult{Success: true, Data: data}
}

func (a *App) GetDriverStatusList(downloadDir string, manifestURL string) connection.QueryResult {
	resolvedDir, err := resolveDriverDownloadDirectory(downloadDir)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	db.SetExternalDriverDownloadDirectory(resolvedDir)

	effectivePackages, manifestErr := resolveEffectiveDriverPackages(manifestURL)
	definitions := allDriverDefinitionsWithPackages(effectivePackages)
	triggerDriverVersionMetadataWarmup(definitions)
	packageSizeBytesMap := readCachedOptionalDriverPackageSizes(definitions)
	usageCounts := a.savedConnectionDriverUsageCounts()
	activeUsageCounts := a.activeConnectionDriverUsageCounts()
	items := make([]driverStatusItem, 0, len(definitions))
	for _, definition := range definitions {
		engine := effectiveDriverEngine(definition)
		// 先清失效元数据再求 runtimeAvailable：后者内部会把 installed.json 当作
		// 安装标记，顺序反了会让同一次返回里两个字段源自不同磁盘状态。
		if staleMetaPath := probeOptionalDriverInstall(resolvedDir, definition.Type).StaleMetaPath; staleMetaPath != "" {
			removeStaleInstalledDriverMeta(staleMetaPath)
		}
		runtimeAvailable, runtimeReason := db.DriverRuntimeSupportStatus(definition.Type)
		pkg, packageMetaExists := readInstalledDriverPackage(resolvedDir, definition.Type)
		needsUpdate, optionalUpdate, updateReason, expectedRevision := optionalDriverPackageUpdateStatus(definition, pkg, packageMetaExists)
		packageInstalled := definition.BuiltIn || packageMetaExists
		if runtimeAvailable && db.IsOptionalGoDriver(definition.Type) {
			packageInstalled = true
		}

		item := driverStatusItem{
			Type:                definition.Type,
			Name:                definition.Name,
			Engine:              engine,
			BuiltIn:             definition.BuiltIn,
			PinnedVersion:       definition.PinnedVersion,
			InstalledVersion:    strings.TrimSpace(pkg.Version),
			PackageSizeText:     resolveDriverPackageSizeText(definition, pkg, packageMetaExists, packageSizeBytesMap, a.appText),
			RuntimeAvailable:    runtimeAvailable,
			PackageInstalled:    packageInstalled,
			Connectable:         runtimeAvailable,
			DefaultDownloadURL:  definition.DefaultDownloadURL,
			InstallDir:          driverInstallDir(resolvedDir, definition.Type),
			AgentRevision:       strings.TrimSpace(pkg.AgentRevision),
			ExpectedRevision:    expectedRevision,
			NeedsUpdate:         needsUpdate,
			OptionalUpdate:      optionalUpdate && !needsUpdate,
			UpdateReason:        updateReason,
			AffectedConnections: usageCounts[normalizeDriverType(definition.Type)],
			ActiveConnections:   activeUsageCounts[normalizeDriverType(definition.Type)],
		}
		if !runtimeAvailable && db.IsOptionalGoDriver(definition.Type) && !db.IsOptionalGoDriverBuildIncluded(definition.Type) {
			item.ReasonCode = driverStatusReasonSlimBuildMissingDriver
		}
		if packageMetaExists {
			item.PackagePath = pkg.FilePath
			item.PackageFileName = pkg.FileName
			item.DownloadedAt = pkg.DownloadedAt
			item.ExecutablePath = pkg.ExecutablePath
		}
		runtimeReason = a.localizeDriverRuntimeReason(definition, runtimeReason)
		if needsUpdate {
			item.UpdateReason, item.Message = a.localizedDriverNeedsUpdateTexts(item.AgentRevision, expectedRevision, item.AffectedConnections)
		}

		switch {
		case definition.BuiltIn:
			item.Message = a.appText("driver_manager.backend.status.built_in_available", nil)
		case optionalUpdate:
			item.Message = a.appText("driver_manager.backend.status.optional_component_update_detail", nil)
		case needsUpdate:
			// item.UpdateReason / item.Message already localized above.
		case runtimeAvailable:
			item.Message = a.appText("driver_manager.backend.status.optional_enabled", nil)
		case packageInstalled && strings.TrimSpace(runtimeReason) != "":
			item.Message = runtimeReason
		case packageInstalled:
			if item.InstalledVersion != "" {
				item.Message = a.appText("driver_manager.backend.status.installed_pending_with_version", map[string]any{"version": item.InstalledVersion})
			} else {
				item.Message = a.appText("driver_manager.backend.status.installed_pending", nil)
			}
		case strings.TrimSpace(runtimeReason) != "":
			item.Message = runtimeReason
		default:
			if strings.TrimSpace(definition.PinnedVersion) != "" {
				item.Message = a.appText("driver_manager.backend.status.optional_disabled_with_version", map[string]any{"version": strings.TrimSpace(definition.PinnedVersion)})
			} else {
				item.Message = a.appText("driver_manager.backend.status.optional_disabled_generic", nil)
			}
		}

		items = append(items, item)
	}

	return connection.QueryResult{
		Success: true,
		Data: map[string]interface{}{
			"downloadDir":   resolvedDir,
			"drivers":       items,
			"manifestURL":   resolveManifestURLForView(manifestURL),
			"manifestError": localizedDriverBackendErrorMessage(a, manifestErr),
		},
	}
}
