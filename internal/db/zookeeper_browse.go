//go:build gonavi_full_drivers || gonavi_zookeeper_driver

package db

import (
	"context"
	"errors"
	"math"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/logger"

	"github.com/go-zookeeper/zk"
	"golang.org/x/sync/errgroup"
)

// ZooKeeper 浏览：库是 chroot 下的顶层节点，表是库本身与它的下一级节点（完整路径），表的行是表路径下
// 整棵子树（含自身）。子树用逐层并发的 getChildren 遍历（响应里带节点自身的 stat），数据只为当前页读取；
// WHERE 引用 data 列或按 data 排序时才读取全部候选节点的数据。

const (
	zookeeperColumnPath           = "path"
	zookeeperColumnData           = "data"
	zookeeperColumnNodeType       = "node_type"
	zookeeperColumnVersion        = "version"
	zookeeperColumnCtime          = "ctime"
	zookeeperColumnMtime          = "mtime"
	zookeeperColumnNumChildren    = "num_children"
	zookeeperColumnDataLength     = "data_length"
	zookeeperColumnEphemeralOwner = "ephemeral_owner"
	zookeeperColumnCversion       = "cversion"
	zookeeperColumnAversion       = "aversion"
	zookeeperColumnCzxid          = "czxid"
	zookeeperColumnMzxid          = "mzxid"
	zookeeperColumnPzxid          = "pzxid"

	// zookeeperDefaultSelectLimit 是 SELECT 没写 LIMIT 时的行数：读取全部（遍历仍受 zookeeperScanCap 限制）。
	zookeeperDefaultSelectLimit = math.MaxInt32
	// zookeeperScanCap 是一次遍历最多访问的节点数（每个节点一次请求），防止浏览大树时拉全量。
	zookeeperScanCap = 50000
	// zookeeperParallelism 是并发请求数（go-zookeeper 在同一连接上流水线发送）。
	zookeeperParallelism  = 32
	zookeeperSegmentLimit = 5000
	// zookeeperWalkCacheTTL 让网格的计数与分页查询共用一次遍历；本连接的写操作会立即使缓存失效。
	zookeeperWalkCacheTTL = 2 * time.Second
)

var zookeeperColumns = []string{
	zookeeperColumnPath, zookeeperColumnData, zookeeperColumnNodeType, zookeeperColumnVersion, zookeeperColumnCtime,
	zookeeperColumnMtime, zookeeperColumnNumChildren, zookeeperColumnDataLength, zookeeperColumnEphemeralOwner,
	zookeeperColumnCversion, zookeeperColumnAversion, zookeeperColumnCzxid, zookeeperColumnMzxid, zookeeperColumnPzxid,
}

// zookeeperNode 是一个节点：路径、stat 与（读取后的）数据。restricted 表示当前身份没有该节点的读权限
// （3.6 起 exists 也校验 READ），只能列出路径，stat 与数据都显示为空。
type zookeeperNode struct {
	path       string
	data       []byte
	stat       zk.Stat
	loaded     bool
	restricted bool
}

func (n zookeeperNode) columnValue(column string) (string, int64, bool) {
	column = strings.ToLower(column)
	if column == zookeeperColumnPath {
		return n.path, 0, false
	}
	if n.restricted {
		return "", 0, false
	}
	switch column {
	case zookeeperColumnData:
		return string(n.data), 0, false
	case zookeeperColumnNodeType:
		return zookeeperNodeType(n.stat.EphemeralOwner), 0, false
	case zookeeperColumnCtime:
		return formatZooKeeperTime(n.stat.Ctime), 0, false
	case zookeeperColumnMtime:
		return formatZooKeeperTime(n.stat.Mtime), 0, false
	case zookeeperColumnVersion:
		return "", int64(n.stat.Version), true
	case zookeeperColumnNumChildren:
		return "", int64(n.stat.NumChildren), true
	case zookeeperColumnDataLength:
		return "", int64(n.stat.DataLength), true
	case zookeeperColumnEphemeralOwner:
		return "", n.stat.EphemeralOwner, true
	case zookeeperColumnCversion:
		return "", int64(n.stat.Cversion), true
	case zookeeperColumnAversion:
		return "", int64(n.stat.Aversion), true
	case zookeeperColumnCzxid:
		return "", n.stat.Czxid, true
	case zookeeperColumnMzxid:
		return "", n.stat.Mzxid, true
	case zookeeperColumnPzxid:
		return "", n.stat.Pzxid, true
	}
	return "", 0, false
}

