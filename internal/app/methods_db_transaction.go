package app

import (
	"time"

	"GoNavi-Wails/internal/sqlaudit"
)

const sqlEditorTransactionFinishTimeout = 30 * time.Second

type managedSQLStatementObservation struct {
	Statement      string
	StatementIndex int
	StatementCount int
	StartedAt      time.Time
	CompletedAt    time.Time
	Duration       time.Duration
	RowsAffected   int64
	RowsReturned   int64
	Err            error
}

type managedSQLStatementObserver func(managedSQLStatementObservation)

func withManagedSQLStatementAuditTimestamp(
	observer managedSQLStatementObserver,
	events *[]sqlaudit.Event,
) managedSQLStatementObserver {
	if observer == nil {
		return nil
	}
	return func(observation managedSQLStatementObservation) {
		before := 0
		if events != nil {
			before = len(*events)
		}
		observer(observation)
		if events == nil || observation.CompletedAt.IsZero() {
			return
		}
		for index := before; index < len(*events); index++ {
			(*events)[index].Timestamp = observation.CompletedAt.UnixMilli()
		}
	}
}
