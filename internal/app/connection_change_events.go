package app

import "GoNavi-Wails/internal/uievents"

// savedConnectionsChangedEvent 通知所有已连接的客户端重新拉取连接列表。
// Web 模式多客户端共享同一份 connections.json；没有这个事件时，A 客户端的
// 修改要等 B 刷新页面才可见。
const savedConnectionsChangedEvent = "connections:changed"

func (a *App) notifySavedConnectionsChanged() {
	if a == nil {
		return
	}
	uievents.Emit(a.ctx, savedConnectionsChangedEvent, nil)
}
