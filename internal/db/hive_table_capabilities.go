package db

import "context"

// HiveTableWriteCapabilities describes verified table-level write semantics.
// AtomicBatch is false: Hive ACID does not provide a generic multi-statement transaction.
type HiveTableWriteCapabilities struct {
	Family           string            `json:"family"`
	Insert           bool              `json:"insert"`
	Update           bool              `json:"update"`
	Delete           bool              `json:"delete"`
	Truncate         bool              `json:"truncate"`
	Transactional    bool              `json:"transactional"`
	InsertOnly       bool              `json:"insertOnly"`
	AtomicBatch      bool              `json:"atomicBatch"`
	Reason           string            `json:"reason,omitempty"`
	Properties       map[string]string `json:"properties,omitempty"`
	PartitionColumns []string          `json:"partitionColumns,omitempty"`
}

// HiveTableWriteCapabilityProvider verifies storage and table properties before mutation.
type HiveTableWriteCapabilityProvider interface {
	HiveTableWriteCapabilities(ctx context.Context, tableName string) (HiveTableWriteCapabilities, error)
}

const hiveAgentMethodTableWriteCapabilities = "hiveTableWriteCapabilities"

// HiveTableWriteCapabilities asks the Hive agent to inspect current table metadata.
func (d *OptionalDriverAgentDB) HiveTableWriteCapabilities(ctx context.Context, tableName string) (HiveTableWriteCapabilities, error) {
	client, err := d.requireClient()
	if err != nil {
		return HiveTableWriteCapabilities{}, err
	}
	var result HiveTableWriteCapabilities
	err = client.callContext(ctx, optionalAgentRequest{Method: hiveAgentMethodTableWriteCapabilities, TableName: tableName}, &result, nil, nil, nil)
	return result, err
}
