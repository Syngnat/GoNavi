//go:build gonavi_full_drivers || gonavi_oceanbase_driver

// Package db 中的 OceanBase 实现说明（请在调整 Oracle 路径前阅读，避免方向摇摆）：
//
// OceanBase 有两类入口：
//  1. OBServer 直连 / OBProxy MySQL listener —— MySQL wire 协议（OBClient 协议扩展）
//  2. OBProxy Oracle listener —— 标准 Oracle TNS 网络协议
//
// Navicat 的"OceanBase"数据源经实测能在 OB MySQL wire 端口上直接连接 Oracle 租户，
// 但本机企业版验证表明：仅通过 go-sql-driver/mysql 注入 CLIENT_CONNECT_ATTRS 不足以
// 让 Oracle 租户放行，还需要 CLIENT_SUPPORT_ORACLE_MODE 等 OceanBase 私有 capability。
// 因此 GoNavi 将 Oracle 租户的 MySQL-wire 路径隔离到 OB Oracle 专用 driver。
//
// GoNavi 当前路由（按 OceanBase 协议字段选择决定）：
//   - 协议=MySQL：走 go-sql-driver/mysql，连 MySQL 租户。OB 服务端在 Oracle 租户上返回
//     "Error 1235 (0A000): Oracle tenant for current client driver is not supported"
//     时，错误信息提示用户切换到 Oracle 协议。
//   - 协议=Oracle：先做 mysql wire 端口预探测（probeOceanBaseMySQLWireHandshake）。
//     识别为 OB MySQL wire 时，走 obconnector-go 的 OB Oracle 专用握手路径；
//     元数据查询通过 OracleDB wrapper 复用 Oracle 方言 SQL，ApplyChanges 用
//     applyOracleChangesMySQLWire（"?" 占位符 + 双引号引用）。
//     端口非 OB MySQL wire 时，走 sijms/go-ora 连接 OBProxy 的 Oracle listener。
//
// 历史教训：d2dad751 / 17331ddb / 5/14 两次反转都没在真实 OB Oracle 租户集群上联调，
// 多次方向摇摆。本次反转有 Navicat 真实工作证据（用户报告：Navicat 用 OceanBase 数据源
// 类型连同一端口 60014 成功）以及本机企业版 Oracle 租户验证。go-sql-driver/mysql 即使
// 注入 connectionAttributes 也无法发出 OceanBase Oracle 租户需要的私有 capability，
// 因此 Oracle/MySQL-wire 路径必须和普通 OceanBase MySQL 路径隔离。
package db

import (
	"database/sql"
	"time"

	mysqlDriver "github.com/go-sql-driver/mysql"
	_ "github.com/helingjun/obconnector-go"
)

const (
	oceanbaseDriverName             = "gonavi_oceanbase_mysql"
	oceanbaseOracleOBClientDriver   = "oboracle"
	defaultOceanBasePort            = 2881
	oceanBaseProtocolMySQL          = "mysql"
	oceanBaseProtocolOracle         = "oracle"
	oceanBaseOracleProbeReadTimeout = 3 * time.Second
)

// OceanBaseDB 支持 OceanBase MySQL/Oracle 两种租户协议。
type OceanBaseDB struct {
	MySQLDB
	oracle   *OracleDB
	protocol string
}

func init() {
	for _, name := range sql.Drivers() {
		if name == oceanbaseDriverName {
			return
		}
	}
	sql.Register(oceanbaseDriverName, &mysqlDriver.MySQLDriver{})
}
