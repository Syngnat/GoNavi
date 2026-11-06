package webserver

import (
	"fmt"
	"strings"
	"time"

	"GoNavi-Wails/internal/webidentity"
)

// webAuthUserMutation 是管理界面提交的账号变更请求。
type webAuthUserMutation struct {
	Action               string   `json:"action"`
	Username             string   `json:"username"`
	Password             string   `json:"password"`
	Role                 string   `json:"role"`
	Disabled             bool     `json:"disabled"`
	AllowedConnectionIDs []string `json:"allowedConnectionIds"`
}

// Users 返回脱敏后的账号列表，供管理界面渲染。
func (m *webAuthManager) Users() ([]webAuthUserSummary, error) {
	m.refreshConfigFromDisk()
	m.mu.RLock()
	defer m.mu.RUnlock()
	if !m.config.IsConfigured() {
		return nil, errWebAuthNotConfigured
	}
	return buildWebAuthUserSummaries(m.config, m.passwordManagedByEnvironment), nil
}

// MutateUser 执行一次账号变更，并把最新账号列表返回给调用方。
func (m *webAuthManager) MutateUser(actorUsername string, request webAuthUserMutation) ([]webAuthUserSummary, error) {
	m.refreshConfigFromDisk()
	m.mu.Lock()
	defer m.mu.Unlock()
	if !m.config.IsConfigured() {
		return nil, errWebAuthNotConfigured
	}
	cfg := cloneWebAuthConfig(m.config)
	action := strings.ToLower(strings.TrimSpace(request.Action))
	switch action {
	case "create", "update", "reset_password", "delete":
	default:
		return nil, fmt.Errorf("unsupported user action")
	}

	username := webidentity.NormalizeUsername(request.Username)
	if action == "create" {
		if err := m.mutateCreateUser(&cfg, request); err != nil {
			return nil, err
		}
	} else {
		if username == "" {
			return nil, fmt.Errorf("username is required")
		}
		if _, ok := findWebAuthUser(cfg, username); !ok {
			return nil, fmt.Errorf("user not found")
		}
		if action == "delete" {
			if username == webidentity.NormalizeUsername(actorUsername) {
				return nil, fmt.Errorf("the current user cannot be removed")
			}
			if err := removeWebAuthUser(&cfg, username); err != nil {
				return nil, err
			}
		} else if action == "reset_password" {
			passwordHash, err := hashPassword(request.Password)
			if err != nil {
				return nil, err
			}
			if err := setWebAuthUserPassword(&cfg, username, passwordHash); err != nil {
				return nil, err
			}
		} else {
			if err := m.mutateUpdateUser(&cfg, username, actorUsername, request); err != nil {
				return nil, err
			}
		}
	}

	cfg = normalizeWebAuthConfig(cfg)
	cfg.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
	if err := m.saveConfigLocked(cfg); err != nil {
		return nil, err
	}
	m.config = cfg
	if action == "delete" || action == "reset_password" {
		m.sessions.DestroyUser(username)
	}
	return buildWebAuthUserSummaries(cfg, m.passwordManagedByEnvironment), nil
}

func (m *webAuthManager) mutateCreateUser(cfg *webAuthConfig, request webAuthUserMutation) error {
	if strings.TrimSpace(request.Password) == "" {
		return fmt.Errorf("password is required")
	}
	passwordHash, err := hashPassword(request.Password)
	if err != nil {
		return err
	}
	role, err := normalizeWebAuthUserRole(request.Role)
	if err != nil {
		return err
	}
	return upsertWebAuthUser(cfg, request.Username, passwordHash, role, request.Disabled, request.AllowedConnectionIDs)
}

func (m *webAuthManager) mutateUpdateUser(cfg *webAuthConfig, username string, actorUsername string, request webAuthUserMutation) error {
	if username == webidentity.NormalizeUsername(actorUsername) && request.Disabled {
		return fmt.Errorf("the current user cannot be disabled")
	}
	passwordHash := ""
	if strings.TrimSpace(request.Password) != "" {
		hashed, err := hashPassword(request.Password)
		if err != nil {
			return err
		}
		passwordHash = hashed
	}
	role, err := normalizeWebAuthUserRole(request.Role)
	if err != nil {
		return err
	}
	if err := upsertWebAuthUser(cfg, username, passwordHash, role, request.Disabled, request.AllowedConnectionIDs); err != nil {
		return err
	}
	// 角色、密码或停用状态变化后，旧会话必须作废，避免继续持有旧权限。
	m.sessions.DestroyUser(username)
	return nil
}
