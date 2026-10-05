//go:build gonavi_full_drivers || gonavi_etcd_driver

package db

import (
	"math"
	"sort"
	"strings"
)

// 数据浏览生成的 SELECT 子集：SELECT * | COUNT(*) | 列清单 FROM "<表路径>" [WHERE …] [ORDER BY 列 [ASC|DESC]] [LIMIT n] [OFFSET m]。
// 表是键前缀（完整路径），行是前缀下的键。WHERE 里 key 的等值、前缀 LIKE、范围条件下推为 etcd 范围查询，其余条件在客户端过滤。

const (
	etcdColumnKey            = "key"
	etcdColumnValue          = "value"
	etcdColumnCreateRevision = "create_revision"
	etcdColumnModRevision    = "mod_revision"
	etcdColumnVersion        = "version"
	etcdColumnLease          = "lease"
	etcdColumnTTL            = "ttl"
	etcdColumnDir            = "dir"
	// etcdDefaultSelectLimit 是 SELECT 没写 LIMIT 时的行数：读取全部（导出、备份与迁移按全表读取；控制台的 SELECT
	// 由编辑器自动补上 LIMIT）。
	etcdDefaultSelectLimit = math.MaxInt32
	// etcdDDLScriptLimit 是建表语句页重建脚本里最多写出的键数。
	etcdDDLScriptLimit = 500
	// etcdScanCap 是带客户端过滤或非键排序时最多扫描的键数，防止一次浏览拉全库。
	etcdScanCap = 200000
)

// etcdKeyValue 是一行键值：v3 的修订号、版本与租约，v2 的 TTL、是否目录与索引（映射到修订号列）。
type etcdKeyValue struct {
	key            string
	value          []byte
	createRevision int64
	modRevision    int64
	version        int64
	lease          int64
	ttl            int64
	dir            bool
}

// etcdSelect 是解析后的浏览查询：通用部分加上下推的键范围。
type etcdSelect struct {
	kvSelect
	keyRanges []etcdKeyRange
	// residual 为 true 表示 WHERE 里有无法下推的条件，需要在客户端逐行过滤。
	residual bool
}

// etcdKeyRange 是半开区间 [start, end)；end 为空表示单个键（start 本身）。
type etcdKeyRange struct {
	start string
	end   string
}

// parseEtcdSelect 解析浏览查询；表路径决定基础范围：路径本身 + 路径/ 开头的键。
func parseEtcdSelect(text, delimiter string) (etcdSelect, bool, error) {
	selection, ok, err := parseKVSelect(text, etcdDefaultSelectLimit)
	if !ok || err != nil {
		return etcdSelect{}, ok, err
	}
	query := etcdSelect{kvSelect: selection}
	base := etcdTableRanges(query.table, delimiter)
	query.keyRanges = base
	if query.where != nil {
		ranges, residual := etcdPushdownKeyRanges(query.where)
		query.residual = residual
		if ranges != nil {
			query.keyRanges = intersectEtcdRanges(base, ranges)
		}
	}
	return query, true, nil
}

// etcdTableRanges 是表路径对应的键：路径本身与 路径+分隔符 开头的键。
func etcdTableRanges(path, delimiter string) []etcdKeyRange {
	if path == "" {
		return []etcdKeyRange{{start: "", end: "\x00"}}
	}
	children := path + delimiter
	return []etcdKeyRange{{start: path}, {start: children, end: etcdPrefixEnd(children)}}
}

// etcdPushdownKeyRanges 从 WHERE 的顶层 AND 里取出 key 条件转成范围；返回 nil 表示没有可下推的条件。
// residual 报告是否还有条件需要客户端过滤（下推的条件同样保留在过滤里，结果仍然正确）。
func etcdPushdownKeyRanges(node interface{}) ([]etcdKeyRange, bool) {
	var conditions []interface{}
	if logical, ok := node.(registryWhereLogical); ok && logical.op == "And" {
		conditions = logical.operands
	} else {
		conditions = []interface{}{node}
	}
	var ranges []etcdKeyRange
	residual := false
	for _, operand := range conditions {
		condition, ok := operand.(registryWhereCondition)
		if !ok || !strings.EqualFold(condition.field, etcdColumnKey) {
			residual = true
			continue
		}
		next, exact := etcdConditionRanges(condition)
		if next == nil {
			residual = true
			continue
		}
		if !exact {
			residual = true
		}
		if ranges == nil {
			ranges = next
		} else {
			ranges = intersectEtcdRanges(ranges, next)
		}
	}
	return ranges, residual
}