// zookeeperNodeType 按 ephemeralOwner 判断节点类型。服务端（3.5.3 起）对客户端隐藏容器与 TTL 节点的编码，
// 它们和持久节点一样报告 0；只有 3.5.3 之前的容器节点会暴露 Long.MIN_VALUE。
func zookeeperNodeType(owner int64) string {
	switch owner {
	case 0:
		return "persistent"
	case math.MinInt64:
		return "container"
	}
	return "ephemeral"
}

func formatZooKeeperTime(millis int64) string {
	return time.UnixMilli(millis).Format("2006-01-02 15:04:05.000")
}

func formatZooKeeperHex(value int64) string {
	return "0x" + strconv.FormatUint(uint64(value), 16)
}

func zookeeperRowMap(node zookeeperNode, columns []string) map[string]interface{} {
	result := make(map[string]interface{}, len(columns))
	if node.restricted {
		for _, column := range columns {
			result[column] = nil
		}
		result[zookeeperColumnPath] = node.path
		return result
	}
	var data interface{}
	if node.data != nil {
		data = normalizeQueryValueWithDBType(node.data, "")
	}
	stat := node.stat
	values := map[string]interface{}{
		zookeeperColumnPath:           node.path,
		zookeeperColumnData:           data,
		zookeeperColumnNodeType:       zookeeperNodeType(stat.EphemeralOwner),
		zookeeperColumnVersion:        int64(stat.Version),
		zookeeperColumnCtime:          formatZooKeeperTime(stat.Ctime),
		zookeeperColumnMtime:          formatZooKeeperTime(stat.Mtime),
		zookeeperColumnNumChildren:    int64(stat.NumChildren),
		zookeeperColumnDataLength:     int64(stat.DataLength),
		zookeeperColumnEphemeralOwner: formatZooKeeperHex(stat.EphemeralOwner),
		zookeeperColumnCversion:       int64(stat.Cversion),
		zookeeperColumnAversion:       int64(stat.Aversion),
		zookeeperColumnCzxid:          formatZooKeeperHex(stat.Czxid),
		zookeeperColumnMzxid:          formatZooKeeperHex(stat.Mzxid),
		zookeeperColumnPzxid:          formatZooKeeperHex(stat.Pzxid),
	}
	for _, column := range columns {
		result[column] = values[column]
	}
	return result
}

// joinZooKeeperPath 拼接父路径与子节点名。
func joinZooKeeperPath(parent, child string) string {
	if parent == "/" {
		return "/" + child
	}
	return parent + "/" + child
}

// zookeeperParent 返回父路径；根节点返回空串。
func zookeeperParent(path string) string {
	index := strings.LastIndex(path, "/")
	switch {
	case path == "/" || index < 0:
		return ""
	case index == 0:
		return "/"
	}
	return path[:index]
}

// zookeeperWithin 报告 path 是否是 root 本身或其子孙。
func zookeeperWithin(path, root string) bool {
	return path == root || root == "/" || strings.HasPrefix(path, root+"/")
}

// zookeeperTreeKey 让按字节比较等价于按路径段比较（/a、/a/b、/a-x 的树序）。
func zookeeperTreeKey(path string) string {
	return strings.ReplaceAll(path, "/", "\x00")
}

func sortZooKeeperNodes(nodes []zookeeperNode, desc bool) {
	sort.SliceStable(nodes, func(i, j int) bool {
		if desc {
			return zookeeperTreeKey(nodes[i].path) > zookeeperTreeKey(nodes[j].path)
		}
		return zookeeperTreeKey(nodes[i].path) < zookeeperTreeKey(nodes[j].path)
	})
}

// children 列出子节点名（排序）与节点自身的 stat。
func (z *ZooKeeperDB) children(path string) ([]string, *zk.Stat, error) {
	names, stat, err := z.conn.Children(path)
	if err != nil {
		return nil, nil, err
	}
	sort.Strings(names)
	return names, stat, nil
}

