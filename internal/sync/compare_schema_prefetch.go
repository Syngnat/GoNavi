package sync

import (
	"strings"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
)

// comparePrefetchedDatabase 用整库批量结果回答逐表元数据查询。
//
// 对比的结构计划构造是逐表的（GetColumns + GetIndexes），但成本全在往返上：
// 1569 张表就是约 4700 次往返。这里在扫描开始前把整库列与索引各拉一次，之后
// 的逐表查询全部命中内存；表不存在时直接返回空，连存在性查询也省掉。
type comparePrefetchedDatabase struct {
	db.Database
	columns map[string][]connection.ColumnDefinition
	indexes map[string][]connection.IndexDefinition
	// tables 是「小写表名 -> 该库真实存在的表」：批量查询缺席的表即不存在。
	tables map[string]struct{}
}

// prefetchCompareDatabase 预取整库元数据并返回包装后的连接。
//
// 任何一步不可用（驱动不支持批量、查询失败）都原样返回入参：批量只是加速，
// 正确性必须由逐表路径兜底。第二个返回值表示是否真的启用了预取。
func prefetchCompareDatabase(database db.Database, dbName string, tableNames []string) (db.Database, bool) {
	columnsBatcher, ok := database.(db.TableColumnsBatcher)
	if !ok {
		return database, false
	}
	batchedColumns, err := columnsBatcher.GetColumnsBatch(dbName, tableNames)
	if err != nil {
		return database, false
	}
	tables, err := database.GetTables(dbName)
	if err != nil {
		return database, false
	}
	prefetched := &comparePrefetchedDatabase{
		Database: database,
		columns:  make(map[string][]connection.ColumnDefinition, len(batchedColumns)),
		tables:   make(map[string]struct{}, len(tables)),
	}
	for name, columns := range batchedColumns {
		prefetched.columns[strings.ToLower(strings.TrimSpace(name))] = columns
	}
	for _, name := range tables {
		if trimmed := strings.ToLower(strings.TrimSpace(name)); trimmed != "" {
			prefetched.tables[trimmed] = struct{}{}
		}
	}
	if indexesBatcher, ok := database.(db.TableIndexesBatcher); ok {
		if batchedIndexes, indexErr := indexesBatcher.GetIndexesBatch(dbName, tableNames); indexErr == nil {
			prefetched.indexes = make(map[string][]connection.IndexDefinition, len(batchedIndexes))
			for name, indexes := range batchedIndexes {
				prefetched.indexes[strings.ToLower(strings.TrimSpace(name))] = indexes
			}
		}
	}
	return prefetched, true
}

func (p *comparePrefetchedDatabase) GetColumns(dbName, tableName string) ([]connection.ColumnDefinition, error) {
	key := strings.ToLower(strings.TrimSpace(tableName))
	if columns, ok := p.columns[key]; ok {
		return columns, nil
	}
	if _, exists := p.tables[key]; !exists {
		// 预取已证明该表不在库里：直接回空，避免再付一次往返。
		return nil, nil
	}
	return p.Database.GetColumns(dbName, tableName)
}

func (p *comparePrefetchedDatabase) GetIndexes(dbName, tableName string) ([]connection.IndexDefinition, error) {
	key := strings.ToLower(strings.TrimSpace(tableName))
	if indexes, ok := p.indexes[key]; ok {
		return indexes, nil
	}
	if p.indexes != nil {
		if _, exists := p.tables[key]; !exists {
			return nil, nil
		}
	}
	return p.Database.GetIndexes(dbName, tableName)
}

// compareSourceTableNames 返回本次对比要扫的源表名（去掉 schema 前缀前的原名）。
func compareSourceTableNames(config SyncConfig) []string {
	names := make([]string, 0, len(config.Tables))
	for _, table := range config.Tables {
		if trimmed := strings.TrimSpace(table); trimmed != "" {
			names = append(names, compareTableBaseName(trimmed))
		}
	}
	return names
}

// compareTargetTableNames 返回目标端要预取的表名：以映射里的目标名为准，
// 没有映射时按同名对比。
func compareTargetTableNames(config SyncConfig) []string {
	bySource := make(map[string]string, len(config.Mappings))
	for _, mapping := range config.Mappings {
		source := strings.ToLower(compareTableBaseName(syncObjectRefIdentifier(mapping.Source)))
		target := strings.TrimSpace(mapping.Target.Name)
		if source == "" || target == "" {
			continue
		}
		bySource[source] = compareTableBaseName(target)
	}
	names := make([]string, 0, len(config.Tables))
	for _, table := range config.Tables {
		base := compareTableBaseName(table)
		if target, ok := bySource[strings.ToLower(base)]; ok {
			names = append(names, target)
			continue
		}
		names = append(names, base)
	}
	return names
}

// compareTableBaseName 去掉库/schema 前缀与标识符引号。
func compareTableBaseName(name string) string {
	value := strings.TrimSpace(name)
	if index := strings.LastIndex(value, "."); index >= 0 {
		value = value[index+1:]
	}
	return strings.Trim(value, "`\"[] \t")
}
