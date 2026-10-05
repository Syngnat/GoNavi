//go:build gonavi_full_drivers || gonavi_clickhouse_driver

package db

import (
	"database/sql"
	"errors"
	"time"

	"GoNavi-Wails/internal/ssh"
)

const (
	defaultClickHousePort     = 9000
	defaultClickHouseUser     = "default"
	defaultClickHouseDatabase = "default"
	// clickhouse-go replaces a zero ReadTimeout with five minutes. Max duration
	// keeps context cancellation as the only practical automatic query deadline.
	clickHouseNoAutomaticReadTimeout = time.Duration(1<<63 - 1)
	clickHouseHTTPPortHint           = "8123/8125/8132/8443"

	clickHouseProtocolAuto   = "auto"
	clickHouseProtocolHTTP   = "http"
	clickHouseProtocolNative = "native"
)

type ClickHouseDB struct {
	conn        *sql.DB
	legacyHTTP  *clickHouseLegacyHTTPClient
	pingTimeout time.Duration
	forwarder   *ssh.LocalForwarder
	database    string
}

var _ BatchApplierContext = (*ClickHouseDB)(nil)

var errClickHouseWritePreflightStopped = errors.New("ClickHouse write stopped before dispatch")

type clickHouseWriteCauseError struct {
	message string
	cause   error
}

func (err *clickHouseWriteCauseError) Error() string {
	if err == nil {
		return ""
	}
	return err.message
}

func (err *clickHouseWriteCauseError) Unwrap() error {
	if err == nil {
		return nil
	}
	return err.cause
}

func preserveClickHouseWriteCause(messageErr, cause error) error {
	if messageErr == nil {
		return cause
	}
	if cause == nil {
		return messageErr
	}
	return &clickHouseWriteCauseError{message: messageErr.Error(), cause: cause}
}
