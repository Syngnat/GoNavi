// Package webidentity carries the authenticated browser user across layers.
//
// 该包只承载请求级身份，不保存用户配置，也不做鉴权决策；鉴权策略留在
// internal/webserver，审计归因从 context 读取这里的 Actor。之所以独立成包，
// 是为了让 internal/app 能在不反向依赖 webserver 的前提下拿到操作者身份。
package webidentity

import (
	"context"
	"strings"
)

// Role 是浏览器会话的角色标识。
type Role string

const (
	// RoleAdmin 拥有全部能力，包括用户管理与连接配置修改。
	RoleAdmin Role = "admin"
	// RoleViewer 只能执行读取操作；连接配置会被强制为只读。
	RoleViewer Role = "viewer"
)

// Actor 是一次已认证请求的操作者。
type Actor struct {
	Username string
	Role     Role
	// AllowedConnectionIDs 为空表示不限制；非空时只允许访问这些已保存连接。
	AllowedConnectionIDs []string
}

type actorContextKey struct{}

// WithActor 把已认证用户写入请求 context。
func WithActor(ctx context.Context, actor Actor) context.Context {
	if ctx == nil {
		ctx = context.Background()
	}
	normalized := NormalizeActor(actor)
	if normalized.Username == "" {
		return ctx
	}
	return context.WithValue(ctx, actorContextKey{}, normalized)
}

// ActorFromContext 读取请求 context 中的操作者。未认证请求返回 false。
func ActorFromContext(ctx context.Context) (Actor, bool) {
	if ctx == nil {
		return Actor{}, false
	}
	actor, ok := ctx.Value(actorContextKey{}).(Actor)
	if !ok || strings.TrimSpace(actor.Username) == "" {
		return Actor{}, false
	}
	return NormalizeActor(actor), true
}

// UsernameFromContext 返回请求操作者用户名；未认证请求返回空字符串。
func UsernameFromContext(ctx context.Context) string {
	actor, ok := ActorFromContext(ctx)
	if !ok {
		return ""
	}
	return actor.Username
}

// NormalizeActor 统一用户名大小写并收敛未知角色。
//
// 未知角色按 viewer 处理：配置损坏或未来新增角色时宁可少给权限，
// 不能把读权限误升为管理员。
func NormalizeActor(actor Actor) Actor {
	allowed := make([]string, 0, len(actor.AllowedConnectionIDs))
	seen := make(map[string]struct{}, len(actor.AllowedConnectionIDs))
	for _, id := range actor.AllowedConnectionIDs {
		id = strings.TrimSpace(id)
		if id == "" {
			continue
		}
		if _, exists := seen[id]; exists {
			continue
		}
		seen[id] = struct{}{}
		allowed = append(allowed, id)
	}
	return Actor{
		Username:             NormalizeUsername(actor.Username),
		Role:                 NormalizeRole(string(actor.Role)),
		AllowedConnectionIDs: allowed,
	}
}

// NormalizeRole 将任意角色字符串收敛为受支持的角色。
func NormalizeRole(role string) Role {
	switch strings.ToLower(strings.TrimSpace(role)) {
	case string(RoleAdmin):
		return RoleAdmin
	default:
		return RoleViewer
	}
}

// NormalizeUsername 规范化用户名：去空白并转小写，保证登录与查找一致。
func NormalizeUsername(username string) string {
	return strings.ToLower(strings.TrimSpace(username))
}
