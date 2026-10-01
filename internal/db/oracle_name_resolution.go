package db

// 记录「哪个大小写变体命中了」。
//
// oracleMetadataNamePairs 的第一个候选就是调用方传入的原样名称，所以在正常路径上
// 一次查询即命中 —— 它并不是性能问题。真正的浪费出现在大小写不一致时：那一次
// 解析要试到第 2 或第 4 个变体，而预检对同一张表会先后调用存在性检查、列定义与
// 索引三处，于是同一个「试错」被重复三轮。
//
// 因此这里不做额外的解析查询（那会凭空多一次往返），只把已经命中的变体记下来，
// 后续调用直接复用。首次调用代价与改动前完全一致，第二轮起才减少查询。
//
// 只缓存命中结果：任务运行期间目标表可能刚被创建，缓存「未命中」会让存在性检查
// 继续报缺失，进而误判为需要重建表。

func (o *OracleDB) cachedOracleMetadataNamePair(dbName, tableName string) (oracleMetadataNamePair, bool) {
	return o.metadataCacheFor().lookupName(oracleNameCacheKey(dbName, tableName))
}

func (o *OracleDB) rememberOracleMetadataNamePair(dbName, tableName string, pair oracleMetadataNamePair) {
	o.metadataCacheFor().storeName(oracleNameCacheKey(dbName, tableName), pair)
}

// oracleMetadataNameCandidates 返回本次应尝试的候选名。
//
// 已有命中记录时只返回那一个，避免重复试错；否则返回完整的变体列表，行为与
// 改动前一致。
func (o *OracleDB) oracleMetadataNameCandidates(dbName, tableName string) []oracleMetadataNamePair {
	if pair, ok := o.cachedOracleMetadataNamePair(dbName, tableName); ok {
		return []oracleMetadataNamePair{pair}
	}
	return oracleMetadataNamePairs(dbName, tableName)
}
