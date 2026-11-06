package webserver

import (
	"path/filepath"

	"GoNavi-Wails/internal/appdata"
)

const webInstanceLockFileName = ".web-server.instance.lock"

// acquireWebInstanceLock 尝试持有数据目录的单实例标记。
//
// 仓库刻意允许桌面/无头进程并存（事务级文件锁），因此这里不阻止启动，
// 只让运维在误起多个 Web Server 副本时能从日志里看到明确告警：
// 会话、连接缓存与审计写入都假设单进程。
func acquireWebInstanceLock() (func(), error) {
	lock, err := appdata.TryAcquireFileLock(filepath.Join(appdata.MustResolveActiveRoot(), webInstanceLockFileName))
	if err != nil {
		return func() {}, err
	}
	return func() {
		_ = lock.Close()
	}, nil
}
