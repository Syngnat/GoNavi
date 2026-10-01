// Package mysql 实现 MySQL 系（MySQL / Percona / MariaDB / TiDB / OceanBase MySQL 模式 /
// GoldenDB）的账号管理。版本差异集中在 features 中判定，语句生成只看特性开关。
package mysql

import (
	"strings"

	"GoNavi-Wails/internal/dbuser"
)

// 分支。
const (
	flavorMySQL     = "mysql"
	flavorPercona   = "percona"
	flavorMariaDB   = "mariadb"
	flavorTiDB      = "tidb"
	flavorOceanBase = "oceanbase"
	flavorGoldenDB  = "goldendb"
)

// 特性开关键。
const (
	featAlterUser         = "alterUser"
	featAccountLock       = "accountLock"
	featPasswordExpire    = "passwordExpire"
	featExpireNow         = "expireNow"
	featLimitsInCreate    = "limitsInCreate"
	featResourceLimits    = "resourceLimits"
	featRequireSSL        = "requireSsl"
	featRoles             = "roles"
	featRoleHost          = "roleHost"
	featDefaultRoles      = "defaultRoles"
	featSingleDefaultRole = "singleDefaultRole"
	featPasswordHistory   = "passwordHistory"
	featRequireCurrent    = "requireCurrent"
	featDualPassword      = "dualPassword"
	featFailedLogin       = "failedLogin"
	featComment           = "comment"
	featDynamicPrivileges = "dynamicPrivileges"
	featPluginChoice      = "pluginChoice"
	featMariaDBVia        = "mariadbVia"
	featRename            = "rename"
	featRoleRename        = "roleRename"
)

// 方言开关键（写入 ServerProfile.Dialect，参与指纹）。
const (
	dialectFlavor           = "flavor"
	dialectBackslashEscapes = "backslashEscapes"
	dialectDefaultPlugin    = "defaultPlugin"
)

// resolveFlavor 根据连接类型与版本串判定分支。
func resolveFlavor(sourceType, version, versionComment string) string {
	lowerVersion := strings.ToLower(version)
	lowerComment := strings.ToLower(versionComment)
	switch {
	case sourceType == "mariadb" || strings.Contains(lowerVersion, "mariadb"):
		return flavorMariaDB
	case strings.Contains(lowerVersion, "tidb"):
		return flavorTiDB
	case sourceType == "oceanbase" || strings.Contains(lowerVersion, "oceanbase"):
		return flavorOceanBase
	case sourceType == "goldendb":
		return flavorGoldenDB
	case strings.Contains(lowerComment, "percona"):
		return flavorPercona
	default:
		return flavorMySQL
	}
}

// parseFlavorVersion 解析各分支的产品版本号。
func parseFlavorVersion(flavor, version string) dbuser.Version {
	switch flavor {
	case flavorMariaDB:
		if strings.HasPrefix(version, "5.5.5-") {
			return dbuser.ParseDottedVersionAfter(version, "5.5.5-")
		}
		return dbuser.ParseDottedVersion(version)
	case flavorTiDB, flavorOceanBase:
		// 形如 8.0.11-TiDB-v7.5.0、5.7.25-OceanBase_CE-v4.2.1.2：取 -v 之后的产品版本。
		if strings.Contains(strings.ToLower(version), "-v") {
			return dbuser.ParseDottedVersionAfter(version, "-v")
		}
		return dbuser.ParseDottedVersion(version)
	default:
		return dbuser.ParseDottedVersion(version)
	}
}

// resolveFeatures 按分支与版本给出默认能力；运行时探测会在此基础上调整。
func resolveFeatures(flavor string, v dbuser.Version) map[string]bool {
	switch flavor {
	case flavorMariaDB:
		return map[string]bool{
			featAlterUser:         v.AtLeast(10, 2, 0),
			featAccountLock:       v.AtLeast(10, 4, 2),
			featPasswordExpire:    v.AtLeast(10, 4, 3),
			featExpireNow:         v.AtLeast(10, 4, 3),
			featLimitsInCreate:    v.AtLeast(10, 2, 0),
			featResourceLimits:    true,
			featRequireSSL:        true,
			featRoles:             v.AtLeast(10, 0, 5),
			featDefaultRoles:      v.AtLeast(10, 1, 1),
			featSingleDefaultRole: true,
			featMariaDBVia:        v.AtLeast(10, 4, 0),
			featRename:            true,
		}
	case flavorTiDB:
		return map[string]bool{
			featAlterUser:    true,
			featAccountLock:  true,
			featRequireSSL:   true,
			featRoles:        true,
			featRoleHost:     true,
			featDefaultRoles: true,
			featPluginChoice: true,
			featRename:       true,
			featRoleRename:   true,
		}
	case flavorOceanBase:
		return map[string]bool{
			featAlterUser:   true,
			featAccountLock: true,
			featRename:      true,
		}
	default:
		return map[string]bool{
			featAlterUser:         v.AtLeast(5, 7, 6),
			featAccountLock:       v.AtLeast(5, 7, 6),
			featPasswordExpire:    v.AtLeast(5, 7, 6),
			featExpireNow:         v.AtLeast(5, 6, 6),
			featLimitsInCreate:    v.AtLeast(5, 7, 6),
			featResourceLimits:    true,
			featRequireSSL:        true,
			featRoles:             v.AtLeast(8, 0, 0),
			featRoleHost:          true,
			featDefaultRoles:      v.AtLeast(8, 0, 0),
			featPasswordHistory:   v.AtLeast(8, 0, 3),
			featRequireCurrent:    v.AtLeast(8, 0, 13),
			featDualPassword:      v.AtLeast(8, 0, 14),
			featFailedLogin:       v.AtLeast(8, 0, 19),
			featComment:           v.AtLeast(8, 0, 21),
			featDynamicPrivileges: v.AtLeast(8, 0, 0),
			featPluginChoice:      v.AtLeast(5, 7, 6),
			featRename:            true,
			featRoleRename:        v.AtLeast(8, 0, 0),
		}
	}
}

// userNameMaxLength 返回用户名长度上限（字符）。
func userNameMaxLength(flavor string, v dbuser.Version) int {
	switch flavor {
	case flavorMariaDB:
		if v.AtLeast(10, 0, 0) {
			return 80
		}
		return 16
	case flavorTiDB, flavorOceanBase:
		return 32
	default:
		if v.AtLeast(5, 7, 8) {
			return 32
		}
		return 16
	}
}

// hostMaxLength 返回主机名长度上限。
func hostMaxLength(flavor string, v dbuser.Version) int {
	if flavor == flavorMySQL || flavor == flavorPercona || flavor == flavorGoldenDB {
		if v.AtLeast(8, 0, 17) {
			return 255
		}
	}
	return 60
}

// isPasswordPlugin 表示该认证插件使用口令（IDENTIFIED ... BY）。
func isPasswordPlugin(plugin string) bool {
	switch strings.ToLower(plugin) {
	case "mysql_native_password", "caching_sha2_password", "sha256_password", "ed25519", "parsec", "tidb_sm3_password":
		return true
	default:
		return false
	}
}

// mariaDBViaPlugins 是 MariaDB 需要 IDENTIFIED VIA ... USING PASSWORD() 的插件。
func mariaDBViaPlugin(plugin string) bool {
	switch strings.ToLower(plugin) {
	case "ed25519", "parsec":
		return true
	default:
		return false
	}
}
