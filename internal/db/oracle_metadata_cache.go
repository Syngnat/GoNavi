package db

import (
	"strings"
	"sync"
)

// oracleMetadataCache 保存连接期内的元数据解析结果。
//
// 动机：预检对同一张表会多次解析同一个对象名（字段、存在性、索引各一次），
// 而 oracleMetadataNamePairs 每次都要按大小写盲试最多 4 个变体 —— 正常路径上
// 3/4 的字典查询是纯粹的重试浪费，在大库上直接表现为预检超时。
//
// 只有「命中」会进缓存。任务运行期间目标表可能刚刚被创建出来，缓存「不存在」
// 会让下一次存在性检查继续报缺失，从而误判为需要重建表。
type oracleMetadataCache struct {
	mu sync.Mutex
	// names 以 schema\x00对象名 为键，保存解析出的规范名对。
	names map[string]oracleMetadataNamePair
	// identityView 记录 ALL_TAB_IDENTITY_COLS 是否可用。该视图 12c 起才有，
	// 受限账号也可能缺权限；视图是否存在是连接期内的稳定属性，正负结果都可缓存。
	identityView *bool
}

func (c *oracleMetadataCache) lookupName(key string) (oracleMetadataNamePair, bool) {
	if c == nil {
		return oracleMetadataNamePair{}, false
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	pair, ok := c.names[key]
	return pair, ok
}

func (c *oracleMetadataCache) storeName(key string, pair oracleMetadataNamePair) {
	if c == nil {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.names == nil {
		c.names = make(map[string]oracleMetadataNamePair)
	}
	c.names[key] = pair
}

func (c *oracleMetadataCache) identitySupported() (bool, bool) {
	if c == nil {
		return false, false
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.identityView == nil {
		return false, false
	}
	return *c.identityView, true
}

func (c *oracleMetadataCache) storeIdentitySupported(supported bool) {
	if c == nil {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.identityView = &supported
}

// metadataCacheFor 惰性初始化连接级元数据缓存。
//
// 并发调用者可能同时首次进入，因此在锁内创建；缓存本身再由内部互斥保护。
func (o *OracleDB) metadataCacheFor() *oracleMetadataCache {
	o.metadataMu.Lock()
	defer o.metadataMu.Unlock()
	if o.metadataCache == nil {
		o.metadataCache = &oracleMetadataCache{}
	}
	return o.metadataCache
}

// resetOracleMetadataCache 在重新连接时清空缓存：新连接可能是另一个库实例，
// 沿用旧解析结果会让对象名解析到不存在的 schema。
func (o *OracleDB) resetOracleMetadataCache() {
	o.metadataMu.Lock()
	defer o.metadataMu.Unlock()
	o.metadataCache = nil
}

// oracleNameCacheKey 生成解析缓存键。大小写不敏感，与解析语义一致。
func oracleNameCacheKey(dbName, tableName string) string {
	return strings.ToUpper(strings.TrimSpace(dbName)) + "\x00" + strings.ToUpper(strings.TrimSpace(tableName))
}
