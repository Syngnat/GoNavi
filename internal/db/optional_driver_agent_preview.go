package db

import (
	"GoNavi-Wails/internal/connection"
)

const optionalAgentMethodPreviewChanges = "previewChanges"

// optionalAgentChangePreview 是代理返回的变更预览；Supported 为 false 表示代理内的驱动没有自己的预览。
type optionalAgentChangePreview struct {
	Supported bool     `json:"supported"`
	Deletes   []string `json:"deletes,omitempty"`
	Updates   []string `json:"updates,omitempty"`
	Inserts   []string `json:"inserts,omitempty"`
}

var _ ChangePreviewTrier = (*OptionalDriverAgentDB)(nil)

// TryPreviewChanges 请求代理内驱动的变更预览（非 SQL 数据源展示实际发出的请求）。旧版代理不认识该方法、
// 驱动没有实现预览或调用失败时返回 false，由调用方回退到 SQL 预览。
func (d *OptionalDriverAgentDB) TryPreviewChanges(tableName string, changes connection.ChangeSet) ([]string, []string, []string, bool) {
	client, err := d.requireClient()
	if err != nil {
		return nil, nil, nil, false
	}
	var preview optionalAgentChangePreview
	if err := client.callWithContext(metadataContextFor(d), optionalAgentRequest{
		Method:    optionalAgentMethodPreviewChanges,
		TableName: tableName,
		Changes:   &changes,
	}, &preview, nil, nil, nil, optionalAgentControlCallTimeout); err != nil || !preview.Supported {
		return nil, nil, nil, false
	}
	return preview.Deletes, preview.Updates, preview.Inserts, true
}
