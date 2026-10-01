package dbuser

import (
	"context"
	"errors"
	"strconv"
)

// 通知码：执行阶段。
const (
	NoticeOptionalStatementFailed = "optional_statement_failed"
	NoticeRollbackFailed          = "rollback_failed"
	NoticeTransactionFallback     = "transaction_fallback"
)

var errMissingExecutor = errors.New("dbuser: executor not available for statement")

// Execute 按计划顺序执行语句，遇到第一个非可选失败即停止。
//
// Plan.Transactional 且运行时支持会话固定时，按 Statement.Database 分组，
// 每组在一个文本事务中执行（PG 系 DDL 可回滚）；否则逐条执行并记录部分成功。
// 所有错误文本都经过 secrets 脱敏。
func Execute(ctx context.Context, env Env, plan Plan, secrets *Secrets) ApplyReport {
	report := ApplyReport{Results: make([]StatementResult, 0, len(plan.Statements))}
	if secrets == nil {
		secrets = &Secrets{}
	}
	for _, statement := range plan.Statements {
		secrets.Add(statement.Secrets...)
	}
	if plan.Transactional && env.Sessions != nil {
		executeTransactional(ctx, env, plan, secrets, &report)
		return report
	}
	if plan.Transactional {
		report.Notices = append(report.Notices, Notice{Code: NoticeTransactionFallback, Level: LevelWarning})
	}
	for index, statement := range plan.Statements {
		if report.Failed() {
			report.Results = append(report.Results, skippedResult(index, statement))
			continue
		}
		executeOne(ctx, env, index, statement, secrets, &report)
	}
	return report
}

func executeOne(ctx context.Context, env Env, index int, statement Statement, secrets *Secrets, report *ApplyReport) {
	position := index + 1
	if statement.Args != nil && statement.EachNode {
		executeEachNode(ctx, env, position, statement, secrets, report)
		return
	}
	err := runStatement(ctx, env, statement)
	if err == nil {
		report.ExecutedCount++
		report.Results = append(report.Results, StatementResult{Index: position, Display: statement.Display, Success: true})
		return
	}
	message := SanitizeError(err, secrets).Error()
	report.Results = append(report.Results, StatementResult{Index: position, Display: statement.Display, Error: message})
	if statement.Optional {
		report.Notices = append(report.Notices, Notice{
			Code:   NoticeOptionalStatementFailed,
			Level:  LevelWarning,
			Params: map[string]string{"index": strconv.Itoa(position), "detail": message},
		})
		return
	}
	report.FailedIndex = position
}

func executeEachNode(ctx context.Context, env Env, position int, statement Statement, secrets *Secrets, report *ApplyReport) {
	if env.Commands == nil {
		report.Results = append(report.Results, StatementResult{Index: position, Display: statement.Display, Error: errMissingExecutor.Error()})
		report.FailedIndex = position
		return
	}
	nodes, err := env.Commands.DoEachNode(ctx, statement.Args)
	if err != nil {
		message := SanitizeError(err, secrets).Error()
		report.Results = append(report.Results, StatementResult{Index: position, Display: statement.Display, Error: message})
		if !statement.Optional {
			report.FailedIndex = position
		}
		return
	}
	failed := false
	for _, node := range nodes {
		result := StatementResult{Index: position, Display: statement.Display, Node: node.Node, Success: node.Err == nil}
		if node.Err != nil {
			result.Error = SanitizeError(node.Err, secrets).Error()
			failed = true
		}
		report.Results = append(report.Results, result)
	}
	if !failed {
		report.ExecutedCount++
		return
	}
	if statement.Optional {
		report.Notices = append(report.Notices, Notice{
			Code:   NoticeOptionalStatementFailed,
			Level:  LevelWarning,
			Params: map[string]string{"index": strconv.Itoa(position)},
		})
		return
	}
	report.FailedIndex = position
}

func runStatement(ctx context.Context, env Env, statement Statement) error {
	if statement.Args != nil {
		if env.Commands == nil {
			return errMissingExecutor
		}
		_, err := env.Commands.Do(ctx, statement.Args)
		return err
	}
	if env.SQL == nil {
		return errMissingExecutor
	}
	return env.SQL.Exec(ctx, statement.Database, statement.Exec)
}

func skippedResult(index int, statement Statement) StatementResult {
	return StatementResult{Index: index + 1, Display: statement.Display, Skipped: true}
}

// executeTransactional 把连续的同库语句放进一个 BEGIN/COMMIT 事务。
func executeTransactional(ctx context.Context, env Env, plan Plan, secrets *Secrets, report *ApplyReport) {
	start := 0
	for start < len(plan.Statements) {
		end := start + 1
		for end < len(plan.Statements) && plan.Statements[end].Database == plan.Statements[start].Database {
			end++
		}
		if report.Failed() {
			for index := start; index < end; index++ {
				report.Results = append(report.Results, skippedResult(index, plan.Statements[index]))
			}
		} else {
			runTransactionGroup(ctx, env, plan.Statements, start, end, secrets, report)
		}
		start = end
	}
}

func runTransactionGroup(ctx context.Context, env Env, statements []Statement, start, end int, secrets *Secrets, report *ApplyReport) {
	database := statements[start].Database
	fail := func(position int, err error) {
		for index := start; index < end; index++ {
			if index+1 < position {
				continue
			}
			if index+1 == position {
				report.Results = append(report.Results, StatementResult{
					Index: position, Display: statements[index].Display, Error: SanitizeError(err, secrets).Error(),
				})
				continue
			}
			report.Results = append(report.Results, skippedResult(index, statements[index]))
		}
		report.FailedIndex = position
	}
	session, err := env.Sessions.OpenSession(ctx, database)
	if err != nil {
		fail(start+1, err)
		return
	}
	defer func() { _ = session.Close() }()
	if err := session.Exec(ctx, "BEGIN"); err != nil {
		fail(start+1, err)
		return
	}
	groupResults := make([]StatementResult, 0, end-start)
	for index := start; index < end; index++ {
		if err := session.Exec(ctx, statements[index].Exec); err != nil {
			report.Results = append(report.Results, groupResults...)
			fail(index+1, err)
			if rollbackErr := session.Exec(ctx, "ROLLBACK"); rollbackErr != nil {
				report.Notices = append(report.Notices, Notice{Code: NoticeRollbackFailed, Level: LevelDanger})
			} else {
				report.RolledBack = true
				markGroupRolledBack(report, start, index)
			}
			return
		}
		groupResults = append(groupResults, StatementResult{Index: index + 1, Display: statements[index].Display, Success: true})
	}
	if err := session.Exec(ctx, "COMMIT"); err != nil {
		// 提交失败时服务端已整体回滚：本组语句都不算成功，错误挂在最后一条上。
		for i := range groupResults {
			groupResults[i].Success = false
			groupResults[i].Skipped = true
		}
		last := &groupResults[len(groupResults)-1]
		last.Skipped = false
		last.Error = SanitizeError(err, secrets).Error()
		report.Results = append(report.Results, groupResults...)
		report.FailedIndex = end
		report.RolledBack = true
		return
	}
	report.Results = append(report.Results, groupResults...)
	report.ExecutedCount += end - start
}

// markGroupRolledBack 把同组中已执行成功的语句标记为已回滚（不再计入成功）。
func markGroupRolledBack(report *ApplyReport, start, failedIndex int) {
	for i := range report.Results {
		position := report.Results[i].Index
		if position-1 >= start && position-1 < failedIndex && report.Results[i].Success {
			report.Results[i].Success = false
			report.Results[i].Skipped = true
		}
	}
}