func (z *ZooKeeperDB) GetDatabases() ([]string, error) {
	if z.conn == nil {
		return nil, localizedDatabaseRuntimeError("db.backend.error.connection_not_open", nil)
	}
	return z.childPaths(z.scope)
}

// GetTables 返回库本身（库下整棵子树）与下一级节点，表名都是完整路径。
func (z *ZooKeeperDB) GetTables(dbName string) ([]string, error) {
	database := normalizeZooKeeperPath(dbName)
	if database == "" {
		return z.GetDatabases()
	}
	if z.conn == nil {
		return nil, localizedDatabaseRuntimeError("db.backend.error.connection_not_open", nil)
	}
	children, err := z.childPaths(database)
	if err != nil {
		return nil, err
	}
	return append([]string{database}, children...), nil
}

func (z *ZooKeeperDB) childPaths(parent string) ([]string, error) {
	names, _, err := z.children(parent)
	if err != nil {
		return nil, zookeeperError(err, parent)
	}
	if len(names) > zookeeperSegmentLimit {
		logger.Warnf("ZooKeeper 节点 %q 下的子节点超过 %d 个，只列出前 %d 个", parent, zookeeperSegmentLimit, zookeeperSegmentLimit)
		names = names[:zookeeperSegmentLimit]
	}
	paths := make([]string, 0, len(names))
	for _, name := range names {
		paths = append(paths, joinZooKeeperPath(parent, name))
	}
	return paths, nil
}

// walk 逐层遍历 root 子树，返回节点（不含数据，树序）与是否因达到上限而截断。根节点不存在时返回空。
// 没有读权限的节点仍然列出（能取到 stat 时来自 exists，否则标记为 restricted），但不再向下遍历。
func (z *ZooKeeperDB) walk(ctx context.Context, root string, limit int) ([]zookeeperNode, bool, error) {
	var nodes []zookeeperNode
	level := []string{root}
	for len(level) > 0 {
		type listing struct {
			names      []string
			stat       *zk.Stat
			restricted bool
		}
		results := make([]listing, len(level))
		group, groupCtx := errgroup.WithContext(ctx)
		group.SetLimit(zookeeperParallelism)
		for i, path := range level {
			group.Go(func() error {
				if err := groupCtx.Err(); err != nil {
					return err
				}
				names, stat, err := z.children(path)
				if errors.Is(err, zk.ErrNoAuth) {
					_, stat, err = z.conn.Exists(path)
				}
				switch {
				case errors.Is(err, zk.ErrNoNode):
					return nil
				case errors.Is(err, zk.ErrNoAuth):
					results[i] = listing{stat: &zk.Stat{}, restricted: true}
					return nil
				case err != nil:
					return zookeeperError(err, path)
				}
				results[i] = listing{names: names, stat: stat}
				return nil
			})
		}
		if err := group.Wait(); err != nil {
			return nil, false, err
		}
		var next []string
		for i, result := range results {
			if result.stat == nil {
				continue
			}
			nodes = append(nodes, zookeeperNode{path: level[i], stat: *result.stat, restricted: result.restricted})
			if len(nodes) >= limit {
				return nodes, true, nil
			}
			for _, name := range result.names {
				next = append(next, joinZooKeeperPath(level[i], name))
			}
		}
		level = next
	}
	sortZooKeeperNodes(nodes, false)
	return nodes, false, nil
}

// walkCached 遍历 root 子树，短时间内的重复遍历（网格的计数 + 分页）共用结果。
func (z *ZooKeeperDB) walkCached(ctx context.Context, root string) ([]zookeeperNode, error) {
	if nodes, ok := z.cache.get(root); ok {
		return nodes, nil
	}
	nodes, truncated, err := z.walk(ctx, root, zookeeperScanCap)
	if err != nil {
		return nil, err
	}
	if truncated {
		sortZooKeeperNodes(nodes, false)
		logger.Warnf("ZooKeeper 节点 %q 的子树超过 %d 个节点，只浏览前 %d 个", root, zookeeperScanCap, zookeeperScanCap)
	}
	z.cache.put(root, nodes)
	return nodes, nil
}

