package webserver

import (
	"crypto/subtle"
	"fmt"
	"strings"
	"time"

	"GoNavi-Wails/internal/webidentity"
)

const (
	webRoleAdmin  = string(webidentity.RoleAdmin)
	webRoleViewer = string(webidentity.RoleViewer)
)

// webAuthUser 是一个浏览器登录账号。TOTP 与恢复码跟随账号，不再全局共享。
type webAuthUser struct {
	Username             string   `json:"username"`
	PasswordHash         string   `json:"passwordHash,omitempty"`
	Role                 string   `json:"role"`
	AllowedConnectionIDs []string `json:"allowedConnectionIds,omitempty"`
	TOTPEnabled          bool     `json:"totpEnabled,omitempty"`
	TOTPSecret           string   `json:"totpSecret,omitempty"`
	RecoveryCodeHashes   []string `json:"recoveryCodeHashes,omitempty"`
	Disabled             bool     `json:"disabled,omitempty"`
	CreatedAt            string   `json:"createdAt,omitempty"`
	UpdatedAt            string   `json:"updatedAt,omitempty"`
}

// webAuthUserSummary 是返回给管理界面的账号视图，绝不包含密码哈希与 TOTP 密钥。
type webAuthUserSummary struct {
	Username             string   `json:"username"`
	Role                 string   `json:"role"`
	AllowedConnectionIDs []string `json:"allowedConnectionIds,omitempty"`
	TOTPEnabled          bool     `json:"totpEnabled"`
	Disabled             bool     `json:"disabled"`
	CreatedAt            string   `json:"createdAt,omitempty"`
	UpdatedAt            string   `json:"updatedAt,omitempty"`
	PasswordManaged      bool     `json:"passwordManagedByEnvironment,omitempty"`
}

// migrateLegacyWebAuthUser 把 v1 的单管理员密码迁移成 Users[0]。
//
// 只在 Users 为空且旧字段有密码时执行；迁移后旧字段由 normalizeWebAuthConfig 清空，
// 因此同一份配置不会被重复迁移。
func migrateLegacyWebAuthUser(cfg webAuthConfig) []webAuthUser {
	if len(cfg.Users) > 0 {
		return append([]webAuthUser(nil), cfg.Users...)
	}
	if strings.TrimSpace(cfg.PasswordHash) == "" {
		return nil
	}
	return []webAuthUser{{
		Username:           webDefaultAdminUsername,
		PasswordHash:       cfg.PasswordHash,
		Role:               string(webidentity.RoleAdmin),
		TOTPEnabled:        cfg.TOTPEnabled,
		TOTPSecret:         cfg.TOTPSecret,
		RecoveryCodeHashes: append([]string(nil), cfg.RecoveryCodeHashes...),
		UpdatedAt:          cfg.UpdatedAt,
	}}
}

// normalizeWebAuthUsers 去重、收敛角色并保证至少有一个可登录的管理员。
//
// 未知角色按 viewer 处理（见 webidentity.NormalizeRole）；空角色时第一个账号
// 默认管理员，其余默认只读，兼容手工编辑过的配置。
func normalizeWebAuthUsers(users []webAuthUser) []webAuthUser {
	normalized := make([]webAuthUser, 0, len(users))
	seen := make(map[string]struct{}, len(users))
	for index, user := range users {
		username := webidentity.NormalizeUsername(user.Username)
		if username == "" {
			continue
		}
		if _, exists := seen[username]; exists {
			continue
		}
		seen[username] = struct{}{}

		role := webidentity.RoleViewer
		if strings.EqualFold(strings.TrimSpace(user.Role), string(webidentity.RoleAdmin)) {
			role = webidentity.RoleAdmin
		} else if strings.TrimSpace(user.Role) == "" && index == 0 {
			role = webidentity.RoleAdmin
		}

		normalizedUser := webAuthUser{
			Username:             username,
			PasswordHash:         strings.TrimSpace(user.PasswordHash),
			Role:                 string(role),
			AllowedConnectionIDs: normalizeAllowedConnectionIDs(user.AllowedConnectionIDs),
			TOTPEnabled:          user.TOTPEnabled && strings.TrimSpace(user.TOTPSecret) != "",
			TOTPSecret:           strings.TrimSpace(user.TOTPSecret),
			Disabled:             user.Disabled,
			CreatedAt:            strings.TrimSpace(user.CreatedAt),
			UpdatedAt:            strings.TrimSpace(user.UpdatedAt),
		}
		if role == webidentity.RoleAdmin {
			// 管理员始终拥有全部连接，不保存冗余的允许列表。
			normalizedUser.AllowedConnectionIDs = nil
		}
		if !normalizedUser.TOTPEnabled {
			normalizedUser.TOTPSecret = ""
			normalizedUser.RecoveryCodeHashes = nil
		} else if user.RecoveryCodeHashes != nil {
			normalizedUser.RecoveryCodeHashes = append([]string(nil), user.RecoveryCodeHashes...)
		}
		normalized = append(normalized, normalizedUser)
	}
	ensureAdminUser(normalized)
	return normalized
}

