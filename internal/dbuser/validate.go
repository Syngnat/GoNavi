package dbuser

import (
	"slices"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"
)

// NameRule 是某数据源对账号/角色名的限制。
type NameRule struct {
	// MaxLength 为 0 表示不限制；MaxBytes 为 true 时按 UTF-8 字节计。
	MaxLength int
	MaxBytes  bool
	// AllowedRunes 非 nil 时，名称中每个字符都必须通过校验（如 TDengine 白名单）。
	AllowedRunes func(r rune) bool
}

// ValidateName 校验名称：非空、无控制字符、长度与字符集。
func ValidateName(name string, rule NameRule) error {
	if strings.TrimSpace(name) == "" {
		return Errorf(ErrCodeInvalidName, "name", name)
	}
	if !utf8.ValidString(name) {
		return Errorf(ErrCodeInvalidName, "name", name)
	}
	for _, r := range name {
		if r == 0 || unicode.IsControl(r) {
			return Errorf(ErrCodeInvalidName, "name", strings.ToValidUTF8(name, "?"))
		}
		if rule.AllowedRunes != nil && !rule.AllowedRunes(r) {
			return Errorf(ErrCodeInvalidName, "name", name)
		}
	}
	length := utf8.RuneCountInString(name)
	if rule.MaxBytes {
		length = len(name)
	}
	if rule.MaxLength > 0 && length > rule.MaxLength {
		return Errorf(ErrCodeNameTooLong, "name", name, "max", strconv.Itoa(rule.MaxLength))
	}
	return nil
}

