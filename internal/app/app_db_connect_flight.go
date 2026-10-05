package app

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
	"GoNavi-Wails/internal/logger"
)

func normalizeCacheKeyConfig(config connection.ConnectionConfig) connection.ConnectionConfig {
	normalized := config
	normalized.ID = ""
	normalized.Type = strings.ToLower(strings.TrimSpace(normalized.Type))
	if normalized.Type == "oceanbase" {
		protocol := resolveOceanBaseProtocolForApp(normalized)
		normalized.ConnectionParams = normalizeOceanBaseConnectionParamsForCacheWithProtocol(normalized.ConnectionParams, protocol)
		normalized.OceanBaseProtocol = ""
	}
	// Connection/query timeouts affect operations, not physical connection identity.
	normalized.Timeout = 0
	normalized.QueryTimeout = 0
	// keepalive 仅影响后台保活策略，不应参与物理连接复用键。
	normalized.KeepAliveEnabled = false
	normalized.KeepAliveIntervalMinutes = 0
	normalized.KeepAliveSQL = ""
	normalized.SavePassword = false

	if !normalized.UseSSH {
		normalized.SSH = connection.SSHConfig{}
	}
	if !normalized.UseProxy {
		normalized.Proxy = connection.ProxyConfig{}
	}
	if !normalized.UseHTTPTunnel {
		normalized.HTTPTunnel = connection.HTTPTunnelConfig{}
	}

	if isFileDatabaseType(normalized.Type) {
		dsn := strings.TrimSpace(normalized.Host)
		if dsn == "" {
			dsn = strings.TrimSpace(normalized.Database)
		}
		if dsn == "" {
			dsn = ":memory:"
		}

		// DuckDB/SQLite 仅基于文件来源识别连接，其他网络字段不参与键计算。
		normalized.Host = dsn
		normalized.Database = ""
		normalized.Port = 0
		normalized.User = ""
		normalized.Password = ""
		normalized.URI = ""
		normalized.ConnectionParams = ""
		normalized.Hosts = nil
		normalized.Topology = ""
		normalized.RedisSentinelMaster = ""
		normalized.RedisSentinelUser = ""
		normalized.RedisSentinelPassword = ""
		normalized.MySQLReplicaUser = ""
		normalized.MySQLReplicaPassword = ""
		normalized.ReplicaSet = ""
		normalized.AuthSource = ""
		normalized.ReadPreference = ""
		normalized.MongoSRV = false
		normalized.MongoAuthMechanism = ""
		normalized.MongoReplicaUser = ""
		normalized.MongoReplicaPassword = ""
		normalized.UseHTTPTunnel = false
		normalized.HTTPTunnel = connection.HTTPTunnelConfig{}
	}

	return normalized
}

func resolveFileDatabaseDSN(config connection.ConnectionConfig) string {
	dsn := strings.TrimSpace(config.Host)
	if dsn == "" {
		dsn = strings.TrimSpace(config.Database)
	}
	if dsn == "" {
		dsn = ":memory:"
	}
	return dsn
}

