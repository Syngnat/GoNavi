package app

import (
	"context"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/dbuser"
	"GoNavi-Wails/internal/redis"
)

// userMgmtRedisExecutor 把 redis.NodeCommandExecutor 适配为 dbuser.CommandExecutor。
type userMgmtRedisExecutor struct {
	client redis.NodeCommandExecutor
}

func (a *App) newUserMgmtRedisExecutor(config connection.ConnectionConfig) (dbuser.CommandExecutor, error) {
	client, err := a.getRedisClient(config)
	if err != nil {
		return nil, err
	}
	executor, ok := client.(redis.NodeCommandExecutor)
	if !ok {
		return nil, dbuser.NewError(dbuser.ErrCodeUnsupported, nil)
	}
	return userMgmtRedisExecutor{client: executor}, nil
}

func (e userMgmtRedisExecutor) Do(ctx context.Context, args []string) (any, error) {
	return e.client.ExecuteContext(ctx, args)
}

func (e userMgmtRedisExecutor) DoEachNode(ctx context.Context, args []string) ([]dbuser.NodeResult, error) {
	results, err := e.client.ExecuteOnEachNode(ctx, args)
	if err != nil && len(results) == 0 {
		return nil, err
	}
	out := make([]dbuser.NodeResult, 0, len(results))
	for _, item := range results {
		out = append(out, dbuser.NodeResult{Node: item.Addr, Role: item.Role, Result: item.Result, Err: item.Err})
	}
	return out, nil
}

func (e userMgmtRedisExecutor) Topology() string {
	return e.client.Topology()
}
