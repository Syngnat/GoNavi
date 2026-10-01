// Package oracle 实现 Oracle（11g–23ai，含 CDB/PDB 与 OceanBase Oracle 租户）与达梦（DM7/DM8）的账号管理。
// 两者视图（DBA_USERS / DBA_ROLE_PRIVS / DBA_TAB_PRIVS）与授权语法基本一致，差异由 variant 控制。
package oracle

import (
	"context"
	"fmt"
	"regexp"
	"strings"

	"GoNavi-Wails/internal/dbuser"
)

type variant int

const (
	variantOracle variant = iota
	variantDameng
)

// 特性开关。
const (
	featNoAuthentication = "noAuthentication"
	featCommonUsers      = "commonUsers"
	featDBAViews         = "dbaViews"
	featDefaultRoles     = "defaultRoles"
	featQuota            = "quota"
	featProfiles         = "profiles"
)

// 方言开关（参与指纹）。
const (
	dialectCommonPrefix = "commonPrefix"
	dialectContainer    = "container"
)

// 提示码。
const (
	noticeCDBRoot         = "oracle_cdb_root"
	noticePDB             = "oracle_pdb"
	noticeNoDBAViews      = "oracle_no_dba_views"
	noticeLogonVersion    = "oracle_logon_version"
	noticeDamengSeparated = "dameng_separation_of_duty"
	noticeExperimental    = "experimental_flavor"
)

// Provider 是 Oracle / 达梦实现。
type Provider struct {
	variant variant
}

var _ dbuser.Provider = (*Provider)(nil)

// New 返回 Oracle Provider（含 OceanBase Oracle 租户）。
func New() *Provider {
	return &Provider{variant: variantOracle}
}

// NewDameng 返回达梦 Provider。
func NewDameng() *Provider {
	return &Provider{variant: variantDameng}
}

// Family 实现 dbuser.Provider。
func (p *Provider) Family() dbuser.Family {
	if p.variant == variantDameng {
		return dbuser.FamilyDameng
	}
	return dbuser.FamilyOracle
}

var damengVersionPattern = regexp.MustCompile(`(?i)\bV(\d+)`)

// Probe 实现 dbuser.Provider。
func (p *Provider) Probe(ctx context.Context, env dbuser.Env, target dbuser.Target) (dbuser.ServerProfile, error) {
	banner := firstString(ctx, env, "SELECT BANNER FROM V$VERSION", "BANNER")
	current := firstString(ctx, env, "SELECT USER AS CURRENT_USER_NAME FROM DUAL", "CURRENT_USER_NAME")
	if current == "" {
		return dbuser.ServerProfile{}, fmt.Errorf("probe oracle: cannot read current user")
	}
	profile := dbuser.ServerProfile{
		Supported:   true,
		Family:      p.Family(),
		Flavor:      "oracle",
		Banner:      banner,
		VersionText: strings.TrimSpace(strings.Split(banner, " - ")[0]),
		CurrentUser: current,
		Dialect:     map[string]string{},
		Features:    map[string]bool{"grantOption": true, "adminOption": true},
	}
	switch {
	case p.variant == variantDameng:
		profile.Flavor = "dameng"
		if match := damengVersionPattern.FindStringSubmatch(banner); match != nil {
			profile.Version = dbuser.Version{Major: atoi(match[1]), Raw: banner}
		}
	case target.OceanBaseOracle || strings.Contains(strings.ToLower(banner), "oceanbase"):
		profile.Flavor = "oceanbase-oracle"
		profile.Experimental = true
		profile.Version = dbuser.ParseDottedVersion(banner)
	default:
		profile.Version = dbuser.ParseDottedVersionAfter(banner, "Release ")
	}
	p.probeFeatures(ctx, env, &profile)
	profile.Permissions = probePermissions(ctx, env)
	tablespaces, temporary := probeTablespaces(ctx, env, profile)
	profile.Kinds = []dbuser.KindDescriptor{
		{Kind: dbuser.KindUser, Creatable: true, IdentityFields: []string{"name"}, SupportsPassword: true},
		{Kind: dbuser.KindRole, Creatable: true, IdentityFields: []string{"name"}},
	}
	profile.EditorTabs = []string{dbuser.TabGeneral, dbuser.TabServerPrivileges, dbuser.TabObjectPrivileges, dbuser.TabMembership, dbuser.TabPreview}
	profile.ObjectScopes = []string{dbuser.ScopeTable, dbuser.ScopeColumn, dbuser.ScopeSequence, dbuser.ScopeRoutine}
	profile.Privileges = probePrivileges(ctx, env, p.variant)
	profile.Options = p.buildOptions(profile, tablespaces, temporary, probeProfiles(ctx, env, profile))
	if p.variant == variantDameng {
		profile.PasswordPolicy = probeDamengPolicy(ctx, env)
	}
	profile.Notices = p.buildNotices(profile)
	return profile, nil
}

