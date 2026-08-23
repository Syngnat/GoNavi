package synccdc

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"GoNavi-Wails/internal/connection"
)

type Position struct {
	Adapter string          `json:"adapter"`
	Opaque  json.RawMessage `json:"opaque"`
}

type Barrier struct {
	Position      Position        `json:"position"`
	SnapshotToken json.RawMessage `json:"snapshotToken,omitempty"`
}

type ObjectRef struct {
	Database string `json:"database,omitempty"`
	Schema   string `json:"schema,omitempty"`
	Name     string `json:"name"`
}

type Event struct {
	Object     ObjectRef              `json:"object"`
	Operation  string                 `json:"operation"`
	Key        map[string]interface{} `json:"key,omitempty"`
	Before     map[string]interface{} `json:"before,omitempty"`
	After      map[string]interface{} `json:"after,omitempty"`
	CommitTime time.Time              `json:"commitTime"`
	SourceTxID string                 `json:"sourceTxId,omitempty"`
}

type Transaction struct {
	Events   []Event  `json:"events"`
	Position Position `json:"position"`
}

type Request struct {
	Config   connection.ConnectionConfig `json:"-"`
	Objects  []ObjectRef                 `json:"objects"`
	Database string                      `json:"database,omitempty"`
	Schema   string                      `json:"schema,omitempty"`
}

type Capability struct {
	Adapter                     string   `json:"adapter"`
	SourceType                  string   `json:"sourceType"`
	Supported                   bool     `json:"supported"`
	Ready                       bool     `json:"ready"`
	Reason                      string   `json:"reason,omitempty"`
	RequiredSettings            []string `json:"requiredSettings,omitempty"`
	SupportsInitialSnapshot     bool     `json:"supportsInitialSnapshot"`
	SupportsSchemaEvents        bool     `json:"supportsSchemaEvents"`
	PreservesSourceTransactions bool     `json:"preservesSourceTransactions"`
	RequiresCausalSnapshotReads bool     `json:"requiresCausalSnapshotReads"`
	SnapshotSemantics           string   `json:"snapshotSemantics,omitempty"`
	DeliverySemantics           string   `json:"deliverySemantics,omitempty"`
	AcknowledgementSemantics    string   `json:"acknowledgementSemantics,omitempty"`
}

type Stream interface {
	Next(context.Context) (Transaction, error)
	Acknowledge(context.Context, Position) error
	Close() error
}

type Adapter interface {
	Name() string
	SourceTypes() []string
	Probe(context.Context, connection.ConnectionConfig) (Capability, error)
	BeginSnapshot(context.Context, Request) (Barrier, error)
	Open(context.Context, Request, Position) (Stream, error)
}

var ErrAdapterNotRegistered = errors.New("CDC adapter is not registered in this build")

func ValidatePosition(position Position, adapterName string) error {
	if strings.TrimSpace(position.Adapter) == "" {
		return errors.New("CDC position adapter is required")
	}
	if !strings.EqualFold(strings.TrimSpace(position.Adapter), strings.TrimSpace(adapterName)) {
		return fmt.Errorf("CDC position adapter %q does not match %q", position.Adapter, adapterName)
	}
	if len(position.Opaque) == 0 || !json.Valid(position.Opaque) {
		return errors.New("CDC position payload must be valid JSON")
	}
	return nil
}
