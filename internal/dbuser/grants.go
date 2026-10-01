package dbuser

import (
	"regexp"
	"slices"
	"strings"
)

// privilegeNamePattern 是权限名的兜底字符白名单。权限名会不加引号地拼入
// GRANT/REVOKE，因此除了必须存在于探测到的权限目录外，还要满足此模式。
var privilegeNamePattern = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_ ]{0,63}$`)

// GrantGroup 是可以合并进一条 GRANT/REVOKE 的授权集合（同一目标、同一选项）。
type GrantGroup struct {
	Target          Grant
	Privileges      []string
	WithGrantOption bool
	Deny            bool
}

// GrantTargetKey 返回授权目标的键（不含权限名与选项）。
func GrantTargetKey(grant Grant) string {
	return strings.Join([]string{
		grant.Scope, grant.Database, grant.Schema, grant.Object, grant.Column, strings.ToUpper(grant.ObjectType), grant.Node,
	}, "\x1f")
}

// GrantKey 返回授权的完整键，用于前端/后端 diff。
func GrantKey(grant Grant) string {
	return GrantTargetKey(grant) + "\x1f" + strings.ToUpper(grant.Privilege)
}

// GroupGrants 把同目标、同选项的授权合并，保持首次出现的顺序以获得稳定输出。
func GroupGrants(grants []Grant) []GrantGroup {
	groups := make([]GrantGroup, 0, len(grants))
	index := make(map[string]int, len(grants))
	for _, grant := range grants {
		key := GrantTargetKey(grant)
		if grant.WithGrantOption {
			key += "\x1fwgo"
		}
		if grant.Deny {
			key += "\x1fdeny"
		}
		position, ok := index[key]
		if !ok {
			target := grant
			target.Privilege = ""
			groups = append(groups, GrantGroup{Target: target, WithGrantOption: grant.WithGrantOption, Deny: grant.Deny})
			position = len(groups) - 1
			index[key] = position
		}
		privilege := NormalizePrivilegeName(grant.Privilege)
		if !slices.Contains(groups[position].Privileges, privilege) {
			groups[position].Privileges = append(groups[position].Privileges, privilege)
		}
	}
	return groups
}

// NormalizePrivilegeName 统一权限名大小写与空白。
func NormalizePrivilegeName(name string) string {
	return strings.Join(strings.Fields(strings.ToUpper(name)), " ")
}

// ValidateGrants 校验授权：权限名存在于目录且作用域允许、字符白名单、对象名非空。
// 在 GrantsRevoke 中 WithGrantOption=true 表示“仅撤销授予权”。
func ValidateGrants(profile ServerProfile, grants []Grant) error {
	for _, grant := range grants {
		privilege := NormalizePrivilegeName(grant.Privilege)
		if !privilegeNamePattern.MatchString(privilege) {
			return Errorf(ErrCodeInvalidPrivilege, "privilege", grant.Privilege)
		}
		descriptor, ok := findPrivilege(profile.Privileges, privilege)
		if !ok || !slices.Contains(descriptor.Scopes, grant.Scope) {
			return Errorf(ErrCodeInvalidPrivilege, "privilege", grant.Privilege, "scope", grant.Scope)
		}
		if err := validateGrantTarget(grant); err != nil {
			return err
		}
	}
	return nil
}

func findPrivilege(catalog []PrivilegeDescriptor, name string) (PrivilegeDescriptor, bool) {
	for _, descriptor := range catalog {
		if NormalizePrivilegeName(descriptor.Name) == name {
			return descriptor, true
		}
	}
	return PrivilegeDescriptor{}, false
}

func validateGrantTarget(grant Grant) error {
	invalid := Errorf(ErrCodeInvalidObject, "scope", grant.Scope)
	for _, part := range []string{grant.Database, grant.Schema, grant.Object, grant.Column, grant.ObjectType} {
		if strings.ContainsRune(part, 0) {
			return invalid
		}
	}
	switch grant.Scope {
	case ScopeGlobal:
		return nil
	case ScopeDatabase:
		if grant.Database == "" {
			return invalid
		}
	case ScopeSchema:
		if grant.Schema == "" {
			return invalid
		}
	case ScopeTable, ScopeRoutine, ScopeSequence:
		if grant.Object == "" {
			return invalid
		}
	case ScopeColumn:
		if grant.Object == "" || grant.Column == "" {
			return invalid
		}
	default:
		return invalid
	}
	return nil
}

// PrivilegeList 以 ", " 连接权限名。
func PrivilegeList(privileges []string) string {
	return strings.Join(privileges, ", ")
}
