package app

import (
	"strings"
	"time"

	"GoNavi-Wails/internal/uievents"
)

const (
	redisImportProgressRowInterval  = 50
	redisImportProgressTimeInterval = 200 * time.Millisecond
)

// newRedisImportProgressEmitter 把逐 Key 回调收敛成限流的 import:progress 事件。
// 大 Key 量逐条直发会产生上千次 IPC，并让携带全量 Key 预览的导入弹窗反复整树
// 重渲染；这里按「行数或时间」任一达标才发送，首条与末条强制发送，保证进度起止可见。
func newRedisImportProgressEmitter(a *App, jobID string, stage string) func(current, success, skipped, total int) {
	jobID = strings.TrimSpace(jobID)
	if a == nil || a.ctx == nil || jobID == "" {
		return nil
	}
	var lastEmittedAt time.Time
	lastCurrent := -1
	return func(current, success, skipped, total int) {
		now := time.Now()
		if current != 0 && current != total &&
			current-lastCurrent < redisImportProgressRowInterval &&
			now.Sub(lastEmittedAt) < redisImportProgressTimeInterval {
			return
		}
		lastEmittedAt = now
		lastCurrent = current
		uievents.Emit(a.ctx, "import:progress", importProgressState{
			JobID:          jobID,
			Current:        current,
			Total:          total,
			Success:        success,
			Skipped:        skipped,
			TotalRowsKnown: true,
			Stage:          stage,
		})
	}
}
