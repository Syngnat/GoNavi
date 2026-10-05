package db

import (
	"context"
	"reflect"
	"sync"
)

// metadataContexts 让元数据入口复用既有驱动实现，同时把请求上下文传给 Query。
// 元数据请求使用独立的 Database 实例，因此不会与常规缓存连接的操作重叠。
var metadataContexts sync.Map

type metadataContextKey struct {
	typ reflect.Type
	ptr uintptr
}

type metadataContextChildBinder interface {
	bindMetadataContext(context.Context)
	clearMetadataContext()
}

func metadataContextKeyFor(database any) (metadataContextKey, bool) {
	value := reflect.ValueOf(database)
	if !value.IsValid() || value.Kind() != reflect.Ptr || value.IsNil() {
		return metadataContextKey{}, false
	}
	return metadataContextKey{typ: value.Type(), ptr: value.Pointer()}, true
}

// BindMetadataContext 将独立数据库实例与元数据请求上下文关联。
// 请求结束后必须调用 ClearMetadataContext。
func BindMetadataContext(database Database, ctx context.Context) {
	key, ok := metadataContextKeyFor(database)
	if !ok || ctx == nil {
		return
	}
	metadataContexts.Store(key, ctx)
	if child, ok := database.(metadataContextChildBinder); ok {
		child.bindMetadataContext(ctx)
	}
}

// ClearMetadataContext 移除由 BindMetadataContext 建立的关联。
func ClearMetadataContext(database Database) {
	if key, ok := metadataContextKeyFor(database); ok {
		metadataContexts.Delete(key)
	}
	if child, ok := database.(metadataContextChildBinder); ok {
		child.clearMetadataContext()
	}
}

// MetadataContext 返回绑定到隔离元数据连接的请求上下文。
func MetadataContext(database Database) context.Context {
	return metadataContextFor(database)
}

// metadataContextFor 返回隔离元数据数据库关联的请求上下文。
// 常规查询路径保持原有的 Background 上下文行为。
func metadataContextFor(database any) context.Context {
	if key, ok := metadataContextKeyFor(database); ok {
		if ctx, ok := metadataContexts.Load(key); ok {
			if requestCtx, ok := ctx.(context.Context); ok && requestCtx != nil {
				return requestCtx
			}
		}
	}
	return context.Background()
}
