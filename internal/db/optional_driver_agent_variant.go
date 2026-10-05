package db

import "GoNavi-Wails/internal/connection"

// resolveOptionalDriverAgentExecutableForConfig 是代理连接时定位可执行文件的入口：
// 描述表类型按连接上选择的驱动版本档位换算成代理键（独立构建档位装在自己的目录下），
// 历史类型沿用原有路径。
func resolveOptionalDriverAgentExecutableForConfig(driverType string, config connection.ConnectionConfig) (string, error) {
	return ResolveOptionalDriverAgentExecutablePath("", RegistryAgentKeyForConfig(driverType, config.DriverVariant))
}
