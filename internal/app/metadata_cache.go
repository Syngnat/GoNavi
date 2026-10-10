package app

import (
	"encoding/json"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/logger"

	"golang.org/x/sync/singleflight"
)

// metadataCacheTTL 是结构元数据（表清单 / 列定义）在服务端的缓存时长。
//
// TTL 与 DDL 钩子（invalidateMetadata，接在 methods_db_*_ddl.go 与 dbQueryWithCancel 上）
// 一起构成失效杠杆：DDL 成功后立即清空，其余情况靠 TTL 兜底。45s 是在「冷启动逐表
// 补全的 IPC 惊群」收益与「外部客户端改结构后最长陈旧窗口」之间取的平衡。
const metadataCacheTTL = 45 * time.Second

// 元数据种类。列级缓存必须同时带上 schema 与表名：Oracle / OceanBase Oracle 模式下
// normalizeMetadataRunConfig 刻意不把 owner 放进连接（同 owner 的元数据请求共用
// 一个连接池），只按表名区分会让 S1.T 与 S2.T 互相串味。
const (
	metadataCacheKindTables       = "tables"
	metadataCacheKindAllColumns   = "allcols"
	metadataCacheKindColumnPrefix = "cols:"
)

type metadataCacheEntry struct {
	value     interface{}
	fetchedAt time.Time
}

// metadataCacheStore 是结构元数据的存储体，含「一把锁 + 一张表 + 一个合并组」。
//
// 以指针在 App 实例之间共享：根 App 与它派生的元数据会话（newMetadataSessionWithMode）
// 指向同一个 store，于是跨请求能命中同一份缓存 —— 会话 App 此前拿到的是全新的空 App，
// 缓存永远为空，那正是「冷启动逐表补全 IPC 惊群」的主体。
//
// 共享的是整个 store 而不是裸 map：map 与锁必须同生共死。只把 map 指针赋给会话 App
// 会变成两个 App 各持一把自己的锁去写同一张 map，直接构成数据竞争。
//
// 之所以不做成包级全局：全局存储会让「同进程内任意两个 App」共享缓存，测试里每个用例
// 新建 App 时就会互相读到彼此的条目（实测出现「上一条用例的空结果被下一条用例读到」
// 的假失败）。以 App 为所有者、会话继承，既满足生产上的跨请求共享，又保持实例隔离。
//
// 锁序：只允许 a.mu -> store.mu。store.mu 是叶子锁，持它时不得再取 a.mu。
type metadataCacheStore struct {
	mu      sync.RWMutex
	entries map[string]metadataCacheEntry
	// sf 合并同 key 的并发拉取。合并组与缓存绑在同一个 store 上，但 flight key 会带上
	// 调用方的会话标识（见 metadataFlightScope），所以跨会话的请求不会互相合并。
	sf singleflight.Group
}

func newMetadataCacheStore() *metadataCacheStore {
	return &metadataCacheStore{entries: make(map[string]metadataCacheEntry)}
}

// metadataFlightScope 返回调用方的合并作用域。
//
// 合并的前提是「合并进来的请求与领头请求可互换」。会话请求各自带 ctx：会话 A 被取消时，
// 领头 fetch 会带着 A 的取消状态返回部分结果，并且把 A 的连接实例交给 follower。若两条
// 会话共用同一个 flight key，会话 B 会拿到 A 的部分结果与 A 的连接，随后 A 的 Close 会在
// B 仍在查询时把它关掉（实测为「查询尚未退出即关闭数据库」panic）。因此按会话切分作用域：
// 根 App 的请求之间仍合并（同一请求内的逐表补全照旧收敛），每条元数据会话独立合并。
func (a *App) metadataFlightScope() string {
	if a != nil && a.metadataSession != nil {
		return a.metadataSession.flightScope
	}
	return metadataRootFlightScope
}

// metadataRootFlightScope 是根 App（无元数据会话）的合并作用域，取值必须与任何会话的
// flightScope 都不同，且不含 \x00（flight key 用 \x00 拼装）。
const metadataRootFlightScope = "root"

// metadataSessionFlightScopeSeq 给每条元数据会话发一个互不相同的作用域标识。
// 单调递增的序号足够区分会话，不需要可读性。
var metadataSessionFlightScopeSeq atomic.Uint64

func nextMetadataSessionFlightScope() string {
	return "session:" + strconv.FormatUint(metadataSessionFlightScopeSeq.Add(1), 10)
}

// metadataColumnCacheKind 拼出列级缓存的种类段。用 \x00 而不是 "." 分隔 schema 与
// 表名：两者都可能含点号（SQL Server 的点号表名），点号分隔会撞键。
func metadataColumnCacheKind(schemaName, tableName string) string {
	return metadataCacheKindColumnPrefix + schemaName + "\x00" + tableName
}

