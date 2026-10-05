//go:build gonavi_full_drivers || gonavi_etcd_driver

package db

import (
	"context"
	"errors"
	"strconv"
	"strings"

	"GoNavi-Wails/internal/logger"

	"go.etcd.io/etcd/api/v3/v3rpc/rpctypes"
	clientv3 "go.etcd.io/etcd/client/v3"
)

// etcd v3 浏览：库与表由“跳跃扫描”得到——每次只取一个键（keys-only、limit 1），
// 拿到它所在的段后直接跳过该段的全部子键，请求次数等于段数而不是键数。

const (
	etcdSegmentLimit = 1000
	etcdScanBatch    = 500
	etcdTTLLookups   = 50
)

// splitEtcdSegment 取剩余键的第一段；顶层带前导分隔符的键（/registry/…）把前导分隔符算进第一段。
func splitEtcdSegment(rest, delimiter string, topLevel bool) (string, bool) {
	lead := ""
	if topLevel && strings.HasPrefix(rest, delimiter) {
		lead, rest = delimiter, rest[len(delimiter):]
	}
	segment, _, found := strings.Cut(rest, delimiter)
	return lead + segment, found
}

// v3Segments 列出 prefix 下一层的段名（不含 prefix）。同名段的键在字节序上可能不连续
// （a、a-x、a/b），所以只在确认有子键时跳过整个 段+分隔符 范围，否则只跳过当前键。
func (e *EtcdDB) v3Segments(ctx context.Context, prefix string) ([]string, error) {
	var segments []string
	seen := map[string]struct{}{}
	cursor := prefix
	for len(segments) < etcdSegmentLimit {
		options := []clientv3.OpOption{clientv3.WithLimit(1), clientv3.WithKeysOnly(), clientv3.WithSerializable()}
		if prefix == "" {
			options = append(options, clientv3.WithFromKey())
		} else {
			options = append(options, clientv3.WithRange(etcdPrefixEnd(prefix)))
		}
		resp, err := e.v3.Get(ctx, cursor, options...)
		if err != nil {
			return segments, err
		}
		if len(resp.Kvs) == 0 {
			return segments, nil
		}
		key := string(resp.Kvs[0].Key)
		segment, hasChildren := splitEtcdSegment(key[len(prefix):], e.delimiter, prefix == "")
		if _, ok := seen[segment]; !ok {
			seen[segment] = struct{}{}
			segments = append(segments, segment)
		}
		if hasChildren {
			cursor = etcdPrefixEnd(prefix + segment + e.delimiter)
			if cursor == "\x00" {
				return segments, nil
			}
		} else {
			cursor = key + "\x00"
		}
	}
	logger.Warnf("etcd 前缀 %q 下的段超过 %d 个，只列出前 %d 个", prefix, etcdSegmentLimit, etcdSegmentLimit)
	return segments, nil
}

func (e *EtcdDB) GetDatabases() ([]string, error) {
	ctx, cancel := e.requestContext()
	defer cancel()
	prefix := e.databasePrefix()
	if e.v2 != nil {
		return e.v2.children(ctx, prefix)
	}
	segments, err := e.v3Segments(ctx, prefix)
	if err != nil {
		// 只授权了部分前缀的用户读不了整个键空间，提示用 prefix 连接参数限定浏览范围。
		if errors.Is(err, rpctypes.ErrPermissionDenied) {
			return nil, localizedDatabaseRuntimeError("db.backend.error.etcd_list_permission_denied", map[string]any{"prefix": prefix})
		}
		return nil, err
	}
	databases := make([]string, 0, len(segments))
	for _, segment := range segments {
		databases = append(databases, prefix+segment)
	}
	return databases, nil
}

