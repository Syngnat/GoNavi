package db

import (
	"database/sql"
	"sync"
	"weak"
)

// PoolStatsSnapshot 汇总本进程内所有 SQL 连接池的运行状态。
type PoolStatsSnapshot struct {
	Pools          int   `json:"pools"`
	Open           int   `json:"open"`
	InUse          int   `json:"inUse"`
	Idle           int   `json:"idle"`
	MaxOpen        int   `json:"maxOpen"`
	WaitCount      int64 `json:"waitCount"`
	WaitDurationMs int64 `json:"waitDurationMs"`
}

type sqlPoolRegistryState struct {
	mu    sync.Mutex
	pools []weak.Pointer[sql.DB]
}

var sqlPoolRegistry sqlPoolRegistryState

// registerSQLPool 用弱引用登记连接池：元数据会话会频繁创建/关闭临时池，
// 强引用会让注册表随运行时间无限增长。GC 后失效的弱引用在下次登记时清理。
func registerSQLPool(pool *sql.DB) {
	if pool == nil {
		return
	}
	sqlPoolRegistry.mu.Lock()
	defer sqlPoolRegistry.mu.Unlock()
	live := sqlPoolRegistry.pools[:0]
	for _, item := range sqlPoolRegistry.pools {
		if item.Value() != nil {
			live = append(live, item)
		}
	}
	sqlPoolRegistry.pools = append(live, weak.Make(pool))
}

// SQLPoolStatsSnapshot 返回所有仍存活连接池的累计统计。
func SQLPoolStatsSnapshot() PoolStatsSnapshot {
	sqlPoolRegistry.mu.Lock()
	defer sqlPoolRegistry.mu.Unlock()
	var snapshot PoolStatsSnapshot
	live := sqlPoolRegistry.pools[:0]
	for _, item := range sqlPoolRegistry.pools {
		pool := item.Value()
		if pool == nil {
			continue
		}
		live = append(live, item)
		stats := pool.Stats()
		snapshot.Pools++
		snapshot.Open += stats.OpenConnections
		snapshot.InUse += stats.InUse
		snapshot.Idle += stats.Idle
		snapshot.MaxOpen += stats.MaxOpenConnections
		snapshot.WaitCount += stats.WaitCount
		snapshot.WaitDurationMs += stats.WaitDuration.Milliseconds()
	}
	sqlPoolRegistry.pools = live
	return snapshot
}
