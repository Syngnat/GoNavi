//go:build gonavi_mongodb_driver_v1

package db

import (
	"context"
	"fmt"
	"net/url"
	"strconv"
	"strings"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/logger"

	"go.mongodb.org/mongo-driver/mongo"
	"go.mongodb.org/mongo-driver/mongo/options"
	"go.mongodb.org/mongo-driver/mongo/readpref"
)

func applyMongoURI(config connection.ConnectionConfig) connection.ConnectionConfig {
	uriText := strings.TrimSpace(config.URI)
	if uriText == "" {
		return config
	}
	lowerURI := strings.ToLower(uriText)
	if strings.HasPrefix(lowerURI, "mongodb+srv://") {
		config.MongoSRV = true
	}
	if !strings.HasPrefix(lowerURI, "mongodb://") && !strings.HasPrefix(lowerURI, "mongodb+srv://") {
		return config
	}

	parsed, err := url.Parse(uriText)
	if err != nil {
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
		defaultPort = defaultMongoPort
	}
	hostsFromURI := make([]string, 0, 4)
	hostText := strings.TrimSpace(parsed.Host)
	if hostText != "" {
		for _, entry := range strings.Split(hostText, ",") {
			normalized, ok := normalizeMongoSeed(entry, defaultPort, config.MongoSRV)
			if ok {
				hostsFromURI = append(hostsFromURI, normalized)
			}
		}
	}

	explicitHost := strings.TrimSpace(config.Host) != ""
	explicitHosts := len(config.Hosts) > 0

	// 显式填写的 host/hosts 优先级高于 URI，避免表单 host 被 URI 中的 localhost 覆盖。
	if !explicitHost && !explicitHosts && len(hostsFromURI) > 0 {
		config.Hosts = hostsFromURI
	}
	if !explicitHost && !explicitHosts && len(hostsFromURI) > 0 {
		host, port, ok := parseHostPortWithDefault(hostsFromURI[0], defaultPort)
		if ok {
			config.Host = host
			config.Port = port
		}
	}

	query := parsed.Query()
	if config.AuthSource == "" {
		config.AuthSource = strings.TrimSpace(query.Get("authSource"))
	}
	if config.ReadPreference == "" {
		config.ReadPreference = strings.TrimSpace(query.Get("readPreference"))
	}
	if config.ReplicaSet == "" {
		config.ReplicaSet = strings.TrimSpace(query.Get("replicaSet"))
	}
	if config.MongoAuthMechanism == "" {
		config.MongoAuthMechanism = strings.TrimSpace(query.Get("authMechanism"))
	}
	if config.Topology == "" {
		if len(config.Hosts) > 1 || strings.TrimSpace(config.ReplicaSet) != "" {
			config.Topology = "replica"
		} else {
			config.Topology = "single"
		}
	}

	return config
}

func (m *MongoDBV1) getURI(config connection.ConnectionConfig) string {
	if strings.TrimSpace(config.URI) != "" {
		return mergeConnectionParamsIntoRawURI(config.URI, config.ConnectionParams, "mongodb", "mongodb+srv")
	}

	seeds := collectMongoSeeds(config)
	if len(seeds) == 0 {
		if config.MongoSRV {
			seed := strings.TrimSpace(config.Host)
			if seed == "" {
				seed = "localhost"
			}
			seeds = append(seeds, seed)
		} else {
			seeds = append(seeds, normalizeMongoAddress(config.Host, config.Port))
		}
	}

	scheme := "mongodb"
	if config.MongoSRV {
		scheme = "mongodb+srv"
	}
	hostText := strings.Join(seeds, ",")
	uri := fmt.Sprintf("%s://%s", scheme, hostText)

	noAuth := strings.EqualFold(strings.TrimSpace(config.MongoAuthMechanism), "NONE")

	if config.User != "" && !noAuth {
		var userinfo *url.Userinfo
		if config.Password != "" {
			userinfo = url.UserPassword(config.User, config.Password)
		} else {
			userinfo = url.User(config.User)
		}
		uri = fmt.Sprintf("%s://%s@%s", scheme, userinfo.String(), hostText)
	}

	path := "/"
	if strings.TrimSpace(config.Database) != "" {
		path = "/" + url.PathEscape(strings.TrimSpace(config.Database))
	}
	uri += path

	params := url.Values{}
	timeout := getConnectTimeoutSeconds(config)
	params.Set("connectTimeoutMS", strconv.Itoa(timeout*1000))
	params.Set("serverSelectionTimeoutMS", strconv.Itoa(timeout*1000))

	// 仅在有用户名且非 NONE 认证时设置 authSource
	if config.User != "" && !noAuth {
		authSource := strings.TrimSpace(config.AuthSource)
		if authSource == "" {
			authSource = "admin"
		}
		params.Set("authSource", authSource)
	}

	if replicaSet := strings.TrimSpace(config.ReplicaSet); replicaSet != "" {
		params.Set("replicaSet", replicaSet)
	}
	if readPreference := strings.TrimSpace(config.ReadPreference); readPreference != "" {
		params.Set("readPreference", readPreference)
	}
	// NONE 表示无认证，不设置 authMechanism
	if authMechanism := strings.TrimSpace(config.MongoAuthMechanism); authMechanism != "" && !noAuth {
		params.Set("authMechanism", authMechanism)
	}
	mergeConnectionParamValues(params, connectionParamsFromText(config.ConnectionParams))

	// 单机模式且未指定副本集名称时，启用 directConnection 避免驱动自动跟随副本集成员发现
	if strings.TrimSpace(config.Topology) != "replica" && strings.TrimSpace(config.ReplicaSet) == "" && !config.MongoSRV {
		params.Set("directConnection", "true")
	}

	if encoded := params.Encode(); encoded != "" {
		uri += "?" + encoded
	}

	return uri
}