// loadData 并发读取节点数据并刷新 stat；读取时已被删除的节点从结果里去掉，没有读权限的节点数据留空。
func (z *ZooKeeperDB) loadData(ctx context.Context, nodes []zookeeperNode) ([]zookeeperNode, error) {
	gone := make([]bool, len(nodes))
	group, groupCtx := errgroup.WithContext(ctx)
	group.SetLimit(zookeeperParallelism)
	for i := range nodes {
		if nodes[i].loaded || nodes[i].restricted {
			continue
		}
		group.Go(func() error {
			if err := groupCtx.Err(); err != nil {
				return err
			}
			data, stat, err := z.conn.Get(nodes[i].path)
			switch {
			case errors.Is(err, zk.ErrNoNode):
				gone[i] = true
			case errors.Is(err, zk.ErrNoAuth):
				nodes[i].loaded = true
			case err != nil:
				return zookeeperError(err, nodes[i].path)
			default:
				nodes[i].data, nodes[i].stat, nodes[i].loaded = data, *stat, true
			}
			return nil
		})
	}
	if err := group.Wait(); err != nil {
		return nil, err
	}
	kept := nodes[:0]
	for i, node := range nodes {
		if !gone[i] {
			kept = append(kept, node)
		}
	}
	return kept, nil
}

// zookeeperPushdown 从 WHERE 的顶层 AND 里取 path 条件缩小遍历范围：等值 / IN 直接定位节点（exact 非 nil），
// 前缀 LIKE 从前缀所在的最深节点开始遍历。其余条件仍在客户端过滤。
func zookeeperPushdown(table string, where interface{}) ([]string, string) {
	conditions := []interface{}{where}
	if logical, ok := where.(registryWhereLogical); ok && logical.op == "And" {
		conditions = logical.operands
	}
	for _, operand := range conditions {
		condition, ok := operand.(registryWhereCondition)
		if !ok || !strings.EqualFold(condition.field, zookeeperColumnPath) {
			continue
		}
		switch condition.op {
		case "=", "IN":
			exact := []string{}
			for _, value := range condition.values {
				if path := normalizeZooKeeperPath(value.text); path == value.text && zookeeperWithin(path, table) {
					exact = append(exact, path)
				}
			}
			return exact, table
		case "LIKE":
			pattern := condition.values[0].text
			index := strings.IndexAny(pattern, "%_\\")
			if index < 0 {
				if zookeeperWithin(pattern, table) {
					return []string{pattern}, table
				}
				return []string{}, table
			}
			root := zookeeperParent(pattern[:index] + "x")
			switch {
			case root == "" || zookeeperWithin(table, root):
				return nil, table
			case zookeeperWithin(root, table):
				return nil, root
			}
			return []string{}, table
		}
	}
	return nil, table
}

// statNodes 读取指定节点（等值条件下推），不存在的跳过；没有读权限的节点（服务端只对存在的节点校验 ACL）
// 标记为 restricted。
func (z *ZooKeeperDB) statNodes(paths []string) ([]zookeeperNode, error) {
	nodes := make([]zookeeperNode, 0, len(paths))
	for _, path := range paths {
		exists, stat, err := z.conn.Exists(path)
		switch {
		case errors.Is(err, zk.ErrNoAuth):
			nodes = append(nodes, zookeeperNode{path: path, restricted: true})
		case err != nil:
			return nil, zookeeperError(err, path)
		case exists:
			nodes = append(nodes, zookeeperNode{path: path, stat: *stat})
		}
	}
	sortZooKeeperNodes(nodes, false)
	return nodes, nil
}