func (p *Provider) probeFeatures(ctx context.Context, env dbuser.Env, profile *dbuser.ServerProfile) {
	oracle := p.variant == variantOracle && profile.Flavor == "oracle"
	profile.Features[featNoAuthentication] = oracle && profile.Version.AtLeast(18, 0, 0)
	profile.Features[featDefaultRoles] = p.variant == variantOracle
	profile.Features[featQuota] = p.variant == variantOracle
	_, dbaErr := env.SQL.Query(ctx, "", "SELECT USERNAME FROM DBA_USERS WHERE ROWNUM = 1")
	profile.Features[featDBAViews] = dbaErr == nil
	profile.ReadOnly = dbaErr != nil
	if !oracle || !profile.Version.AtLeast(12, 0, 0) {
		return
	}
	container := firstString(ctx, env, "SELECT SYS_CONTEXT('USERENV', 'CON_NAME') AS CON_NAME FROM DUAL", "CON_NAME")
	profile.Dialect[dialectContainer] = container
	if strings.EqualFold(container, "CDB$ROOT") {
		profile.Features[featCommonUsers] = true
		prefix := firstString(ctx, env, "SELECT VALUE FROM V$PARAMETER WHERE NAME = 'common_user_prefix'", "VALUE")
		if prefix == "" {
			prefix = "C##"
		}
		profile.Dialect[dialectCommonPrefix] = prefix
	}
}

func firstString(ctx context.Context, env dbuser.Env, query, column string) string {
	rows, err := env.SQL.Query(ctx, "", query)
	if err != nil || len(rows) == 0 {
		return ""
	}
	return strings.TrimSpace(dbuser.CellString(rows[0], column))
}

func atoi(text string) int {
	value, _ := dbuser.AsInt(text)
	return int(value)
}

func probePermissions(ctx context.Context, env dbuser.Env) dbuser.Permissions {
	rows, err := env.SQL.Query(ctx, "", "SELECT PRIVILEGE FROM SESSION_PRIVS")
	if err != nil || len(rows) == 0 {
		return dbuser.Permissions{CanList: true, CanCreate: true, CanAlter: true, CanDrop: true, CanGrant: true}
	}
	privileges := map[string]bool{}
	for _, row := range rows {
		privileges[strings.ToUpper(dbuser.CellString(row, "PRIVILEGE"))] = true
	}
	return dbuser.Permissions{
		CanList:   true,
		CanCreate: privileges["CREATE USER"],
		CanAlter:  privileges["ALTER USER"],
		CanDrop:   privileges["DROP USER"],
		CanGrant:  privileges["GRANT ANY PRIVILEGE"] || privileges["GRANT ANY ROLE"] || privileges["GRANT ANY OBJECT PRIVILEGE"],
	}
}

