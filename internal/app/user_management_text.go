package app

import (
	"GoNavi-Wails/internal/dbuser"
)

// userMgmtNoticeKey 把 dbuser 提示码映射为 i18n 键。键名按码拼接，
// 新增提示码时必须同步 shared/i18n 六个语言文件（catalog 测试会校验）。
func userMgmtNoticeKey(code string) string {
	return "user_management.backend.notice." + code
}

func userMgmtErrorKey(code string) string {
	return "user_management.backend.error." + code
}

func toI18nParams(params map[string]string) map[string]any {
	if len(params) == 0 {
		return nil
	}
	out := make(map[string]any, len(params))
	for key, value := range params {
		out[key] = value
	}
	return out
}

func (a *App) localizeUserMgmtNotices(notices []dbuser.Notice) []dbuser.Notice {
	for index := range notices {
		notices[index].Text = a.appText(userMgmtNoticeKey(notices[index].Code), toI18nParams(notices[index].Params))
	}
	return notices
}

// localizeUserMgmtProfile 为提示、字段与候选项填充本地化文本。
func (a *App) localizeUserMgmtProfile(profile dbuser.ServerProfile) dbuser.ServerProfile {
	profile.Notices = a.localizeUserMgmtNotices(profile.Notices)
	if profile.UnsupportedReason != nil {
		reason := *profile.UnsupportedReason
		reason.Text = a.appText(userMgmtNoticeKey(reason.Code), toI18nParams(reason.Params))
		profile.UnsupportedReason = &reason
	}
	for i := range profile.Options {
		if code := profile.Options[i].NoticeCode; code != "" {
			profile.Options[i].Hint = a.appText(userMgmtNoticeKey(code), nil)
		}
		for j := range profile.Options[i].Choices {
			if code := profile.Options[i].Choices[j].NoticeCode; code != "" {
				profile.Options[i].Choices[j].Hint = a.appText(userMgmtNoticeKey(code), nil)
			}
		}
	}
	return profile
}

func (a *App) localizeUserMgmtImpact(impact dbuser.DropImpact) dbuser.DropImpact {
	for index := range impact.Items {
		params := toI18nParams(impact.Items[index].Params)
		if params == nil {
			params = map[string]any{}
		}
		params["count"] = impact.Items[index].Count
		params["database"] = impact.Items[index].Database
		key := "user_management.backend.impact." + impact.Items[index].Code
		if impact.Items[index].Database != "" {
			// 按库统计的影响项使用带库名的文案，避免空库名拼出残缺句子。
			key += "_in_database"
		}
		impact.Items[index].Text = a.appText(key, params)
	}
	impact.Notices = a.localizeUserMgmtNotices(impact.Notices)
	return impact
}

// localizeUserMgmtPrincipals 把只读原因代码替换为本地化文案。
func (a *App) localizeUserMgmtPrincipals(principals []dbuser.Principal) []dbuser.Principal {
	for index := range principals {
		if code := principals[index].ReadOnlyReason; code != "" {
			principals[index].ReadOnlyReason = a.appText(userMgmtNoticeKey(code), nil)
		}
	}
	return principals
}

// userMgmtErrorMessage 把错误转为可展示文案：领域错误按码本地化，
// 其余错误（已脱敏的驱动错误）作为 detail 嵌入通用文案。
func (a *App) userMgmtErrorMessage(err error) string {
	if domainErr, ok := dbuser.AsError(err); ok {
		if rule := domainErr.Params["rule"]; domainErr.Code == dbuser.ErrCodePasswordPolicy && rule != "" {
			return a.appText(userMgmtErrorKey(domainErr.Code)+"."+rule, toI18nParams(domainErr.Params))
		}
		return a.appText(userMgmtErrorKey(domainErr.Code), toI18nParams(domainErr.Params))
	}
	return a.appText(userMgmtErrorKey("operation_failed"), map[string]any{"detail": err.Error()})
}
