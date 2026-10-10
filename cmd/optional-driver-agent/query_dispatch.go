package main

import (
	"context"
	"fmt"
	"strings"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
)

// 本文件承载 agent 侧的查询/写入/流式执行分发：按驱动实现的可选接口选择执行路径，
// 并把请求生命周期上下文（requestCtx）贯穿到驱动调用。
//
// requestCtx 是取消通知的作用点：取消通知会取消它，驱动层据此中止正在执行的语句。
// 因此这里始终优先选择上下文接口，只有驱动完全不支持时才回退到无上下文方法——无上下文
// 方法一旦进入就无法再被取消。

type agentQueryRunner interface {
	Query(string) ([]map[string]interface{}, []string, error)
}

type agentQueryContextRunner interface {
	QueryContext(context.Context, string) ([]map[string]interface{}, []string, error)
}

type agentQueryMessageRunner interface {
	QueryWithMessages(query string) ([]map[string]interface{}, []string, []string, error)
}

type agentQueryMessageContextRunner interface {
	QueryContextWithMessages(context.Context, string) ([]map[string]interface{}, []string, []string, error)
}

type agentMultiResultMessageRunner interface {
	QueryMultiWithMessages(query string) ([]connection.ResultSetData, []string, error)
}

type agentMultiResultMessageContextRunner interface {
	QueryMultiContextWithMessages(context.Context, string) ([]connection.ResultSetData, []string, error)
}

type agentMultiResultRunner interface {
	QueryMulti(query string) ([]connection.ResultSetData, error)
}

type agentMultiResultContextRunner interface {
	QueryMultiContext(context.Context, string) ([]connection.ResultSetData, error)
}

type agentExecRunner interface {
	Exec(string) (int64, error)
}

type agentExecContextRunner interface {
	ExecContext(context.Context, string) (int64, error)
}

func queryWithMessagesOptionalTimeout(requestCtx context.Context, inst agentQueryRunner, query string, timeoutMs int64) ([]map[string]interface{}, []string, []string, error) {
	data, fields, messages, _, err := queryWithMessagesRequest(requestCtx, inst, query, timeoutMs, nil)
	return data, fields, messages, err
}

func queryWithMessagesRequest(
	requestCtx context.Context,
	inst agentQueryRunner,
	query string,
	timeoutMs int64,
	options *db.RowBudgetOptions,
) ([]map[string]interface{}, []string, []string, *db.RowBudget, error) {
	effectiveTimeoutMs := timeoutMs
	if effectiveTimeoutMs <= 0 && strings.EqualFold(strings.TrimSpace(agentDriverType), "clickhouse") {
		effectiveTimeoutMs = int64(legacyClickHouseDefaultTimeout / time.Millisecond)
	}
	ctx, cancel, budget := agentQueryRequestContext(requestCtx, effectiveTimeoutMs, options)
	defer cancel()
	if q, ok := inst.(agentQueryMessageContextRunner); ok {
		data, fields, messages, err := q.QueryContextWithMessages(ctx, query)
		return data, fields, messages, budget, err
	}
	if q, ok := inst.(agentQueryContextRunner); ok {
		data, fields, err := q.QueryContext(ctx, query)
		return data, fields, nil, budget, err
	}
	if budget != nil {
		return nil, nil, nil, budget, fmt.Errorf("当前驱动不支持带结果预算的上下文查询")
	}
	if q, ok := inst.(agentQueryMessageRunner); ok {
		data, fields, messages, err := q.QueryWithMessages(query)
		return data, fields, messages, nil, err
	}
	data, fields, err := inst.Query(query)
	return data, fields, nil, nil, err
}

func queryWithOptionalTimeout(requestCtx context.Context, inst agentQueryRunner, query string, timeoutMs int64) ([]map[string]interface{}, []string, error) {
	data, fields, _, err := queryWithMessagesOptionalTimeout(requestCtx, inst, query, timeoutMs)
	return data, fields, err
}

func queryStatementWithOptionalTimeout(requestCtx context.Context, inst db.StatementExecer, query string, timeoutMs int64) ([]map[string]interface{}, []string, error) {
	queryRunner, ok := inst.(agentQueryRunner)
	if !ok {
		return nil, nil, fmt.Errorf("当前事务会话不支持查询语句")
	}
	return queryWithOptionalTimeout(requestCtx, queryRunner, query, timeoutMs)
}

func queryStatementWithMessagesOptionalTimeout(requestCtx context.Context, inst db.StatementExecer, query string, timeoutMs int64) ([]map[string]interface{}, []string, []string, error) {
	data, fields, messages, _, err := queryStatementWithMessagesRequest(requestCtx, inst, query, timeoutMs, nil)
	return data, fields, messages, err
}

