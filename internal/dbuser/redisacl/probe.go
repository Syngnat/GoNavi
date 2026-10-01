// Package redisacl 实现 Redis（6.0+ ACL，含 Valkey / KeyDB）的用户管理。
// 命令以参数数组下发，不拼接命令文本；集群模式 ACL 只在单节点生效，写操作逐节点执行。
package redisacl

import (
	"context"
	"fmt"
	"sort"
	"strings"

	"GoNavi-Wails/internal/dbuser"
)

// 特性开关。
const (
	featChannels  = "channels"
	featSelectors = "selectors"
	featCluster   = "cluster"
)

// 方言开关：持久化方式（aclfile / config / none）。
const (
	dialectPersist   = "persist"
	persistACLFile   = "aclfile"
	persistConfig    = "config"
	persistNone      = "none"
	topologyCluster  = "cluster"
	topologySentinel = "sentinel"
)

// 提示码。
const (
	noticeNoACL          = "redis_no_acl"
	noticeClusterNodes   = "redis_cluster_each_node"
	noticeSentinel       = "redis_sentinel_master_only"
	noticeNotPersistent  = "redis_acl_not_persistent"
	noticePubSubDefault  = "redis_pubsub_default"
	noticePersistACLFile = "redis_acl_persist_file"
	noticePersistConfig  = "redis_acl_persist_config"
)

// Provider 是 Redis ACL 实现。
type Provider struct{}

var _ dbuser.Provider = (*Provider)(nil)

// New 返回 Redis ACL Provider。
func New() *Provider {
	return &Provider{}
}

// Family 实现 dbuser.Provider。
func (p *Provider) Family() dbuser.Family {
	return dbuser.FamilyRedis
}

// parseInfo 解析 INFO 文本为键值。
func parseInfo(text string) map[string]string {
	values := map[string]string{}
	for line := range strings.SplitSeq(strings.ReplaceAll(text, "\r\n", "\n"), "\n") {
		key, value, found := strings.Cut(strings.TrimSpace(line), ":")
		if found && !strings.HasPrefix(key, "#") {
			values[key] = strings.TrimSpace(value)
		}
	}
	return values
}

// Probe 实现 dbuser.Provider。
func (p *Provider) Probe(ctx context.Context, env dbuser.Env, _ dbuser.Target) (dbuser.ServerProfile, error) {
	raw, err := env.Commands.Do(ctx, []string{"INFO", "server"})
	if err != nil {
		return dbuser.ServerProfile{}, fmt.Errorf("probe redis info: %w", err)
	}
	info := parseInfo(dbuser.AsString(raw))
	version := dbuser.ParseDottedVersion(info["redis_version"])
	flavor, versionText := "redis", "Redis "+info["redis_version"]
	if valkey := info["valkey_version"]; valkey != "" {
		flavor, versionText = "valkey", "Valkey "+valkey
	}
	topology := env.Commands.Topology()
	profile := dbuser.ServerProfile{
		Supported:   true,
		Family:      dbuser.FamilyRedis,
		Flavor:      flavor,
		Version:     version,
		VersionText: versionText,
		Banner:      info["redis_version"],
		Topology:    topology,
		Features: map[string]bool{
			featChannels:  version.AtLeast(6, 2, 0),
			featSelectors: version.AtLeast(7, 0, 0),
			featCluster:   topology == topologyCluster,
		},
		Dialect: map[string]string{},
	}
	if !version.AtLeast(6, 0, 0) {
		reason := dbuser.Notef(noticeNoACL, dbuser.LevelWarning, "version", info["redis_version"])
		profile.Supported = false
		profile.UnsupportedReason = &reason
		return profile, nil
	}
	if who, err := env.Commands.Do(ctx, []string{"ACL", "WHOAMI"}); err == nil {
		profile.CurrentUser = dbuser.AsString(who)
	}
	profile.Dialect[dialectPersist] = probePersistence(ctx, env, info)
	profile.Kinds = []dbuser.KindDescriptor{{Kind: dbuser.KindUser, Creatable: true, IdentityFields: []string{"name"}, SupportsPassword: true}}
	profile.EditorTabs = []string{dbuser.TabGeneral, dbuser.TabRedisRules, dbuser.TabPreview}
	profile.Options = buildOptions(profile, probeCategories(ctx, env))
	profile.Permissions = dbuser.Permissions{CanList: true, CanCreate: true, CanAlter: true, CanDrop: true, CanGrant: true}
	profile.Notices = buildNotices(profile)
	return profile, nil
}

