package redis

import (
	"context"
	"errors"
	"strings"
	"sync"

	goredis "github.com/redis/go-redis/v9"
)

// 拓扑名称。
const (
	TopologyStandalone = "standalone"
	TopologyCluster    = "cluster"
	TopologySentinel   = "sentinel"
)

// NodeCommandResult 是某个节点上的命令执行结果。
type NodeCommandResult struct {
	Addr   string
	Role   string
	Result any
	Err    error
}

// NodeCommandExecutor 是可选能力：按参数数组执行命令，并支持对集群所有节点逐一执行。
//
// ACL 等配置只在单个节点生效（不随复制传播），账号管理必须对主从每个节点下发；
// 普通 ExecuteCommand 会经过命名空间改写与集群路由，不适合此类管理命令。
type NodeCommandExecutor interface {
	ExecuteContext(ctx context.Context, args []string) (any, error)
	ExecuteOnEachNode(ctx context.Context, args []string) ([]NodeCommandResult, error)
	Topology() string
}

var _ NodeCommandExecutor = (*RedisClientImpl)(nil)

var errRedisNotConnected = errors.New("redis client not connected")

func toCommandArgs(args []string) []any {
	cmdArgs := make([]any, len(args))
	for index, arg := range args {
		cmdArgs[index] = arg
	}
	return cmdArgs
}

// Topology 返回当前连接的拓扑：standalone / cluster / sentinel。
func (r *RedisClientImpl) Topology() string {
	switch {
	case r.isCluster:
		return TopologyCluster
	case strings.EqualFold(strings.TrimSpace(r.config.Topology), TopologySentinel):
		return TopologySentinel
	default:
		return TopologyStandalone
	}
}

// ExecuteContext 在当前连接上执行命令（集群下由路由选择节点），不做命名空间改写。
func (r *RedisClientImpl) ExecuteContext(ctx context.Context, args []string) (any, error) {
	if r.client == nil {
		return nil, errRedisNotConnected
	}
	if len(args) == 0 {
		return nil, errors.New("redis command is empty")
	}
	result, err := r.client.Do(ctx, toCommandArgs(args)...).Result()
	if err != nil {
		return nil, err
	}
	return formatCommandResult(result), nil
}

// ExecuteOnEachNode 在集群的每个主从节点上执行命令；单机/哨兵只执行一次（哨兵为主节点）。
// 单个节点失败不会中断其他节点，结果中逐节点携带错误。
func (r *RedisClientImpl) ExecuteOnEachNode(ctx context.Context, args []string) ([]NodeCommandResult, error) {
	if r.client == nil {
		return nil, errRedisNotConnected
	}
	if len(args) == 0 {
		return nil, errors.New("redis command is empty")
	}
	if !r.isCluster || r.clusterClient == nil {
		result, err := r.client.Do(ctx, toCommandArgs(args)...).Result()
		node := NodeCommandResult{Addr: r.primaryAddr(), Role: "master", Err: err}
		if err == nil {
			node.Result = formatCommandResult(result)
		}
		return []NodeCommandResult{node}, nil
	}
	masters := map[string]bool{}
	var mu sync.Mutex
	_ = r.clusterClient.ForEachMaster(ctx, func(_ context.Context, node *goredis.Client) error {
		mu.Lock()
		masters[node.Options().Addr] = true
		mu.Unlock()
		return nil
	})
	results := make([]NodeCommandResult, 0, 8)
	err := r.clusterClient.ForEachShard(ctx, func(nodeCtx context.Context, node *goredis.Client) error {
		addr := node.Options().Addr
		value, nodeErr := node.Do(nodeCtx, toCommandArgs(args)...).Result()
		item := NodeCommandResult{Addr: addr, Role: "replica", Err: nodeErr}
		mu.Lock()
		defer mu.Unlock()
		if masters[addr] {
			item.Role = "master"
		}
		if nodeErr == nil {
			item.Result = formatCommandResult(value)
		}
		results = append(results, item)
		return nil
	})
	return results, err
}

func (r *RedisClientImpl) primaryAddr() string {
	if r.singleClient != nil {
		return r.singleClient.Options().Addr
	}
	if len(r.seedAddrs) > 0 {
		return r.seedAddrs[0]
	}
	return ""
}
