package app

import (
	"strings"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
)

// registryDataImportModes 返回描述表类型声明的导入方式（excelImport / sqlFileImport）；
// 不是描述表类型时 ok 为 false，沿用按方言判断的历史规则。
func registryDataImportModes(config connection.ConnectionConfig) (tableImport bool, sqlFileImport bool, ok bool) {
	if strings.EqualFold(strings.TrimSpace(config.Type), "custom") {
		return false, false, false
	}
	spec, found := db.DataSourceSpec(config.Type)
	if !found {
		return false, false, false
	}
	return spec.ExcelImport, spec.SQLFileImport, true
}

// registryImportSupportsTransactionalBatch 报告描述表类型的导入能否整批回滚：只有声明了事务能力的类型可以，
// 文档库、键值库与时序库的写入逐条生效。
func registryImportSupportsTransactionalBatch(config connection.ConnectionConfig) bool {
	return db.ResolveDataSourceCapability(config.Type).Transaction.Supported
}
