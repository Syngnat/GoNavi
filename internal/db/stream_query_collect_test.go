package db

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"
)

type streamCollectFakeExecer struct {
	columns      []string
	rowValues    [][]interface{}
	rowMaps      []map[string]interface{}
	useValueMode bool
	streamErr    error
	onRow        func(ctx context.Context, index int)
}

func (f *streamCollectFakeExecer) StreamQuery(query string, consumer QueryStreamConsumer) error {
	return f.StreamQueryContext(context.Background(), query, consumer)
}

func (f *streamCollectFakeExecer) StreamQueryContext(ctx context.Context, _ string, consumer QueryStreamConsumer) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := consumer.SetColumns(f.columns); err != nil {
		return err
	}
	if f.useValueMode {
		valueConsumer, ok := consumer.(QueryStreamValueConsumer)
		if !ok {
			return fmt.Errorf("expected QueryStreamValueConsumer")
		}
		for idx, values := range f.rowValues {
			if f.onRow != nil {
				f.onRow(ctx, idx)
			}
			if err := ctx.Err(); err != nil {
				return err
			}
			if err := valueConsumer.ConsumeRowValues(values); err != nil {
				return err
			}
		}
	} else {
		for idx, row := range f.rowMaps {
			if f.onRow != nil {
				f.onRow(ctx, idx)
			}
			if err := ctx.Err(); err != nil {
				return err
			}
			if err := consumer.ConsumeRow(row); err != nil {
				return err
			}
		}
	}
	return f.streamErr
}

func TestCollectStreamQueryWithBudget(t *testing.T) {
	t.Run("unbounded collection preserves empty non-nil rows", func(t *testing.T) {
		streamer := &streamCollectFakeExecer{
			columns:      []string{"id", "name"},
			useValueMode: true,
		}
		rows, cols, err := CollectStreamQueryWithBudget(context.Background(), streamer, "SELECT id, name FROM empty_tbl", nil)
		if err != nil {
			t.Fatalf("CollectStreamQueryWithBudget returned error: %v", err)
		}
		if rows == nil || len(rows) != 0 {
			t.Fatalf("rows = %#v, want empty non-nil slice", rows)
		}
		if !reflect.DeepEqual(cols, []string{"id", "name"}) {
			t.Fatalf("cols = %#v, want [id name]", cols)
		}
	})

	t.Run("max rows truncation cancels stream context and returns prefix", func(t *testing.T) {
		parentCtx := context.Background()
		var observedStreamCtxDone bool
		streamer := &streamCollectFakeExecer{
			columns:      []string{"id", "name"},
			useValueMode: true,
			rowValues: [][]interface{}{
				{int64(1), "a"},
				{int64(2), "b"},
				{int64(3), "c"},
			},
			onRow: func(ctx context.Context, index int) {
				if index == 2 {
					observedStreamCtxDone = ctx.Err() != nil
				}
			},
		}
		budget := NewRowBudgetWithOptions(RowBudgetOptions{
			MaxRowsPerResult: 2,
			MaxTotalRows:     10,
		})
		rows, cols, err := CollectStreamQueryWithBudget(parentCtx, streamer, "SELECT id, name FROM t", budget)
		if err != nil {
			t.Fatalf("CollectStreamQueryWithBudget returned error: %v", err)
		}
		if len(rows) != 2 || rows[0]["id"] != int64(1) || rows[1]["id"] != int64(2) {
			t.Fatalf("rows = %#v, want first 2 rows", rows)
		}
		if !reflect.DeepEqual(cols, []string{"id", "name"}) {
			t.Fatalf("cols = %#v", cols)
		}
		if observedStreamCtxDone {
			t.Fatalf("stream context should still be active before row 3 ConsumeRowValues")
		}
		if !budget.Truncated() || !budget.Exhausted() || !budget.TakeResultTruncated() {
			t.Fatalf("budget flags = truncated:%t exhausted:%t, want both true", budget.Truncated(), budget.Exhausted())
		}
	})

	t.Run("max total bytes stops before overflowing budget via ConsumeRow", func(t *testing.T) {
		sourceRow := map[string]interface{}{"id": int64(1), "payload": strings.Repeat("a", 40)}
		streamer := &streamCollectFakeExecer{
			columns: []string{"id", "payload"},
			rowMaps: []map[string]interface{}{
				{"id": int64(1), "payload": strings.Repeat("a", 40)},
				{"id": int64(2), "payload": strings.Repeat("b", 40)},
				{"id": int64(3), "payload": strings.Repeat("c", 40)},
			},
		}
		rowBytes := estimateQueryRowBytes(sourceRow)
		budget := NewRowBudgetWithOptions(RowBudgetOptions{
			MaxTotalBytes: rowBytes*2 + 5,
		})
		rows, _, err := CollectStreamQueryWithBudget(context.Background(), streamer, "SELECT id, payload FROM t", budget)
		if err != nil {
			t.Fatalf("CollectStreamQueryWithBudget returned error: %v", err)
		}
		if len(rows) != 2 {
			t.Fatalf("len(rows) = %d, want 2", len(rows))
		}
		if !budget.Truncated() || !budget.TakeResultTruncated() {
			t.Fatal("expected budget truncation flag to be set")
		}
	})

	t.Run("max field bytes truncates large field preview without dropping rows", func(t *testing.T) {
		streamer := &streamCollectFakeExecer{
			columns:      []string{"id", "payload"},
			useValueMode: true,
			rowValues: [][]interface{}{
				{int64(1), strings.Repeat("x", 32)},
				{int64(2), "ok"},
			},
		}
		budget := NewRowBudgetWithOptions(RowBudgetOptions{
			MaxFieldBytes: 8,
		})
		rows, _, err := CollectStreamQueryWithBudget(context.Background(), streamer, "SELECT id, payload FROM t", budget)
		if err != nil {
			t.Fatalf("CollectStreamQueryWithBudget returned error: %v", err)
		}
		if len(rows) != 2 {
			t.Fatalf("len(rows) = %d, want 2", len(rows))
		}
		preview, _ := rows[0]["payload"].(string)
		if !strings.HasPrefix(preview, "[TEXT preview: 8/32 bytes] ") {
			t.Fatalf("truncated preview = %q", preview)
		}
		if !budget.Truncated() || budget.Exhausted() || !budget.TakeResultTruncated() {
			t.Fatalf("expected field truncation only: truncated=%t exhausted=%t", budget.Truncated(), budget.Exhausted())
		}
	})

	t.Run("parent context cancellation is never masked as budget truncation", func(t *testing.T) {
		parentCtx, cancel := context.WithCancel(context.Background())
		streamer := &streamCollectFakeExecer{
			columns:      []string{"id"},
			useValueMode: true,
			rowValues: [][]interface{}{
				{int64(1)},
				{int64(2)},
			},
			onRow: func(_ context.Context, index int) {
				if index == 1 {
					cancel()
				}
			},
		}
		budget := NewRowBudgetWithOptions(RowBudgetOptions{MaxRowsPerResult: 1})
		_, _, err := CollectStreamQueryWithBudget(parentCtx, streamer, "SELECT id FROM t", budget)
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("err = %v, want context.Canceled", err)
		}
	})
}

