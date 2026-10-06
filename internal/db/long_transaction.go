package db

import (
	"context"
	"fmt"

	"GoNavi-Wails/internal/connection"
)

// LongTransactionInspector lists sessions holding an open transaction. It
// shares the session workbench's engine routing and row normalization; each
// row's DurationMs is the transaction's age.
type LongTransactionInspector interface {
	ListLongTransactions(context.Context) (connection.LongTransactionPayload, error)
}

type longTransactionSpec struct {
	engine     string
	capability connection.LockWaitCapability
	// variants run in order until one succeeds (server versions differ).
	variants []string
}

type databaseLongTransactionInspector struct {
	database Database
	spec     longTransactionSpec
}

// LongTransactionCapabilityFor returns the normalized engine and whether its
// open transactions can be listed, without opening a connection.
func LongTransactionCapabilityFor(config connection.ConnectionConfig) (string, connection.LockWaitCapability) {
	spec := longTransactionSpecFor(config)
	return spec.engine, spec.capability
}

// NewLongTransactionInspector adapts one already-open isolated database.
func NewLongTransactionInspector(database Database, config connection.ConnectionConfig) LongTransactionInspector {
	return &databaseLongTransactionInspector{database: database, spec: longTransactionSpecFor(config)}
}

func (i *databaseLongTransactionInspector) ListLongTransactions(ctx context.Context) (connection.LongTransactionPayload, error) {
	ctx = normalizeSessionContext(ctx)
	payload := connection.LongTransactionPayload{
		Engine:       i.spec.engine,
		Capability:   i.spec.capability,
		Transactions: []connection.DatabaseSession{},
	}
	if !i.spec.capability.Supported {
		return payload, nil
	}
	if i.database == nil {
		return payload, errorsForMissingSessionDatabase()
	}
	inspector := databaseLockWaitInspector{database: i.database}
	rows, err := inspector.querySource(ctx, lockWaitSource{variants: i.spec.variants})
	if err != nil {
		return payload, fmt.Errorf("list open transactions: %w", err)
	}
	// Ages are reported in milliseconds by every query, so the unit only
	// matters for a bare "time" column, which none of them return.
	sessionShape := sessionSpec{engine: i.spec.engine, durationUnit: sessionDurationMilliseconds, rowDatabaseAuthoritative: true}
	payload.Transactions = normalizeSessionRows(sessionShape, rows, "")
	return payload, nil
}

func longTransactionSpecFor(config connection.ConnectionConfig) longTransactionSpec {
	engine, sessionCapability := SessionCapabilityFor(config)
	supported := func(variants ...string) longTransactionSpec {
		return longTransactionSpec{engine: engine, capability: connection.LockWaitCapability{Supported: true}, variants: variants}
	}
	switch engine {
	case "mysql":
		return supported(mysql8LongTransactionQuery, mysqlLongTransactionQuery)
	case "mariadb":
		return supported(mysqlLongTransactionQuery)
	case "postgres", "kingbase", "highgo", "vastbase", "opengauss", "gaussdb", "gbase8c":
		return supported(postgresLongTransactionQuery)
	case "oracle":
		return supported(oracleLongTransactionQuery)
	case "sqlserver":
		return supported(sqlServerLongTransactionQuery)
	case "yashandb":
		return supported(yashanDBLongTransactionQuery)
	case "oceanbase-mysql":
		return supported(oceanBaseMySQLLongTransactionQuery)
	}
	reason := sessionCapability.ReasonCode
	if sessionCapability.Supported || reason == "" {
		reason = sessionReasonUnsupported
	}
	return longTransactionSpec{engine: engine, capability: connection.LockWaitCapability{ReasonCode: reason}}
}
