//go:build gonavi_full_drivers || gonavi_hive_driver

package db

import (
	"context"
	"errors"

	"github.com/apache/thrift/lib/go/thrift"
)

func hiveWriteOutcomeError(ctx context.Context, err error) error {
	if err == nil {
		return nil
	}
	var transport thrift.TTransportException
	var protocol thrift.TProtocolException
	if errors.As(err, &transport) || errors.As(err, &protocol) {
		return MarkWriteOutcomeUnknown(err)
	}
	return markWriteOutcomeUnknownIfAmbiguous(ctx, err)
}
