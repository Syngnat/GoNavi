package app

import "sync"

// 驱动安装锁：从「全局单锁」改为「按驱动类型分片」。
//
// 此前的 driverInstallMu 是一把全局 sync.Mutex，安装/删除/下载/导出四类操作
// 全部串行 —— 用户在驱动页点第二个驱动安装时，请求会阻塞在锁上直到第一个跑完，
// 表现为按钮转圈。分片后不同类型可并行。
//
// 两层结构：
//
//	gate    排他闸门。安装/删除取读锁（彼此兼容），导出取写锁（与全部互斥）。
//	perType 每个驱动类型一把互斥锁，保证同类型串行。
//
// 为什么同类型必须串行：两次安装会争抢同一个 installPath / runtimePath，
// 而 promoteOptionalDriverAgentFromStaging 的快照-替换-回滚只在激活阶段互斥，
// 对 installPath 的写发生在安装最开始（resolve 目标路径时）。因此锁范围必须
// 覆盖「解析目标路径 → 下载/构建 → 写 staging → promote → 写 installed.json」
// 全程，即沿用原 driverInstallMu 的范围，不缩小。
//
// 为什么导出要取写锁：它打包的是**全部**已安装驱动，必须与任意类型的安装/删除
// 互斥（删除会在打包中途删掉二进制）。Go 的 RWMutex 在有写者等待后会阻塞新的
// 读者，因此导出不会被持续不断的安装饿死。
//
// 锁顺序恒为 gate → perType，不存在反向获取，因此无死锁。
type driverInstallLockManager struct {
	gate    sync.RWMutex
	mu      sync.Mutex
	perType map[string]*sync.Mutex
}

// lockDriver 为单个驱动类型加锁，返回释放函数。
//
// 用返回函数而非 Lock/Unlock 成对方法：调用点多为 `defer`，成对写法容易在
// 提前 return 的分支上漏掉释放。
func (m *driverInstallLockManager) lockDriver(driverType string) func() {
	m.gate.RLock()
	typeMu := m.typeMutex(driverType)
	typeMu.Lock()
	return func() {
		typeMu.Unlock()
		m.gate.RUnlock()
	}
}

// lockAll 为跨全部类型的操作（导出）取排他锁。
func (m *driverInstallLockManager) lockAll() func() {
	m.gate.Lock()
	return func() {
		m.gate.Unlock()
	}
}

// typeMutex 返回某驱动类型的互斥锁，首次使用时创建。
//
// 条目只增不删：驱动类型数量有界（内置 + 可选共约 30 个），保留条目比引入
// 引用计数更不容易出错。
func (m *driverInstallLockManager) typeMutex(driverType string) *sync.Mutex {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.perType == nil {
		m.perType = make(map[string]*sync.Mutex)
	}
	existing, ok := m.perType[driverType]
	if !ok {
		existing = &sync.Mutex{}
		m.perType[driverType] = existing
	}
	return existing
}
