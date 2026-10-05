//go:build gonavi_full_drivers || gonavi_presto_driver

package db

import (
	"context"
	"errors"
	"regexp"
	"strconv"
	"strings"
)

// prestoTrailingOffset 匹配语句末尾的 OFFSET n [ROWS] [LIMIT m]（数据浏览分页生成的形式）。
var prestoTrailingOffset = regexp.MustCompile(`(?is)^(.*\S)\s+OFFSET\s+(\d+)(?:\s+ROWS?)?(?:\s+LIMIT\s+(\d+|ALL))?$`)

// rewritePrestoOffset 为没有 OFFSET 的服务端改写分页：OFFSET n LIMIT m → LIMIT n+m，返回需要在客户端丢弃的前导行数。
// 只处理位于语句末尾、不在行注释里的 OFFSET；其余语句原样返回。
func rewritePrestoOffset(query string) (string, int64) {
	text := strings.TrimRight(strings.TrimSpace(query), "; \t\r\n")
	match := prestoTrailingOffset.FindStringSubmatch(text)
	if match == nil {
		return query, 0
	}
	prefix := match[1]
	if lastLine := prefix[strings.LastIndex(prefix, "\n")+1:]; strings.Contains(lastLine, "--") {
		return query, 0
	}
	offset, err := strconv.ParseInt(match[2], 10, 64)
	if err != nil || offset <= 0 {
		return query, 0
	}
	switch limit := strings.ToUpper(match[3]); limit {
	case "", "ALL":
		return prefix, offset
	default:
		count, err := strconv.ParseInt(limit, 10, 64)
		if err != nil {
			return query, 0
		}
		return prefix + " LIMIT " + strconv.FormatInt(offset+count, 10), offset
	}
}

func (p *PrestoDB) prepareQuery(query string) (string, int64) {
	if p.offsetMode == prestoOffsetEmulated {
		return rewritePrestoOffset(query)
	}
	return query, 0
}

func (p *PrestoDB) QueryContext(ctx context.Context, query string) ([]map[string]interface{}, []string, error) {
	return p.queryOn(ctx, p.session, query, nil)
}

func (p *PrestoDB) Query(query string) ([]map[string]interface{}, []string, error) {
	return p.QueryContext(metadataContextFor(p), query)
}

func (p *PrestoDB) queryOn(ctx context.Context, session *prestoSession, query string, prepared map[string]string) ([]map[string]interface{}, []string, error) {
	if p.client == nil {
		return nil, nil, localizedDatabaseRuntimeError("db.backend.error.connection_not_open", nil)
	}
	statement, skip := p.prepareQuery(query)
	collector := &prestoRowCollector{budget: RowBudgetFromContext(ctx), skip: skip}
	if _, err := p.client.execute(ctx, session, statement, prepared, collector); err != nil {
		return nil, nil, err
	}
	if collector.data == nil {
		collector.data = make([]map[string]interface{}, 0)
	}
	return collector.data, collector.names, nil
}

func (p *PrestoDB) StreamQueryContext(ctx context.Context, query string, consumer QueryStreamConsumer) error {
	if p.client == nil {
		return localizedDatabaseRuntimeError("db.backend.error.connection_not_open", nil)
	}
	statement, skip := p.prepareQuery(query)
	_, err := p.client.execute(ctx, p.session, statement, nil, &prestoStreamSink{consumer: consumer, skip: skip})
	return err
}

func (p *PrestoDB) StreamQuery(query string, consumer QueryStreamConsumer) error {
	return p.StreamQueryContext(context.Background(), query, consumer)
}

func (p *PrestoDB) ExecContext(ctx context.Context, query string) (int64, error) {
	return p.execOn(ctx, p.session, query, nil)
}

func (p *PrestoDB) Exec(query string) (int64, error) {
	return p.ExecContext(context.Background(), query)
}

