package app

import (
	"context"
	"errors"
	"reflect"
	"strings"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
	"GoNavi-Wails/internal/logger"
)

type localizedOversizeQueryError struct {
	message string
	cause   error
}

func (e *localizedOversizeQueryError) Error() string {
	if e == nil {
		return ""
	}
	return e.message
}

func (e *localizedOversizeQueryError) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.cause
}

type formattedStatementExecutionError struct {
	message string
	cause   error
}

func (e *formattedStatementExecutionError) Error() string {
	if e == nil {
		return ""
	}
	return e.message
}

func (e *formattedStatementExecutionError) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.cause
}

func resolveOptionalDriverAgentDisplayName(driverType string) string {
	if definition, ok := resolveDriverDefinitionWithPackages(driverType, nil); ok {
		if name := strings.TrimSpace(definition.Name); name != "" {
			return name
		}
	}
	return resolveDriverDisplayName(driverDefinition{Type: driverType})
}

func (a *App) localizeOptionalDriverAgentOversizeError(driverType string, err error) error {
	var text func(string, map[string]any) string
	if a != nil {
		text = a.appText
	}
	return localizeOptionalDriverAgentOversizeErrorWithText(text, driverType, err)
}

func localizeOptionalDriverAgentOversizeErrorWithText(
	text func(string, map[string]any) string,
	driverType string,
	err error,
) error {
	if err == nil || !errors.Is(err, db.ErrOptionalDriverAgentJSONLineTooLarge) {
		return err
	}
	var alreadyLocalized *localizedOversizeQueryError
	if errors.As(err, &alreadyLocalized) {
		return err
	}
	if text == nil {
		text = defaultDBBackendText
	}
	message := text("db.backend.error.driver_agent_json_line_too_large", map[string]any{
		"driver": resolveOptionalDriverAgentDisplayName(driverType),
		"detail": err.Error(),
	})
	return &localizedOversizeQueryError{
		message: message,
		cause:   err,
	}
}

func formatMultiStatementExecutionError(
	text func(string, map[string]any) string,
	driverType string,
	index int,
	err error,
) error {
	if text == nil {
		text = defaultDBBackendText
	}
	localizedErr := localizeOptionalDriverAgentOversizeErrorWithText(text, driverType, err)
	detail := ""
	if localizedErr != nil {
		detail = localizedErr.Error()
	}
	message := text("db.backend.error.multi_statement_execution_failed", map[string]any{
		"index":  index,
		"detail": detail,
	})
	return &formattedStatementExecutionError{
		message: message,
		cause:   localizedErr,
	}
}

func nonNilStreamQueryExecer(target any) (db.StreamQueryExecer, bool) {
	if target == nil {
		return nil, false
	}
	value := reflect.ValueOf(target)
	if value.Kind() == reflect.Pointer && value.IsNil() {
		return nil, false
	}
	streamer, ok := target.(db.StreamQueryExecer)
	return streamer, ok && streamer != nil
}

func fallbackReadQueryToStreamOnOversize(
	ctx context.Context,
	config connection.ConnectionConfig,
	query string,
	budget *db.RowBudget,
	originalErr error,
	targets ...any,
) ([]map[string]interface{}, []string, bool, error) {
	if !errors.Is(originalErr, db.ErrOptionalDriverAgentJSONLineTooLarge) {
		return nil, nil, false, originalErr
	}
	var streamer db.StreamQueryExecer
	for _, target := range targets {
		if candidate, ok := nonNilStreamQueryExecer(target); ok {
			streamer = candidate
			break
		}
	}
	if streamer == nil {
		return nil, nil, false, originalErr
	}
	if budget == nil {
		budget = db.RowBudgetFromContext(ctx)
	}
	logger.Warnf("检测到旧版驱动代理单帧超过上限，切换流式分片读取：场景=只读查询结果超限 | 操作=回退流式查询 | 结果=开始 | 失败阶段=非流式结果接收 | 初步判断=旧版驱动代理单帧返回超过 32 MiB 上限 | 建议=请在驱动管理中更新或重装对应驱动代理 | %s SQL片段=%q",
		formatConnSummary(config), sqlSnippet(query))
	rows, columns, streamErr := db.CollectStreamQueryWithBudget(ctx, streamer, query, budget)
	if streamErr != nil {
		logger.Warnf("流式分片回退执行失败：场景=只读查询结果超限 | 操作=回退流式查询 | 结果=失败 | 失败阶段=流式读取响应 | 初步判断=驱动代理不支持流式查询或单行数据本身超过旧版代理单帧上限 | 建议=请在驱动管理中更新或重装对应驱动代理 | %s SQL片段=%q err=%v",
			formatConnSummary(config), sqlSnippet(query), streamErr)
		return nil, nil, false, streamErr
	}
	return rows, columns, true, nil
}

