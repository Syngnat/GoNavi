//go:build gonavi_full_drivers || gonavi_cockroachdb_driver || gonavi_kwdb_driver || gonavi_questdb_driver || gonavi_timescaledb_driver

package db

import (
	"net/url"

	"GoNavi-Wails/internal/connection"
)

// withDefaultSearchPath 在用户没有通过连接参数或 URI 指定 search_path 时写入给定默认值。
// 显式写入后 PostgresDB 不再把库里全部 schema 拼成 search_path：描述表里复用 PostgresDB 的数据源
// （CockroachDB / KWDB 的内部 schema、TimescaleDB 的扩展 schema、不支持该探测语句的 QuestDB）都依赖这一点。
func withDefaultSearchPath(config connection.ConnectionConfig, searchPath string) connection.ConnectionConfig {
	params := connectionParamsFromText(config.ConnectionParams)
	if params.Get("search_path") != "" || connectionParamsFromURI(config.URI, "postgresql", "postgres").Get("search_path") != "" {
		return config
	}
	if params == nil {
		params = url.Values{}
	}
	params.Set("search_path", searchPath)
	config.ConnectionParams = params.Encode()
	return config
}
