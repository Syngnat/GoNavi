package sync

import (
	"context"
	"testing"

	"GoNavi-Wails/internal/connection"
)

func TestHiveSourceQueryNeverInfersUnknownComplexShapeFromTarget(t *testing.T) {
	for _, test := range []struct{ bare, target string }{
		{"array", "array<int>"}, {"map", "map<string,string>"}, {"struct", "struct<a:int>"}, {"uniontype", "uniontype<int,string>"},
	} {
		t.Run(test.bare, func(t *testing.T) {
			source := newHiveSyncTestDB("src", []connection.ColumnDefinition{{Name: "payload", Type: test.bare}}, []map[string]interface{}{{"payload": "[1]"}})
			target := newHiveSyncTestDB("dst", []connection.ColumnDefinition{{Name: "payload", Type: test.target}}, nil)
			config := hiveTestConfig("full_overwrite")
			config.SourceQuery = "SELECT payload FROM events"
			useHiveSyncTestDBs(t, source, target)
			result := NewSyncEngine(Reporter{}).RunSyncContext(context.Background(), config)
			if result.Success {
				t.Fatalf("unknown source shape inferred from target: %+v", result)
			}
			assertHiveNoWrites(t, target)
		})
	}
}

func TestHiveStreamOwnsNativeNestedCollectionBuffers(t *testing.T) {
	var copied []map[string]interface{}
	consumer := &hiveSyncStreamConsumer{ctx: context.Background(), batchSize: 1, consume: func(rows []map[string]interface{}) error { copied = append(copied, rows...); return nil }}
	if err := consumer.SetColumns([]string{"payload"}); err != nil {
		t.Fatal(err)
	}
	members := []interface{}{int64(1), []byte{0, 255}}
	payload := map[string]interface{}{"values": members}
	if err := consumer.ConsumeRow(map[string]interface{}{"payload": payload}); err != nil {
		t.Fatal(err)
	}
	members[0] = int64(2)
	members[1].([]byte)[0] = 3
	values := copied[0]["payload"].(map[string]interface{})["values"].([]interface{})
	if values[0] != int64(1) || values[1].([]byte)[0] != 0 {
		t.Fatalf("nested fetch buffers were reused: %#v", values)
	}
}