func (z *ZooKeeperDB) runSelect(ctx context.Context, query kvSelect) ([]map[string]interface{}, []string, error) {
	table := normalizeZooKeeperPath(query.table)
	if table == "" {
		table = z.scope
	}
	exact, root := zookeeperPushdown(table, query.where)
	var (
		nodes []zookeeperNode
		err   error
	)
	if exact != nil {
		nodes, err = z.statNodes(exact)
	} else {
		nodes, err = z.walkCached(ctx, root)
		nodes = append([]zookeeperNode(nil), nodes...)
	}
	if err != nil {
		return nil, nil, err
	}
	needsData := kvWhereReferences(query.where, zookeeperColumnData) || query.orderBy == zookeeperColumnData
	if needsData {
		if nodes, err = z.loadData(ctx, nodes); err != nil {
			return nil, nil, err
		}
	}
	if query.where != nil {
		matched := nodes[:0]
		for _, node := range nodes {
			if matchKVWhere(query.where, node.columnValue) {
				matched = append(matched, node)
			}
		}
		nodes = matched
	}
	if query.count {
		return []map[string]interface{}{{"total": int64(len(nodes))}}, []string{"total"}, nil
	}
	switch query.orderBy {
	case "", zookeeperColumnPath:
		sortZooKeeperNodes(nodes, query.desc)
	default:
		sortKVRows(nodes, func(node zookeeperNode) kvColumnValue { return node.columnValue }, query.orderBy, query.desc)
	}
	page := sliceKVPage(nodes, query.offset, query.limit)
	if !needsData {
		if page, err = z.loadData(ctx, append([]zookeeperNode(nil), page...)); err != nil {
			return nil, nil, err
		}
	}
	columns := zookeeperColumns
	if len(query.columns) > 0 {
		columns = query.columns
	}
	rows := make([]map[string]interface{}, 0, len(page))
	for _, node := range page {
		rows = append(rows, zookeeperRowMap(node, columns))
	}
	return rows, columns, nil
}

func (z *ZooKeeperDB) GetColumns(dbName, tableName string) ([]connection.ColumnDefinition, error) {
	types := map[string]string{
		zookeeperColumnPath: "znode path", zookeeperColumnData: "bytes", zookeeperColumnNodeType: "string",
		zookeeperColumnVersion: "int32", zookeeperColumnCtime: "datetime", zookeeperColumnMtime: "datetime",
		zookeeperColumnNumChildren: "int32", zookeeperColumnDataLength: "int32", zookeeperColumnEphemeralOwner: "session id (hex)",
		zookeeperColumnCversion: "int32", zookeeperColumnAversion: "int32", zookeeperColumnCzxid: "zxid (hex)",
		zookeeperColumnMzxid: "zxid (hex)", zookeeperColumnPzxid: "zxid (hex)",
	}
	columns := make([]connection.ColumnDefinition, 0, len(zookeeperColumns))
	for _, name := range zookeeperColumns {
		column := connection.ColumnDefinition{Name: name, Type: types[name], Nullable: "YES"}
		if name == zookeeperColumnPath {
			column.Key, column.Nullable = "PRI", "NO"
		}
		columns = append(columns, column)
	}
	return columns, nil
}

func (z *ZooKeeperDB) GetAllColumns(dbName string) ([]connection.ColumnDefinitionWithTable, error) {
	tables, err := z.GetTables(dbName)
	if err != nil {
		return nil, err
	}
	columns, _ := z.GetColumns(dbName, "")
	result := make([]connection.ColumnDefinitionWithTable, 0, len(tables)*len(columns))
	for _, table := range tables {
		for _, column := range columns {
			result = append(result, connection.ColumnDefinitionWithTable{TableName: table, Name: column.Name, Type: column.Type})
		}
	}
	return result, nil
}

func (z *ZooKeeperDB) GetIndexes(dbName, tableName string) ([]connection.IndexDefinition, error) {
	return []connection.IndexDefinition{}, nil
}

func (z *ZooKeeperDB) GetForeignKeys(dbName, tableName string) ([]connection.ForeignKeyDefinition, error) {
	return []connection.ForeignKeyDefinition{}, nil
}

func (z *ZooKeeperDB) GetTriggers(dbName, tableName string) ([]connection.TriggerDefinition, error) {
	return []connection.TriggerDefinition{}, nil
}

// zookeeperWalkCache 缓存最近一次遍历的结果。
type zookeeperWalkCache struct {
	mu      sync.Mutex
	root    string
	nodes   []zookeeperNode
	expires time.Time
}

func (c *zookeeperWalkCache) get(root string) ([]zookeeperNode, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.nodes == nil || c.root != root || time.Now().After(c.expires) {
		return nil, false
	}
	return c.nodes, true
}

func (c *zookeeperWalkCache) put(root string, nodes []zookeeperNode) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.root, c.nodes, c.expires = root, nodes, time.Now().Add(zookeeperWalkCacheTTL)
}

func (c *zookeeperWalkCache) clear() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.root, c.nodes = "", nil
}
