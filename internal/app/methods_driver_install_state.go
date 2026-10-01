package app

import (
	"os"
	"path/filepath"
	"strings"

	"GoNavi-Wails/internal/db"
)

// 可选驱动「已安装」判定。
//
// installed.json 存在只说明曾经装过，不能证明二进制还在：用户可能直接从
// 文件夹删文件、清理工具可能误删、磁盘错误也可能让文件消失。
// 判定必须以磁盘上的二进制为准，否则状态页会谎报「已安装」并给出误导性文案。

// optionalDriverInstallProbe 描述一次「可选驱动是否真的可用」的探测结果。
type optionalDriverInstallProbe struct {
	// MetaExists 表示 installed.json 存在（仅表示"装过"）。
	MetaExists bool
	// BinaryPresent 表示元数据指向的代理二进制确实存在于磁盘。
	BinaryPresent bool
	// Installed 表示该驱动当前可视为已安装：元数据与二进制都在。
	Installed bool
	// StaleMetaPath 非空时表示这是指向已消失二进制的失效元数据，可清理。
	StaleMetaPath string
}

// probeOptionalDriverInstall 判定可选驱动是否真的已安装。
//
// 非可选驱动（内置 / 未知类型）直接返回零值，由调用方另行处理。
func probeOptionalDriverInstall(downloadDir string, driverType string) optionalDriverInstallProbe {
	if !db.IsOptionalGoDriver(driverType) {
		return optionalDriverInstallProbe{}
	}

	pkg, metaExists := readInstalledDriverPackage(downloadDir, driverType)
	if !metaExists {
		return optionalDriverInstallProbe{}
	}

	probe := optionalDriverInstallProbe{
		MetaExists:    true,
		StaleMetaPath: installedDriverMetaPath(downloadDir, driverType),
	}

	// 按元数据记录的版本解析二进制路径；解析不出来再退回不带版本的形式。
	executablePath := ""
	if resolved, err := db.ResolveOptionalDriverAgentExecutablePathForVersion(downloadDir, driverType, pkg.Version); err == nil {
		executablePath = resolved
	} else if resolved, err := db.ResolveOptionalDriverAgentExecutablePath(downloadDir, driverType); err == nil {
		executablePath = resolved
	}
	if strings.TrimSpace(executablePath) == "" {
		return probe
	}
	if info, err := os.Stat(executablePath); err != nil || info.IsDir() {
		return probe
	}

	probe.BinaryPresent = true
	probe.Installed = true
	probe.StaleMetaPath = ""
	return probe
}

// removeStaleInstalledDriverMeta 删除指向已消失二进制的 installed.json。
//
// 失败不影响状态返回：状态页已按"未安装"呈现，残留元数据只是冗余而非错误。
func removeStaleInstalledDriverMeta(metaPath string) {
	trimmed := strings.TrimSpace(metaPath)
	if trimmed == "" {
		return
	}
	_ = os.Remove(trimmed)
	// 驱动目录空了就一并收掉，避免留下一堆空壳目录干扰用户排查。
	if dir := filepath.Dir(trimmed); dir != "." && dir != string(filepath.Separator) {
		if entries, err := os.ReadDir(dir); err == nil && len(entries) == 0 {
			_ = os.Remove(dir)
		}
	}
}
