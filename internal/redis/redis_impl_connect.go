package redis

import (
	"context"
	"crypto/tls"
	"fmt"
	"net"
	"strings"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/logger"
	"GoNavi-Wails/internal/ssh"

	"github.com/redis/go-redis/v9"
)

// Connect establishes a connection to Redis
func (r *RedisClientImpl) Connect(config connection.ConnectionConfig) (err error) {
	_ = r.Close()
	defer func() {
		if err != nil {
			_ = r.Close()
		}
	}()

	config.Password = sanitizeRedisPassword(config.Password)
	config.RedisSentinelPassword = sanitizeRedisPassword(config.RedisSentinelPassword)
	r.config = config
	if r.config.RedisDB < 0 {
		r.config.RedisDB = 0
	}
	seedAddrs, err := buildRedisSeedAddrs(config)
	if err != nil {
		return err
	}
	r.seedAddrs = append([]string(nil), seedAddrs...)

	topology := strings.ToLower(strings.TrimSpace(config.Topology))
	isSentinel := topology == "sentinel"
	r.isCluster = !isSentinel && (topology == "cluster" || len(seedAddrs) > 1)
	if r.isCluster && r.config.RedisDB >= redisClusterLogicalDBCount {
		r.config.RedisDB = 0
	}
	r.currentDB = r.config.RedisDB

	if (r.isCluster || isSentinel) && config.UseSSH {
		return localizedRedisBackendError("redis.backend.error.topology_ssh_tunnel_unsupported", map[string]any{
			"topology": redisTopologyDisplayName(topology),
		})
	}

	timeout := normalizeRedisTimeout(config.Timeout)
	if isSentinel {
		masterName := strings.TrimSpace(config.RedisSentinelMaster)
		if masterName == "" {
			return localizedRedisBackendError("redis.backend.error.sentinel_master_required", nil)
		}
		attempts := []connection.ConnectionConfig{config}
		if shouldTryRedisSSLPreferredFallback(config) {
			attempts = append(attempts, withRedisSSLDisabled(config))
		}

		var failures []string
		for idx, attempt := range attempts {
			var tlsConfig *tls.Config
			if cfg, err := resolveRedisTLSConfig(attempt); err != nil {
				failures = append(failures, redisConnectAttemptFailureMessage("redis.backend.error.connect_tls_setup_failed", idx+1, err))
				continue
			} else if cfg != nil {
				if host, _, err := net.SplitHostPort(seedAddrs[0]); err == nil && host != "" {
					cfg.ServerName = host
				}
				tlsConfig = cfg
			}
			opts := &redis.FailoverOptions{
				MasterName:       masterName,
				SentinelAddrs:    seedAddrs,
				Username:         strings.TrimSpace(attempt.User),
				Password:         attempt.Password,
				SentinelUsername: strings.TrimSpace(attempt.RedisSentinelUser),
				SentinelPassword: attempt.RedisSentinelPassword,
				DB:               r.currentDB,
				DialTimeout:      timeout,
				ReadTimeout:      timeout,
				WriteTimeout:     timeout,
				TLSConfig:        tlsConfig,
			}
			sentinelClient := redis.NewFailoverClient(opts)
			ctx, cancel := context.WithTimeout(context.Background(), timeout)
			pingErr := sentinelClient.Ping(ctx).Err()
			cancel()
			if pingErr != nil {
				sentinelClient.Close()
				failures = append(failures, redisConnectAttemptFailureMessage("redis.backend.error.connect_attempt_failed", idx+1, pingErr))
				continue
			}
			r.client = sentinelClient
			r.singleClient = sentinelClient
			r.config = attempt
			if idx > 0 {
				logger.Warnf("Redis Sentinel SSL 优先连接失败，已回退至明文连接")
			}
			logger.Infof("Redis Sentinel 连接成功: sentinels=%s master=%s DB=%d", strings.Join(seedAddrs, ","), masterName, r.currentDB)
			return nil
		}
		return localizedRedisBackendError("redis.backend.error.sentinel_connect_failed", map[string]any{
			"detail": joinRedisFailures(failures),
		})
	}

	if r.isCluster {
		attempts := []connection.ConnectionConfig{config}
		if shouldTryRedisSSLPreferredFallback(config) {
			attempts = append(attempts, withRedisSSLDisabled(config))
		}

		var failures []string
		for idx, attempt := range attempts {
			var tlsConfig *tls.Config
			if cfg, err := resolveRedisTLSConfig(attempt); err != nil {
				failures = append(failures, redisConnectAttemptFailureMessage("redis.backend.error.connect_tls_setup_failed", idx+1, err))
				continue
			} else if cfg != nil {
				if host, _, err := net.SplitHostPort(seedAddrs[0]); err == nil && host != "" {
					cfg.ServerName = host
				}
				tlsConfig = cfg
			}
			opts := &redis.ClusterOptions{
				Addrs:                 seedAddrs,
				Username:              strings.TrimSpace(attempt.User),
				Password:              attempt.Password,
				DialTimeout:           timeout,
				ReadTimeout:           timeout,
				WriteTimeout:          timeout,
				ContextTimeoutEnabled: true,
				TLSConfig:             tlsConfig,
			}
			clusterClient := redis.NewClusterClient(opts)
			ctx, cancel := context.WithTimeout(context.Background(), timeout)
			pingErr := clusterClient.Ping(ctx).Err()
			cancel()
			if pingErr != nil {
				clusterClient.Close()
				failures = append(failures, redisConnectAttemptFailureMessage("redis.backend.error.connect_attempt_failed", idx+1, pingErr))
				continue
			}
			r.client = clusterClient
			r.clusterClient = clusterClient
			r.config = attempt
			if idx > 0 {
				logger.Warnf("Redis 集群 SSL 优先连接失败，已回退至明文连接")
			}
			logger.Infof("Redis 集群连接成功: seeds=%s 逻辑库=db%d", strings.Join(seedAddrs, ","), r.currentDB)
			return nil
		}
		return localizedRedisBackendError("redis.backend.error.cluster_connect_failed", map[string]any{
			"detail": joinRedisFailures(failures),
		})
	}

	addr := seedAddrs[0]
	if config.UseSSH {
		forwarder, err := ssh.AcquireLocalForwarder(config.SSH, config.Host, config.Port)
		if err != nil {
			return localizedRedisBackendErrorWithCause("redis.backend.error.ssh_tunnel_create_failed", map[string]any{
				"detail": err.Error(),
			}, err)
		}
		r.forwarder = forwarder
		addr = forwarder.LocalAddr
		logger.Infof("Redis 通过 SSH 隧道连接: %s -> %s:%d", addr, config.Host, config.Port)
	}

	attempts := []connection.ConnectionConfig{config}
	if shouldTryRedisSSLPreferredFallback(config) {
		attempts = append(attempts, withRedisSSLDisabled(config))
	}

	var failures []string
	for idx, attempt := range attempts {
		var tlsConfig *tls.Config
		if cfg, err := resolveRedisTLSConfig(attempt); err != nil {
			failures = append(failures, redisConnectAttemptFailureMessage("redis.backend.error.connect_tls_setup_failed", idx+1, err))
			continue
		} else if cfg != nil {
			if host, _, err := net.SplitHostPort(addr); err == nil && host != "" {
				cfg.ServerName = host
			}
			tlsConfig = cfg
		}

		opts := &redis.Options{
			Addr:         addr,
			Username:     strings.TrimSpace(attempt.User),
			Password:     attempt.Password,
			DB:           r.currentDB,
			DialTimeout:  timeout,
			ReadTimeout:  timeout,
			WriteTimeout: timeout,
			TLSConfig:    tlsConfig,
		}

		singleClient := redis.NewClient(opts)
		ctx, cancel := context.WithTimeout(context.Background(), timeout)
		pingErr := singleClient.Ping(ctx).Err()
		cancel()
		if pingErr != nil {
			singleClient.Close()
			failures = append(failures, redisConnectAttemptFailureMessage("redis.backend.error.connect_attempt_failed", idx+1, pingErr))
			continue
		}

		r.client = singleClient
		r.singleClient = singleClient
		r.config = attempt
		if idx > 0 {
			logger.Warnf("Redis SSL 优先连接失败，已回退至明文连接")
		}
		logger.Infof("Redis 连接成功: %s DB=%d", addr, r.currentDB)
		return nil
	}

	return localizedRedisBackendError("redis.backend.error.connect_failed", map[string]any{
		"detail": joinRedisFailures(failures),
	})
}

// Close closes the Redis connection
func (r *RedisClientImpl) Close() error {
	var firstErr error
	if r.client != nil {
		firstErr = r.client.Close()
	}
	r.client = nil
	r.singleClient = nil
	r.clusterClient = nil
	r.isCluster = false
	r.seedAddrs = nil
	if r.forwarder != nil {
		if err := r.forwarder.Release(); err != nil && firstErr == nil {
			firstErr = err
		}
		r.forwarder = nil
	}
	return firstErr
}

// Ping tests the connection
func (r *RedisClientImpl) Ping() error {
	if r.client == nil {
		return fmt.Errorf("Redis 客户端未连接")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return r.client.Ping(ctx).Err()
}
