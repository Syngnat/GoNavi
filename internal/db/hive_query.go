//go:build gonavi_full_drivers || gonavi_hive_driver

package db

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/hivesql"
)

import hs "github.com/beltran/gohive/hiveserver"

var errHiveBudgetStop = errors.New("Hive result budget exhausted")

// normalizeHiveStatement trims a trailing statement terminator. HiveServer2
// ExecuteStatement accepts one statement and rejects a trailing semicolon.
func normalizeHiveStatement(query string) string {
	return strings.TrimRight(strings.TrimSpace(query), "; \t\r\n")
}

func (s *hiveSession) Query(query string) ([]map[string]interface{}, []string, error) {
	return s.QueryContext(context.Background(), query)
}
func (s *hiveSession) QueryContext(ctx context.Context, query string) ([]map[string]interface{}, []string, error) {
	collector := &hiveRowCollector{budget: RowBudgetFromContext(ctx)}
	err := s.run(ctx, func(ctx context.Context) error { _, err := s.execute(ctx, query, collector); return err })
	return collector.rows, collector.names, err
}
func (s *hiveSession) Exec(query string) (int64, error) {
	return s.ExecContext(context.Background(), query)
}
func (s *hiveSession) ExecContext(ctx context.Context, query string) (int64, error) {
	affected := int64(-1)
	err := s.run(ctx, func(ctx context.Context) error {
		var err error
		affected, err = s.execute(ctx, query, nil)
		return hiveWriteOutcomeError(ctx, err)
	})
	return affected, err
}
func (s *hiveSession) StreamQuery(query string, consumer QueryStreamConsumer) error {
	return s.StreamQueryContext(context.Background(), query, consumer)
}
func (s *hiveSession) StreamQueryContext(ctx context.Context, query string, consumer QueryStreamConsumer) error {
	if consumer == nil {
		return fmt.Errorf("Hive stream consumer is nil")
	}
	return s.run(ctx, func(ctx context.Context) error { _, err := s.execute(ctx, query, consumer); return err })
}

func (s *hiveSession) execute(ctx context.Context, query string, consumer QueryStreamConsumer) (affected int64, resultErr error) {
	if err := ctx.Err(); err != nil {
		return -1, err
	}
	statement := normalizeHiveStatement(query)
	if statement == "" || len(statement) > 16<<20 {
		return -1, fmt.Errorf("Hive SQL statement is empty or exceeds 16 MiB")
	}
	request := &hs.TExecuteStatementReq{SessionHandle: s.handle, Statement: statement, RunAsync: true}
	if deadline, ok := ctx.Deadline(); ok {
		remaining := time.Until(deadline)
		request.QueryTimeout = int64((remaining + time.Second - 1) / time.Second)
	}
	response, err := s.wire.api.ExecuteStatement(ctx, request)
	if err != nil {
		s.broken = true
		s.cancel()
		return -1, fmt.Errorf("execute Hive statement: %w", err)
	}
	if err = hiveCheckStatus(response.GetStatus()); err != nil {
		return -1, err
	}
	operation := response.OperationHandle
	if operation == nil {
		return -1, fmt.Errorf("HiveServer2 returned no operation handle")
	}
	finished := false
	defer func() {
		cleanupErr := s.cleanupOperation(ctx, operation, resultErr != nil)
		if cleanupErr != nil && finished && consumer == nil {
			cleanupErr = MarkWriteOutcomeUnknown(fmt.Errorf("Hive statement completed before operation cleanup failed; do not replay: %w", cleanupErr))
		}
		resultErr = errors.Join(resultErr, cleanupErr)
	}()
	status, err := s.waitOperation(ctx, operation)
	if err != nil {
		return -1, err
	}
	finished = true
	affected = -1
	if status.NumModifiedRows != nil {
		affected = *status.NumModifiedRows
	} else if operation.ModifiedRowCount != nil {
		affected = int64(*operation.ModifiedRowCount)
	}
	hasResults := operation.HasResultSet
	if status.HasResultSet != nil {
		hasResults = *status.HasResultSet
	}
	if !hasResults || consumer == nil {
		if hivesql.ChangesDatabase(statement) {
			if selected, known := hivesql.SelectedDatabase(statement); known {
				s.database = selected
			} else {
				s.database = ""
			}
		}
		return affected, nil
	}
	if err = s.fetchOperation(ctx, operation, consumer, statement); errors.Is(err, errHiveBudgetStop) {
		return affected, nil
	}
	return affected, err
}

