package dbuser

import (
	"errors"
	"fmt"
	"sort"
	"strings"
)

// 领域错误码；绑定层映射为 i18n 键 user_management.backend.error.<code>。
const (
	ErrCodeUnsupported         = "unsupported"
	ErrCodeReadOnly            = "read_only"
	ErrCodeNothingToApply      = "nothing_to_apply"
	ErrCodeInvalidName         = "invalid_name"
	ErrCodeNameTooLong         = "name_too_long"
	ErrCodeInvalidHost         = "invalid_host"
	ErrCodeInvalidOption       = "invalid_option"
	ErrCodeUnknownOption       = "unknown_option"
	ErrCodeInvalidPrivilege    = "invalid_privilege"
	ErrCodeInvalidObject       = "invalid_object"
	ErrCodePasswordRequired    = "password_required"
	ErrCodePasswordInvalidChar = "password_invalid_char"
	ErrCodePasswordPolicy      = "password_policy"
	ErrCodeCurrentPassword     = "current_password_required"
	ErrCodeKindNotSupported    = "kind_not_supported"
	ErrCodeFeatureUnavailable  = "feature_unavailable"
	ErrCodeRenameUnsupported   = "rename_unsupported"
	ErrCodeReservedAccount     = "reserved_account"
	ErrCodePlanChanged         = "plan_changed"
	ErrCodeSessionUnavailable  = "session_unavailable"
	ErrCodeTargetMissing       = "target_missing"
)

// Error 是带错误码的领域错误，参数只包含可展示的非敏感信息。
type Error struct {
	Code   string
	Params map[string]string
}

// NewError 构造领域错误。
func NewError(code string, params map[string]string) *Error {
	return &Error{Code: code, Params: params}
}

// Error 实现 error；文本仅用于日志，UI 文案由绑定层按 Code 本地化。
func (e *Error) Error() string {
	if e == nil {
		return ""
	}
	if len(e.Params) == 0 {
		return "dbuser: " + e.Code
	}
	keys := make([]string, 0, len(e.Params))
	for key := range e.Params {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	parts := make([]string, 0, len(keys))
	for _, key := range keys {
		parts = append(parts, fmt.Sprintf("%s=%s", key, e.Params[key]))
	}
	return "dbuser: " + e.Code + " (" + strings.Join(parts, ", ") + ")"
}

// AsError 提取领域错误。
func AsError(err error) (*Error, bool) {
	var target *Error
	if errors.As(err, &target) {
		return target, true
	}
	return nil, false
}

// Errorf 构造带参数的领域错误：Errorf(code, "key", "value", ...)。
func Errorf(code string, pairs ...string) *Error {
	params := make(map[string]string, len(pairs)/2)
	for index := 0; index+1 < len(pairs); index += 2 {
		params[pairs[index]] = pairs[index+1]
	}
	return NewError(code, params)
}
