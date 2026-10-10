//go:build gonavi_full_drivers || gonavi_iris_driver || gonavi_cache_driver

package db

import (
	"database/sql"
	"strings"
	"time"

	"GoNavi-Wails/internal/ssh"

	_ "github.com/caretdev/go-irisnative"
)

const (
	defaultIRISPort      = 1972
	defaultIRISNamespace = "USER"

	// irisDriverQueryReadTimeout 是注入到底层 go-irisnative 驱动的「单次网络读」
	// 超时。该驱动不响应 context 取消，且服务端对受限账号的 %SYS 视图、大量系统
	// 投影表的流式 fetchMoreData 都可能长时间不回包，没有这层兜底上层
	// （GetDatabases/GetTables/loadSchemas）会永久转圈（issue #1430/#1427）。
	//
	// 取值是「单次 Read」的上限，不是整条 SQL 的端到端超时；INTERNATIONAL_SCHEMA
	// 在跨网络的长链路上单次 fetchMoreData 可能耗时几十秒，所以这里要够宽，
	// 仅作为「服务端真的不回包」的兜底，而不是常规慢查询的限速器。
	irisDriverQueryReadTimeout = 90 * time.Second
)

type interSystemsProduct string

const (
	interSystemsProductIRIS  interSystemsProduct = "iris"
	interSystemsProductCache interSystemsProduct = "cache"
)

type IrisDB struct {
	conn        *sql.DB
	pingTimeout time.Duration
	namespace   string
	// namespaceExplicit 记录命名空间是否为连接配置里显式给定。配置留空时驱动会兜底成
	// defaultIRISNamespace（USER）以保证会话可用，但那个名字是本地推断的、服务端从未
	// 确认过，不能当作库列表的唯一来源，否则侧栏会显示一个并不存在的库，展开即失败。
	namespaceExplicit bool
	forwarder         *ssh.LocalForwarder
	product           interSystemsProduct
}

// CacheDB exposes InterSystems Caché as an independent data-source type while
// reusing the wire-compatible InterSystems SQL implementation. Keeping a
// dedicated wrapper preserves Caché connection identity, driver lifecycle and
// UI state instead of silently rewriting saved connections to IRIS.
type CacheDB struct {
	IrisDB
}

// productName/productType intentionally shadow the embedded IrisDB methods so
// a zero-value CacheDB already reports its stable Caché identity. This keeps
// connection identity independent even before Connect initializes the
// embedded implementation state.
func (c *CacheDB) productName() string {
	return "InterSystems Caché"
}

func (c *CacheDB) productType() string {
	return string(interSystemsProductCache)
}

var _ Database = (*IrisDB)(nil)
var _ Database = (*CacheDB)(nil)
var _ BatchApplierContext = (*IrisDB)(nil)
var _ BatchApplierContext = (*CacheDB)(nil)

type irisTableRef struct {
	Schema string
	Table  string
}

func normalizeIRISNamespace(namespace string) string {
	trimmed := strings.Trim(strings.TrimSpace(namespace), "/")
	if trimmed == "" {
		return defaultIRISNamespace
	}
	return trimmed
}

func (i *IrisDB) productName() string {
	if i != nil && i.product == interSystemsProductCache {
		return "InterSystems Caché"
	}
	return "InterSystems IRIS"
}

func (i *IrisDB) productType() string {
	if i != nil && i.product == interSystemsProductCache {
		return string(interSystemsProductCache)
	}
	return string(interSystemsProductIRIS)
}
