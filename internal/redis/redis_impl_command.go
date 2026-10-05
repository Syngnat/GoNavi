package redis

import (
	"context"
	"fmt"
	"math"
	"math/big"
	"reflect"
	"strconv"
	"strings"
	"time"
)

func parseRedisCommandGetKeysResult(result interface{}) []string {
	items, ok := result.([]interface{})
	if !ok || len(items) == 0 {
		return nil
	}
	keys := make([]string, 0, len(items))
	for _, item := range items {
		switch v := item.(type) {
		case string:
			if v != "" {
				keys = append(keys, v)
			}
		case []byte:
			text := string(v)
			if text != "" {
				keys = append(keys, text)
			}
		}
	}
	return keys
}

func (r *RedisClientImpl) rewriteCommandArgsForNamespace(ctx context.Context, args []string) []string {
	if !r.isCluster || r.currentDB <= 0 || len(args) == 0 {
		return args
	}

	command := strings.ToUpper(strings.TrimSpace(args[0]))
	if command == "COMMAND" || command == "SELECT" || command == "FLUSHDB" {
		return args
	}

	probeArgs := make([]interface{}, 0, len(args)+2)
	probeArgs = append(probeArgs, "COMMAND", "GETKEYS")
	for _, arg := range args {
		probeArgs = append(probeArgs, arg)
	}

	result, err := r.client.Do(ctx, probeArgs...).Result()
	if err != nil {
		return args
	}

	keyCandidates := parseRedisCommandGetKeysResult(result)
	if len(keyCandidates) == 0 {
		return args
	}

	rewritten := append([]string(nil), args...)
	used := make([]bool, len(rewritten))
	for _, key := range keyCandidates {
		for i := 1; i < len(rewritten); i++ {
			if used[i] {
				continue
			}
			if rewritten[i] != key {
				continue
			}
			rewritten[i] = r.toPhysicalKey(rewritten[i])
			used[i] = true
			break
		}
	}
	return rewritten
}

// ExecuteCommand executes a raw Redis command
func (r *RedisClientImpl) ExecuteCommand(args []string) (interface{}, error) {
	if r.client == nil {
		return nil, fmt.Errorf("Redis 客户端未连接")
	}
	if len(args) == 0 {
		return nil, fmt.Errorf("命令不能为空")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	if r.isCluster {
		command := strings.ToUpper(strings.TrimSpace(args[0]))
		switch command {
		case "SELECT":
			if len(args) < 2 {
				return nil, localizedRedisBackendError("redis.backend.error.select_db_index_required", nil)
			}
			rawIndex := strings.TrimSpace(args[1])
			index, err := strconv.Atoi(rawIndex)
			if err != nil {
				return nil, localizedRedisBackendError("redis.backend.error.select_db_index_invalid", map[string]any{"value": rawIndex})
			}
			if index < 0 || index >= redisClusterLogicalDBCount {
				return nil, localizedRedisBackendError("redis.backend.error.select_db_index_out_of_range", map[string]any{
					"min": 0,
					"max": redisClusterLogicalDBCount - 1,
				})
			}
			r.currentDB = index
			r.config.RedisDB = index
			return "OK", nil
		case "FLUSHDB":
			if err := r.FlushDB(); err != nil {
				return nil, err
			}
			return "OK", nil
		}
	}

	args = r.rewriteCommandArgsForNamespace(ctx, args)

	// Convert to []interface{}
	cmdArgs := make([]interface{}, len(args))
	for i, arg := range args {
		cmdArgs[i] = arg
	}

	result, err := r.client.Do(ctx, cmdArgs...).Result()
	if err != nil {
		return nil, err
	}

	return formatCommandResult(result), nil
}

// formatCommandResult formats the command result for display.
//
// RESP3 协议（go-redis v9 默认）下，HGETALL / CONFIG GET / XINFO 等命令返回 Map 类型，
// go-redis 用 map[interface{}]interface{} 承载。encoding/json 不支持非 string-key 的 map，
// 如果让原值穿透到 Wails RPC，json.Marshal 会失败，Wails runtime 在 Windows 上会直接 panic
// 让进程退出——用户感知为 GoNavi 闪退（issue: HGETALL 闪退）。
// 平展成 [k1, v1, k2, v2, ...] 交错形式与 RESP2 array 输出一致，前端按 array 渲染。
//
// 这里同时把 RESP3 的 NaN/Inf 浮点、大整数、error 以及其他 map/slice 形态统一收敛为
// JSON-safe 结构，避免 Redis 命令面板再把不可序列化的值透传给 Wails。
func formatCommandResult(result interface{}) interface{} {
	switch v := result.(type) {
	case []interface{}:
		formatted := make([]interface{}, len(v))
		for i, item := range v {
			formatted[i] = formatCommandResult(item)
		}
		return formatted
	case map[interface{}]interface{}:
		flattened := make([]interface{}, 0, len(v)*2)
		for key, val := range v {
			flattened = append(flattened, formatCommandResult(key))
			flattened = append(flattened, formatCommandResult(val))
		}
		return flattened
	case map[string]interface{}:
		formatted := make(map[string]interface{}, len(v))
		for key, val := range v {
			formatted[key] = formatCommandResult(val)
		}
		return formatted
	case []byte:
		return string(v)
	case error:
		return v.Error()
	case *big.Int:
		if v == nil {
			return nil
		}
		return v.String()
	case float64:
		if math.IsNaN(v) || math.IsInf(v, 0) {
			return fmt.Sprint(v)
		}
		return v
	case float32:
		f := float64(v)
		if math.IsNaN(f) || math.IsInf(f, 0) {
			return fmt.Sprint(v)
		}
		return v
	default:
		return formatCommandResultByReflection(v)
	}
}

func formatCommandResultByReflection(result interface{}) interface{} {
	value := reflect.ValueOf(result)
	if !value.IsValid() {
		return nil
	}
	switch value.Kind() {
	case reflect.Map:
		if value.Type().Key().Kind() == reflect.String {
			formatted := make(map[string]interface{}, value.Len())
			iter := value.MapRange()
			for iter.Next() {
				formatted[iter.Key().String()] = formatCommandResult(iter.Value().Interface())
			}
			return formatted
		}
		flattened := make([]interface{}, 0, value.Len()*2)
		iter := value.MapRange()
		for iter.Next() {
			flattened = append(flattened, formatCommandResult(iter.Key().Interface()))
			flattened = append(flattened, formatCommandResult(iter.Value().Interface()))
		}
		return flattened
	case reflect.Slice, reflect.Array:
		formatted := make([]interface{}, value.Len())
		for i := 0; i < value.Len(); i++ {
			formatted[i] = formatCommandResult(value.Index(i).Interface())
		}
		return formatted
	default:
		return result
	}
}
