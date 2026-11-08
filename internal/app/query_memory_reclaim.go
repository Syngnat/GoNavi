package app

import (
	"runtime"
	"runtime/debug"
	"sync/atomic"
	"time"

	"GoNavi-Wails/internal/connection"
)

const (
	// 交互式查询受 RowBudget 约束（5 万行 / 24MB），但一次大表查询仍会让 Go
	// 堆在高位停留：结果集释放后，Go 只按 scavenger 节奏把内存还给系统。
	// 超过阈值的查询结束后主动回收一次，避免「关掉大表后 RSS 一直不降」。
	queryMemoryTrimRowsThreshold  = 10000
	queryMemoryTrimBytesThreshold = 8 << 20
	queryMemoryTrimMinInterval    = 15 * time.Second
	// 结果集在返回后还要经过 Wails JSON 序列化才真正变成垃圾；稍等片刻再回收，
	// 回收才有效，同时避免和序列化抢 CPU。
	queryMemoryTrimSettleDelay = 500 * time.Millisecond
)

var (
	queryMemoryTrimRunning atomic.Bool
	queryMemoryTrimLastAt  atomic.Int64

	runQueryMemoryTrimAsync = func(fn func()) {
		go fn()
	}
	queryMemoryTrimFn = func() {
		runtime.GC()
		debug.FreeOSMemory()
	}
)

// maybeReleaseQueryMemory 在单个结果集较大时异步回收堆内存。它只在查询成功
// 返回后调用：此时结果已序列化给前端，Go 侧的副本即将变成垃圾。
func maybeReleaseQueryMemory(rows int, approxBytes int64) {
	if !shouldReleaseQueryMemory(rows, approxBytes) {
		return
	}
	if !queryMemoryTrimRunning.CompareAndSwap(false, true) {
		return
	}
	runQueryMemoryTrimAsync(func() {
		defer queryMemoryTrimRunning.Store(false)
		time.Sleep(queryMemoryTrimSettleDelay)
		if delay := nextQueryMemoryTrimDelay(); delay > 0 {
			time.Sleep(delay)
		}
		queryMemoryTrimFn()
		queryMemoryTrimLastAt.Store(time.Now().UnixNano())
	})
}

func shouldReleaseQueryMemory(rows int, approxBytes int64) bool {
	return rows >= queryMemoryTrimRowsThreshold || approxBytes >= queryMemoryTrimBytesThreshold
}

// estimateQueryRowsBytes 估算结果集载荷大小，用于决定是否需要主动回收。
// 只统计字符串/字节长度与每格固定开销，量级足以判断阈值，不做精算。
func estimateQueryRowsBytes(rows []map[string]interface{}) int64 {
	var total int64
	for _, row := range rows {
		total += 64
		for _, value := range row {
			switch typed := value.(type) {
			case string:
				total += int64(len(typed)) + 16
			case []byte:
				total += int64(len(typed)) + 16
			default:
				total += 16
			}
		}
	}
	return total
}

// queryResultRowStats 返回结果集载荷的行数与估算字节数。Data 可能是单结果集
// （[]map）或多语句结果（[]connection.ResultSetData）。
func queryResultRowStats(data interface{}) (int, int64) {
	switch typed := data.(type) {
	case []map[string]interface{}:
		return len(typed), estimateQueryRowsBytes(typed)
	case []connection.ResultSetData:
		rows := 0
		var total int64
		for _, set := range typed {
			rows += len(set.Rows)
			total += estimateQueryRowsBytes(set.Rows)
		}
		return rows, total
	}
	return 0, 0
}

func maybeReleaseQueryResultMemory(result connection.QueryResult) {
	if !result.Success {
		return
	}
	rows, bytes := queryResultRowStats(result.Data)
	maybeReleaseQueryMemory(rows, bytes)
}

func nextQueryMemoryTrimDelay() time.Duration {
	lastUnixNano := queryMemoryTrimLastAt.Load()
	if lastUnixNano <= 0 {
		return 0
	}
	elapsed := time.Since(time.Unix(0, lastUnixNano))
	if elapsed >= queryMemoryTrimMinInterval {
		return 0
	}
	return queryMemoryTrimMinInterval - elapsed
}