// etcdConditionRanges 把单个 key 条件转成范围；exact 为 false 时范围只是上界近似，仍需过滤。
func etcdConditionRanges(condition registryWhereCondition) ([]etcdKeyRange, bool) {
	value := func(i int) string { return condition.values[i].text }
	switch condition.op {
	case "=":
		return []etcdKeyRange{{start: value(0)}}, true
	case "IN":
		ranges := make([]etcdKeyRange, 0, len(condition.values))
		for i := range condition.values {
			ranges = append(ranges, etcdKeyRange{start: value(i)})
		}
		return ranges, true
	case "LIKE":
		pattern := value(0)
		prefix := pattern
		if index := strings.IndexAny(pattern, "%_"); index >= 0 {
			prefix = pattern[:index]
		}
		if prefix == "" {
			return nil, false
		}
		if prefix == pattern {
			return []etcdKeyRange{{start: prefix}}, true
		}
		return []etcdKeyRange{{start: prefix, end: etcdPrefixEnd(prefix)}}, pattern == prefix+"%"
	case ">=":
		return []etcdKeyRange{{start: value(0), end: "\x00"}}, true
	case ">":
		return []etcdKeyRange{{start: value(0) + "\x00", end: "\x00"}}, true
	case "<":
		return []etcdKeyRange{{start: "", end: value(0)}}, true
	case "<=":
		return []etcdKeyRange{{start: "", end: value(0) + "\x00"}}, true
	case "BETWEEN":
		return []etcdKeyRange{{start: value(0), end: value(1) + "\x00"}}, true
	}
	return nil, false
}

// etcdRangeEnd 返回区间的结束键；单键区间返回 start + "\x00"。"\x00" 表示到键空间末尾。
func (r etcdKeyRange) rangeEnd() string {
	if r.end == "" {
		return r.start + "\x00"
	}
	return r.end
}

func etcdKeyLess(a, b string) bool {
	if b == "\x00" {
		return a != "\x00"
	}
	if a == "\x00" {
		return false
	}
	return a < b
}

// intersectEtcdRanges 求两组区间的交集，结果按起点排序。
func intersectEtcdRanges(left, right []etcdKeyRange) []etcdKeyRange {
	var result []etcdKeyRange
	for _, a := range left {
		for _, b := range right {
			start := a.start
			if b.start > start {
				start = b.start
			}
			end := a.rangeEnd()
			if etcdKeyLess(b.rangeEnd(), end) {
				end = b.rangeEnd()
			}
			if !etcdKeyLess(start, end) {
				continue
			}
			if end == start+"\x00" {
				result = append(result, etcdKeyRange{start: start})
			} else {
				result = append(result, etcdKeyRange{start: start, end: end})
			}
		}
	}
	sort.Slice(result, func(i, j int) bool { return result[i].start < result[j].start })
	return result
}

// columnValue 取一行在某列上的值，用于客户端过滤与排序。
func (kv etcdKeyValue) columnValue(column string) (string, int64, bool) {
	switch strings.ToLower(column) {
	case etcdColumnKey:
		return kv.key, 0, false
	case etcdColumnValue:
		return string(kv.value), 0, false
	case etcdColumnCreateRevision:
		return "", kv.createRevision, true
	case etcdColumnModRevision:
		return "", kv.modRevision, true
	case etcdColumnVersion:
		return "", kv.version, true
	case etcdColumnLease:
		return "", kv.lease, true
	case etcdColumnTTL:
		return "", kv.ttl, true
	}
	return "", 0, false
}

// matchEtcdWhere 在客户端求值 WHERE。
func matchEtcdWhere(node interface{}, kv etcdKeyValue) bool {
	return matchKVWhere(node, kv.columnValue)
}

// sortEtcdRows 按排序列在客户端排序（非键排序且需要过滤时使用）。
func sortEtcdRows(rows []etcdKeyValue, column string, desc bool) {
	sortKVRows(rows, func(kv etcdKeyValue) kvColumnValue { return kv.columnValue }, column, desc)
}