// execOn 执行写语句并取完结果：INSERT / CTAS 的影响行数在结果的 rows 列或 updateCount 里。
// 语句已提交后发生的传输错误（不是服务端返回的失败）标记为结果未知，导入与同步不会重试。
func (p *PrestoDB) execOn(ctx context.Context, session *prestoSession, query string, prepared map[string]string) (int64, error) {
	if p.client == nil {
		return 0, localizedDatabaseRuntimeError("db.backend.error.connection_not_open", nil)
	}
	outcome, err := p.client.execute(ctx, session, query, prepared, nil)
	if err != nil {
		var queryErr *prestoQueryError
		if outcome.submitted && !errors.As(err, &queryErr) {
			return 0, MarkWriteOutcomeUnknown(err)
		}
		return 0, err
	}
	return prestoAffectedRows(outcome), nil
}

func (p *PrestoDB) QueryContextWithArgs(ctx context.Context, query string, args []any) ([]map[string]interface{}, []string, error) {
	statement, prepared, err := prestoBindArgs(query, args)
	if err != nil {
		return nil, nil, err
	}
	return p.queryOn(ctx, p.session, statement, prepared)
}

func (p *PrestoDB) ExecContextWithArgs(ctx context.Context, query string, args []any) (int64, error) {
	statement, prepared, err := prestoBindArgs(query, args)
	if err != nil {
		return 0, err
	}
	return p.execOn(ctx, p.session, statement, prepared)
}

// OpenSessionExecer 返回独立会话：导入任务等长作业里的 USE、SET SESSION 不影响连接上的其他查询。
func (p *PrestoDB) OpenSessionExecer(ctx context.Context) (StatementExecer, error) {
	if p.client == nil {
		return nil, localizedDatabaseRuntimeError("db.backend.error.connection_not_open", nil)
	}
	return &prestoSessionExecer{db: p, session: newPrestoSession(p.catalog, p.schema)}, nil
}

// prestoSessionExecer 在一个独立的逻辑会话上执行语句；关闭时回滚未结束的显式事务。
type prestoSessionExecer struct {
	db      *PrestoDB
	session *prestoSession
}

var (
	_ StatementQueryExecer     = (*prestoSessionExecer)(nil)
	_ StatementQueryArgsExecer = (*prestoSessionExecer)(nil)
	_ StatementExecArgsExecer  = (*prestoSessionExecer)(nil)
)

func (s *prestoSessionExecer) Exec(query string) (int64, error) {
	return s.ExecContext(context.Background(), query)
}

func (s *prestoSessionExecer) ExecContext(ctx context.Context, query string) (int64, error) {
	return s.db.execOn(ctx, s.session, query, nil)
}

func (s *prestoSessionExecer) Query(query string) ([]map[string]interface{}, []string, error) {
	return s.QueryContext(context.Background(), query)
}

func (s *prestoSessionExecer) QueryContext(ctx context.Context, query string) ([]map[string]interface{}, []string, error) {
	return s.db.queryOn(ctx, s.session, query, nil)
}

func (s *prestoSessionExecer) QueryContextWithArgs(ctx context.Context, query string, args []any) ([]map[string]interface{}, []string, error) {
	statement, prepared, err := prestoBindArgs(query, args)
	if err != nil {
		return nil, nil, err
	}
	return s.db.queryOn(ctx, s.session, statement, prepared)
}

func (s *prestoSessionExecer) ExecContextWithArgs(ctx context.Context, query string, args []any) (int64, error) {
	statement, prepared, err := prestoBindArgs(query, args)
	if err != nil {
		return 0, err
	}
	return s.db.execOn(ctx, s.session, statement, prepared)
}

func (s *prestoSessionExecer) Close() error {
	if s.session == nil || !s.session.inTransaction() || s.db.client == nil {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), prestoCancelTimeout)
	defer cancel()
	_, err := s.db.client.execute(ctx, s.session, "ROLLBACK", nil, nil)
	return err
}