// probePersistence：配置了 aclfile 用 ACL SAVE；否则有配置文件时用 CONFIG REWRITE；都没有则无法持久化。
func probePersistence(ctx context.Context, env dbuser.Env, info map[string]string) string {
	raw, err := env.Commands.Do(ctx, []string{"CONFIG", "GET", "aclfile"})
	if err == nil && strings.TrimSpace(configValue(raw, "aclfile")) != "" {
		return persistACLFile
	}
	if strings.TrimSpace(info["config_file"]) != "" {
		return persistConfig
	}
	return persistNone
}

// configValue 兼容 RESP2 数组 [k, v] 与 RESP3 映射。
func configValue(raw any, key string) string {
	switch typed := raw.(type) {
	case map[string]any:
		return dbuser.AsString(typed[key])
	case []any:
		for index := 0; index+1 < len(typed); index += 2 {
			if strings.EqualFold(dbuser.AsString(typed[index]), key) {
				return dbuser.AsString(typed[index+1])
			}
		}
	}
	return ""
}

func probeCategories(ctx context.Context, env dbuser.Env) []string {
	raw, err := env.Commands.Do(ctx, []string{"ACL", "CAT"})
	if err != nil {
		return nil
	}
	items, _ := raw.([]any)
	categories := make([]string, 0, len(items))
	for _, item := range items {
		if name := dbuser.AsString(item); name != "" {
			categories = append(categories, name)
		}
	}
	sort.Strings(categories)
	return categories
}

func buildOptions(profile dbuser.ServerProfile, categories []string) []dbuser.OptionDescriptor {
	user := dbuser.KindUser
	rules := dbuser.TabRedisRules
	commandChoices := make([]dbuser.Choice, 0, len(categories)*2)
	for _, category := range categories {
		commandChoices = append(commandChoices, dbuser.Choice{Value: "+@" + category}, dbuser.Choice{Value: "-@" + category})
	}
	loginEnabled := dbuser.BoolOption(dbuser.OptLoginEnabled, dbuser.TabGeneral, user)
	loginEnabled.Default = "true"
	options := []dbuser.OptionDescriptor{
		loginEnabled,
		dbuser.BoolOption(dbuser.OptNoPass, dbuser.TabGeneral, user),
		{ID: dbuser.OptACLKeys, Type: dbuser.OptionList, Tab: rules, Kinds: []dbuser.PrincipalKind{user}},
		{ID: dbuser.OptACLCommands, Type: dbuser.OptionList, Tab: rules, Kinds: []dbuser.PrincipalKind{user}, Choices: commandChoices},
	}
	if profile.Feature(featChannels) {
		options = append(options, dbuser.OptionDescriptor{ID: dbuser.OptACLChannels, Type: dbuser.OptionList, Tab: rules, Kinds: []dbuser.PrincipalKind{user}})
	}
	if profile.Feature(featSelectors) {
		options = append(options, dbuser.OptionDescriptor{ID: dbuser.OptACLSelectors, Type: dbuser.OptionList, Tab: rules, Kinds: []dbuser.PrincipalKind{user}})
	}
	if profile.Dialect[dialectPersist] != persistNone {
		persist := dbuser.BoolOption(dbuser.OptACLPersist, dbuser.TabGeneral, user)
		persist.Default = "true"
		options = append(options, persist)
	}
	return options
}

func buildNotices(profile dbuser.ServerProfile) []dbuser.Notice {
	var notices []dbuser.Notice
	switch profile.Topology {
	case topologyCluster:
		notices = append(notices, dbuser.Notef(noticeClusterNodes, dbuser.LevelWarning))
	case topologySentinel:
		notices = append(notices, dbuser.Notef(noticeSentinel, dbuser.LevelWarning))
	}
	switch profile.Dialect[dialectPersist] {
	case persistACLFile:
		notices = append(notices, dbuser.Notef(noticePersistACLFile, dbuser.LevelInfo))
	case persistConfig:
		notices = append(notices, dbuser.Notef(noticePersistConfig, dbuser.LevelInfo))
	default:
		notices = append(notices, dbuser.Notef(noticeNotPersistent, dbuser.LevelWarning))
	}
	if profile.Feature(featSelectors) {
		notices = append(notices, dbuser.Notef(noticePubSubDefault, dbuser.LevelInfo))
	}
	return notices
}
