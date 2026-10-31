package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
)

// ReadOnlyQueryContexter executes a query within a database-enforced read-only
// transaction. Implementations must fail closed when that boundary is unavailable.
type ReadOnlyQueryContexter interface {
	QueryReadOnlyContext(ctx context.Context, query string) ([]map[string]interface{}, []string, error)
}

var _ ReadOnlyQueryContexter = (*PostgresDB)(nil)

// QueryReadOnlyContext keeps both execution and scanning in a read-only transaction.
func (p *PostgresDB) QueryReadOnlyContext(ctx context.Context, query string) ([]map[string]interface{}, []string, error) {
	return querySQLReadOnlyContext(ctx, p.conn, query)
}

func querySQLReadOnlyContext(ctx context.Context, conn *sql.DB, query string) (data []map[string]interface{}, fields []string, err error) {
	if err := ctx.Err(); err != nil {
		return nil, nil, err
	}
	if conn == nil {
		return nil, nil, errors.New("connection not open")
	}
	tx, err := conn.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return nil, nil, fmt.Errorf("begin read-only transaction: %w", err)
	}
	// Always roll back, including after successful reads and budget truncation.
	// database/sql may already have rolled back a canceled transaction.
	defer func() {
		if contextErr := ctx.Err(); contextErr != nil {
			err = errors.Join(err, contextErr)
		}
		if rollbackErr := tx.Rollback(); rollbackErr != nil && !(errors.Is(rollbackErr, sql.ErrTxDone) && ctx.Err() != nil) {
			err = errors.Join(err, fmt.Errorf("rollback read-only transaction: %w", rollbackErr))
		}
		if err != nil {
			data, fields = nil, nil
		}
	}()
	rows, err := tx.QueryContext(ctx, query)
	if err != nil {
		return nil, nil, fmt.Errorf("query read-only transaction: %w", err)
	}
	defer func() {
		if closeErr := rows.Close(); closeErr != nil {
			err = errors.Join(err, fmt.Errorf("close read-only rows: %w", closeErr))
		}
	}()
	data, fields, err = scanRowsContext(ctx, rows)
	if err != nil {
		err = fmt.Errorf("scan read-only rows: %w", err)
	}
	return data, fields, err
}
