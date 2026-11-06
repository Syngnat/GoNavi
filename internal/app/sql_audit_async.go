package app

import (
	"context"
	"sync"
	"sync/atomic"
	"time"

	"GoNavi-Wails/internal/logger"
	"GoNavi-Wails/internal/sqlaudit"
)

const (
	// 队列按“批”计数：一次查询通常只产生 1 个事件，1024 批足以吸收
	// 数十个客户端同时查询的瞬时峰值；真正占内存的是批内事件数，由批量上限约束。
	sqlAuditAsyncQueueCapacity = 1024
	sqlAuditAsyncBatchLimit    = 512
	sqlAuditAsyncFlushInterval = 50 * time.Millisecond
)

// sqlAuditAsyncWriter 把 Web 运行时的审计写入合并成小批次。
//
// 原来每个查询都要在全局锁内完成一次 SQLite 事务 + FULL fsync，多客户端时
// 所有查询排队等磁盘。异步化只改变“何时落盘”，不改变写入顺序、失败语义或
// 哈希链：队列满时回退同步写，关闭时先刷盘再关库。
type sqlAuditAsyncWriter struct {
	mu                 sync.RWMutex
	queue              chan []sqlaudit.Event
	cancel             context.CancelFunc
	done               chan struct{}
	started            bool
	stopping           bool
	pending            atomic.Int64
	written            atomic.Int64
	lastWriteUnixMilli atomic.Int64
}

// SQLAuditAsyncStats 是审计异步队列对外暴露的运行指标。
type SQLAuditAsyncStats struct {
	Pending            int64
	Written            int64
	LastWriteUnixMilli int64
}

// SQLAuditAsyncStatsFor 读取 App 的审计队列指标；未启用异步时返回零值。
func SQLAuditAsyncStatsFor(a *App) SQLAuditAsyncStats {
	if a == nil {
		return SQLAuditAsyncStats{}
	}
	return SQLAuditAsyncStats{
		Pending:            a.sqlAuditAsync.pending.Load(),
		Written:            a.sqlAuditAsync.written.Load(),
		LastWriteUnixMilli: a.sqlAuditAsync.lastWriteUnixMilli.Load(),
	}
}

// enqueue 返回 false 时调用方必须同步写入，保证审计不丢。
func (w *sqlAuditAsyncWriter) enqueue(events []sqlaudit.Event, write func([]sqlaudit.Event)) bool {
	w.mu.Lock()
	if w.stopping {
		w.mu.Unlock()
		return false
	}
	if !w.started {
		w.started = true
		w.queue = make(chan []sqlaudit.Event, sqlAuditAsyncQueueCapacity)
		ctx, cancel := context.WithCancel(context.Background())
		w.cancel = cancel
		w.done = make(chan struct{})
		go w.run(ctx, write)
	}
	queue := w.queue
	w.mu.Unlock()

	batch := append([]sqlaudit.Event(nil), events...)
	w.mu.RLock()
	defer w.mu.RUnlock()
	if w.stopping {
		return false
	}
	// 先计入 pending 再入队，避免 worker 先写完后调用方才自增造成的竞态。
	w.pending.Add(int64(len(batch)))
	select {
	case queue <- batch:
		return true
	default:
		w.pending.Add(-int64(len(batch)))
		return false
	}
}

// flushNow 等待已入队事件落盘。审计读取接口在查询前调用它，保证
// “刚执行完的查询”能立刻出现在执行历史/导出里。
func (w *sqlAuditAsyncWriter) flushNow(timeout time.Duration) {
	if w == nil {
		return
	}
	deadline := time.Now().Add(timeout)
	for w.pending.Load() > 0 && time.Now().Before(deadline) {
		time.Sleep(2 * time.Millisecond)
	}
}

func (w *sqlAuditAsyncWriter) run(ctx context.Context, write func([]sqlaudit.Event)) {
	defer close(w.done)
	for {
		select {
		case <-ctx.Done():
			w.drain(write, nil)
			return
		case batch := <-w.queue:
			pending := append([]sqlaudit.Event(nil), batch...)
			timer := time.NewTimer(sqlAuditAsyncFlushInterval)
			collecting := true
			for collecting && len(pending) < sqlAuditAsyncBatchLimit {
				select {
				case more := <-w.queue:
					pending = append(pending, more...)
				case <-timer.C:
					collecting = false
				case <-ctx.Done():
					timer.Stop()
					w.drain(write, pending)
					return
				}
			}
			if !timer.Stop() {
				select {
				case <-timer.C:
				default:
				}
			}
			write(pending)
			w.pending.Add(-int64(len(pending)))
			w.recordWrite(len(pending))
		}
	}
}

// drain 在退出前把队列里剩余事件全部写完，超大时按批量上限切分。
func (w *sqlAuditAsyncWriter) drain(write func([]sqlaudit.Event), pending []sqlaudit.Event) {
	for {
		select {
		case more := <-w.queue:
			pending = append(pending, more...)
			if len(pending) >= sqlAuditAsyncBatchLimit {
				written := len(pending)
				write(pending)
				w.pending.Add(-int64(written))
				w.recordWrite(written)
				pending = nil
			}
		default:
			if len(pending) > 0 {
				write(pending)
				w.pending.Add(-int64(len(pending)))
				w.recordWrite(len(pending))
			}
			return
		}
	}
}

func (w *sqlAuditAsyncWriter) recordWrite(count int) {
	if w == nil || count <= 0 {
		return
	}
	w.written.Add(int64(count))
	w.lastWriteUnixMilli.Store(time.Now().UnixMilli())
}

func (a *App) flushSQLAuditWrites() {
	if a == nil {
		return
	}
	a.sqlAuditAsync.flushNow(2 * time.Second)
}

// stop 停止接收新事件并等待刷盘完成。超时只记录告警，不阻塞进程退出。
func (w *sqlAuditAsyncWriter) stop(timeout time.Duration) {
	w.mu.Lock()
	if w.stopping {
		w.mu.Unlock()
		return
	}
	w.stopping = true
	if !w.started {
		w.mu.Unlock()
		return
	}
	cancel := w.cancel
	done := w.done
	w.mu.Unlock()

	cancel()
	select {
	case <-done:
	case <-time.After(timeout):
		logger.Warnf("SQL 审计异步队列未能在 %s 内完成刷盘", timeout)
	}
}
