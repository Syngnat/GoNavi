package app

import (
	"os"

	"GoNavi-Wails/internal/connection"
)

// driverPackageSelectionSet 把前端勾选的驱动类型归一成集合。
// nil 表示不限制，导出全部已安装可选驱动。
func driverPackageSelectionSet(driverTypes []string) map[string]struct{} {
	if len(driverTypes) == 0 {
		return nil
	}
	wanted := make(map[string]struct{}, len(driverTypes))
	for _, raw := range driverTypes {
		normalized := normalizeDriverType(raw)
		if normalized == "" {
			continue
		}
		wanted[normalized] = struct{}{}
	}
	if len(wanted) == 0 {
		return nil
	}
	return wanted
}

func filterDriverPackageExport(
	candidates []driverPackageExportCandidate,
	skipped []string,
	driverTypes []string,
) ([]driverPackageExportCandidate, []string) {
	wanted := driverPackageSelectionSet(driverTypes)
	if wanted == nil {
		return candidates, skipped
	}
	filtered := make([]driverPackageExportCandidate, 0, len(wanted))
	for _, candidate := range candidates {
		driverType := normalizeDriverType(candidate.definition.Type)
		if _, ok := wanted[driverType]; ok {
			filtered = append(filtered, candidate)
		}
	}
	filteredSkipped := make([]string, 0)
	for _, name := range skipped {
		if _, ok := wanted[normalizeDriverType(name)]; ok {
			filteredSkipped = append(filteredSkipped, name)
		}
	}
	return filtered, filteredSkipped
}

func loadDriverPackageExportSet(resolvedDir string, driverTypes []string) ([]driverPackageExportCandidate, []string, int64) {
	candidates, skipped, totalBytes := collectDriverPackageCandidates(resolvedDir)
	if driverPackageSelectionSet(driverTypes) == nil {
		return candidates, skipped, totalBytes
	}
	candidates, skipped = filterDriverPackageExport(candidates, skipped, driverTypes)
	return candidates, skipped, driverPackageCandidateBytes(candidates)
}

func driverPackageCandidateBytes(candidates []driverPackageExportCandidate) int64 {
	var total int64
	for _, candidate := range candidates {
		total += fileSizeIfRegular(candidate.binaryPath)
		for _, support := range candidate.supportFiles {
			total += fileSizeIfRegular(support.path)
		}
	}
	return total
}

func fileSizeIfRegular(path string) int64 {
	info, err := os.Stat(path)
	if err != nil || info.IsDir() {
		return 0
	}
	return info.Size()
}

func (a *App) driverPackageExportEmptyResult(driverTypes []string) connection.QueryResult {
	key := "driver_manager.backend.error.package_no_installed_drivers"
	if driverPackageSelectionSet(driverTypes) != nil {
		key = "driver_manager.backend.error.package_no_selected_drivers"
	}
	return connection.QueryResult{
		Success: false,
		Message: a.appText(key, nil),
	}
}
