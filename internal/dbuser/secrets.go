package dbuser

import (
	"errors"
	"sort"
	"strings"
)

// Secrets 收集一次请求中出现的所有敏感值（明文口令、各种转义形态、预哈希值），
// 用于从驱动错误文本中剔除。
type Secrets struct {
	values []string
}

// minSecretLength 以下的值不做替换，避免把单字符口令替换成满屏掩码。
const minSecretLength = 2

// Add 登记一个敏感值及其常见转义形态。
func (s *Secrets) Add(values ...string) {
	for _, value := range values {
		if len(value) < minSecretLength {
			continue
		}
		s.values = append(s.values, value)
		for _, variant := range secretVariants(value) {
			if variant != value && len(variant) >= minSecretLength {
				s.values = append(s.values, variant)
			}
		}
	}
}

// FromRequest 登记 ChangeRequest 中的口令字段。
func (s *Secrets) FromRequest(request ChangeRequest) {
	if request.Password == nil {
		return
	}
	s.Add(request.Password.Password, request.Password.CurrentPassword)
}

// Empty 表示没有登记任何敏感值。
func (s *Secrets) Empty() bool {
	return s == nil || len(s.values) == 0
}

// Redact 把文本中的敏感值替换为掩码；长值优先替换，避免子串残留。
func (s *Secrets) Redact(text string) string {
	if s.Empty() || text == "" {
		return text
	}
	values := append([]string(nil), s.values...)
	sort.SliceStable(values, func(i, j int) bool { return len(values[i]) > len(values[j]) })
	for _, value := range values {
		text = strings.ReplaceAll(text, value, MaskedSecret)
	}
	return text
}

// SanitizeError 返回一个不包裹原错误的新错误，其文本已剔除敏感值。
// 不包裹是刻意的：errors.Unwrap / ErrorChain 不能再拿到含口令的原始文本。
func SanitizeError(err error, secrets *Secrets) error {
	if err == nil {
		return nil
	}
	if domainErr, ok := AsError(err); ok {
		return domainErr
	}
	return errors.New(secrets.Redact(err.Error()))
}

func secretVariants(value string) []string {
	return []string{
		strings.ReplaceAll(value, "'", "''"),
		strings.ReplaceAll(strings.ReplaceAll(value, `\`, `\\`), "'", `\'`),
		strings.ReplaceAll(strings.ReplaceAll(value, `\`, `\\`), "'", "''"),
		strings.ReplaceAll(value, `"`, `\"`),
	}
}