func buildMongoAuthAttempts(config connection.ConnectionConfig) []connection.ConnectionConfig {
	attempts := []connection.ConnectionConfig{config}
	replicaUser := strings.TrimSpace(config.MongoReplicaUser)
	if replicaUser == "" {
		return attempts
	}
	if replicaUser == strings.TrimSpace(config.User) && config.MongoReplicaPassword == config.Password {
		return attempts
	}

	replicaConfig := config
	replicaConfig.URI = ""
	replicaConfig.User = replicaUser
	replicaConfig.Password = config.MongoReplicaPassword
	attempts = append(attempts, replicaConfig)
	return attempts
}

func mongoURIForcesTLS(uriText string) bool {
	trimmed := strings.TrimSpace(uriText)
	if trimmed == "" {
		return false
	}
	parsed, err := url.Parse(trimmed)
	if err != nil {
		return false
	}
	query := parsed.Query()
	for _, key := range []string{"tls", "ssl"} {
		value := strings.ToLower(strings.TrimSpace(query.Get(key)))
		switch value {
		case "1", "true", "t", "yes", "y", "required":
			return true
		}
	}
	return false
}

func mongoAttemptSSLLabel(config connection.ConnectionConfig, fallbackToPlain bool) string {
	if fallbackToPlain {
		return "明文回退"
	}
	if mongoURIForcesTLS(config.URI) {
		return "SSL"
	}
	enabled, _ := resolveMongoTLSSettings(config)
	if enabled {
		return "SSL"
	}
	return "明文"
}

