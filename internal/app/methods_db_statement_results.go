package app

import (
	"strings"
	"time"

	"GoNavi-Wails/internal/connection"
)

func newStatementExecutionResults(statements []string) []connection.StatementExecutionResult {
	results := make([]connection.StatementExecutionResult, 0, len(statements))
	for _, statement := range statements {
		if strings.TrimSpace(statement) == "" {
			continue
		}
		results = append(results, connection.StatementExecutionResult{
			StatementIndex: len(results) + 1,
			Status:         connection.StatementResultSkipped,
		})
	}
	return results
}

func statementAffectedRows(value int64) *int64 {
	return &value
}

func updateStatementExecutionResult(
	results []connection.StatementExecutionResult,
	statementIndex int,
	status string,
	affectedRows *int64,
	rowsReturned int64,
	duration time.Duration,
	err error,
) {
	if statementIndex < 1 || statementIndex > len(results) {
		return
	}
	result := &results[statementIndex-1]
	result.Status = status
	result.AffectedRows = affectedRows
	result.RowsReturned = rowsReturned
	result.DurationMs = duration.Milliseconds()
	result.Error = ""
	if err != nil {
		result.Error = err.Error()
	}
}

func nativeStatementExecutionResults(
	statements []string,
	nativeResults []connection.ResultSetData,
	executedCount int,
	failedIndex int,
	exactPrefix bool,
	outcomeUnknown bool,
	failureErr error,
) []connection.StatementExecutionResult {
	results := newStatementExecutionResults(statements)
	if !exactPrefix || len(nativeResults) == 0 {
		for index := range results {
			results[index].Status = connection.StatementResultUnknown
			if failureErr != nil {
				results[index].Error = failureErr.Error()
			}
		}
		return results
	}
	for index := 1; index <= executedCount; index++ {
		affectedRows, rowsReturned := nativeStatementResultMetrics(nativeResults, index)
		updateStatementExecutionResult(results, index, connection.StatementResultSuccess, affectedRows, rowsReturned, 0, nil)
	}
	if failedIndex > 0 {
		status := connection.StatementResultFailed
		if outcomeUnknown {
			status = connection.StatementResultUnknown
		}
		updateStatementExecutionResult(results, failedIndex, status, nil, 0, 0, failureErr)
		for index := failedIndex; index < len(results); index++ {
			if results[index].Status == connection.StatementResultSkipped {
				results[index].Status = connection.StatementResultUnknown
			}
		}
		return results
	}
	for index := range results {
		if results[index].Status == connection.StatementResultSuccess {
			results[index].Status = connection.StatementResultUnknown
			if failureErr != nil {
				results[index].Error = failureErr.Error()
			}
		}
	}
	return results
}

func nativeSuccessStatementExecutionResults(
	statements []string,
	nativeResults []connection.ResultSetData,
) []connection.StatementExecutionResult {
	results := newStatementExecutionResults(statements)
	for index := range results {
		affectedRows, rowsReturned := nativeStatementResultMetrics(nativeResults, index+1)
		updateStatementExecutionResult(results, index+1, connection.StatementResultSuccess, affectedRows, rowsReturned, 0, nil)
	}
	return results
}

func nativeStatementResultMetrics(
	nativeResults []connection.ResultSetData,
	statementIndex int,
) (*int64, int64) {
	var (
		affectedRows  int64
		rowsReturned  int64
		foundAffected bool
	)
	for _, resultSet := range nativeResults {
		if resultSet.StatementIndex != statementIndex {
			continue
		}
		if isAffectedRowsResultSet(resultSet) && len(resultSet.Rows) > 0 {
			if affected, ok := parseStatementAffectedRows(resultSet.Rows[0]["affectedRows"]); ok {
				affectedRows += affected
				foundAffected = true
			}
			continue
		}
		rowsReturned += int64(len(resultSet.Rows))
	}
	if !foundAffected {
		return nil, rowsReturned
	}
	return statementAffectedRows(affectedRows), rowsReturned
}

func parseStatementAffectedRows(value interface{}) (int64, bool) {
	switch affectedRows := value.(type) {
	case int:
		return int64(affectedRows), true
	case int32:
		return int64(affectedRows), true
	case int64:
		return affectedRows, true
	case uint:
		return int64(affectedRows), true
	case uint32:
		return int64(affectedRows), true
	case uint64:
		return int64(affectedRows), true
	case float64:
		return int64(affectedRows), true
	default:
		return 0, false
	}
}

func managedObservationStatementResults(
	statements []string,
	observations []managedSQLStatementObservation,
	rollbackState string,
) []connection.StatementExecutionResult {
	results := newStatementExecutionResults(statements)
	for _, observation := range observations {
		status := connection.StatementResultSuccess
		if observation.Err != nil {
			status = connection.StatementResultFailed
		}
		var affectedRows *int64
		if observation.AffectedRowsKnown {
			affectedRows = statementAffectedRows(observation.RowsAffected)
		}
		updateStatementExecutionResult(
			results,
			observation.StatementIndex,
			status,
			affectedRows,
			observation.RowsReturned,
			observation.Duration,
			observation.Err,
		)
	}
	if rollbackState == "" {
		return results
	}
	for index := range results {
		if results[index].Status == connection.StatementResultSkipped {
			continue
		}
		if rollbackState == connection.StatementResultRolledBack {
			if results[index].Status != connection.StatementResultSuccess {
				continue
			}
			results[index].Status = connection.StatementResultRolledBack
			continue
		}
		results[index].Status = connection.StatementResultUnknown
	}
	return results
}