type nativeMultiOversizeRecoveryInput struct {
	ctx                   context.Context
	runConfig             connection.ConnectionConfig
	dbInst                db.Database
	statements            []string
	allReadOnly           bool
	rowBudget             *db.RowBudget
	results               []connection.ResultSetData
	resultMessages        []string
	err                   error
	measureQueryExecution func(func())
}

func recoverNativeMultiReadOversize(in nativeMultiOversizeRecoveryInput) ([]connection.ResultSetData, bool, error) {
	if !in.allReadOnly || !errors.Is(in.err, db.ErrOptionalDriverAgentJSONLineTooLarge) {
		return in.results, false, in.err
	}
	nonEmptyIndex := 0
	nonEmptyStmt := ""
	nonEmptyCount := 0
	for idx, stmt := range in.statements {
		trimmed := strings.TrimSpace(stmt)
		if trimmed == "" {
			continue
		}
		nonEmptyCount++
		if nonEmptyCount == 1 {
			nonEmptyIndex = idx + 1
			nonEmptyStmt = trimmed
		}
	}
	if nonEmptyCount > 1 {
		logger.Warnf("原生多结果集遇到旧版驱动代理单帧超限，回退逐条执行：场景=只读多语句查询结果超限 | 操作=回退逐条流式读取 | 结果=开始 | 失败阶段=原生多结果集接收 | 初步判断=旧版驱动代理单帧返回超过 32 MiB 上限 | 建议=请在驱动管理中更新或重装对应驱动代理 | %s 语句数=%d",
			formatConnSummary(in.runConfig), nonEmptyCount)
		return nil, true, nil
	}
	targetSQL := nonEmptyStmt
	if targetSQL == "" && len(in.statements) > 0 {
		targetSQL = in.statements[0]
		nonEmptyIndex = 1
	}
	var (
		rows      []map[string]interface{}
		columns   []string
		recovered bool
		streamErr error
	)
	in.measureQueryExecution(func() {
		rows, columns, recovered, streamErr = fallbackReadQueryToStreamOnOversize(
			in.ctx, in.runConfig, targetSQL, in.rowBudget, in.err, in.dbInst,
		)
	})
	if !recovered {
		if streamErr != nil {
			return in.results, false, streamErr
		}
		return in.results, false, in.err
	}
	if rows == nil {
		rows = make([]map[string]interface{}, 0)
	}
	if columns == nil {
		columns = []string{}
	}
	resultSets := []connection.ResultSetData{{
		Rows:           rows,
		Columns:        columns,
		Messages:       in.resultMessages,
		StatementIndex: nonEmptyIndex,
	}}
	applyRowBudgetTruncation(resultSets, in.rowBudget)
	return resultSets, true, nil
}

type perStatementReadFinalizeInput struct {
	ctx                   context.Context
	runConfig             connection.ConnectionConfig
	stmt                  string
	stmtIndex             int
	totalStatements       int
	isReadStmt            bool
	rowBudget             *db.RowBudget
	sessionExecTarget     db.StatementExecer
	dbInst                db.Database
	usedMultiResult       bool
	statementResultSets   []connection.ResultSetData
	data                  []map[string]interface{}
	columns               []string
	messages              []string
	err                   error
	runStatementQuery     func() ([]map[string]interface{}, []string, []string, error)
	measureQueryExecution func(func())
}