// IsIdentifierRune 是 [A-Za-z0-9_] 白名单。
func IsIdentifierRune(r rune) bool {
	return r == '_' || (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9')
}

// ValidatePassword 校验口令：不含 NUL/换行、不含禁用字符、满足探测到的复杂度策略。
func ValidatePassword(password, username string, policy PasswordPolicy) error {
	if password == "" {
		return NewError(ErrCodePasswordRequired, nil)
	}
	if !utf8.ValidString(password) {
		return NewError(ErrCodePasswordInvalidChar, nil)
	}
	for _, r := range password {
		if r == 0 || r == '\n' || r == '\r' {
			return NewError(ErrCodePasswordInvalidChar, nil)
		}
		if policy.ForbiddenChars != "" && strings.ContainsRune(policy.ForbiddenChars, r) {
			return Errorf(ErrCodePasswordInvalidChar, "chars", policy.ForbiddenChars)
		}
	}
	return checkPasswordPolicy(password, username, policy)
}

func checkPasswordPolicy(password, username string, policy PasswordPolicy) error {
	length := utf8.RuneCountInString(password)
	if policy.MinLength > 0 && length < policy.MinLength {
		return Errorf(ErrCodePasswordPolicy, "rule", "min_length", "value", strconv.Itoa(policy.MinLength))
	}
	if policy.MaxLength > 0 && length > policy.MaxLength {
		return Errorf(ErrCodePasswordPolicy, "rule", "max_length", "value", strconv.Itoa(policy.MaxLength))
	}
	var upper, lower, digit, special bool
	for _, r := range password {
		switch {
		case unicode.IsUpper(r):
			upper = true
		case unicode.IsLower(r):
			lower = true
		case unicode.IsDigit(r):
			digit = true
		default:
			special = true
		}
	}
	if policy.RequireUpper && !upper {
		return Errorf(ErrCodePasswordPolicy, "rule", "upper")
	}
	if policy.RequireLower && !lower {
		return Errorf(ErrCodePasswordPolicy, "rule", "lower")
	}
	if policy.RequireDigit && !digit {
		return Errorf(ErrCodePasswordPolicy, "rule", "digit")
	}
	if policy.RequireSpecial && !special {
		return Errorf(ErrCodePasswordPolicy, "rule", "special")
	}
	if policy.MinCategories > 0 {
		categories := 0
		for _, present := range []bool{upper, lower, digit, special} {
			if present {
				categories++
			}
		}
		if categories < policy.MinCategories {
			return Errorf(ErrCodePasswordPolicy, "rule", "categories", "value", strconv.Itoa(policy.MinCategories))
		}
	}
	if policy.DisallowUsername && username != "" {
		lowered := strings.ToLower(password)
		name := strings.ToLower(username)
		if lowered == name || lowered == reverseString(name) {
			return Errorf(ErrCodePasswordPolicy, "rule", "username")
		}
	}
	return nil
}

func reverseString(text string) string {
	runes := []rune(text)
	for i, j := 0, len(runes)-1; i < j; i, j = i+1, j-1 {
		runes[i], runes[j] = runes[j], runes[i]
	}
	return string(runes)
}

// ValidateRequestShape 做与数据源无关的结构校验：动作、主体种类、选项 ID 与类型。
func ValidateRequestShape(profile ServerProfile, request ChangeRequest) error {
	if !profile.Supported {
		return NewError(ErrCodeUnsupported, nil)
	}
	if profile.ReadOnly {
		return NewError(ErrCodeReadOnly, nil)
	}
	switch request.Action {
	case ActionCreate, ActionAlter, ActionDrop:
	default:
		return Errorf(ErrCodeInvalidOption, "option", "action")
	}
	kind, ok := profile.Kind(request.Target.Kind)
	if !ok {
		return Errorf(ErrCodeKindNotSupported, "kind", string(request.Target.Kind))
	}
	if request.Action == ActionCreate && !kind.Creatable {
		return Errorf(ErrCodeKindNotSupported, "kind", string(request.Target.Kind))
	}
	if request.Rename != nil && !kind.Renamable {
		return NewError(ErrCodeRenameUnsupported, nil)
	}
	if strings.TrimSpace(request.Target.Name) == "" {
		return NewError(ErrCodeTargetMissing, nil)
	}
	for id, value := range request.Options {
		descriptor, found := profile.Option(id)
		if !found || !descriptorAppliesTo(descriptor, request.Target.Kind) {
			return Errorf(ErrCodeUnknownOption, "option", id)
		}
		if descriptor.ReadOnly || (descriptor.CreateOnly && request.Action != ActionCreate) {
			return Errorf(ErrCodeInvalidOption, "option", id)
		}
		if err := validateOptionValue(descriptor, value); err != nil {
			return err
		}
	}
	return nil
}

func descriptorAppliesTo(descriptor OptionDescriptor, kind PrincipalKind) bool {
	return len(descriptor.Kinds) == 0 || slices.Contains(descriptor.Kinds, kind)
}

func validateOptionValue(descriptor OptionDescriptor, value string) error {
	invalid := Errorf(ErrCodeInvalidOption, "option", descriptor.ID)
	if strings.ContainsRune(value, 0) {
		return invalid
	}
	switch descriptor.Type {
	case OptionBool:
		if value != "true" && value != "false" {
			return invalid
		}
	case OptionInt:
		if value == "" {
			return nil
		}
		number, err := strconv.Atoi(value)
		if err != nil {
			return invalid
		}
		if (descriptor.Min != 0 || descriptor.Max != 0) && (number < descriptor.Min || (descriptor.Max != 0 && number > descriptor.Max)) {
			return invalid
		}
	case OptionEnum:
		if value == "" && !descriptor.Required {
			return nil
		}
		if len(descriptor.Choices) > 0 && !choiceAllowed(descriptor.Choices, value) {
			return invalid
		}
	case OptionMulti:
		for _, item := range SplitList(value) {
			if len(descriptor.Choices) > 0 && !choiceAllowed(descriptor.Choices, item) {
				return invalid
			}
		}
	}
	return nil
}

func choiceAllowed(choices []Choice, value string) bool {
	for _, choice := range choices {
		if choice.Value == value && !choice.Disabled {
			return true
		}
	}
	return false
}

// SplitList 把换行分隔的 list/multi 取值拆分为非空项。
func SplitList(value string) []string {
	if strings.TrimSpace(value) == "" {
		return nil
	}
	lines := strings.Split(strings.ReplaceAll(value, "\r\n", "\n"), "\n")
	items := make([]string, 0, len(lines))
	for _, line := range lines {
		if trimmed := strings.TrimSpace(line); trimmed != "" {
			items = append(items, trimmed)
		}
	}
	return items
}

// JoinList 是 SplitList 的逆操作。
func JoinList(items []string) string {
	return strings.Join(items, "\n")
}

// OptionBoolValue 读取布尔选项；found 表示请求中包含该键。
func OptionBoolValue(options map[string]string, id string) (value bool, found bool) {
	raw, ok := options[id]
	if !ok {
		return false, false
	}
	return raw == "true", true
}

// OptionIntValue 读取整数选项；空值视为未设置。
func OptionIntValue(options map[string]string, id string) (value int, found bool) {
	raw, ok := options[id]
	if !ok || strings.TrimSpace(raw) == "" {
		return 0, false
	}
	number, err := strconv.Atoi(strings.TrimSpace(raw))
	if err != nil {
		return 0, false
	}
	return number, true
}