func queryStatementWithMessagesRequest(
	requestCtx context.Context,
	inst db.StatementExecer,
	query string,
	timeoutMs int64,
	options *db.RowBudgetOptions,
) ([]map[string]interface{}, []string, []string, *db.RowBudget, error) {
	queryRunner, ok := inst.(agentQueryRunner)
	if !ok {
		return nil, nil, nil, nil, fmt.Errorf("当前事务会话不支持查询语句")
	}
	return queryWithMessagesRequest(requestCtx, queryRunner, query, timeoutMs, options)
}

// hasNonContextMultiResult 报告实例是否实现了不接收 context 的多结果集方法。
func hasNonContextMultiResult(inst any) bool {
	if _, ok := inst.(agentMultiResultMessageRunner); ok {
		return true
	}
	_, ok := inst.(agentMultiResultRunner)
	return ok
}

func queryMultiWithMessagesOptionalTimeout(requestCtx context.Context, inst db.Database, query string, timeoutMs int64) ([]connection.ResultSetData, []string, bool, error) {
	data, messages, supported, _, err := queryMultiWithMessagesRequest(requestCtx, inst, query, timeoutMs, nil)
	return data, messages, supported, err
}

func queryMultiWithMessagesRequest(
	requestCtx context.Context,
	inst db.Database,
	query string,
	timeoutMs int64,
	options *db.RowBudgetOptions,
) ([]connection.ResultSetData, []string, bool, *db.RowBudget, error) {
	effectiveTimeoutMs := timeoutMs
	if effectiveTimeoutMs <= 0 && strings.EqualFold(strings.TrimSpace(agentDriverType), "clickhouse") {
		effectiveTimeoutMs = int64(legacyClickHouseDefaultTimeout / time.Millisecond)
	}
	ctx, cancel, budget := agentQueryRequestContext(requestCtx, effectiveTimeoutMs, options)
	defer cancel()
	if q, ok := inst.(agentMultiResultMessageContextRunner); ok {
		data, messages, err := q.QueryMultiContextWithMessages(ctx, query)
		return data, messages, true, budget, err
	}
	if q, ok := inst.(agentMultiResultContextRunner); ok {
		data, err := q.QueryMultiContext(ctx, query)
		return data, nil, true, budget, err
	}
	if budget != nil {
		if hasNonContextMultiResult(inst) {
			return nil, nil, false, budget, fmt.Errorf("当前驱动不支持带结果预算的多结果集上下文查询")
		}
		// 驱动根本没有多结果集接口。按不支持返回，调用方改走带预算的普通查询。
		return nil, nil, false, nil, nil
	}
	if q, ok := inst.(agentMultiResultMessageRunner); ok {
		data, messages, err := q.QueryMultiWithMessages(query)
		return data, messages, true, nil, err
	}
	if q, ok := inst.(agentMultiResultRunner); ok {
		data, err := q.QueryMulti(query)
		return data, nil, true, nil, err
	}
	return nil, nil, false, nil, nil
}

func queryMultiStatementWithMessagesOptionalTimeout(requestCtx context.Context, inst db.StatementExecer, query string, timeoutMs int64) ([]connection.ResultSetData, []string, bool, error) {
	data, messages, supported, _, err := queryMultiStatementWithMessagesRequest(requestCtx, inst, query, timeoutMs, nil)
	return data, messages, supported, err
}

func queryMultiStatementWithMessagesRequest(
	requestCtx context.Context,
	inst db.StatementExecer,
	query string,
	timeoutMs int64,
	options *db.RowBudgetOptions,
) ([]connection.ResultSetData, []string, bool, *db.RowBudget, error) {
	effectiveTimeoutMs := timeoutMs
	if effectiveTimeoutMs <= 0 && strings.EqualFold(strings.TrimSpace(agentDriverType), "clickhouse") {
		effectiveTimeoutMs = int64(legacyClickHouseDefaultTimeout / time.Millisecond)
	}
	ctx, cancel, budget := agentQueryRequestContext(requestCtx, effectiveTimeoutMs, options)
	defer cancel()
	if q, ok := inst.(agentMultiResultMessageContextRunner); ok {
		data, messages, err := q.QueryMultiContextWithMessages(ctx, query)
		return data, messages, true, budget, err
	}
	if q, ok := inst.(agentMultiResultContextRunner); ok {
		data, err := q.QueryMultiContext(ctx, query)
		return data, nil, true, budget, err
	}
	if budget != nil {
		if hasNonContextMultiResult(inst) {
			return nil, nil, false, budget, fmt.Errorf("当前事务会话不支持带结果预算的多结果集上下文查询")
		}
		return nil, nil, false, nil, nil
	}
	if q, ok := inst.(agentMultiResultMessageRunner); ok {
		data, messages, err := q.QueryMultiWithMessages(query)
		return data, messages, true, nil, err
	}
	if q, ok := inst.(agentMultiResultRunner); ok {
		data, err := q.QueryMulti(query)
		return data, nil, true, nil, err
	}
	return nil, nil, false, nil, nil
}

