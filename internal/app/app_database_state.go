package app

import (
	"context"
	"sync"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
)

type cachedDatabase struct {
	inst                      db.Database
	lastPing                  time.Time
	lastKeepAliveAt           time.Time
	config                    connection.ConnectionConfig
	keepAliveEnabled          bool
	keepAliveInterval         time.Duration
	keepAliveSQL              string
	keepAliveDBType           string
	keepAliveRevision         uint64
	keepAliveInFlight         bool
	keepAliveInFlightRevision uint64
}

type cachedConnectFailure struct {
	occurredAt      time.Time
	err             error
	releaseMatchKey string
}

type databaseConnectFlight struct {
	id              uint64
	groupKey        string
	cacheKey        string
	releaseMatchKey string
	driverType      string
	cancelErr       error
}

type databaseConnectResult struct {
	inst     db.Database
	cacheKey string
}

type queryContext struct {
	cancel                  context.CancelFunc
	started                 time.Time
	retainUntilDone         bool
	cancellationUnsupported bool
	registrationID          uint64
	driverType              string
}

type managedSQLTransaction struct {
	mu           sync.Mutex
	id           string
	execer       db.StatementExecer
	transactor   db.TransactionExecer
	cancel       context.CancelFunc
	config       connection.ConnectionConfig
	dbType       string
	boundaryMode string
	auditSource  string
	auditActor   string
	auditRunID   string
	owner        string
	commitSQL    string
	rollbackSQL  string
	createdAt    time.Time
	finished     bool
}
