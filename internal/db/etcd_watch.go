//go:build gonavi_full_drivers || gonavi_etcd_driver

package db

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"strconv"
	"time"

	clientv3 "go.etcd.io/etcd/client/v3"
)

// 控制台里的 watch 是有界的：收集事件直到 --timeout 秒（默认 5，最多 300）或 --limit 条（默认 100），然后整体返回。

const (
	etcdWatchDefaultTimeout = 5 * time.Second
	etcdWatchMaxTimeout     = 300 * time.Second
	etcdWatchDefaultLimit   = 100
)

var etcdWatchColumns = []string{"event", etcdColumnKey, etcdColumnValue, etcdColumnCreateRevision, etcdColumnModRevision, etcdColumnVersion, etcdColumnLease}

func etcdWatchBounds(command etcdCommand) (time.Duration, int, error) {
	timeout, limit := etcdWatchDefaultTimeout, etcdWatchDefaultLimit
	if text, ok := command.flag("timeout"); ok {
		seconds, err := strconv.ParseFloat(text, 64)
		if err != nil || seconds <= 0 || time.Duration(seconds*float64(time.Second)) > etcdWatchMaxTimeout {
			return 0, 0, etcdFlagError("timeout", text)
		}
		timeout = time.Duration(seconds * float64(time.Second))
	}
	if text, ok := command.flag("limit"); ok {
		value, err := strconv.Atoi(text)
		if err != nil || value <= 0 {
			return 0, 0, etcdFlagError("limit", text)
		}
		limit = value
	}
	return timeout, limit, nil
}

func (e *EtcdDB) v3Watch(ctx context.Context, command etcdCommand) ([]map[string]interface{}, []string, error) {
	if len(command.args) == 0 {
		return nil, nil, etcdUsageError("watch <key> [<range_end>] [--prefix] [--rev=N] [--timeout=SECONDS] [--limit=N]")
	}
	timeout, limit, err := etcdWatchBounds(command)
	if err != nil {
		return nil, nil, err
	}
	options := v3RangeOptions(command)
	if rev, ok := command.flag("rev"); ok {
		value, err := strconv.ParseInt(rev, 10, 64)
		if err != nil || value < 0 {
			return nil, nil, etcdFlagError("rev", rev)
		}
		options = append(options, clientv3.WithRev(value))
	}
	watchCtx, cancel := context.WithTimeout(clientv3.WithRequireLeader(ctx), timeout)
	defer cancel()
	rows := make([]map[string]interface{}, 0)
	for resp := range e.v3.Watch(watchCtx, command.args[0], options...) {
		if err := resp.Err(); err != nil {
			if errors.Is(watchCtx.Err(), context.DeadlineExceeded) {
				break
			}
			return nil, nil, err
		}
		for _, event := range resp.Events {
			kv := event.Kv
			row := etcdRowMap(etcdKeyValue{key: string(kv.Key), value: kv.Value, createRevision: kv.CreateRevision, modRevision: kv.ModRevision, version: kv.Version, lease: kv.Lease}, etcdWatchColumns[1:])
			row["event"] = event.Type.String()
			rows = append(rows, row)
			if len(rows) >= limit {
				return rows, etcdWatchColumns, nil
			}
		}
	}
	return rows, etcdWatchColumns, nil
}

// v2Watch 用长轮询（wait=true&waitIndex=N）逐个收集事件。
func (e *EtcdDB) v2Watch(ctx context.Context, command etcdCommand) ([]map[string]interface{}, []string, error) {
	if len(command.args) == 0 {
		return nil, nil, etcdUsageError("watch <key> [--recursive] [--after-index=N] [--timeout=SECONDS] [--limit=N]")
	}
	timeout, limit, err := etcdWatchBounds(command)
	if err != nil {
		return nil, nil, err
	}
	watchCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	waitIndex := ""
	if after, ok := command.flag("after-index"); ok {
		value, err := strconv.ParseInt(after, 10, 64)
		if err != nil || value < 0 {
			return nil, nil, etcdFlagError("after-index", after)
		}
		waitIndex = strconv.FormatInt(value+1, 10)
	}
	rows := make([]map[string]interface{}, 0)
	for len(rows) < limit {
		query := url.Values{"wait": {"true"}}
		if command.boolFlag("recursive") || command.boolFlag("prefix") {
			query.Set("recursive", "true")
		}
		if waitIndex != "" {
			query.Set("waitIndex", waitIndex)
		}
		resp, err := e.v2.do(watchCtx, http.MethodGet, command.args[0], query, nil)
		if err != nil {
			if watchCtx.Err() != nil {
				break
			}
			return nil, nil, err
		}
		if resp.Node == nil {
			continue
		}
		rows = append(rows, map[string]interface{}{
			"event": resp.Action, etcdColumnKey: resp.Node.Key, etcdColumnValue: resp.Node.Value,
			etcdColumnCreateRevision: resp.Node.CreatedIndex, etcdColumnModRevision: resp.Node.ModifiedIndex,
			etcdColumnVersion: nil, etcdColumnLease: nil,
		})
		waitIndex = strconv.FormatInt(resp.Node.ModifiedIndex+1, 10)
	}
	return rows, etcdWatchColumns, nil
}
