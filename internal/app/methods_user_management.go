package app

import (
	"context"
	"strings"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/dbuser"
	"GoNavi-Wails/internal/dbuser/providers"
	"GoNavi-Wails/internal/logger"
)

const (
	// userMgmtRequestTimeout 是单次账号管理请求的硬上限，防止探测/执行被慢库拖住；
	// 取 45s 以落在 Web 模式 1 分钟 HTTP WriteTimeout 之内。
	userMgmtRequestTimeout   = 45 * time.Second
	userMgmtAuditSource      = "user_management"
	userMgmtProtectionAction = "connection.backend.action.user_management"
)

// UserMgmtOverview 是工作台首屏数据：探测结果与主体列表。
type UserMgmtOverview struct {
	Profile    dbuser.ServerProfile `json:"profile"`
	Principals []dbuser.Principal   `json:"principals"`
}

type userMgmtCall struct {
	provider dbuser.Provider
	target   dbuser.Target
	env      dbuser.Env
	sql      *userMgmtSQLExecutor
	ctx      context.Context
	cancel   context.CancelFunc
}

// beginUserMgmtCall 校验能力并装配 Provider 与执行环境。
// 自定义连接一律拒绝：其方言由用户驱动决定，无法保证账号语句正确。
func (a *App) beginUserMgmtCall(config connection.ConnectionConfig) (*userMgmtCall, error) {
	if strings.EqualFold(strings.TrimSpace(config.Type), "custom") || !a.DataSourceCapability(config).UI.UserManagement {
		return nil, dbuser.NewError(dbuser.ErrCodeUnsupported, nil)
	}
	target := buildUserManagementTarget(config)
	provider, ok := providers.Resolve(target)
	if !ok {
		return nil, dbuser.NewError(dbuser.ErrCodeUnsupported, nil)
	}
	env, sqlExecutor, err := a.newUserManagementEnv(config, provider.Family())
	if err != nil {
		return nil, err
	}
	parent, parentCancel := newQueryExecutionContext(config)
	ctx, cancel := context.WithTimeout(parent, userMgmtRequestTimeout)
	return &userMgmtCall{
		provider: provider,
		target:   target,
		env:      env,
		sql:      sqlExecutor,
		ctx:      ctx,
		cancel: func() {
			cancel()
			parentCancel()
		},
	}, nil
}

func (a *App) userMgmtFailure(method string, config connection.ConnectionConfig, err error) connection.QueryResult {
	logger.Error(err, "%s 失败：%s", method, formatConnSummary(config))
	return connection.QueryResult{Success: false, Message: a.userMgmtErrorMessage(err)}
}

// probeForUserMgmt 探测并叠加连接级保护：开启「限制结构修改」时整体只读。
func (a *App) probeForUserMgmt(call *userMgmtCall, config connection.ConnectionConfig) (dbuser.ServerProfile, error) {
	profile, err := call.provider.Probe(call.ctx, call.env, call.target)
	if err != nil {
		return dbuser.ServerProfile{}, err
	}
	if profile.Supported && isConnectionProtectionEnabled(config, connectionProtectionStructureEdit) {
		profile.ReadOnly = true
		profile.Notices = append(profile.Notices, dbuser.Notef("connection_protected", dbuser.LevelWarning))
	}
	return profile, nil
}

// UserMgmtOverview 返回探测结果与账号/角色列表。
func (a *App) UserMgmtOverview(config connection.ConnectionConfig, query dbuser.ListQuery) connection.QueryResult {
	call, err := a.beginUserMgmtCall(config)
	if err != nil {
		return a.userMgmtFailure("UserMgmtOverview", config, err)
	}
	defer call.cancel()
	profile, err := a.probeForUserMgmt(call, config)
	if err != nil {
		return a.userMgmtFailure("UserMgmtOverview", config, err)
	}
	overview := UserMgmtOverview{Profile: profile, Principals: []dbuser.Principal{}}
	if profile.Supported {
		principals, listErr := call.provider.List(call.ctx, call.env, profile, query)
		if listErr != nil {
			return a.userMgmtFailure("UserMgmtOverview", config, listErr)
		}
		overview.Principals = a.localizeUserMgmtPrincipals(principals)
	}
	overview.Profile = a.localizeUserMgmtProfile(overview.Profile)
	return connection.QueryResult{Success: true, Data: overview}
}

