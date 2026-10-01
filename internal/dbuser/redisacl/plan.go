package redisacl

import (
	"strings"
	"unicode"

	"GoNavi-Wails/internal/dbuser"
)

// validateUserName：ACL 用户名不能含空白与控制字符（否则 ACL LIST 无法可靠回读）。
func validateUserName(name string) error {
	if err := dbuser.ValidateName(name, dbuser.NameRule{MaxLength: 256}); err != nil {
		return err
	}
	for _, r := range name {
		if unicode.IsSpace(r) {
			return dbuser.Errorf(dbuser.ErrCodeInvalidName, "name", name)
		}
	}
	return nil
}

// Plan 实现 dbuser.Provider。规则按类别整体替换：resetkeys / resetchannels / -@all / clearselectors
// 之后再写入目标规则；不使用整体 reset，以免清掉未修改的口令哈希。
func (p *Provider) Plan(profile dbuser.ServerProfile, request dbuser.ChangeRequest) (dbuser.Plan, error) {
	name := request.Target.Name
	if err := validateUserName(name); err != nil {
		return dbuser.Plan{}, err
	}
	if request.Rename != nil && request.Rename.Name != name {
		return dbuser.Plan{}, dbuser.NewError(dbuser.ErrCodeRenameUnsupported, nil)
	}
	eachNode := profile.Feature(featCluster)
	if request.Action == dbuser.ActionDrop {
		if name == "default" {
			return dbuser.Plan{}, dbuser.Errorf(dbuser.ErrCodeReservedAccount, "name", name)
		}
		statements := []dbuser.Statement{argsStatement([]string{"ACL", "DELUSER", name}, nil, eachNode, dbuser.RiskDanger)}
		return dbuser.Plan{Statements: append(statements, persistStatements(profile, request.Options, eachNode)...)}, nil
	}
	args, secrets, err := p.setUserArgs(profile, request)
	if err != nil {
		return dbuser.Plan{}, err
	}
	var statements []dbuser.Statement
	if len(args) > 3 || request.Action == dbuser.ActionCreate {
		risk := dbuser.RiskNormal
		if request.Action == dbuser.ActionAlter {
			risk = dbuser.RiskHigh
		}
		statements = append(statements, argsStatement(args, secrets, eachNode, risk))
	}
	if len(statements) > 0 {
		statements = append(statements, persistStatements(profile, request.Options, eachNode)...)
	}
	return dbuser.Plan{Statements: statements}, nil
}

// setUserArgs 生成 ACL SETUSER 参数；secrets 标记口令参数下标用于展示掩码。
func (p *Provider) setUserArgs(profile dbuser.ServerProfile, request dbuser.ChangeRequest) ([]string, map[int]bool, error) {
	options := request.Options
	args := []string{"ACL", "SETUSER", request.Target.Name}
	secrets := map[int]bool{}
	creating := request.Action == dbuser.ActionCreate
	if enabled, ok := dbuser.OptionBoolValue(options, dbuser.OptLoginEnabled); ok {
		if enabled {
			args = append(args, "on")
		} else {
			args = append(args, "off")
		}
	}
	noPass, noPassSet := dbuser.OptionBoolValue(options, dbuser.OptNoPass)
	change := request.Password
	switch {
	case noPassSet && noPass, change != nil && change.Remove:
		args = append(args, "nopass")
	case change != nil && change.Set:
		if change.Password != "" {
			if err := dbuser.ValidatePassword(change.Password, request.Target.Name, profile.PasswordPolicy); err != nil {
				return nil, nil, err
			}
		}
		if !change.RetainCurrent || (noPassSet && !noPass) {
			args = append(args, "resetpass")
		}
		secrets[len(args)] = true
		args = append(args, ">"+change.Password)
	case creating:
		return nil, nil, dbuser.NewError(dbuser.ErrCodePasswordRequired, nil)
	case noPassSet && !noPass:
		// 关闭 nopass 且未设新口令：清空口令，用户在设置口令前无法认证。
		args = append(args, "resetpass")
	}
	groups := []struct {
		id      string
		reset   string
		pattern func([]string) error
	}{
		{dbuser.OptACLKeys, "resetkeys", func(items []string) error { return validateRules(items, keyRulePattern, dbuser.OptACLKeys) }},
		{dbuser.OptACLChannels, "resetchannels", func(items []string) error { return validateRules(items, channelRulePattern, dbuser.OptACLChannels) }},
		{dbuser.OptACLCommands, "-@all", func(items []string) error { return validateRules(items, commandRulePattern, dbuser.OptACLCommands) }},
		{dbuser.OptACLSelectors, "clearselectors", validateSelectors},
	}
	for _, group := range groups {
		raw, ok := options[group.id]
		if !ok {
			continue
		}
		items := dbuser.SplitList(raw)
		if err := group.pattern(items); err != nil {
			return nil, nil, err
		}
		args = append(args, group.reset)
		args = append(args, items...)
	}
	return args, secrets, nil
}

func argsStatement(args []string, secrets map[int]bool, eachNode bool, risk string) dbuser.Statement {
	display := make([]string, len(args))
	for index, arg := range args {
		switch {
		case secrets[index]:
			display[index] = ">" + dbuser.MaskedSecret
		case strings.ContainsAny(arg, " \t"):
			display[index] = `"` + arg + `"`
		default:
			display[index] = arg
		}
	}
	return dbuser.Statement{Args: args, Display: strings.Join(display, " "), Risk: risk, EachNode: eachNode}
}

// persistStatements 追加可选的持久化命令；失败只提示，不回滚已生效的 ACL。
func persistStatements(profile dbuser.ServerProfile, options map[string]string, eachNode bool) []dbuser.Statement {
	persist, ok := dbuser.OptionBoolValue(options, dbuser.OptACLPersist)
	if ok && !persist {
		return nil
	}
	if _, available := profile.Option(dbuser.OptACLPersist); !available {
		return nil
	}
	args := []string{"CONFIG", "REWRITE"}
	if profile.Dialect[dialectPersist] == persistACLFile {
		args = []string{"ACL", "SAVE"}
	}
	statement := argsStatement(args, nil, eachNode, dbuser.RiskNormal)
	statement.Optional = true
	return []dbuser.Statement{statement}
}