// GetTables 返回库本身（库下全部键）与下一层的各个前缀，表名都是完整路径。
func (e *EtcdDB) GetTables(dbName string) ([]string, error) {
	ctx, cancel := e.requestContext()
	defer cancel()
	database := strings.TrimSpace(dbName)
	if database == "" {
		return e.GetDatabases()
	}
	if e.v2 != nil {
		children, err := e.v2.children(ctx, database+e.delimiter)
		return append([]string{database}, children...), err
	}
	childPrefix := database + e.delimiter
	segments, err := e.v3Segments(ctx, childPrefix)
	if err != nil {
		return nil, err
	}
	tables := make([]string, 0, len(segments)+1)
	tables = append(tables, database)
	for _, segment := range segments {
		tables = append(tables, childPrefix+segment)
	}
	return tables, nil
}

// v3Range 读取一个区间（单键或半开区间）里的键，按键排序；limit 为 0 表示不限。
func (e *EtcdDB) v3Range(ctx context.Context, r etcdKeyRange, limit int64, desc, keysOnly bool) ([]etcdKeyValue, bool, error) {
	var options []clientv3.OpOption
	if r.end != "" {
		if r.end == "\x00" {
			options = append(options, clientv3.WithFromKey())
		} else {
			options = append(options, clientv3.WithRange(r.end))
		}
		order := clientv3.SortAscend
		if desc {
			order = clientv3.SortDescend
		}
		options = append(options, clientv3.WithSort(clientv3.SortByKey, order))
	}
	if limit > 0 {
		options = append(options, clientv3.WithLimit(limit))
	}
	if keysOnly {
		options = append(options, clientv3.WithKeysOnly())
	}
	resp, err := e.v3.Get(ctx, r.start, options...)
	if err != nil {
		return nil, false, err
	}
	rows := make([]etcdKeyValue, 0, len(resp.Kvs))
	for _, kv := range resp.Kvs {
		rows = append(rows, etcdKeyValue{
			key: string(kv.Key), value: kv.Value, createRevision: kv.CreateRevision,
			modRevision: kv.ModRevision, version: kv.Version, lease: kv.Lease,
		})
	}
	return rows, resp.More, nil
}

func (e *EtcdDB) v3Count(ctx context.Context, r etcdKeyRange) (int64, error) {
	options := []clientv3.OpOption{clientv3.WithCountOnly()}
	if r.end == "\x00" {
		options = append(options, clientv3.WithFromKey())
	} else if r.end != "" {
		options = append(options, clientv3.WithRange(r.end))
	}
	resp, err := e.v3.Get(ctx, r.start, options...)
	if err != nil {
		return 0, err
	}
	return resp.Count, nil
}

// v3Scan 按键序遍历区间，逐批交给 visit；visit 返回 false 或扫描达到上限时停止。
func (e *EtcdDB) v3Scan(ctx context.Context, ranges []etcdKeyRange, desc bool, visit func(etcdKeyValue) bool) error {
	ordered := ranges
	if desc {
		ordered = make([]etcdKeyRange, len(ranges))
		for i, r := range ranges {
			ordered[len(ranges)-1-i] = r
		}
	}
	scanned := 0
	for _, r := range ordered {
		if r.end == "" {
			rows, _, err := e.v3Range(ctx, r, 0, false, false)
			if err != nil {
				return err
			}
			for _, row := range rows {
				if !visit(row) {
					return nil
				}
			}
			continue
		}
		current := r
		for {
			rows, more, err := e.v3Range(ctx, current, etcdScanBatch, desc, false)
			if err != nil {
				return err
			}
			for _, row := range rows {
				scanned++
				if !visit(row) || scanned >= etcdScanCap {
					return nil
				}
			}
			if !more || len(rows) == 0 {
				break
			}
			last := rows[len(rows)-1].key
			if desc {
				current = etcdKeyRange{start: current.start, end: last}
			} else {
				current = etcdKeyRange{start: last + "\x00", end: current.end}
			}
		}
	}
	return nil
}