// UserMgmtDescribePrincipal 返回单个主体的属性、权限与角色关系。
func (a *App) UserMgmtDescribePrincipal(config connection.ConnectionConfig, query dbuser.DescribeQuery) connection.QueryResult {
	call, err := a.beginUserMgmtCall(config)
	if err != nil {
		return a.userMgmtFailure("UserMgmtDescribePrincipal", config, err)
	}
	defer call.cancel()
	profile, err := a.probeForUserMgmt(call, config)
	if err != nil {
		return a.userMgmtFailure("UserMgmtDescribePrincipal", config, err)
	}
	detail, err := call.provider.Describe(call.ctx, call.env, profile, query)
	if err != nil {
		return a.userMgmtFailure("UserMgmtDescribePrincipal", config, err)
	}
	detail.Notices = a.localizeUserMgmtNotices(detail.Notices)
	detail.Principal = a.localizeUserMgmtPrincipals([]dbuser.Principal{detail.Principal})[0]
	return connection.QueryResult{Success: true, Data: detail}
}

// UserMgmtDropImpact 返回删除前的依赖分析。
func (a *App) UserMgmtDropImpact(config connection.ConnectionConfig, ref dbuser.PrincipalRef) connection.QueryResult {
	call, err := a.beginUserMgmtCall(config)
	if err != nil {
		return a.userMgmtFailure("UserMgmtDropImpact", config, err)
	}
	defer call.cancel()
	profile, err := a.probeForUserMgmt(call, config)
	if err != nil {
		return a.userMgmtFailure("UserMgmtDropImpact", config, err)
	}
	impact, err := call.provider.Impact(call.ctx, call.env, profile, ref)
	if err != nil {
		return a.userMgmtFailure("UserMgmtDropImpact", config, err)
	}
	return connection.QueryResult{Success: true, Data: a.localizeUserMgmtImpact(impact)}
}

// UserMgmtExportDDL 导出账号脚本；口令哈希已脱敏。
func (a *App) UserMgmtExportDDL(config connection.ConnectionConfig, ref dbuser.PrincipalRef) connection.QueryResult {
	call, err := a.beginUserMgmtCall(config)
	if err != nil {
		return a.userMgmtFailure("UserMgmtExportDDL", config, err)
	}
	defer call.cancel()
	profile, err := a.probeForUserMgmt(call, config)
	if err != nil {
		return a.userMgmtFailure("UserMgmtExportDDL", config, err)
	}
	ddl, err := call.provider.ExportDDL(call.ctx, call.env, profile, ref)
	if err != nil {
		return a.userMgmtFailure("UserMgmtExportDDL", config, err)
	}
	return connection.QueryResult{Success: true, Data: ddl}
}

// UserMgmtPreview 生成脱敏后的语句预览与指纹。预览请求不应携带口令，
// 即使携带也会在此丢弃，保证预览链路从不接触明文。
func (a *App) UserMgmtPreview(config connection.ConnectionConfig, request dbuser.ChangeRequest) connection.QueryResult {
	stripUserMgmtSecrets(&request)
	if err := ensureConnectionAllowsActionWithText(config, connectionProtectionStructureEdit, userMgmtProtectionAction, a.appText); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	call, err := a.beginUserMgmtCall(config)
	if err != nil {
		return a.userMgmtFailure("UserMgmtPreview", config, err)
	}
	defer call.cancel()
	profile, err := a.probeForUserMgmt(call, config)
	if err != nil {
		return a.userMgmtFailure("UserMgmtPreview", config, err)
	}
	plan, err := dbuser.BuildPlan(call.provider, profile, request)
	if err != nil {
		return connection.QueryResult{Success: false, Message: a.userMgmtErrorMessage(err)}
	}
	plan.Notices = a.localizeUserMgmtNotices(plan.Notices)
	return connection.QueryResult{Success: true, Data: plan}
}

func stripUserMgmtSecrets(request *dbuser.ChangeRequest) {
	if request.Password != nil {
		request.Password.Password = ""
		request.Password.CurrentPassword = ""
	}
}

// requireUserMgmtSecrets 保证 Apply 阶段声明要设置的口令确实已提供。
func requireUserMgmtSecrets(request dbuser.ChangeRequest) error {
	if request.Password != nil && request.Password.Set && !request.Password.Remove && request.Password.Password == "" {
		return dbuser.NewError(dbuser.ErrCodePasswordRequired, nil)
	}
	return nil
}