// ensureAdminUser 防止配置被改成「没有管理员可登录」的锁死状态。
// 只要存在带密码的启用账号，就把第一个这样的账号提升为管理员。
func ensureAdminUser(users []webAuthUser) {
	for _, user := range users {
		if !user.Disabled && user.Role == string(webidentity.RoleAdmin) && user.PasswordHash != "" {
			return
		}
	}
	for index := range users {
		if users[index].Disabled || users[index].PasswordHash == "" {
			continue
		}
		users[index].Role = string(webidentity.RoleAdmin)
		return
	}
}

func findWebAuthUserIndex(cfg webAuthConfig, username string) (int, bool) {
	normalized := webidentity.NormalizeUsername(username)
	if normalized == "" {
		return 0, false
	}
	for index, user := range cfg.Users {
		if user.Username == normalized {
			return index, true
		}
	}
	return 0, false
}

func findWebAuthUser(cfg webAuthConfig, username string) (webAuthUser, bool) {
	index, ok := findWebAuthUserIndex(cfg, username)
	if !ok {
		return webAuthUser{}, false
	}
	return cfg.Users[index], true
}

// normalizeWebAuthUsername 校验并规范化管理界面输入的用户名。
func normalizeWebAuthUsername(username string) (string, error) {
	normalized := webidentity.NormalizeUsername(username)
	if normalized == "" {
		return "", fmt.Errorf("username is required")
	}
	if len(normalized) > 64 {
		return "", fmt.Errorf("username must be at most 64 characters")
	}
	for _, char := range normalized {
		if (char >= 'a' && char <= 'z') || (char >= '0' && char <= '9') ||
			char == '.' || char == '_' || char == '-' {
			continue
		}
		return "", fmt.Errorf("username may only contain letters, digits, dot, underscore or hyphen")
	}
	return normalized, nil
}

func normalizeWebAuthUserRole(role string) (string, error) {
	switch webidentity.NormalizeRole(role) {
	case webidentity.RoleAdmin:
		return string(webidentity.RoleAdmin), nil
	default:
		return string(webidentity.RoleViewer), nil
	}
}

func buildWebAuthUserSummaries(cfg webAuthConfig, passwordManaged bool) []webAuthUserSummary {
	summaries := make([]webAuthUserSummary, 0, len(cfg.Users))
	for _, user := range cfg.Users {
		summaries = append(summaries, webAuthUserSummary{
			Username:             user.Username,
			Role:                 user.Role,
			AllowedConnectionIDs: append([]string(nil), user.AllowedConnectionIDs...),
			TOTPEnabled:          user.TOTPEnabled,
			Disabled:             user.Disabled,
			CreatedAt:            user.CreatedAt,
			UpdatedAt:            user.UpdatedAt,
			PasswordManaged:      passwordManaged && user.Role == string(webidentity.RoleAdmin),
		})
	}
	return summaries
}

