package mysql

import "GoNavi-Wails/internal/dbuser"

// 口令过期策略取值。
const (
	expireDefault  = "default"
	expireNever    = "never"
	expireInterval = "interval"
)

// REQUIRE 取值。specified 表示已有 CIPHER/ISSUER/SUBJECT 细项，只读展示。
const (
	sslNone      = "none"
	sslAny       = "ssl"
	sslX509      = "x509"
	sslSpecified = "specified"
)

// PASSWORD REQUIRE CURRENT 取值。
const (
	requireCurrentDefault  = "default"
	requireCurrentOptional = "optional"
	requireCurrentRequired = "required"
)

// buildOptions 按特性开关给出该版本可编辑的字段。
func buildOptions(profile dbuser.ServerProfile, plugins []string, defaultPlugin string) []dbuser.OptionDescriptor {
	user := dbuser.KindUser
	options := make([]dbuser.OptionDescriptor, 0, 24)
	if profile.Feature(featPluginChoice) || profile.Feature(featMariaDBVia) {
		choices := make([]dbuser.Choice, 0, len(plugins))
		for _, plugin := range plugins {
			choice := dbuser.Choice{Value: plugin}
			if plugin == "sha256_password" {
				choice.Deprecated = true
			}
			if plugin == "caching_sha2_password" {
				choice.NoticeCode = noticeCachingSha2Clients
			}
			choices = append(choices, choice)
		}
		option := dbuser.EnumOption(dbuser.OptAuthPlugin, dbuser.TabGeneral, choices, user)
		option.Default = defaultPlugin
		options = append(options, option)
	}
	if profile.Feature(featAccountLock) {
		options = append(options, dbuser.BoolOption(dbuser.OptAccountLocked, dbuser.TabGeneral, user))
	}
	if profile.Feature(featComment) {
		options = append(options, dbuser.StringOption(dbuser.OptComment, dbuser.TabGeneral, user))
	}
	if profile.Feature(featExpireNow) {
		options = append(options, dbuser.BoolOption(dbuser.OptExpirePasswordNow, dbuser.TabAdvanced, user))
	}
	if profile.Feature(featPasswordExpire) {
		options = append(options,
			dbuser.EnumOption(dbuser.OptPasswordExpirePolicy, dbuser.TabAdvanced, dbuser.Choices(expireDefault, expireNever, expireInterval), user),
			dbuser.IntOption(dbuser.OptPasswordLifetimeDays, dbuser.TabAdvanced, 1, 65535, user),
		)
	}
	if profile.Feature(featPasswordHistory) {
		options = append(options,
			dbuser.IntOption(dbuser.OptPasswordHistory, dbuser.TabAdvanced, 0, 4294967295, user),
			dbuser.IntOption(dbuser.OptPasswordReuseDays, dbuser.TabAdvanced, 0, 4294967295, user),
		)
	}
	if profile.Feature(featRequireCurrent) {
		options = append(options, dbuser.EnumOption(dbuser.OptPasswordRequireCurrent, dbuser.TabAdvanced,
			dbuser.Choices(requireCurrentDefault, requireCurrentOptional, requireCurrentRequired), user))
	}
	if profile.Feature(featFailedLogin) {
		options = append(options,
			dbuser.IntOption(dbuser.OptFailedLoginAttempts, dbuser.TabAdvanced, 0, 32767, user),
			// -1 表示 UNBOUNDED（锁定直到手动解锁）。
			dbuser.IntOption(dbuser.OptPasswordLockDays, dbuser.TabAdvanced, -1, 32767, user),
		)
	}
	if profile.Feature(featResourceLimits) {
		options = append(options,
			dbuser.IntOption(dbuser.OptMaxQueriesPerHour, dbuser.TabAdvanced, 0, 4294967295, user),
			dbuser.IntOption(dbuser.OptMaxUpdatesPerHour, dbuser.TabAdvanced, 0, 4294967295, user),
			dbuser.IntOption(dbuser.OptMaxConnectionsPerHour, dbuser.TabAdvanced, 0, 4294967295, user),
			dbuser.IntOption(dbuser.OptMaxUserConnections, dbuser.TabAdvanced, 0, 4294967295, user),
		)
	}
	if profile.Feature(featRequireSSL) {
		choices := dbuser.Choices(sslNone, sslAny, sslX509)
		choices = append(choices, dbuser.Choice{Value: sslSpecified, Disabled: true})
		options = append(options, dbuser.EnumOption(dbuser.OptRequireSSL, dbuser.TabAdvanced, choices, user))
	}
	if profile.Feature(featDefaultRoles) {
		options = append(options, dbuser.OptionDescriptor{
			ID: dbuser.OptDefaultRoles, Type: dbuser.OptionMulti, Tab: dbuser.TabMembership, Kinds: []dbuser.PrincipalKind{user},
		})
	}
	return options
}
