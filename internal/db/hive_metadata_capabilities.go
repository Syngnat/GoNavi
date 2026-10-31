package db

import (
	"context"
	"encoding/json"
	"fmt"

	"GoNavi-Wails/internal/connection"
)

// HiveViewProvider enumerates native HiveServer2 view metadata without SHOW VIEWS assumptions.
type HiveViewProvider interface {
	HiveViews(ctx context.Context, dbName string) ([]string, error)
}

const hiveAgentMethodViews = "hiveViews"

// HiveViews delegates protocol-native view enumeration to the Hive agent.
func (d *OptionalDriverAgentDB) HiveViews(ctx context.Context, dbName string) ([]string, error) {
	client, err := d.requireClient()
	if err != nil {
		return nil, err
	}
	var views []string
	err = client.callContext(ctx, optionalAgentRequest{Method: hiveAgentMethodViews, DBName: dbName}, &views, nil, nil, nil)
	return views, err
}

// HiveStreamColumnDefinitionConsumer is the optional typed streaming callback.
// It runs before any rows; consumers can reject lossy cross-engine type mappings.
type HiveStreamColumnDefinitionConsumer interface {
	SetColumnDefinitions([]connection.ColumnDefinition) error
}

func consumeHiveStreamDefinitions(raw []byte, consumer QueryStreamConsumer) error {
	if len(raw) == 0 || string(raw) == "null" {
		return nil
	}
	typed, ok := consumer.(HiveStreamColumnDefinitionConsumer)
	if !ok {
		return nil
	}
	var columns []connection.ColumnDefinition
	if err := json.Unmarshal(raw, &columns); err != nil {
		return fmt.Errorf("decode Hive stream column definitions: %w", err)
	}
	return typed.SetColumnDefinitions(columns)
}