// upsertWebAuthUser 新建或更新账号。更新时 PasswordHash 为空表示保留原密码；
// 不允许把最后一个可登录管理员降级或停用。
func upsertWebAuthUser(cfg *webAuthConfig, username string, passwordHash string, role string, disabled bool, allowedConnectionIDs []string) error {
	if cfg == nil {
		return fmt.Errorf("web auth config is unavailable")
	}
	normalizedUsername, err := normalizeWebAuthUsername(username)
	if err != nil {
		return err
	}
	normalizedRole, err := normalizeWebAuthUserRole(role)
	if err != nil {
		return err
	}
	allowed := normalizeAllowedConnectionIDs(allowedConnectionIDs)
	if normalizedRole == webRoleAdmin {
		allowed = nil
	}
	now := time.Now().UTC().Format(time.RFC3339)
	index, exists := findWebAuthUserIndex(*cfg, normalizedUsername)
	if !exists {
		cfg.Users = append(cfg.Users, webAuthUser{
			Username:             normalizedUsername,
			PasswordHash:         strings.TrimSpace(passwordHash),
			Role:                 normalizedRole,
			AllowedConnectionIDs: allowed,
			Disabled:             disabled,
			CreatedAt:            now,
			UpdatedAt:            now,
		})
		ensureAdminUser(cfg.Users)
		return nil
	}
	previous := cfg.Users[index]
	next := previous
	next.Role = normalizedRole
	next.AllowedConnectionIDs = allowed
	next.Disabled = disabled
	next.UpdatedAt = now
	if strings.TrimSpace(passwordHash) != "" {
		next.PasswordHash = strings.TrimSpace(passwordHash)
	}
	if next.Role != string(webidentity.RoleAdmin) || next.Disabled {
		if isLastLoginableAdmin(*cfg, previous) {
			return fmt.Errorf("the last enabled administrator cannot be demoted or disabled")
		}
	}
	cfg.Users[index] = next
	return nil
}

func isLastLoginableAdmin(cfg webAuthConfig, candidate webAuthUser) bool {
	if candidate.Role != string(webidentity.RoleAdmin) || candidate.Disabled || candidate.PasswordHash == "" {
		return false
	}
	for _, user := range cfg.Users {
		if user.Username == candidate.Username {
			continue
		}
		if !user.Disabled && user.Role == string(webidentity.RoleAdmin) && user.PasswordHash != "" {
			return false
		}
	}
	return true
}

func removeWebAuthUser(cfg *webAuthConfig, username string) error {
	if cfg == nil {
		return fmt.Errorf("web auth config is unavailable")
	}
	index, ok := findWebAuthUserIndex(*cfg, username)
	if !ok {
		return fmt.Errorf("user not found")
	}
	if isLastLoginableAdmin(*cfg, cfg.Users[index]) {
		return fmt.Errorf("the last enabled administrator cannot be removed")
	}
	cfg.Users = append(cfg.Users[:index], cfg.Users[index+1:]...)
	return nil
}

func setWebAuthUserPassword(cfg *webAuthConfig, username string, passwordHash string) error {
	if cfg == nil {
		return fmt.Errorf("web auth config is unavailable")
	}
	index, ok := findWebAuthUserIndex(*cfg, username)
	if !ok {
		return fmt.Errorf("user not found")
	}
	cfg.Users[index].PasswordHash = strings.TrimSpace(passwordHash)
	cfg.Users[index].UpdatedAt = time.Now().UTC().Format(time.RFC3339)
	return nil
}

// normalizeAllowedConnectionIDs 去空白、去重并限制条目数，避免配置无限膨胀。
func normalizeAllowedConnectionIDs(ids []string) []string {
	if len(ids) == 0 {
		return nil
	}
	normalized := make([]string, 0, len(ids))
	seen := make(map[string]struct{}, len(ids))
	for _, id := range ids {
		id = strings.TrimSpace(id)
		if id == "" {
			continue
		}
		if _, exists := seen[id]; exists {
			continue
		}
		seen[id] = struct{}{}
		normalized = append(normalized, id)
		if len(normalized) >= 512 {
			break
		}
	}
	return normalized
}

// consumeUserRecoveryCode 只从指定账号的恢复码里消费一个，成功后写回配置副本。
func consumeUserRecoveryCode(cfg webAuthConfig, username string, code string) (webAuthConfig, bool) {
	index, ok := findWebAuthUserIndex(cfg, username)
	if !ok {
		return cfg, false
	}
	user := cfg.Users[index]
	if !user.TOTPEnabled || len(user.RecoveryCodeHashes) == 0 {
		return cfg, false
	}
	needle := hashRecoveryCode(code)
	remaining := make([]string, 0, len(user.RecoveryCodeHashes))
	consumed := false
	for _, item := range user.RecoveryCodeHashes {
		if !consumed && subtle.ConstantTimeCompare([]byte(item), []byte(needle)) == 1 {
			consumed = true
			continue
		}
		remaining = append(remaining, item)
	}
	if !consumed {
		return cfg, false
	}
	next := cloneWebAuthConfig(cfg)
	next.Users[index].RecoveryCodeHashes = remaining
	return next, true
}

func anyWebAuthUserTOTPEnabled(cfg webAuthConfig) bool {
	for _, user := range cfg.Users {
		if !user.Disabled && user.TOTPEnabled {
			return true
		}
	}
	return false
}
