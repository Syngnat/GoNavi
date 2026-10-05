package main

import "GoNavi-Wails/internal/db"

const agentMethodPreviewChanges = "previewChanges"

// agentChangePreview 是变更预览响应；Supported 为 false 表示驱动没有自己的预览，主进程回退到 SQL 预览。
type agentChangePreview struct {
	Supported bool     `json:"supported"`
	Deletes   []string `json:"deletes,omitempty"`
	Updates   []string `json:"updates,omitempty"`
	Inserts   []string `json:"inserts,omitempty"`
}

// handlePreviewChanges 转发数据网格的变更预览给实现了 db.ChangePreviewer 的驱动（非 SQL 数据源展示实际发出的请求）。
func handlePreviewChanges(inst db.Database, req agentRequest, resp agentResponse) agentResponse {
	if inst == nil {
		return fail(resp, "connection not open")
	}
	if req.Changes == nil {
		return fail(resp, "变更集为空")
	}
	previewer, ok := inst.(db.ChangePreviewer)
	if !ok {
		resp.Data = agentChangePreview{}
		return resp
	}
	deletes, updates, inserts := previewer.PreviewChanges(req.TableName, *req.Changes)
	resp.Data = agentChangePreview{Supported: true, Deletes: deletes, Updates: updates, Inserts: inserts}
	return resp
}