func streamWithOptionalTimeout(requestCtx context.Context, inst db.StreamQueryExecer, query string, timeoutMs int64, consumer db.QueryStreamConsumer) error {
	effectiveTimeoutMs := timeoutMs
	if effectiveTimeoutMs <= 0 && strings.EqualFold(strings.TrimSpace(agentDriverType), "clickhouse") {
		effectiveTimeoutMs = int64(legacyClickHouseDefaultTimeout / time.Millisecond)
	}
	ctx, cancel := agentStreamRequestContext(requestCtx, effectiveTimeoutMs)
	defer cancel()
	return inst.StreamQueryContext(ctx, query, consumer)
}

func streamBufferedQueryResult(fields []string, data []map[string]interface{}, consumer db.QueryStreamConsumer) error {
	if err := consumer.SetColumns(fields); err != nil {
		return err
	}
	if valueConsumer, ok := consumer.(db.QueryStreamValueConsumer); ok {
		for _, row := range data {
			values := make([]interface{}, len(fields))
			for idx, field := range fields {
				values[idx] = row[field]
			}
			if err := valueConsumer.ConsumeRowValues(values); err != nil {
				return err
			}
		}
		return nil
	}
	for _, row := range data {
		if err := consumer.ConsumeRow(row); err != nil {
			return err
		}
	}
	return nil
}

func streamStatementWithOptionalTimeout(requestCtx context.Context, inst db.StatementExecer, query string, timeoutMs int64, consumer db.QueryStreamConsumer) error {
	if streamer, ok := inst.(db.StreamQueryExecer); ok {
		return streamWithOptionalTimeout(requestCtx, streamer, query, timeoutMs, consumer)
	}
	data, fields, err := queryStatementWithOptionalTimeout(requestCtx, inst, query, timeoutMs)
	if err != nil {
		return err
	}
	return streamBufferedQueryResult(fields, data, consumer)
}

func streamDatabaseWithOptionalTimeout(requestCtx context.Context, inst db.Database, query string, timeoutMs int64, consumer db.QueryStreamConsumer) error {
	if streamer, ok := inst.(db.StreamQueryExecer); ok {
		return streamWithOptionalTimeout(requestCtx, streamer, query, timeoutMs, consumer)
	}
	if provider, ok := inst.(db.SessionExecerProvider); ok {
		openCtx := context.Background()
		var cancel context.CancelFunc
		effectiveTimeoutMs := timeoutMs
		if effectiveTimeoutMs <= 0 && strings.EqualFold(strings.TrimSpace(agentDriverType), "clickhouse") {
			effectiveTimeoutMs = int64(legacyClickHouseDefaultTimeout / time.Millisecond)
		}
		if effectiveTimeoutMs > 0 {
			openCtx, cancel = context.WithTimeout(context.Background(), time.Duration(effectiveTimeoutMs)*time.Millisecond)
			defer cancel()
		}
		session, err := provider.OpenSessionExecer(openCtx)
		if err == nil {
			defer session.Close()
			return streamStatementWithOptionalTimeout(requestCtx, session, query, timeoutMs, consumer)
		}
	}
	data, fields, err := queryWithOptionalTimeout(requestCtx, inst, query, timeoutMs)
	if err != nil {
		return err
	}
	return streamBufferedQueryResult(fields, data, consumer)
}

func execWithOptionalTimeout(requestCtx context.Context, inst agentExecRunner, query string, timeoutMs int64) (int64, error) {
	effectiveTimeoutMs := timeoutMs
	if effectiveTimeoutMs <= 0 && strings.EqualFold(strings.TrimSpace(agentDriverType), "clickhouse") {
		effectiveTimeoutMs = int64(legacyClickHouseDefaultTimeout / time.Millisecond)
	}
	ctx, cancel := agentStreamRequestContext(requestCtx, effectiveTimeoutMs)
	defer cancel()
	if e, ok := inst.(agentExecContextRunner); ok {
		return e.ExecContext(ctx, query)
	}
	return inst.Exec(query)
}

func execStatementWithOptionalTimeout(requestCtx context.Context, inst db.StatementExecer, query string, timeoutMs int64) (int64, error) {
	return execWithOptionalTimeout(requestCtx, inst, query, timeoutMs)
}