// Helper: Generate a unique key for the connection config
func getCacheKey(config connection.ConnectionConfig) string {
	normalized := normalizeCacheKeyConfig(config)
	var b []byte
	if currentSchema := db.QuoteOracleSchemaIdentifier(normalized.RuntimeOracleCurrentSchema()); normalized.Type == "oracle" && currentSchema != "" {
		b, _ = json.Marshal(struct {
			Connection          connection.ConnectionConfig `json:"connection"`
			OracleCurrentSchema string                      `json:"oracleCurrentSchema"`
		}{
			Connection:          normalized,
			OracleCurrentSchema: currentSchema,
		})
	} else {
		b, _ = json.Marshal(normalized)
	}
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

func normalizeConnectionReleaseMatchConfig(config connection.ConnectionConfig) connection.ConnectionConfig {
	normalized := normalizeCacheKeyConfig(config)
	normalized.Database = ""
	normalized.RedisDB = 0
	normalized.ConnectionParams = ""
	return normalized
}

func getConnectionReleaseMatchKey(config connection.ConnectionConfig) string {
	normalized := normalizeConnectionReleaseMatchConfig(config)
	b, _ := json.Marshal(normalized)
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

type cachedDatabaseCloseTarget struct {
	key  string
	inst db.Database
}

func (a *App) beginDatabaseConnectFlight(groupKey string, config connection.ConnectionConfig) (*databaseConnectFlight, error) {
	if a == nil {
		return nil, errDatabaseConnectionShutdown
	}

	a.mu.Lock()
	defer a.mu.Unlock()
	if a.dbShuttingDown {
		return nil, errDatabaseConnectionShutdown
	}
	if driverType := optionalDriverTypeForConnectionConfig(config); driverType != "" && a.driverMaintenance[driverType] > 0 {
		return nil, fmt.Errorf("%s", a.appText("driver_manager.backend.error.driver_maintenance_active", map[string]any{
			"name": a.driverStatusDisplayName(driverDefinition{Type: driverType}),
		}))
	}
	if a.dbConnectFlights == nil {
		a.dbConnectFlights = make(map[uint64]*databaseConnectFlight)
	}
	// Keep only active physical leaders. Release can invalidate these tokens
	// without retaining a generation/tombstone for every connection ever seen.
	a.nextDBConnectFlightID++
	flight := &databaseConnectFlight{
		id:              a.nextDBConnectFlightID,
		groupKey:        groupKey,
		cacheKey:        groupKey,
		releaseMatchKey: getConnectionReleaseMatchKey(config),
		driverType:      optionalDriverTypeForConnectionConfig(config),
	}
	a.dbConnectFlights[flight.id] = flight
	return flight, nil
}

func (a *App) finishDatabaseConnectFlight(flight *databaseConnectFlight) {
	if a == nil || flight == nil {
		return
	}
	a.mu.Lock()
	if current, exists := a.dbConnectFlights[flight.id]; exists && current == flight {
		delete(a.dbConnectFlights, flight.id)
	}
	a.mu.Unlock()
}

func (a *App) databaseConnectFlightErrorLocked(flight *databaseConnectFlight) error {
	if a.dbShuttingDown {
		return errDatabaseConnectionShutdown
	}
	if flight == nil {
		return errDatabaseConnectionReleased
	}
	current, exists := a.dbConnectFlights[flight.id]
	if !exists || current != flight {
		return errDatabaseConnectionReleased
	}
	return flight.cancelErr
}

func (a *App) databaseConnectFlightError(flight *databaseConnectFlight) error {
	if a == nil {
		return errDatabaseConnectionShutdown
	}
	a.mu.RLock()
	defer a.mu.RUnlock()
	return a.databaseConnectFlightErrorLocked(flight)
}

func (a *App) databaseConnectionReturnError(cacheKey string, inst db.Database) error {
	if a == nil {
		return errDatabaseConnectionShutdown
	}
	a.mu.RLock()
	defer a.mu.RUnlock()
	if a.dbShuttingDown {
		return errDatabaseConnectionShutdown
	}
	entry, exists := a.dbCache[cacheKey]
	if !exists || entry.inst == nil || entry.inst != inst {
		return errDatabaseConnectionReleased
	}
	return nil
}

func (a *App) markCachedDatabaseHealthy(inst db.Database, healthyAt time.Time) {
	if a == nil || inst == nil {
		return
	}
	if healthyAt.IsZero() {
		healthyAt = time.Now()
	}

	a.mu.Lock()
	defer a.mu.Unlock()
	for key, entry := range a.dbCache {
		if entry.inst != inst || !healthyAt.After(entry.lastPing) {
			continue
		}
		entry.lastPing = healthyAt
		a.dbCache[key] = entry
	}
}

func (a *App) cancelDatabaseConnectFlightsLocked(match func(*databaseConnectFlight) bool, cancelErr error, excludedFlightID uint64) []string {
	groupKeys := make([]string, 0)
	for _, flight := range a.dbConnectFlights {
		if flight == nil || flight.id == excludedFlightID || !match(flight) {
			continue
		}
		if flight.cancelErr == nil || errors.Is(cancelErr, errDatabaseConnectionShutdown) {
			flight.cancelErr = cancelErr
		}
		if a.connectFailures != nil {
			delete(a.connectFailures, flight.cacheKey)
		}
		groupKeys = append(groupKeys, flight.groupKey)
	}
	return groupKeys
}

func (a *App) forgetDatabaseConnectGroupsLocked(groupKeys []string) {
	if a == nil || len(groupKeys) == 0 {
		return
	}
	// Keep Forget in the same app-cache critical section as flight cancellation.
	// Otherwise an old leader can finish, a fresh group can be installed, and a
	// delayed Forget can accidentally remove that fresh group (ABA).
	if a.dbConnectBeforeForgetHook != nil {
		a.dbConnectBeforeForgetHook()
	}
	forgotten := make(map[string]struct{}, len(groupKeys))
	for _, groupKey := range groupKeys {
		if _, exists := forgotten[groupKey]; exists {
			continue
		}
		forgotten[groupKey] = struct{}{}
		// A request that starts after release must create a fresh physical flight
		// instead of joining the invalidated leader still unwinding in Connect.
		a.dbConnectGroup.Forget(groupKey)
	}
}

func (a *App) beginDatabaseShutdown() {
	if a == nil {
		return
	}
	a.mu.Lock()
	a.dbShuttingDown = true
	groupKeys := a.cancelDatabaseConnectFlightsLocked(func(*databaseConnectFlight) bool { return true }, errDatabaseConnectionShutdown, 0)
	a.forgetDatabaseConnectGroupsLocked(groupKeys)
	a.mu.Unlock()
}

func (a *App) closeCachedDatabasesForShutdown() {
	if a == nil {
		return
	}
	targets := make([]cachedDatabaseCloseTarget, 0)
	a.mu.Lock()
	for key, entry := range a.dbCache {
		targets = append(targets, cachedDatabaseCloseTarget{key: key, inst: entry.inst})
	}
	a.dbCache = make(map[string]cachedDatabase)
	a.connectFailures = make(map[string]cachedConnectFailure)
	a.mu.Unlock()

	for _, target := range targets {
		if target.inst == nil {
			continue
		}
		if err := target.inst.Close(); err != nil {
			logger.Error(err, "关闭数据库连接失败：缓存Key=%s", shortCacheKey(target.key))
		}
	}
}

func (a *App) releaseCachedDatabaseConnectionsForConfig(config connection.ConnectionConfig) int {
	if a == nil {
		return 0
	}
	return a.releaseCachedDatabaseConnectionsForConfigExcludingFlight(config, 0)
}

func (a *App) releaseCachedDatabaseConnectionsForConfigExcludingFlight(config connection.ConnectionConfig, excludedFlightID uint64) int {
	if a == nil {
		return 0
	}
	return a.releaseCachedDatabaseConnectionsByMatchKeyExcludingFlight(getConnectionReleaseMatchKey(config), excludedFlightID)
}

func (a *App) releaseCachedDatabaseConnectionsByMatchKey(targetKey string) int {
	return a.releaseCachedDatabaseConnectionsByMatchKeyExcludingFlight(targetKey, 0)
}

func (a *App) releaseCachedDatabaseConnectionsByMatchKeyExcludingFlight(targetKey string, excludedFlightID uint64) int {
	if a == nil || strings.TrimSpace(targetKey) == "" {
		return 0
	}

	targets := make([]cachedDatabaseCloseTarget, 0)
	a.mu.Lock()
	// Mark leaders under the same lock used by the final cache write. This is
	// the release/store linearization point that prevents late resurrection.
	groupKeys := a.cancelDatabaseConnectFlightsLocked(func(flight *databaseConnectFlight) bool {
		return flight.releaseMatchKey == targetKey
	}, errDatabaseConnectionReleased, excludedFlightID)
	for key, entry := range a.dbCache {
		entryConfig := entry.config
		if strings.TrimSpace(entryConfig.Type) == "" {
			continue
		}
		if getConnectionReleaseMatchKey(entryConfig) != targetKey {
			continue
		}
		targets = append(targets, cachedDatabaseCloseTarget{key: key, inst: entry.inst})
		groupKeys = append(groupKeys, key)
		delete(a.dbCache, key)
	}
	a.forgetDatabaseConnectGroupsLocked(groupKeys)
	a.mu.Unlock()

	for _, target := range targets {
		if target.inst == nil {
			continue
		}
		if closeErr := target.inst.Close(); closeErr != nil {
			logger.Error(closeErr, "关闭缓存连接失败：缓存Key=%s", shortCacheKey(target.key))
		}
	}

	return len(targets)
}

func isMySQLMaxUserConnectionsError(err error) bool {
	if err == nil {
		return false
	}
	message := strings.ToLower(normalizeErrorMessage(err))
	return strings.Contains(message, "max_user_connections") ||
		(strings.Contains(message, "error 1226") && strings.Contains(message, "has exceeded"))
}

func withMySQLMaxUserConnectionsHint(err error, released int) error {
	if err == nil {
		return nil
	}
	if !isMySQLMaxUserConnectionsError(err) {
		return err
	}
	if released > 0 {
		return fmt.Errorf("%w；数据库账号连接数已达上限(max_user_connections)，GoNavi 已释放同一连接实例的 %d 个缓存连接并重试；若仍失败，请关闭 Navicat/其他客户端连接或提高数据库用户 max_user_connections", err, released)
	}
	return fmt.Errorf("%w；数据库账号连接数已达上限(max_user_connections)，GoNavi 未找到可释放的同实例缓存连接；请关闭 Navicat/其他客户端连接或提高数据库用户 max_user_connections", err)
}

func shortCacheKey(cacheKey string) string {
	shortKey := cacheKey
	if len(shortKey) > 12 {
		shortKey = shortKey[:12]
	}
	return shortKey
}

func shouldRefreshCachedConnection(err error) bool {
	if err == nil {
		return false
	}
	normalized := strings.ToLower(normalizeErrorMessage(err))
	if normalized == "" {
		return false
	}

	patterns := []string{
		"invalid connection",
		"bad connection",
		"database is closed",
		"connection is already closed",
		"use of closed network connection",
		"broken pipe",
		"connection reset by peer",
		"server has gone away",
		"eof",
	}
	for _, pattern := range patterns {
		if strings.Contains(normalized, pattern) {
			return true
		}
	}
	return false
}