type perStatementReadFinalizeOutput struct {
	resultSets      []connection.ResultSetData
	rowsAffected    int64
	affectedRowsPtr *int64
	rowsReturned    int64
	err             error
}

func finalizePerStatementReadQuery(in perStatementReadFinalizeInput) perStatementReadFinalizeOutput {
	usedMultiResult := in.usedMultiResult
	statementResultSets := in.statementResultSets
	data := in.data
	columns := in.columns
	messages := in.messages
	err := in.err

	if err == nil && usedMultiResult && shouldFallbackToPlainQueryAfterMultiResult(in.isReadStmt, statementResultSets, messages) {
		logger.Warnf("DBQueryMulti 逐条多结果集返回空结果，将回退普通查询（第 %d/%d 条）：%s SQL片段=%q", in.stmtIndex+1, in.totalStatements, formatConnSummary(in.runConfig), sqlSnippet(in.stmt))
		usedMultiResult = false
		statementResultSets = nil
		data, columns, messages, err = in.runStatementQuery()
	}
	if err != nil && in.isReadStmt && errors.Is(err, db.ErrOptionalDriverAgentJSONLineTooLarge) {
		var streamTarget any = in.dbInst
		if in.sessionExecTarget != nil {
			streamTarget = in.sessionExecTarget
		}
		var (
			streamRows    []map[string]interface{}
			streamColumns []string
			recovered     bool
			streamErr     error
		)
		in.measureQueryExecution(func() {
			streamRows, streamColumns, recovered, streamErr = fallbackReadQueryToStreamOnOversize(
				in.ctx, in.runConfig, in.stmt, in.rowBudget, err, streamTarget,
			)
		})
		if recovered {
			usedMultiResult = false
			statementResultSets = nil
			messages = nil
			data = streamRows
			columns = streamColumns
			err = nil
		} else if streamErr != nil {
			err = streamErr
		}
	}
	if err != nil {
		return perStatementReadFinalizeOutput{err: err}
	}

	return normalizePerStatementReadOutput(in.stmtIndex+1, usedMultiResult, statementResultSets, data, columns, messages)
}

func normalizePerStatementReadOutput(
	stmtNumber int,
	usedMultiResult bool,
	statementResultSets []connection.ResultSetData,
	data []map[string]interface{},
	columns []string,
	messages []string,
) perStatementReadFinalizeOutput {
	if usedMultiResult {
		var rowsAffected, rowsReturned int64
		if len(statementResultSets) == 0 && len(messages) > 0 {
			statementResultSets = []connection.ResultSetData{{
				Rows:     []map[string]interface{}{},
				Columns:  []string{},
				Messages: append([]string(nil), messages...),
			}}
		}
		normalized := make([]connection.ResultSetData, 0, len(statementResultSets))
		for _, statementResult := range statementResultSets {
			if statementResult.Rows == nil {
				statementResult.Rows = []map[string]interface{}{}
			}
			if statementResult.Columns == nil {
				statementResult.Columns = []string{}
			}
			statementResult.StatementIndex = stmtNumber
			affected, returned := summarizeManagedSQLResultSet(statementResult)
			rowsAffected += affected
			rowsReturned += returned
			normalized = append(normalized, statementResult)
		}
		var affectedRowsPtr *int64
		if rowsAffected > 0 {
			affectedRowsPtr = statementAffectedRows(rowsAffected)
		}
		return perStatementReadFinalizeOutput{
			resultSets:      normalized,
			rowsAffected:    rowsAffected,
			affectedRowsPtr: affectedRowsPtr,
			rowsReturned:    rowsReturned,
		}
	}

	if data == nil {
		data = make([]map[string]interface{}, 0)
	}
	if columns == nil {
		columns = []string{}
	}
	return perStatementReadFinalizeOutput{
		resultSets: []connection.ResultSetData{{
			Rows:           data,
			Columns:        columns,
			Messages:       messages,
			StatementIndex: stmtNumber,
		}},
		rowsReturned: int64(len(data)),
	}
}