// probeTablespaces 返回永久表空间与临时表空间清单（用于下拉）。
func probeTablespaces(ctx context.Context, env dbuser.Env, profile dbuser.ServerProfile) ([]string, []string) {
	if !profile.Feature(featDBAViews) {
		return nil, nil
	}
	rows, err := env.SQL.Query(ctx, "", "SELECT TABLESPACE_NAME, CONTENTS FROM DBA_TABLESPACES ORDER BY TABLESPACE_NAME")
	if err != nil {
		return nil, nil
	}
	var permanent, temporary []string
	for _, row := range rows {
		name := dbuser.CellString(row, "TABLESPACE_NAME")
		if strings.EqualFold(dbuser.CellString(row, "CONTENTS"), "TEMPORARY") {
			temporary = append(temporary, name)
		} else if !strings.EqualFold(dbuser.CellString(row, "CONTENTS"), "UNDO") {
			permanent = append(permanent, name)
		}
	}
	return permanent, temporary
}

func probeProfiles(ctx context.Context, env dbuser.Env, profile dbuser.ServerProfile) []string {
	if !profile.Feature(featDBAViews) || profile.Flavor != "oracle" {
		return nil
	}
	rows, err := env.SQL.Query(ctx, "", "SELECT DISTINCT PROFILE FROM DBA_PROFILES ORDER BY PROFILE")
	if err != nil {
		return nil
	}
	profiles := make([]string, 0, len(rows))
	for _, row := range rows {
		profiles = append(profiles, dbuser.CellString(row, "PROFILE"))
	}
	return profiles
}

// probeDamengPolicy 解析 PWD_POLICY 位标志：1 禁止与用户名相同，2 长度不少于 PWD_MIN_LEN，
// 4 需大写，8 需数字，16 需标点符号。
func probeDamengPolicy(ctx context.Context, env dbuser.Env) dbuser.PasswordPolicy {
	rows, err := env.SQL.Query(ctx, "", "SELECT PARA_NAME, PARA_VALUE FROM V$DM_INI WHERE PARA_NAME IN ('PWD_POLICY', 'PWD_MIN_LEN')")
	if err != nil || len(rows) == 0 {
		return dbuser.PasswordPolicy{MinLength: 9, Source: "dameng-default"}
	}
	values := map[string]int{}
	for _, row := range rows {
		values[strings.ToUpper(dbuser.CellString(row, "PARA_NAME"))] = atoi(dbuser.CellString(row, "PARA_VALUE"))
	}
	bits := values["PWD_POLICY"]
	policy := dbuser.PasswordPolicy{
		DisallowUsername: bits&1 != 0,
		RequireUpper:     bits&4 != 0,
		RequireDigit:     bits&8 != 0,
		RequireSpecial:   bits&16 != 0,
		ForbiddenChars:   `"`,
		Source:           "PWD_POLICY",
	}
	if bits&2 != 0 {
		policy.MinLength = values["PWD_MIN_LEN"]
	}
	return policy
}

func (p *Provider) buildNotices(profile dbuser.ServerProfile) []dbuser.Notice {
	var notices []dbuser.Notice
	if profile.Experimental {
		notices = append(notices, dbuser.Notef(noticeExperimental, dbuser.LevelWarning, "flavor", profile.Flavor))
	}
	if !profile.Feature(featDBAViews) {
		notices = append(notices, dbuser.Notef(noticeNoDBAViews, dbuser.LevelWarning))
	}
	if profile.Feature(featCommonUsers) {
		notices = append(notices, dbuser.Notef(noticeCDBRoot, dbuser.LevelWarning, "prefix", profile.Dialect[dialectCommonPrefix]))
	} else if container := profile.Dialect[dialectContainer]; container != "" {
		notices = append(notices, dbuser.Notef(noticePDB, dbuser.LevelInfo, "container", container))
	}
	if p.variant == variantOracle && profile.Version.AtLeast(12, 2, 0) {
		notices = append(notices, dbuser.Notef(noticeLogonVersion, dbuser.LevelInfo))
	}
	if p.variant == variantDameng {
		notices = append(notices, dbuser.Notef(noticeDamengSeparated, dbuser.LevelInfo))
	}
	return notices
}
