package db

import (
	"context"
	"errors"
	"fmt"

	"GoNavi-Wails/internal/connection"
)

var errSessionExecContextUnsupported = errors.New("database session action requires context-aware execution")

// SessionOperator is the optional server-session capability used by the app
// binding. It deliberately stays outside the broad Database contract.
type SessionOperator interface {
	ListSessions(context.Context) (connection.SessionListPayload, error)
	ExecuteSessionAction(context.Context, connection.SessionActionRequest) error
}

type databaseSessionOperator struct {
	database Database
	config   connection.ConnectionConfig
	spec     sessionSpec
}

// NewSessionOperator returns an adapter for one already-open isolated database
// instance. Unsupported engines return a capability-bearing operator whose
// ListSessions result is empty and which rejects actions.
func NewSessionOperator(database Database, config connection.ConnectionConfig) SessionOperator {
	return &databaseSessionOperator{
		database: database,
		config:   config,
		spec:     sessionSpecFor(config),
	}
}

func (o *databaseSessionOperator) ListSessions(ctx context.Context) (connection.SessionListPayload, error) {
	ctx = normalizeSessionContext(ctx)
	payload := connection.SessionListPayload{
		Engine:     o.spec.engine,
		Capability: o.spec.capability,
		Sessions:   []connection.DatabaseSession{},
	}
	if !o.spec.capability.Supported {
		return payload, nil
	}
	if o.database == nil {
		return payload, errorsForMissingSessionDatabase()
	}
	rows, err := o.querySessionRows(ctx)
	if err != nil {
		return payload, fmt.Errorf("list database sessions: %w", err)
	}
	payload.Sessions = normalizeSessionRows(o.spec, rows, o.config.Database)
	return payload, nil
}

// querySessionRows runs the primary list query, then each version fallback.
// The primary error is the one reported when everything fails, because it
// comes from the view current servers are expected to have.
func (o *databaseSessionOperator) querySessionRows(ctx context.Context) ([]map[string]interface{}, error) {
	rows, _, primaryErr := querySessionContext(ctx, o.database, o.spec.listQuery)
	if primaryErr == nil {
		return rows, nil
	}
	for _, query := range o.spec.fallbackListQueries {
		if ctx.Err() != nil {
			break
		}
		if rows, _, err := querySessionContext(ctx, o.database, query); err == nil {
			return rows, nil
		}
	}
	return nil, primaryErr
}

func (o *databaseSessionOperator) ExecuteSessionAction(
	ctx context.Context,
	request connection.SessionActionRequest,
) error {
	ctx = normalizeSessionContext(ctx)
	if err := ctx.Err(); err != nil {
		return err
	}
	if o.database == nil {
		return errorsForMissingSessionDatabase()
	}
	statement, err := buildSessionActionStatement(o.spec, request)
	if err != nil {
		return fmt.Errorf("prepare database session action: %w", err)
	}
	if err := executeSessionActionStatement(ctx, o.database, statement); err != nil {
		return fmt.Errorf("execute database session action: %w", err)
	}
	return nil
}

func querySessionContext(
	ctx context.Context,
	database Database,
	query string,
) ([]map[string]interface{}, []string, error) {
	ctx = normalizeSessionContext(ctx)
	if queryer, ok := database.(QueryContexter); ok {
		return queryer.QueryContext(ctx, query)
	}
	BindMetadataContext(database, ctx)
	defer ClearMetadataContext(database)
	return database.Query(query)
}

func execSessionContext(ctx context.Context, database Database, query string) (int64, error) {
	ctx = normalizeSessionContext(ctx)
	if execer, ok := database.(ExecContexter); ok {
		return execer.ExecContext(ctx, query)
	}
	return 0, errSessionExecContextUnsupported
}

func errorsForMissingSessionDatabase() error {
	return errors.New("database session adapter requires an open connection")
}

func normalizeSessionContext(ctx context.Context) context.Context {
	if ctx == nil {
		return context.Background()
	}
	return ctx
}
