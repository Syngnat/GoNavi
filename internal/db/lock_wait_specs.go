package db

import "GoNavi-Wails/internal/connection"

// lockWaitSpecFor routes on the same normalized engine as the session
// workbench, so a connection's sessions and lock waits always agree on which
// server dialect they are talking to.
func lockWaitSpecFor(config connection.ConnectionConfig) lockWaitSpec {
	engine, sessionCapability := SessionCapabilityFor(config)
	switch engine {
	case "mysql":
		return mysqlLockWaitSpec()
	case "mariadb":
		return mariaDBLockWaitSpec()
	case "postgres", "kingbase", "highgo":
		return postgresLockWaitSpec(engine)
	case "vastbase", "opengauss", "gaussdb", "gbase8c":
		return openGaussLockWaitSpec(engine)
	case "oceanbase-mysql":
		return oceanBaseMySQLLockWaitSpec()
	case "oceanbase-oracle":
		return oceanBaseOracleLockWaitSpec()
	case "dameng":
		return damengLockWaitSpec()
	case "yashandb":
		return yashanDBLockWaitSpec()
	case "oracle":
		return oracleLockWaitSpec()
	case "sqlserver":
		return sqlServerLockWaitSpec()
	}
	// Engines without a session list are N/A for the same reason; engines that
	// list sessions but expose no reliable waiter→holder view are unsupported.
	reason := sessionCapability.ReasonCode
	if sessionCapability.Supported || reason == "" {
		reason = sessionReasonUnsupported
	}
	return lockWaitSpec{engine: engine, capability: connection.LockWaitCapability{ReasonCode: reason}}
}

func supportedLockWaitSpec(engine string, sources ...lockWaitSource) lockWaitSpec {
	return lockWaitSpec{
		engine:     engine,
		capability: connection.LockWaitCapability{Supported: true},
		sources:    sources,
	}
}

func requiredLockWaitSource(variants ...string) lockWaitSource {
	return lockWaitSource{variants: variants}
}

func optionalLockWaitSource(variants ...string) lockWaitSource {
	return lockWaitSource{variants: variants, optional: true}
}
