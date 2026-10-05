package db

import (
	"context"
	"fmt"
	"strings"

	"GoNavi-Wails/internal/logger"
)

func (d *optionalDriverAgentTransactionalDB) OpenTransactionExecer(ctx context.Context) (TransactionExecer, error) {
	if d == nil || d.OptionalDriverAgentDB == nil {
		return nil, fmt.Errorf("连接未打开")
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	client, err := d.requireClient()
	if err != nil {
		return nil, err
	}
	var sessionID string
	if err := client.callContext(ctx, optionalAgentRequest{
		Method:    optionalAgentMethodOpenTransaction,
		TimeoutMs: timeoutMsFromContext(ctx),
	}, &sessionID, nil, nil, nil); err != nil {
		return nil, err
	}
	sessionID = strings.TrimSpace(sessionID)
	if sessionID == "" {
		return nil, fmt.Errorf("%s 驱动代理未返回事务 ID", driverDisplayName(d.driverType))
	}
	return &optionalDriverAgentTransaction{
		optionalDriverAgentSession: &optionalDriverAgentSession{
			client:    client,
			driver:    d.driverType,
			sessionID: sessionID,
		},
	}, nil
}

func (t *optionalDriverAgentTransaction) Commit() error {
	return t.finish(optionalAgentMethodCommitTransaction)
}

func (t *optionalDriverAgentTransaction) Rollback() error {
	return t.finish(optionalAgentMethodRollbackTransaction)
}

func (t *optionalDriverAgentTransaction) finish(method string) error {
	if t == nil || t.optionalDriverAgentSession == nil {
		return nil
	}
	t.finishMu.Lock()
	defer t.finishMu.Unlock()
	if t.finished {
		return nil
	}
	if err := t.ensureOpen(); err != nil {
		return err
	}
	t.finished = true
	// Commit/Rollback have no context in TransactionExecer. A fixed client-side
	// timeout can report failure after the server has already committed, leaving
	// the transaction outcome unknowable. Keep transaction finalization bounded
	// by the database/driver itself; app shutdown still force-closes the agent.
	return t.client.call(optionalAgentRequest{
		Method:    method,
		SessionID: t.sessionID,
	}, nil, nil, nil, nil)
}

func (s *optionalDriverAgentSession) Query(query string) ([]map[string]interface{}, []string, error) {
	return s.QueryContext(context.Background(), query)
}

func (s *optionalDriverAgentSession) QueryWithMessages(query string) ([]map[string]interface{}, []string, []string, error) {
	return s.QueryContextWithMessages(context.Background(), query)
}

func (s *optionalDriverAgentSession) StreamQuery(query string, consumer QueryStreamConsumer) error {
	return s.StreamQueryContext(context.Background(), query, consumer)
}

func (s *optionalDriverAgentSession) StreamQueryContext(ctx context.Context, query string, consumer QueryStreamConsumer) error {
	if err := s.ensureOpen(); err != nil {
		return err
	}
	err := s.client.callStreamQueryContext(ctx, optionalAgentRequest{
		Method:    optionalAgentMethodStreamQuery,
		SessionID: s.sessionID,
		Query:     query,
		TimeoutMs: timeoutMsFromContext(ctx),
	}, consumer)
	if isOptionalAgentStreamUnsupportedError(err) {
		logger.Warnf("%s 驱动代理事务会话暂不支持流式查询，回退到缓冲模式：err=%v", driverDisplayName(s.driver), err)
		data, columns, queryErr := s.QueryContext(ctx, query)
		if queryErr != nil {
			return queryErr
		}
		if err := consumer.SetColumns(columns); err != nil {
			return err
		}
		for _, row := range data {
			if err := consumer.ConsumeRow(row); err != nil {
				return err
			}
		}
		return nil
	}
	return err
}

func (s *optionalDriverAgentSession) Exec(query string) (int64, error) {
	return s.ExecContext(context.Background(), query)
}

func (s *optionalDriverAgentSession) ExecContext(ctx context.Context, query string) (int64, error) {
	if err := s.ensureOpen(); err != nil {
		return 0, err
	}
	var affected int64
	if err := s.client.callContext(ctx, optionalAgentRequest{
		Method:    optionalAgentMethodExec,
		SessionID: s.sessionID,
		Query:     query,
		TimeoutMs: timeoutMsFromContext(ctx),
	}, nil, nil, nil, &affected); err != nil {
		return 0, err
	}
	return affected, nil
}

func (s *optionalDriverAgentSession) Close() error {
	if s == nil {
		return nil
	}
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return nil
	}
	s.closed = true
	sessionID := s.sessionID
	s.mu.Unlock()
	return s.client.callWithTimeout(optionalAgentRequest{
		Method:    optionalAgentMethodCloseSession,
		SessionID: sessionID,
	}, nil, nil, nil, nil, s.client.shutdownCallTimeout())
}

func (s *optionalDriverAgentSession) ensureOpen() error {
	if s == nil || s.client == nil {
		return fmt.Errorf("连接未打开")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed || strings.TrimSpace(s.sessionID) == "" {
		return fmt.Errorf("%s 事务会话已关闭", driverDisplayName(s.driver))
	}
	return nil
}
