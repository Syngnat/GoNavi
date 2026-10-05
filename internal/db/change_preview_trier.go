package db

import (
	"encoding/json"

	"GoNavi-Wails/internal/connection"
)

// ChangePreviewTrier 是可能给不出预览的变更预览接口：驱动代理只有在代理内的驱动实现了 ChangePreviewer 时才有预览，
// 旧版代理或驱动未实现时 ok 为 false，调用方回退到按方言生成的 SQL 预览。
type ChangePreviewTrier interface {
	TryPreviewChanges(tableName string, changes connection.ChangeSet) (deletes, updates, inserts []string, ok bool)
}

// formatConsoleRequest 把 REST 请求写成控制台可直接执行的形式：「METHOD /path」，有请求体时换行后跟缩进的 JSON。
// 非 SQL 数据源的变更预览用它展示实际发出的请求。
func formatConsoleRequest(method, path string, body interface{}) string {
	if body == nil {
		return method + " " + path
	}
	encoded, err := json.MarshalIndent(body, "", "  ")
	if err != nil {
		return method + " " + path
	}
	return method + " " + path + "\n" + string(encoded)
}