// v3Select 执行浏览查询。键序且无客户端过滤时按区间直接分页；否则在扫描上限内过滤、排序后分页。
func (e *EtcdDB) v3Select(ctx context.Context, query etcdSelect) ([]etcdKeyValue, int64, error) {
	keyOrder := query.orderBy == "" || query.orderBy == etcdColumnKey
	if query.count && !query.residual {
		var total int64
		for _, r := range query.keyRanges {
			count, err := e.v3Count(ctx, r)
			if err != nil {
				return nil, 0, err
			}
			total += count
		}
		return nil, total, nil
	}
	if keyOrder && !query.residual && !query.count {
		rows, err := e.v3Page(ctx, query)
		return rows, int64(len(rows)), err
	}
	var matched []etcdKeyValue
	var total int64
	err := e.v3Scan(ctx, query.keyRanges, keyOrder && query.desc, func(row etcdKeyValue) bool {
		if !matchEtcdWhere(query.where, row) {
			return true
		}
		total++
		if !query.count {
			matched = append(matched, row)
		}
		// 键序时凑够一页即可停；其他排序要看完全部匹配行。
		return query.count || !keyOrder || len(matched) < query.offset+query.limit
	})
	if err != nil || query.count {
		return nil, total, err
	}
	if !keyOrder {
		sortEtcdRows(matched, query.orderBy, query.desc)
	}
	return sliceEtcdPage(matched, query.offset, query.limit), total, nil
}

func sliceEtcdPage(rows []etcdKeyValue, offset, limit int) []etcdKeyValue {
	if offset >= len(rows) {
		return []etcdKeyValue{}
	}
	rows = rows[offset:]
	if limit > 0 && limit < len(rows) {
		rows = rows[:limit]
	}
	return rows
}

// v3Page 按键序分页：先用计数跳过整段区间，再用 keys-only 查询定位起始键，最后只取一页的值。
func (e *EtcdDB) v3Page(ctx context.Context, query etcdSelect) ([]etcdKeyValue, error) {
	ranges := query.keyRanges
	if query.desc {
		ranges = make([]etcdKeyRange, len(query.keyRanges))
		for i, r := range query.keyRanges {
			ranges[len(query.keyRanges)-1-i] = r
		}
	}
	offset, need := int64(query.offset), int64(query.limit)
	rows := []etcdKeyValue{}
	for _, r := range ranges {
		if need <= 0 {
			break
		}
		if offset > 0 {
			count, err := e.v3Count(ctx, r)
			if err != nil {
				return nil, err
			}
			if offset >= count {
				offset -= count
				continue
			}
			if r.end != "" {
				keys, _, err := e.v3Range(ctx, r, offset+1, query.desc, true)
				if err != nil {
					return nil, err
				}
				start := keys[len(keys)-1].key
				if query.desc {
					r = etcdKeyRange{start: r.start, end: start + "\x00"}
				} else {
					r = etcdKeyRange{start: start, end: r.end}
				}
			}
			offset = 0
		}
		page, _, err := e.v3Range(ctx, r, need, query.desc, false)
		if err != nil {
			return nil, err
		}
		rows = append(rows, page...)
		need -= int64(len(page))
	}
	return rows, nil
}

// v3TTLs 查询本页出现的租约剩余秒数（最多 etcdTTLLookups 个租约）。
func (e *EtcdDB) v3TTLs(ctx context.Context, rows []etcdKeyValue) {
	ttls := map[int64]int64{}
	for i := range rows {
		lease := rows[i].lease
		if lease == 0 {
			continue
		}
		ttl, ok := ttls[lease]
		if !ok {
			if len(ttls) >= etcdTTLLookups {
				continue
			}
			ttl = -1
			if resp, err := e.v3.TimeToLive(ctx, clientv3.LeaseID(lease)); err == nil {
				ttl = resp.TTL
			}
			ttls[lease] = ttl
		}
		rows[i].ttl = ttl
	}
}

func formatEtcdLease(lease int64) interface{} {
	if lease == 0 {
		return nil
	}
	return strconv.FormatInt(lease, 16)
}

func parseEtcdLease(value interface{}) (int64, error) {
	text := strings.ToLower(strings.TrimSpace(kvText(value)))
	if text == "" || text == "0" {
		return 0, nil
	}
	parsed, err := strconv.ParseUint(strings.TrimPrefix(text, "0x"), 16, 64)
	if err != nil {
		return 0, etcdFlagError(etcdColumnLease, text)
	}
	return int64(parsed), nil
}
