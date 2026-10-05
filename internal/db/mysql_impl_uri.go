package db

import (
	"fmt"
	"strings"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/ssh"
)

func collectMySQLDatabaseNames(queryFn func(string) ([]map[string]interface{}, []string, error)) ([]string, error) {
	if queryFn == nil {
		return nil, fmt.Errorf("查询函数为空")
	}

	names := make([]string, 0, 8)
	seen := make(map[string]struct{}, 8)
	var lastErr error

	normalizeName := func(val interface{}) string {
		if val == nil {
			return ""
		}
		name := strings.TrimSpace(fmt.Sprintf("%v", val))
		if name == "" || strings.EqualFold(name, "<nil>") || strings.EqualFold(name, "null") {
			return ""
		}
		return name
	}

	extractName := func(row map[string]interface{}, columns []string) string {
		for _, key := range mysqlDatabaseNameKeys {
			if name := normalizeName(row[key]); name != "" {
				return name
			}
		}
		for _, column := range columns {
			if name := normalizeName(row[column]); name != "" {
				return name
			}
		}
		if len(row) == 1 {
			for _, val := range row {
				if name := normalizeName(val); name != "" {
					return name
				}
			}
		}
		return ""
	}

	appendNames := func(rows []map[string]interface{}, columns []string) {
		for _, row := range rows {
			name := extractName(row, columns)
			if name == "" {
				continue
			}
			if _, exists := seen[name]; exists {
				continue
			}
			seen[name] = struct{}{}
			names = append(names, name)
		}
	}

	for _, sqlText := range mysqlDatabaseQueries {
		rows, columns, err := queryFn(sqlText)
		if err != nil {
			lastErr = err
			continue
		}
		appendNames(rows, columns)
		if len(names) > 0 {
			return names, nil
		}
	}

	if len(names) > 0 {
		return names, nil
	}
	if lastErr != nil {
		return nil, lastErr
	}
	return nil, fmt.Errorf("未获取到可用数据库")
}

func applyMySQLURI(config connection.ConnectionConfig) connection.ConnectionConfig {
	uriText := strings.TrimSpace(config.URI)
	if uriText == "" {
		return config
	}
	parsed, ok := parseMySQLCompatibleURI(uriText, mysqlCompatibleURISchemes...)
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

	defaultPort := resolveMySQLCompatibleDefaultPort(config)

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

func collectMySQLAddresses(config connection.ConnectionConfig) []string {
	defaultPort := resolveMySQLCompatibleDefaultPort(config)

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

func (m *MySQLDB) resolveProtocolAndAddress(config connection.ConnectionConfig) (string, string, error) {
	protocol := "tcp"
	address := normalizeMySQLAddress(config.Host, config.Port)

	if config.UseSSH {
		netName, err := m.registerSSHNetwork(config.SSH)
		if err != nil {
			return "", "", fmt.Errorf("创建 SSH 隧道失败：%w", err)
		}
		protocol = netName
	}

	return protocol, address, nil
}

func (m *MySQLDB) registerSSHNetwork(config connection.SSHConfig) (string, error) {
	if m != nil && m.sshNetworkRegistrar != nil {
		return m.sshNetworkRegistrar(config)
	}
	return ssh.RegisterSSHNetwork(config)
}

func (m *MySQLDB) getDSN(config connection.ConnectionConfig) (string, error) {
	protocol, address, err := m.resolveProtocolAndAddress(config)
	if err != nil {
		return "", err
	}
	return buildMySQLCompatibleDSN(config, protocol, address, config.Database)
}

func resolveMySQLCredential(config connection.ConnectionConfig, addressIndex int) (string, string) {
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