// buildMetadataCacheKey 以「连接缓存键 + 库名 + 元数据种类」组成键。
// getCacheKey 已含库名（网络库）或文件来源（文件库），天然 per-connection-per-db 隔离。
//
// 有意不带元数据通道后缀：缓存键归属于连接配置，元数据通道与查询通道是同一个配置的
// 两条物理连接，共用一份结构缓存才不会出现「同一张表两条通道各存一份、失效漏清一条」。
func (a *App) buildMetadataCacheKey(config connection.ConnectionConfig, dbName, kind string) string {
	return getCacheKey(config) + "\x00" + dbName + "\x00" + kind
}

// buildScopedMetadataCacheKey 隔离不同模式范围，并保留按连接和库失效全部目录缓存的前缀。
func (a *App) buildScopedMetadataCacheKey(config connection.ConnectionConfig, dbName, kind string, scope *connection.MetadataDiscoveryScope) string {
	key := a.buildMetadataCacheKey(config, dbName, kind)
	if scope == nil || scope.Schemas == nil {
		return key
	}
	// 结构只含字符串、布尔和字符串切片，JSON 编码不存在不支持的值。
	encoded, _ := json.Marshal(scope.Schemas)
	return key + "\x00" + string(encoded)
}

// metadataStore 返回本 App 的缓存存储体，必要时惰性创建。
//
// 生产路径由 NewAppWithSecretStore 预先创建、会话 App 直接继承；惰性创建只为兜住测试里
// 手工构造的 &App{...} 字面量，避免「没走构造函数就没有缓存」这类隐性差异。
//
// 锁序：本函数只取 a.mu（写），返回后由调用方单独取 store.mu，两者不嵌套持有。
func (a *App) metadataStore() *metadataCacheStore {
	if a == nil {
		return nil
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.metadataCache == nil {
		a.metadataCache = newMetadataCacheStore()
	}
	return a.metadataCache
}

// peekMetadataStore 只读取存储体，不创建。用 a.mu 的读锁保护字段读写：字面量构造的
// App 可能被并发地惰性初始化，无锁读会与那次写构成数据竞争。
func (a *App) peekMetadataStore() *metadataCacheStore {
	if a == nil {
		return nil
	}
	a.mu.RLock()
	defer a.mu.RUnlock()
	return a.metadataCache
}

func (a *App) metadataCacheGet(key string) (interface{}, bool) {
	store := a.peekMetadataStore()
	if store == nil {
		return nil, false
	}
	store.mu.RLock()
	defer store.mu.RUnlock()
	entry, ok := store.entries[key]
	if !ok {
		return nil, false
	}
	if time.Since(entry.fetchedAt) > metadataCacheTTL {
		return nil, false
	}
	return entry.value, true
}

func (a *App) metadataCacheSet(key string, value interface{}) {
	store := a.metadataStore()
	if store == nil {
		return
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	store.entries[key] = metadataCacheEntry{value: value, fetchedAt: time.Now()}
}

func (a *App) metadataCacheDelete(key string) {
	store := a.peekMetadataStore()
	if store == nil {
		return
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	delete(store.entries, key)
}

// metadataCacheFetch 双检 + singleflight：命中直接返回缓存值；未命中时同 key 的并发
// 请求合并为一次后端查询，避免冷启动逐表补全时的 IPC 惊群。
//
// 契约：
//   - fetchFn 必须返回不可变副本（调用方不得改写返回切片），因为同一份值会被多个
//     goroutine 读取；本函数不再二次拷贝，以免每次命中都多一轮分配。
//   - 取消中的请求绝不落缓存。会话 App（MCP/Web）的 ctx 被取消时，驱动可能只取到
//     部分元数据；写进缓存会让后续 45s 内的正常请求读到不完整结果。
//   - fetchFn 返回 error 时，value 仍会透传给调用方但不落缓存：Pulsar 这类驱动会
//     「部分成功」（表列表与错误同时返回），调用方需要它渲染降级提示。
func (a *App) metadataCacheFetch(key string, fetchFn func() (interface{}, error)) (interface{}, error) {
	if value, ok := a.metadataCacheGet(key); ok {
		return value, nil
	}
	store := a.metadataStore()
	if store == nil {
		return fetchFn()
	}

	fetch := func() (interface{}, error) {
		if value, ok := a.metadataCacheGet(key); ok {
			return value, nil
		}
		value, err := fetchFn()
		if err != nil {
			return value, err
		}
		if a.metadataSessionContextErr() != nil {
			return value, nil
		}
		a.metadataCacheSet(key, value)
		return value, nil
	}

	value, err, _ := store.sf.Do(a.metadataFlightScope()+"\x00"+key, fetch)
	return value, err
}

// invalidateMetadata 清除指定连接+库的全部缓存元数据，由 DDL（DROP / RENAME / CREATE /
// ALTER）成功后调用，避免缓存继续返回已删除或已改名的表结构。
//
// 内部必须先做 normalizeMetadataRunConfig：缓存键是由「归一化后的运行配置」算出来的
// （网络库会把 Database 改写成 dbName，OceanBase Oracle 模式会清掉 Database），而 DDL
// 调用点手上是原始 config。直接 getCacheKey(config) 会算出另一个哈希，前缀一条都匹配
// 不上，失效会静默变成空操作。
//
// 有意保持非导出：前端对该方法零调用点，导出会进入 Wails 绑定面并触发绑定一致性
// 变更，而本次不改绑定。
func (a *App) invalidateMetadata(config connection.ConnectionConfig, dbName string) {
	store := a.peekMetadataStore()
	if store == nil {
		return
	}
	runConfig := normalizeMetadataRunConfig(config, dbName)
	prefix := getCacheKey(runConfig) + "\x00" + dbName + "\x00"
	store.mu.Lock()
	dropMetadataEntriesByPrefix(store, prefix)
	store.mu.Unlock()
	// 先放锁再写日志：日志要走文件 I/O，不该占着缓存写锁。
	logger.Infof("已失效元数据缓存：库=%s 前缀=%s", strings.TrimSpace(dbName), shortenCacheKey(prefix))
}

// invalidateMetadataAfterDDL 在结构变更成功后失效该连接该库的元数据缓存。
//
// 只在成功时清：失败的 DDL 没有改变真实结构，清了只会让侧栏白刷一次。传进来的必须是
// 原始 config（不是 DDL 用的 runConfig）——invalidateMetadata 内部自己做
// normalizeMetadataRunConfig，与缓存键的算法保持一致。
func (a *App) invalidateMetadataAfterDDL(result connection.QueryResult, config connection.ConnectionConfig, dbName string) {
	if !result.Success {
		return
	}
	a.invalidateMetadata(config, dbName)
}

// isMetadataAffectingDDL 判断 SQL 首关键词是否属于影响元数据缓存的 DDL。
// 命中后 dbQueryWithCancel 的成功写路径会调用 invalidateMetadata，让 SQL 编辑器里
// 建表/删表/改表后侧栏树立刻可见，而不是等 TTL 到期。
//
// 宁可多失效也不能漏：误把普通写判成 DDL 只是多刷一次元数据，漏判则会让树长期陈旧。
// 首关键词解析复用 sqlDataOperationInfo（已处理前导注释与 WITH 前缀）。
func isMetadataAffectingDDL(query string) bool {
	keyword, _ := sqlDataOperationInfo(query)
	switch keyword {
	case "create", "drop", "alter", "rename":
		return true
	}
	return false
}

// statementsAffectMetadata 判断多语句批次里是否**任意一条**是 DDL。
//
// 逐条判定而不是只看整批的首关键词：SQL 编辑器常把「建表 + 建索引」或
// 「SELECT ...; DROP TABLE ...」一次性提交，只看第一条会把后面的结构变更漏掉，
// 那些表要等 TTL 才在侧栏出现或消失。逐条判定在单语句路径之上严格扩大覆盖面，
// 且仍只命中 create/drop/alter/rename，普通写不会误清缓存。
//
// 空批次直接返回 false：没有语句下发过，结构不可能改变。
func statementsAffectMetadata(statements []string) bool {
	for _, statement := range statements {
		if isMetadataAffectingDDL(statement) {
			return true
		}
	}
	return false
}

// dropMetadataCacheForConfig 清除某连接（所有库）的缓存元数据，供连接被释放/失效时
// 级联清理：重连后同一 config 会重新建连，结构缓存不清就会让新连接继续返回旧连接
// 读到的表结构。
func (a *App) dropMetadataCacheForConfig(cacheKey string) {
	if strings.TrimSpace(cacheKey) == "" {
		return
	}
	store := a.peekMetadataStore()
	if store == nil {
		return
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	dropMetadataEntriesByPrefix(store, cacheKey+"\x00")
}

// dropMetadataCacheForConfigLocked 供「调用方已持有 a.mu」的路径使用（连接释放/关闭
// 与 dbCache 的清理处在同一临界区时不能再去抢 a.mu，sync.Mutex 不可重入）：此时读
// a.metadataCache 字段本身已受 a.mu 保护，只需再取 store.mu。
func (a *App) dropMetadataCacheForConfigLocked(cacheKey string) {
	if a == nil || strings.TrimSpace(cacheKey) == "" {
		return
	}
	store := a.metadataCache
	if store == nil {
		return
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	dropMetadataEntriesByPrefix(store, cacheKey+"\x00")
}

// dropMetadataEntriesByPrefix 必须在调用方已持有 store.mu 时调用。
func dropMetadataEntriesByPrefix(store *metadataCacheStore, prefix string) {
	if store == nil || strings.TrimSpace(prefix) == "" {
		return
	}
	for key := range store.entries {
		if strings.HasPrefix(key, prefix) {
			delete(store.entries, key)
		}
	}
}

// metadataSessionContextErr 返回当前元数据请求的取消状态。只有会话 App（MCP/Web
// 元数据请求）持有 ctx；普通 Wails 调用没有会话，恒为 nil。
func (a *App) metadataSessionContextErr() error {
	if a == nil || a.metadataSession == nil || a.metadataSession.ctx == nil {
		return nil
	}
	return a.metadataSession.ctx.Err()
}
