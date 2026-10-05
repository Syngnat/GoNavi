package db

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/datasource"
)

// agentClientLibraryEnv 返回启动描述表驱动代理时追加的环境变量：客户端目录与动态库搜索路径
// （Linux 的 LD_LIBRARY_PATH、macOS 的 DYLD_LIBRARY_PATH、Windows 的 PATH）。没有声明或找不到客户端目录时返回 nil，
// 由驱动在连接时给出“未找到客户端”的提示。
func agentClientLibraryEnv(driverType string, config connection.ConnectionConfig) []string {
	spec, ok := DataSourceSpec(driverType)
	if !ok || spec.ClientLibrary == nil {
		return nil
	}
	return clientLibraryEnv(*spec.ClientLibrary, config, runtime.GOOS, os.Getenv)
}

func clientLibraryEnv(library datasource.ClientLibrarySpec, config connection.ConnectionConfig, goos string, getenv func(string) string) []string {
	home := strings.TrimSpace(connectionParamsFromText(config.ConnectionParams).Get(library.Param))
	for _, name := range library.HomeEnv {
		if home != "" {
			break
		}
		home = strings.TrimSpace(getenv(name))
	}
	if home == "" {
		return nil
	}
	var env []string
	if len(library.HomeEnv) > 0 {
		env = append(env, library.HomeEnv[0]+"="+home)
	}
	dirs, pathVar, separator := library.LibraryDirs, "LD_LIBRARY_PATH", ":"
	switch goos {
	case "windows":
		dirs, pathVar, separator = library.WindowsLibraryDirs, "PATH", ";"
	case "darwin":
		pathVar = "DYLD_LIBRARY_PATH"
	}
	if len(dirs) == 0 {
		return env
	}
	paths := make([]string, 0, len(dirs)+1)
	for _, dir := range dirs {
		paths = append(paths, joinClientPath(home, dir, goos))
	}
	if existing := getenv(pathVar); existing != "" {
		paths = append(paths, existing)
	}
	return append(env, pathVar+"="+strings.Join(paths, separator))
}

// joinClientPath 按目标系统的分隔符拼接客户端子目录（单测里会模拟其他系统）。
func joinClientPath(home, dir, goos string) string {
	if goos == "windows" {
		return strings.TrimRight(home, `\/`) + `\` + strings.ReplaceAll(dir, "/", `\`)
	}
	return filepath.ToSlash(strings.TrimRight(home, "/")) + "/" + strings.TrimLeft(dir, "/")
}
