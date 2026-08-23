//go:build gonavi_full_drivers || gonavi_starrocks_driver

package db

import (
	"context"
	"database/sql"
	"fmt"
	"strings"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/ssh"
	"GoNavi-Wails/internal/utils"

	mysqlDriver "github.com/go-sql-driver/mysql"
)

const (
	starRocksDriverName  = "starrocks"
	defaultStarRocksPort = 9030
)

// StarRocksDB 使用独立 driver 名称接入，底层协议兼容 MySQL。
type StarRocksDB struct {
	MySQLDB
}

func (s *StarRocksDB) bindMetadataContext(ctx context.Context) {
	BindMetadataContext(&s.MySQLDB, ctx)
}

func (s *StarRocksDB) clearMetadataContext() {
	ClearMetadataContext(&s.MySQLDB)
}

func init() {
	for _, name := range sql.Drivers() {
		if name == starRocksDriverName {
			return
		}
	}
	sql.Register(starRocksDriverName, &mysqlDriver.MySQLDriver{})
}

func applyStarRocksURI(config connection.ConnectionConfig) connection.ConnectionConfig {
	uriText := strings.TrimSpace(config.URI)
	if uriText == "" {
		return config
	}

	parsed, ok := parseMySQLCompatibleURI(uriText, "starrocks", "mysql")
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
		defaultPort = defaultStarRocksPort
	}

	hostsFromURI := make([]string, 0, 4)
	hostText := strings.TrimSpace(parsed.Host)
	if hostText != "" {
		for _, entry := range strings.Split(hostText, ",") {
			host, port, ok := parseHostPortWithDefault(entry, defaultPort)
			if !ok {
				continue
			}
			hostsFromURI = append(hostsFromURI, normalizeMySQLAddress(host, port))
		}
	}

	if len(config.Hosts) == 0 && len(hostsFromURI) > 0 {
		config.Hosts = hostsFromURI
	}
	if strings.TrimSpace(config.Host) == "" && len(hostsFromURI) > 0 {
		host, port, ok := parseHostPortWithDefault(hostsFromURI[0], defaultPort)
		if ok {
			config.Host = host
			config.Port = port
		}
	}

	if config.Topology == "" {
		topology := strings.TrimSpace(parsed.Query().Get("topology"))
		if topology != "" {
			config.Topology = strings.ToLower(topology)
		}
	}

	return config
}

func collectStarRocksAddresses(config connection.ConnectionConfig) []string {
	defaultPort := config.Port
	if defaultPort <= 0 {
		defaultPort = defaultStarRocksPort
	}

	candidates := make([]string, 0, len(config.Hosts)+1)
	if len(config.Hosts) > 0 {
		candidates = append(candidates, config.Hosts...)
	} else {
		candidates = append(candidates, normalizeMySQLAddress(config.Host, defaultPort))
	}

	result := make([]string, 0, len(candidates))
	seen := make(map[string]struct{}, len(candidates))
	for _, entry := range candidates {
		host, port, ok := parseHostPortWithDefault(entry, defaultPort)
		if !ok {
			continue
		}
		normalized := normalizeMySQLAddress(host, port)
		if _, exists := seen[normalized]; exists {
			continue
		}
		seen[normalized] = struct{}{}
		result = append(result, normalized)
	}

	return result
}

func starRocksMetadataLiteral(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "''") + "'"
}

func buildStarRocksColumnsQuery(dbName, tableName string) string {
	schemaPredicate := "TABLE_SCHEMA = DATABASE()"
	if strings.TrimSpace(dbName) != "" {
		schemaPredicate = fmt.Sprintf("TABLE_SCHEMA = %s", starRocksMetadataLiteral(strings.TrimSpace(dbName)))
	}

	return fmt.Sprintf(`SELECT
	COLUMN_NAME,
	COLUMN_TYPE,
	IS_NULLABLE,
	COLUMN_KEY,
	COLUMN_DEFAULT,
	EXTRA,
	COLUMN_COMMENT
FROM information_schema.columns
WHERE %s AND TABLE_NAME = %s
ORDER BY ORDINAL_POSITION`, schemaPredicate, starRocksMetadataLiteral(strings.TrimSpace(tableName)))
}

func getStarRocksRowValue(row map[string]interface{}, keys ...string) (interface{}, bool) {
	if len(row) == 0 {
		return nil, false
	}
	for _, key := range keys {
		for k, v := range row {
			if !strings.EqualFold(strings.TrimSpace(k), strings.TrimSpace(key)) {
				continue
			}
			return v, true
		}
	}
	return nil, false
}

func getStarRocksRowString(row map[string]interface{}, keys ...string) string {
	v, ok := getStarRocksRowValue(row, keys...)
	if !ok || v == nil {
		return ""
	}
	text := strings.TrimSpace(fmt.Sprintf("%v", v))
	if text == "" || strings.EqualFold(text, "<nil>") {
		return ""
	}
	return text
}

