package db

import (
	"context"
	"fmt"

	"GoNavi-Wails/internal/connection"
)

// LockWaitInspector is the optional lock-wait capability used by the session
// workbench. Like SessionOperator it stays outside the Database contract and
// works through one generic adapter over per-engine SQL.
type LockWaitInspector interface {
	ListLockWaits(context.Context) (connection.LockWaitPayload, error)
}

// lockWaitSource is one family of waits (row locks, metadata locks, ...).
// Variants cover server versions whose system views differ; the first one
// that runs wins. An optional source is skipped when every variant fails, for
// instrumentation a server may have switched off.
type lockWaitSource struct {
	variants []string
	optional bool
}

type lockWaitSpec struct {
	engine     string
	capability connection.LockWaitCapability
	sources    []lockWaitSource
	// filterCompatibleModes drops edges whose held mode cannot conflict with
	// the requested one. Only needed where the query pairs holders and waiters
	// on the lock tag alone instead of asking the server who blocks whom.
	filterCompatibleModes bool
}

type databaseLockWaitInspector struct {
	database Database
	config   connection.ConnectionConfig
	spec     lockWaitSpec
}

// LockWaitCapabilityFor returns the normalized engine name and its lock-wait
// contract without opening a database connection.
func LockWaitCapabilityFor(config connection.ConnectionConfig) (string, connection.LockWaitCapability) {
	spec := lockWaitSpecFor(config)
	return spec.engine, spec.capability
}

// NewLockWaitInspector returns an adapter for one already-open isolated
// database instance. Unsupported engines list nothing.
func NewLockWaitInspector(database Database, config connection.ConnectionConfig) LockWaitInspector {
	return &databaseLockWaitInspector{
		database: database,
		config:   config,
		spec:     lockWaitSpecFor(config),
	}
}

func (i *databaseLockWaitInspector) ListLockWaits(ctx context.Context) (connection.LockWaitPayload, error) {
	ctx = normalizeSessionContext(ctx)
	payload := connection.LockWaitPayload{
		Engine:     i.spec.engine,
		Capability: i.spec.capability,
		Waits:      []connection.DatabaseLockWait{},
	}
	if !i.spec.capability.Supported {
		return payload, nil
	}
	if i.database == nil {
		return payload, errorsForMissingSessionDatabase()
	}
	var rows []map[string]interface{}
	for index, source := range i.spec.sources {
		sourceRows, err := i.querySource(ctx, source)
		if err != nil {
			if source.optional && ctx.Err() == nil {
				continue
			}
			return payload, fmt.Errorf("list lock waits (source %d): %w", index+1, err)
		}
		rows = append(rows, sourceRows...)
	}
	payload.Waits = normalizeLockWaitRows(i.spec, rows)
	return payload, nil
}

// querySource reports the first variant's error when every variant fails,
// because it targets the view current servers are expected to have.
func (i *databaseLockWaitInspector) querySource(
	ctx context.Context,
	source lockWaitSource,
) ([]map[string]interface{}, error) {
	var firstErr error
	for _, query := range source.variants {
		if err := ctx.Err(); err != nil {
			if firstErr == nil {
				firstErr = err
			}
			break
		}
		rows, _, err := querySessionContext(ctx, i.database, query)
		if err == nil {
			return rows, nil
		}
		if firstErr == nil {
			firstErr = err
		}
	}
	return nil, firstErr
}
