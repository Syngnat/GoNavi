package app

import (
	"strconv"
	"strings"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/dbuser"
	"GoNavi-Wails/internal/logger"
)

// UserMgmtApply 执行变更。流程：连接保护守卫 → 重新探测并生成计划 → 与预览指纹比对
// → 按计划执行 → 写审计（只含脱敏语句）。前端传来的只是结构化变更，从不是 SQL。
func (a *App) UserMgmtApply(config connection.ConnectionConfig, request dbuser.ChangeRequest, fingerprint string) (result connection.QueryResult) {
	auditSQL := ""
	statementCount := 0
	safeError := ""
	defer a.beginSQLAuditUserActionWithOptions(config, request.Database, userMgmtAuditSource, &auditSQL, &result, sqlAuditUserActionOptions{
		StatementCount: &statementCount,
		SafeError:      &safeError,
	})()
	fail := func(message string) connection.QueryResult {
		safeError = message
		return connection.QueryResult{Success: false, Message: message}
	}
	if err := ensureConnectionAllowsActionWithText(config, connectionProtectionStructureEdit, userMgmtProtectionAction, a.appText); err != nil {
		return fail(err.Error())
	}
	if err := requireUserMgmtSecrets(request); err != nil {
		return fail(a.userMgmtErrorMessage(err))
	}
	call, err := a.beginUserMgmtCall(config)
	if err != nil {
		logger.Error(err, "UserMgmtApply 失败：%s", formatConnSummary(config))
		return fail(a.userMgmtErrorMessage(err))
	}
	defer call.cancel()
	secrets := &dbuser.Secrets{}
	secrets.FromRequest(request)
	profile, err := a.probeForUserMgmt(call, config)
	if err != nil {
		sanitized := dbuser.SanitizeError(err, secrets)
		logger.Error(sanitized, "UserMgmtApply 探测失败：%s", formatConnSummary(config))
		return fail(a.userMgmtErrorMessage(sanitized))
	}
	plan, err := dbuser.BuildPlan(call.provider, profile, request)
	if err != nil {
		return fail(a.userMgmtErrorMessage(dbuser.SanitizeError(err, secrets)))
	}
	if plan.Fingerprint != strings.TrimSpace(fingerprint) {
		return fail(a.userMgmtErrorMessage(dbuser.NewError(dbuser.ErrCodePlanChanged, nil)))
	}
	auditSQL = joinUserMgmtDisplays(plan)
	statementCount = len(plan.Statements)
	env := call.env
	if plan.Transactional && call.sql != nil && call.sql.supportsSessions("") {
		env.Sessions = call.sql
	}
	report := dbuser.Execute(call.ctx, env, plan, secrets)
	report.Notices = a.localizeUserMgmtNotices(report.Notices)
	result = connection.QueryResult{
		Success:       !report.Failed(),
		Data:          report,
		ExecutedCount: report.ExecutedCount,
		FailedIndex:   report.FailedIndex,
		Partial:       report.Failed() && report.ExecutedCount > 0,
	}
	if report.Failed() {
		detail := failedStatementError(report)
		result.Message = a.appText("user_management.backend.error.apply_failed", map[string]any{
			"index":  strconv.Itoa(report.FailedIndex),
			"total":  strconv.Itoa(len(plan.Statements)),
			"detail": detail,
		})
		safeError = result.Message
		logger.Warnf("UserMgmtApply 第 %d 条语句失败：%s", report.FailedIndex, formatConnSummary(config))
		return result
	}
	result.Message = a.appText("user_management.backend.message.applied", map[string]any{"count": report.ExecutedCount})
	return result
}

func joinUserMgmtDisplays(plan dbuser.Plan) string {
	displays := make([]string, 0, len(plan.Statements))
	for _, statement := range plan.Statements {
		displays = append(displays, statement.Display)
	}
	return strings.Join(displays, ";\n")
}

func failedStatementError(report dbuser.ApplyReport) string {
	for _, item := range report.Results {
		if item.Index == report.FailedIndex && item.Error != "" {
			return item.Error
		}
	}
	return ""
}