func (s *hiveSession) waitOperation(ctx context.Context, operation *hs.TOperationHandle) (*hs.TGetOperationStatusResp, error) {
	timer := time.NewTimer(s.config.pollInterval)
	defer timer.Stop()
	for {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		response, err := s.wire.api.GetOperationStatus(ctx, &hs.TGetOperationStatusReq{OperationHandle: operation})
		if err != nil {
			s.broken = true
			return nil, err
		}
		if err = hiveCheckStatus(response.GetStatus()); err != nil {
			return nil, err
		}
		if response.OperationState == nil {
			return nil, fmt.Errorf("HiveServer2 returned no operation state")
		}
		switch *response.OperationState {
		case hs.TOperationState_FINISHED_STATE:
			return response, nil
		case hs.TOperationState_INITIALIZED_STATE, hs.TOperationState_RUNNING_STATE, hs.TOperationState_PENDING_STATE:
		case hs.TOperationState_CANCELED_STATE:
			return nil, context.Canceled
		case hs.TOperationState_TIMEDOUT_STATE:
			return nil, context.DeadlineExceeded
		default:
			return nil, &hiveStatusError{state: response.GetSqlState(), code: response.GetErrorCode(), message: response.GetErrorMessage()}
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-timer.C:
			timer.Reset(s.config.pollInterval)
		}
	}
}

func (s *hiveSession) fetchOperation(ctx context.Context, operation *hs.TOperationHandle, consumer QueryStreamConsumer, query ...string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	response, err := s.wire.api.GetResultSetMetadata(ctx, &hs.TGetResultSetMetadataReq{OperationHandle: operation})
	if err != nil {
		s.broken = true
		return err
	}
	if err = hiveCheckStatus(response.GetStatus()); err != nil {
		return err
	}
	columns, err := hiveResultColumns(response.GetSchema())
	if err != nil {
		return err
	}
	if len(query) > 0 && s.enrichColumns != nil {
		columns, err = s.enrichColumns(ctx, query[0], s.database, columns)
		if err != nil {
			return err
		}
	}
	names := make([]string, len(columns))
	for i, column := range columns {
		names[i] = column.Name
	}
	if err = consumer.SetColumns(names); err != nil {
		return err
	}
	if typed, ok := consumer.(interface {
		SetColumnDefinitions([]connection.ColumnDefinition) error
	}); ok {
		if err = typed.SetColumnDefinitions(columns); err != nil {
			return err
		}
	}
	emptyPages := 0
	for {
		if err = ctx.Err(); err != nil {
			return err
		}
		page, fetchErr := s.wire.api.FetchResults(ctx, &hs.TFetchResultsReq{OperationHandle: operation, Orientation: hs.TFetchOrientation_FETCH_NEXT, MaxRows: s.config.fetchSize})
		if fetchErr != nil {
			s.broken = true
			return fetchErr
		}
		if err = hiveCheckStatus(page.GetStatus()); err != nil {
			return err
		}
		count, err := hiveConsumeRows(ctx, page.Results, columns, consumer)
		if err != nil {
			return err
		}
		// Some Hive versions always report hasMoreRows=false. An empty page is the
		// portable EOF signal; never truncate merely because this optional flag is false.
		if count == 0 {
			if !page.GetHasMoreRows() {
				return nil
			}
			emptyPages++
			if emptyPages > 3 {
				return fmt.Errorf("HiveServer2 cursor made no progress")
			}
		} else {
			emptyPages = 0
		}
	}
}

func (s *hiveSession) cleanupOperation(ctx context.Context, operation *hs.TOperationHandle, cancelOperation bool) error {
	cleanupCtx, cancel := context.WithTimeout(context.Background(), hiveCleanupTimeout)
	defer cancel()
	wire := s.wire
	fresh := ctx.Err() != nil || s.broken
	if fresh {
		var err error
		wire, err = openHiveWire(cleanupCtx, s.config, s.serverName)
		if err != nil {
			return fmt.Errorf("open Hive cleanup transport: %w", err)
		}
		defer wire.close()
	}
	stop := func() {}
	if wire.conn != nil {
		stop = watchHiveDeadline(cleanupCtx, wire.conn)
	}
	defer stop()
	var result error
	if cancelOperation || ctx.Err() != nil {
		response, err := wire.api.CancelOperation(cleanupCtx, &hs.TCancelOperationReq{OperationHandle: operation})
		if err == nil {
			err = hiveCheckStatus(response.GetStatus())
		}
		result = errors.Join(result, err)
	}
	response, err := wire.api.CloseOperation(cleanupCtx, &hs.TCloseOperationReq{OperationHandle: operation})
	if err == nil {
		err = hiveCheckStatus(response.GetStatus())
	}
	if err != nil && !fresh {
		s.broken = true
	}
	return errors.Join(result, err)
}
