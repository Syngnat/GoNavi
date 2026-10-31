package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"testing"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
)

func TestHiveAgentExactNumericRequest(t *testing.T) {
	previous := agentDriverType
	agentDriverType = "hive"
	t.Cleanup(func() { agentDriverType = previous })
	raw := []byte("{\"method\":\"applyChanges\",\"changes\":{\"inserts\":[{\"id\":9223372036854775807,\"amount\":12345678901234567890.001}]}}")
	var req agentRequest
	if err := decodeAgentRequestJSON(raw, &req); err != nil {
		t.Fatal(err)
	}
	for key, want := range map[string]string{"id": "9223372036854775807", "amount": "12345678901234567890.001"} {
		got, ok := req.Changes.Inserts[0][key].(json.Number)
		if !ok || got.String() != want {
			t.Fatalf("%s lost precision: %T %v", key, req.Changes.Inserts[0][key], req.Changes.Inserts[0][key])
		}
	}
}

type hiveAgentFake struct {
	db.Database
	seen context.Context
}

func (f *hiveAgentFake) HiveTableWriteCapabilities(ctx context.Context, table string) (db.HiveTableWriteCapabilities, error) {
	f.seen = ctx
	if err := ctx.Err(); err != nil {
		return db.HiveTableWriteCapabilities{}, err
	}
	return db.HiveTableWriteCapabilities{Family: "hive", Insert: true, PartitionColumns: []string{"p"}}, nil
}
func (f *hiveAgentFake) HiveViews(ctx context.Context, database string) ([]string, error) {
	f.seen = ctx
	return []string{"v"}, ctx.Err()
}
func (f *hiveAgentFake) ApplyChanges(string, connection.ChangeSet) error {
	return errors.New("non-context applier must not run")
}
func (f *hiveAgentFake) ApplyChangesContext(ctx context.Context, _ string, _ connection.ChangeSet) error {
	f.seen = ctx
	return ctx.Err()
}

func TestHiveAgentCapabilityAndCancellationDispatch(t *testing.T) {
	inst := &hiveAgentFake{}
	state := &agentRuntime{inst: inst}
	response, handled := handleHiveAgentRequest(context.Background(), state, agentRequest{Method: "hiveTableWriteCapabilities", TableName: "d.t"}, agentResponse{Success: true})
	if !handled || !response.Success {
		t.Fatalf("response=%+v handled=%v", response, handled)
	}
	caps, ok := response.Data.(db.HiveTableWriteCapabilities)
	if !ok || !caps.Insert || caps.AtomicBatch || len(caps.PartitionColumns) != 1 {
		t.Fatalf("capabilities=%+v", response.Data)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	response, handled = handleHiveAgentRequest(ctx, state, agentRequest{Method: "hiveViews"}, agentResponse{Success: true})
	if !handled || response.Success || !errors.Is(inst.seen.Err(), context.Canceled) {
		t.Fatalf("canceled view response=%+v", response)
	}
	response = handleAgentApplyChanges(ctx, inst, agentRequest{Changes: &connection.ChangeSet{}}, agentResponse{Success: true})
	if response.Success || inst.seen != ctx {
		t.Fatalf("context-aware apply response=%+v", response)
	}
}

func TestHiveAgentStreamColumnTypes(t *testing.T) {
	previous := agentDriverType
	agentDriverType = "hive"
	t.Cleanup(func() { agentDriverType = previous })
	var output bytes.Buffer
	writer := newAgentResponseWriter(bufio.NewWriter(&output))
	base := newAgentStreamResponseWriter(writer, 1)
	stream := hiveAgentStreamSink(base)
	if err := stream.SetColumns([]string{"amount"}); err != nil {
		t.Fatal(err)
	}
	if output.Len() != 0 {
		t.Fatal("Hive emitted incomplete metadata before types were known")
	}
	typed, ok := stream.(db.HiveStreamColumnDefinitionConsumer)
	if !ok {
		t.Fatal("typed Hive stream sink missing")
	}
	if err := typed.SetColumnDefinitions([]connection.ColumnDefinition{{Name: "amount", Type: "DECIMAL(38,10)"}}); err != nil {
		t.Fatal(err)
	}
	if err := stream.ConsumeRow(map[string]interface{}{"amount": "1.0000000001"}); err != nil {
		t.Fatal(err)
	}
	if err := base.finish(); err != nil {
		t.Fatal(err)
	}
	scanner := bufio.NewScanner(&output)
	columns := 0
	for scanner.Scan() {
		var decoded struct {
			ChunkType string
			Data      json.RawMessage
		}
		if err := json.Unmarshal(scanner.Bytes(), &decoded); err != nil {
			t.Fatal(err)
		}
		if decoded.ChunkType == "columns" {
			columns++
			var defs []connection.ColumnDefinition
			if err := json.Unmarshal(decoded.Data, &defs); err != nil || len(defs) != 1 || defs[0].Type != "DECIMAL(38,10)" {
				t.Fatalf("typed frame=%s error=%v", decoded.Data, err)
			}
		}
	}
	if columns != 1 {
		t.Fatalf("Hive metadata must be one frame, got %d", columns)
	}
}
