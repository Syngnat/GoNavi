package redisacl

import (
	"context"
	"fmt"
	"slices"
	"sort"
	"strconv"
	"strings"

	"GoNavi-Wails/internal/dbuser"
)

// aclLines 读取 ACL LIST；集群模式合并各节点结果并返回存在差异的用户。
func aclLines(ctx context.Context, env dbuser.Env, profile dbuser.ServerProfile) (map[string]string, map[string]bool, error) {
	lines := map[string]string{}
	drift := map[string]bool{}
	if !profile.Feature(featCluster) {
		raw, err := env.Commands.Do(ctx, []string{"ACL", "LIST"})
		if err != nil {
			return nil, nil, err
		}
		for _, line := range stringList(raw) {
			if rules, ok := parseACLLine(line); ok {
				lines[rules.name] = line
			}
		}
		return lines, drift, nil
	}
	nodes, err := env.Commands.DoEachNode(ctx, []string{"ACL", "LIST"})
	if err != nil {
		return nil, nil, err
	}
	perNode := make([]map[string]string, 0, len(nodes))
	for _, node := range nodes {
		if node.Err != nil {
			continue
		}
		current := map[string]string{}
		for _, line := range stringList(node.Result) {
			if rules, ok := parseACLLine(line); ok {
				current[rules.name] = line
				if _, seen := lines[rules.name]; !seen {
					lines[rules.name] = line
				}
			}
		}
		perNode = append(perNode, current)
	}
	for name, line := range lines {
		for _, node := range perNode {
			if node[name] != line {
				drift[name] = true
			}
		}
	}
	return lines, drift, nil
}

func stringList(raw any) []string {
	items, _ := raw.([]any)
	out := make([]string, 0, len(items))
	for _, item := range items {
		out = append(out, dbuser.AsString(item))
	}
	return out
}

// List 实现 dbuser.Provider。
func (p *Provider) List(ctx context.Context, env dbuser.Env, profile dbuser.ServerProfile, _ dbuser.ListQuery) ([]dbuser.Principal, error) {
	lines, drift, err := aclLines(ctx, env, profile)
	if err != nil {
		return nil, fmt.Errorf("list redis acl users: %w", err)
	}
	names := make([]string, 0, len(lines))
	for name := range lines {
		names = append(names, name)
	}
	sort.Strings(names)
	principals := make([]dbuser.Principal, 0, len(names))
	for _, name := range names {
		rules, _ := parseACLLine(lines[name])
		principal := dbuser.Principal{
			Ref:       dbuser.PrincipalRef{Kind: dbuser.KindUser, Name: name},
			Locked:    !rules.enabled,
			CanLogin:  rules.enabled,
			Superuser: slices.Contains(rules.commands, "+@all") && slices.Contains(rules.keys, "~*"),
			Current:   name == profile.CurrentUser,
		}
		if drift[name] {
			principal.Tags = append(principal.Tags, "drift")
		}
		if rules.noPass {
			principal.Tags = append(principal.Tags, "nopass")
		}
		principals = append(principals, principal)
	}
	return principals, nil
}

// Describe 实现 dbuser.Provider。
func (p *Provider) Describe(ctx context.Context, env dbuser.Env, profile dbuser.ServerProfile, query dbuser.DescribeQuery) (dbuser.PrincipalDetail, error) {
	lines, drift, err := aclLines(ctx, env, profile)
	if err != nil {
		return dbuser.PrincipalDetail{}, fmt.Errorf("describe redis acl user: %w", err)
	}
	line, ok := lines[query.Ref.Name]
	if !ok {
		return dbuser.PrincipalDetail{}, dbuser.NewError(dbuser.ErrCodeTargetMissing, nil)
	}
	rules, _ := parseACLLine(line)
	detail := dbuser.PrincipalDetail{
		Principal: dbuser.Principal{Ref: query.Ref, Locked: !rules.enabled, CanLogin: rules.enabled, Current: query.Ref.Name == profile.CurrentUser},
		Options: map[string]string{
			dbuser.OptLoginEnabled: strconv.FormatBool(rules.enabled),
			dbuser.OptNoPass:       strconv.FormatBool(rules.noPass),
			dbuser.OptACLKeys:      dbuser.JoinList(rules.keys),
			dbuser.OptACLCommands:  dbuser.JoinList(rules.commands),
		},
	}
	if profile.Feature(featChannels) {
		detail.Options[dbuser.OptACLChannels] = dbuser.JoinList(rules.channels)
	}
	if profile.Feature(featSelectors) {
		detail.Options[dbuser.OptACLSelectors] = dbuser.JoinList(rules.selectors)
	}
	if _, ok := profile.Option(dbuser.OptACLPersist); ok {
		detail.Options[dbuser.OptACLPersist] = "true"
	}
	if drift[query.Ref.Name] {
		detail.Principal.Tags = append(detail.Principal.Tags, "drift")
		detail.Notices = append(detail.Notices, dbuser.Notef("redis_acl_drift", dbuser.LevelWarning))
	}
	if rules.passwords > 1 {
		detail.Notices = append(detail.Notices, dbuser.Notef("redis_multiple_passwords", dbuser.LevelInfo, "count", strconv.Itoa(rules.passwords)))
	}
	return detail, nil
}

// Impact 统计该用户当前的客户端连接。
func (p *Provider) Impact(ctx context.Context, env dbuser.Env, _ dbuser.ServerProfile, ref dbuser.PrincipalRef) (dbuser.DropImpact, error) {
	impact := dbuser.DropImpact{}
	raw, err := env.Commands.Do(ctx, []string{"CLIENT", "LIST"})
	if err != nil {
		return impact, nil
	}
	count := 0
	for line := range strings.SplitSeq(dbuser.AsString(raw), "\n") {
		for field := range strings.FieldsSeq(line) {
			if field == "user="+ref.Name {
				count++
			}
		}
	}
	if count > 0 {
		impact.Items = append(impact.Items, dbuser.ImpactItem{Code: "active_sessions", Count: count})
	}
	return impact, nil
}

// ExportDDL 输出 ACL LIST 行（口令哈希替换为掩码），可直接用于 aclfile。
func (p *Provider) ExportDDL(ctx context.Context, env dbuser.Env, profile dbuser.ServerProfile, ref dbuser.PrincipalRef) (string, error) {
	lines, _, err := aclLines(ctx, env, profile)
	if err != nil {
		return "", err
	}
	line, ok := lines[ref.Name]
	if !ok {
		return "", dbuser.NewError(dbuser.ErrCodeTargetMissing, nil)
	}
	tokens := tokenizeACL(line)
	for index, token := range tokens {
		if strings.HasPrefix(token, "#") {
			tokens[index] = "#" + dbuser.MaskedSecret
		}
	}
	return strings.Join(tokens, " "), nil
}