func TestCollectStreamQueryWithBudgetRecoversAfterLegacyAgentQueryOversize(t *testing.T) {
	var stdin optionalAgentTestWriteCloser
	stdout := strings.Join([]string{
		`{"id":1,"success":false,"error":"` + ErrOptionalDriverAgentJSONLineTooLarge.Error() + `"}`,
		streamTestRequestFrames(2, `[[1,"alice"]]`)[0],
		streamTestRequestFrames(2, `[[1,"alice"]]`)[1],
		`{"id":2,"success":true,"chunkType":"rows","data":[[2,"bob"]]}`,
		streamTestDoneFrame(2),
		`{"id":3,"success":true}`,
	}, "\n") + "\n"

	client := &optionalDriverAgentClient{
		stdin:  &stdin,
		reader: bufio.NewReader(strings.NewReader(stdout)),
		driver: "dameng",
	}
	dbInst := &OptionalDriverAgentDB{driverType: "dameng", client: client}

	_, _, _, err := dbInst.QueryContextWithMessages(context.Background(), `SELECT * FROM "MD_ORG_NB2024"`)
	if !errors.Is(err, ErrOptionalDriverAgentJSONLineTooLarge) {
		t.Fatalf("query err = %v, want ErrOptionalDriverAgentJSONLineTooLarge", err)
	}
	if stopped := client.stoppedError(); stopped != nil {
		t.Fatalf("transport unexpectedly stopped after oversize failure: %v", stopped)
	}

	budget := NewRowBudgetWithOptions(RowBudgetOptions{MaxRowsPerResult: 10})
	rows, cols, err := CollectStreamQueryWithBudget(context.Background(), dbInst, `SELECT * FROM "MD_ORG_NB2024"`, budget)
	if err != nil {
		t.Fatalf("CollectStreamQueryWithBudget failed: %v", err)
	}
	if !reflect.DeepEqual(cols, []string{"id", "name"}) {
		t.Fatalf("cols = %#v, want [id name]", cols)
	}
	if len(rows) != 2 || rows[0]["name"] != "alice" || rows[1]["name"] != "bob" {
		t.Fatalf("rows = %#v", rows)
	}
	if budget.TakeResultTruncated() {
		t.Fatal("budget should not report truncated when all 2 rows fit")
	}
	if pingErr := dbInst.PingContext(context.Background()); pingErr != nil {
		t.Fatalf("ping after stream fallback failed: %v", pingErr)
	}
}