func buildStarRocksColumnDefinitions(data []map[string]interface{}) []connection.ColumnDefinition {
	columns := make([]connection.ColumnDefinition, 0, len(data))
	for _, row := range data {
		col := connection.ColumnDefinition{
			Name:     getStarRocksRowString(row, "Field", "COLUMN_NAME"),
			Type:     getStarRocksRowString(row, "Type", "COLUMN_TYPE"),
			Nullable: getStarRocksRowString(row, "Null", "IS_NULLABLE"),
			Key:      strings.ToUpper(getStarRocksRowString(row, "Key", "COLUMN_KEY")),
			Extra:    getStarRocksRowString(row, "Extra", "EXTRA"),
			Comment:  getStarRocksRowString(row, "Comment", "COLUMN_COMMENT"),
		}

		if rawDefault, ok := getStarRocksRowValue(row, "Default", "COLUMN_DEFAULT"); ok && rawDefault != nil {
			def := fmt.Sprintf("%v", rawDefault)
			if strings.EqualFold(def, "<nil>") {
				def = ""
			}
			col.Default = &def
		}

		columns = append(columns, col)
	}
	return columns
}

func (s *StarRocksDB) getDSN(config connection.ConnectionConfig) (string, error) {
	database := config.Database
	protocol := "tcp"
	address := normalizeMySQLAddress(config.Host, config.Port)

	if config.UseSSH {
		netName, err := s.registerSSHNetwork(config.SSH)
		if err != nil {
			return "", fmt.Errorf("创建 SSH 隧道失败：%w", err)
		}
		protocol = netName
	}

	return buildMySQLCompatibleDSN(config, protocol, address, database)
}

func resolveStarRocksCredential(config connection.ConnectionConfig, addressIndex int) (string, string) {
	primaryUser := strings.TrimSpace(config.User)
	primaryPassword := config.Password
	replicaUser := strings.TrimSpace(config.MySQLReplicaUser)
	replicaPassword := config.MySQLReplicaPassword

	if addressIndex > 0 && replicaUser != "" {
		return replicaUser, replicaPassword
	}

	if primaryUser == "" && replicaUser != "" {
		return replicaUser, replicaPassword
	}

	return config.User, primaryPassword
}

func (s *StarRocksDB) GetColumns(dbName, tableName string) ([]connection.ColumnDefinition, error) {
	data, _, err := s.Query(buildStarRocksColumnsQuery(dbName, tableName))
	if err != nil {
		return nil, err
	}
	return buildStarRocksColumnDefinitions(data), nil
}

func (s *StarRocksDB) Connect(config connection.ConnectionConfig) error {
	runConfig := applyStarRocksURI(config)
	addresses := collectStarRocksAddresses(runConfig)
	if len(addresses) == 0 {
		return fmt.Errorf("连接建立后验证失败：未找到可用的 StarRocks 地址")
	}

	var errorDetails []string
	for index, address := range addresses {
		candidateConfig := runConfig
		host, port, ok := parseHostPortWithDefault(address, defaultStarRocksPort)
		if !ok {
			continue
		}
		candidateConfig.Host = host
		candidateConfig.Port = port
		candidateConfig.User, candidateConfig.Password = resolveStarRocksCredential(runConfig, index)

		dsn, err := s.getDSN(candidateConfig)
		if err != nil {
			if _, requiresTrust := ssh.HostKeyTrustStatusFromError(err); requiresTrust {
				return fmt.Errorf("StarRocks %s 创建 SSH 隧道失败: %w", address, err)
			}
			errorDetails = append(errorDetails, fmt.Sprintf("%s 生成连接串失败: %v", address, err))
			continue
		}
		db, err := sql.Open(starRocksDriverName, dsn)
		if err != nil {
			errorDetails = append(errorDetails, fmt.Sprintf("%s 打开失败: %v", address, err))
			continue
		}
		configureSQLConnectionPool(db, "starrocks")

		timeout := getConnectTimeout(candidateConfig)
		ctx, cancel := utils.ContextWithTimeout(timeout)
		pingErr := db.PingContext(ctx)
		cancel()
		if pingErr != nil {
			_ = db.Close()
			errorDetails = append(errorDetails, fmt.Sprintf("%s 验证失败: %v", address, pingErr))
			continue
		}

		s.conn = db
		s.pingTimeout = timeout
		return nil
	}

	if len(errorDetails) == 0 {
		return fmt.Errorf("连接建立后验证失败：未找到可用的 StarRocks 地址")
	}
	return fmt.Errorf("连接建立后验证失败：%s", strings.Join(errorDetails, "；"))
}
