//go:build gonavi_full_drivers || gonavi_opengauss_driver

package db

import (
	"context"
	"net"
	"strconv"
	"strings"

	"GoNavi-Wails/internal/connection"
)

const defaultOpenGaussPort = 5432

// OpenGaussDB 使用 PostgreSQL wire protocol 兼容链路，通过独立 agent 类型暴露。
type OpenGaussDB struct {
	PostgresDB
}

func (o *OpenGaussDB) bindMetadataContext(ctx context.Context) {
	BindMetadataContext(&o.PostgresDB, ctx)
}

func (o *OpenGaussDB) clearMetadataContext() {
	ClearMetadataContext(&o.PostgresDB)
}

func applyOpenGaussURI(config connection.ConnectionConfig) connection.ConnectionConfig {
	uriText := strings.TrimSpace(config.URI)
	if uriText == "" {
		return config
	}
	parsed, ok := parseConnectionURI(uriText, "opengauss", "postgres", "postgresql")
	if !ok {
		return config
	}

	if parsed.User != nil {
		if config.User == "" {
			config.User = parsed.User.Username()
		}
		if pass, ok := parsed.User.Password(); ok && config.Password == "" {
			config.Password = pass
		}
	}

	if dbName := strings.TrimPrefix(parsed.Path, "/"); dbName != "" && config.Database == "" {
		config.Database = dbName
	}

	defaultPort := config.Port
	if defaultPort <= 0 {
		defaultPort = defaultOpenGaussPort
	}
	if strings.TrimSpace(config.Host) == "" && strings.TrimSpace(parsed.Host) != "" {
		host, port, ok := parseHostPortWithDefault(parsed.Host, defaultPort)
		if ok {
			config.Host = host
			config.Port = port
		}
	}
	if config.Port <= 0 {
		config.Port = defaultOpenGaussPort
	}

	return config
}

func (o *OpenGaussDB) getDSN(config connection.ConnectionConfig) string {
	runConfig := applyOpenGaussURI(config)
	if runConfig.Port <= 0 {
		runConfig.Port = defaultOpenGaussPort
	}
	if strings.TrimSpace(runConfig.Host) != "" {
		if host, port, err := net.SplitHostPort(runConfig.Host); err == nil {
			runConfig.Host = host
			if p, convErr := strconv.Atoi(port); convErr == nil && p > 0 {
				runConfig.Port = p
			}
		}
	}
	return o.PostgresDB.getDSN(runConfig)
}

func (o *OpenGaussDB) Connect(config connection.ConnectionConfig) error {
	runConfig := applyOpenGaussURI(config)
	if runConfig.Port <= 0 {
		runConfig.Port = defaultOpenGaussPort
	}
	return o.PostgresDB.Connect(runConfig)
}
