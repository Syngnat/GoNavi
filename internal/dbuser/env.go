package dbuser

import "context"

// Executor 是 SQL / 文本命令执行的最小契约。database 为空表示连接默认库。
// Mongo 的 JSON 命令同样经由它执行（驱动在 agent 进程中也能转发）。
type Executor interface {
	Query(ctx context.Context, database string, statement string) ([]map[string]any, error)
	Exec(ctx context.Context, database string, statement string) error
}

// Session 是固定在一条物理连接上的执行会话，用于 BEGIN/COMMIT 文本事务。
type Session interface {
	Exec(ctx context.Context, statement string) error
	Close() error
}

// SessionOpener 打开会话；运行时不支持会话固定（如 HTTP 隧道）时 Env.Sessions 为 nil。
type SessionOpener interface {
	OpenSession(ctx context.Context, database string) (Session, error)
}

// NodeResult 是 Redis 某个节点的执行结果。
type NodeResult struct {
	Node   string
	Role   string
	Result any
	Err    error
}

// CommandExecutor 以参数数组执行 Redis 命令，不经过字符串拼接。
type CommandExecutor interface {
	Do(ctx context.Context, args []string) (any, error)
	DoEachNode(ctx context.Context, args []string) ([]NodeResult, error)
	Topology() string
}

// Env 聚合一次请求可用的执行能力；按数据源族只会填充其中一部分。
type Env struct {
	SQL      Executor
	Sessions SessionOpener
	Commands CommandExecutor
}