func (m *MongoDBV1) Connect(config connection.ConnectionConfig) (err error) {
	_ = m.Close()
	defer func() {
		if err != nil {
			_ = m.Close()
		}
	}()

	runConfig := applyMongoURI(config)
	connectConfig := runConfig
	sshRouteHint := ""
	if runConfig.UseSSH {
		sshRouteHint = fmt.Sprintf("SSH隧道 %s:%d", runConfig.SSH.Host, runConfig.SSH.Port)
		logger.Infof("MongoDB(v1) 使用 SSH 隧道连接：跳板=%s:%d", runConfig.SSH.Host, runConfig.SSH.Port)
		// MongoDB creates connections through its driver dialer asynchronously and
		// later combines failures into a plain string. Establish the cached SSH
		// client before constructing the driver dialer so a structured host-key
		// trust error remains unwrapable by the application layer.
		if _, sshErr := mongoGetOrCreateSSHClient(runConfig.SSH); sshErr != nil {
			return fmt.Errorf("创建 MongoDB SSH 隧道失败：%w", sshErr)
		}
	}

	m.pingTimeout = getConnectTimeout(connectConfig)
	m.database = connectConfig.Database
	if m.database == "" {
		m.database = "admin"
	}

	sslAttempts := []connection.ConnectionConfig{connectConfig}
	if shouldTrySSLPreferredFallback(connectConfig) {
		sslAttempts = append(sslAttempts, withSSLDisabled(connectConfig))
	}
	totalAttempts := 0
	for _, attemptConfig := range sslAttempts {
		totalAttempts += len(buildMongoAuthAttempts(attemptConfig))
	}
	attemptNo := 0

	var errorDetails []string
	for sslIndex, sslConfig := range sslAttempts {
		sslLabel := mongoAttemptSSLLabel(sslConfig, sslIndex > 0)

		attemptConfigs := buildMongoAuthAttempts(sslConfig)
		for index, attemptConfig := range attemptConfigs {
			attemptNo++
			authLabel := "主库凭据"
			if index > 0 {
				authLabel = "从库凭据"
			}
			targets := collectMongoSeeds(attemptConfig)
			if len(targets) == 0 {
				targets = append(targets, normalizeMongoAddress(attemptConfig.Host, attemptConfig.Port))
			}
			attemptStarted := time.Now()
			logger.Infof(
				"MongoDB(v1) 连接尝试：%d/%d 模式=%s 凭据=%s 目标=%s 代理=%t",
				attemptNo, totalAttempts, sslLabel, authLabel, strings.Join(targets, ","), attemptConfig.UseProxy,
			)

			if sslIndex > 0 {
				attemptConfig.URI = ""
			}
			uri := m.getURI(attemptConfig)
			clientOpts := options.Client().ApplyURI(uri)
			tlsConfig, tlsErr := resolveGenericTLSConfig(attemptConfig)
			if tlsErr != nil {
				detail := fmt.Sprintf("%s %sTLS 配置失败: %v", sslLabel, authLabel, tlsErr)
				errorDetails = append(errorDetails, detail)
				logger.Warnf("MongoDB TLS 配置失败：%d/%d 模式=%s 凭据=%s 错误=%v", attemptNo, totalAttempts, sslLabel, authLabel, tlsErr)
				continue
			}
			if tlsConfig != nil {
				clientOpts.SetTLSConfig(tlsConfig)
			}
			if dialer := mongoConnectionDialer(attemptConfig); dialer != nil {
				clientOpts.SetDialer(dialer)
			}
			connectCtx, connectCancel := context.WithTimeout(context.Background(), m.pingTimeout)
			client, err := mongo.Connect(connectCtx, clientOpts)
			connectCancel()
			if err != nil {
				logger.Warnf("MongoDB(v1) 连接尝试失败：%d/%d 模式=%s 凭据=%s 耗时=%s 错误=%v",
					attemptNo, totalAttempts, sslLabel, authLabel, time.Since(attemptStarted).Round(time.Millisecond), err)
				detail := fmt.Sprintf("%s %s连接失败: %v", sslLabel, authLabel, err)
				if sshRouteHint != "" {
					detail = fmt.Sprintf("%s（%s）", detail, sshRouteHint)
				}
				errorDetails = append(errorDetails, detail)
				continue
			}

			m.client = client
			if err := m.Ping(); err != nil {
				ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
				_ = client.Disconnect(ctx)
				cancel()
				m.client = nil
				logger.Warnf("MongoDB(v1) 连接尝试验证失败：%d/%d 模式=%s 凭据=%s 耗时=%s 错误=%v",
					attemptNo, totalAttempts, sslLabel, authLabel, time.Since(attemptStarted).Round(time.Millisecond), err)
				detail := fmt.Sprintf("%s %s验证失败: %v", sslLabel, authLabel, err)
				if sshRouteHint != "" {
					detail = fmt.Sprintf("%s（%s）", detail, sshRouteHint)
				}
				errorDetails = append(errorDetails, detail)
				continue
			}
			logger.Infof("MongoDB(v1) 连接尝试成功：%d/%d 模式=%s 凭据=%s 耗时=%s",
				attemptNo, totalAttempts, sslLabel, authLabel, time.Since(attemptStarted).Round(time.Millisecond))
			if sslIndex > 0 {
				logger.Warnf("MongoDB(v1) SSL 优先连接失败，已回退至明文连接")
			}
			return nil
		}
	}

	if len(errorDetails) > 0 {
		return fmt.Errorf("MongoDB 连接失败：%s", strings.Join(errorDetails, "；"))
	}

	return fmt.Errorf("MongoDB 连接失败：无可用连接方案")
}

func (m *MongoDBV1) Close() error {
	if m.client != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		return m.client.Disconnect(ctx)
	}
	return nil
}

func (m *MongoDBV1) Ping() error {
	return m.PingContext(context.Background())
}

func (m *MongoDBV1) PingContext(parent context.Context) error {
	if m.client == nil {
		return fmt.Errorf("连接未打开")
	}
	timeout := m.pingTimeout
	if timeout <= 0 {
		timeout = 5 * time.Second
	}
	if parent == nil {
		parent = context.Background()
	}
	ctx, cancel := context.WithTimeout(parent, timeout)
	defer cancel()
	return m.client.Ping(ctx, readpref.Primary())
}