func TestCollectStreamQueryWithBudgetStopsOptionalAgentViaInFlightCancel(t *testing.T) {
	stub := newStreamBudgetCancelAgentStub()
	client := &optionalDriverAgentClient{
		stdin:  stub,
		stdout: stub.stdout,
		reader: bufio.NewReader(stub.stdout),
		driver: "dameng",
	}
	client.setConnectionCapabilities(optionalAgentConnectionInfo{
		ProtocolSchema: OptionalDriverAgentProtocolSchemaV2,
		InFlightCancel: true,
	})
	dbInst := &OptionalDriverAgentDB{driverType: "dameng", client: client}

	budget := NewRowBudgetWithOptions(RowBudgetOptions{MaxRowsPerResult: 2})
	ctx := ContextWithRowBudget(context.Background(), budget)

	rows, cols, err := CollectStreamQueryWithBudget(ctx, dbInst, `SELECT * FROM "BIG_TABLE"`, budget)
	if err != nil {
		t.Fatalf("CollectStreamQueryWithBudget failed: %v", err)
	}
	if !reflect.DeepEqual(cols, []string{"id", "name"}) {
		t.Fatalf("cols = %#v", cols)
	}
	if len(rows) != 2 {
		t.Fatalf("len(rows) = %d, want 2", len(rows))
	}
	if !budget.TakeResultTruncated() {
		t.Fatal("expected budget truncation flag after hitting limit")
	}
	select {
	case targetID := <-stub.cancelSeen:
		if targetID != 1 {
			t.Fatalf("cancel TargetID = %d, want 1", targetID)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for in-flight cancelQuery notification")
	}
	if client.stoppedError() != nil {
		t.Fatalf("transport must stay alive after in-flight cancel: %v", client.stoppedError())
	}
	if pingErr := dbInst.PingContext(context.Background()); pingErr != nil {
		t.Fatalf("ping after budget-canceled stream failed: %v", pingErr)
	}
}

type streamBudgetCancelAgentStub struct {
	mu         sync.Mutex
	stdout     *io.PipeReader
	pipeWriter *io.PipeWriter
	cancelSeen chan int64
	streamID   int64
}

func newStreamBudgetCancelAgentStub() *streamBudgetCancelAgentStub {
	reader, writer := io.Pipe()
	return &streamBudgetCancelAgentStub{
		stdout:     reader,
		pipeWriter: writer,
		cancelSeen: make(chan int64, 4),
	}
}

func (s *streamBudgetCancelAgentStub) Write(payload []byte) (int, error) {
	line := strings.TrimSpace(string(payload))
	if line == "" {
		return len(payload), nil
	}
	var req optionalAgentRequest
	if err := json.Unmarshal([]byte(line), &req); err != nil {
		return 0, err
	}
	switch req.Method {
	case optionalAgentMethodStreamQuery:
		s.mu.Lock()
		s.streamID = req.ID
		s.mu.Unlock()
		go func(id int64) {
			frames := strings.Join([]string{
				streamTestRequestFrames(id, `[[1,"alice"],[2,"bob"]]`)[0],
				streamTestRequestFrames(id, `[[1,"alice"],[2,"bob"]]`)[1],
				`{"id":` + streamTestFrameID(id) + `,"success":true,"chunkType":"rows","data":[[3,"carol"]]}`,
			}, "\n") + "\n"
			_, _ = s.pipeWriter.Write([]byte(frames))
		}(req.ID)
	case optionalAgentMethodCancelQuery:
		s.cancelSeen <- req.TargetID
		go func(id int64) {
			frame := fmt.Sprintf(`{"id":%d,"success":false,"error":"query canceled"}`+"\n", id)
			_, _ = s.pipeWriter.Write([]byte(frame))
		}(req.TargetID)
	case optionalAgentMethodPing:
		go func(id int64) {
			frame := fmt.Sprintf(`{"id":%d,"success":true}`+"\n", id)
			_, _ = s.pipeWriter.Write([]byte(frame))
		}(req.ID)
	}
	return len(payload), nil
}

func (s *streamBudgetCancelAgentStub) Close() error {
	return s.pipeWriter.Close()
}
