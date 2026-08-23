package db

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"sync"
	"testing"
	"time"

	"GoNavi-Wails/internal/connection"
)

type optionalAgentCancelWhenDoneObservedContext struct {
	context.Context
	cancel context.CancelFunc
	once   sync.Once
}

func TestOptionalAgentMetadataProbeTimeout(t *testing.T) {
	if got := optionalAgentMetadataProbeTimeout; got != 30*time.Second {
		t.Fatalf("metadata probe timeout = %s, want 30s on every platform", got)
	}
	if got := optionalAgentMetadataProbeRetryTimeout; got != 5*time.Second {
		t.Fatalf("metadata probe retry timeout = %s, want 5s", got)
	}
}

func TestProbeOptionalDriverAgentMetadataWithRetryRetriesOnlyAfterTimeout(t *testing.T) {
	var timeouts []time.Duration
	metadata, err := probeOptionalDriverAgentMetadataWithRetry(func(timeout time.Duration) (OptionalDriverAgentMetadata, error) {
		timeouts = append(timeouts, timeout)
		if len(timeouts) == 1 {
			return OptionalDriverAgentMetadata{}, fmt.Errorf("first probe: %w", context.DeadlineExceeded)
		}
		return OptionalDriverAgentMetadata{DriverType: "clickhouse", AgentRevision: "src-current"}, nil
	}, true, 0)
	if err != nil {
		t.Fatalf("metadata retry returned error: %v", err)
	}
	if len(timeouts) != 2 || timeouts[0] != optionalAgentMetadataProbeTimeout || timeouts[1] != optionalAgentMetadataProbeRetryTimeout {
		t.Fatalf("metadata retry timeouts = %#v, want [%s %s]", timeouts, optionalAgentMetadataProbeTimeout, optionalAgentMetadataProbeRetryTimeout)
	}
	if metadata.AgentRevision != "src-current" {
		t.Fatalf("metadata retry result = %#v", metadata)
	}
}

func TestProbeOptionalDriverAgentMetadataWithRetryDoesNotRetryNonTimeout(t *testing.T) {
	wantErr := errors.New("invalid metadata response")
	probes := 0
	_, err := probeOptionalDriverAgentMetadataWithRetry(func(time.Duration) (OptionalDriverAgentMetadata, error) {
		probes++
		return OptionalDriverAgentMetadata{}, wantErr
	}, true, 0)
	if !errors.Is(err, wantErr) {
		t.Fatalf("metadata probe error = %v, want %v", err, wantErr)
	}
	if probes != 1 {
		t.Fatalf("non-timeout metadata error triggered %d probes, want 1", probes)
	}
}

func TestProbeOptionalDriverAgentMetadataWithRetryPreservesBothTimeoutErrors(t *testing.T) {
	firstErr := fmt.Errorf("first timeout: %w", context.DeadlineExceeded)
	secondErr := errors.New("second process exited")
	probes := 0
	_, err := probeOptionalDriverAgentMetadataWithRetry(func(time.Duration) (OptionalDriverAgentMetadata, error) {
		probes++
		if probes == 1 {
			return OptionalDriverAgentMetadata{}, firstErr
		}
		return OptionalDriverAgentMetadata{}, secondErr
	}, true, 0)
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("combined metadata error lost first timeout: %v", err)
	}
	if !strings.Contains(err.Error(), secondErr.Error()) {
		t.Fatalf("combined metadata error lost retry detail: %v", err)
	}
	if probes != 2 {
		t.Fatalf("metadata probes = %d, want 2", probes)
	}
}

func TestProbeOptionalDriverAgentMetadataWithRetryKeepsNonWindowsTimeoutBudget(t *testing.T) {
	probes := 0
	_, err := probeOptionalDriverAgentMetadataWithRetry(func(time.Duration) (OptionalDriverAgentMetadata, error) {
		probes++
		return OptionalDriverAgentMetadata{}, context.DeadlineExceeded
	}, false, 0)
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("metadata probe error = %v, want deadline exceeded", err)
	}
	if probes != 1 {
		t.Fatalf("non-Windows timeout triggered %d probes, want 1", probes)
	}
}

func (c *optionalAgentCancelWhenDoneObservedContext) Done() <-chan struct{} {
	done := c.Context.Done()
	c.once.Do(c.cancel)
	return done
}

func TestNormalizeKingbaseAgentTableName(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want string
	}{
		{name: "plain", in: "ldf_server.andon_events", want: "ldf_server.andon_events"},
		{name: "quoted", in: `"ldf_server"."andon_events"`, want: "ldf_server.andon_events"},
		{name: "double quoted", in: `""ldf_server"".""andon_events""`, want: "ldf_server.andon_events"},
		{name: "escaped", in: `\"ldf_server\".\"andon_events\"`, want: "ldf_server.andon_events"},
		{name: "double escaped", in: `\\\"ldf_server\\\".\\\"andon_events\\\"`, want: "ldf_server.andon_events"},
		{name: "space around dot", in: ` "ldf_server" . "andon_events" `, want: "ldf_server.andon_events"},
		{name: "table only", in: `bcs_barcode`, want: "bcs_barcode"},
		{name: "table only quoted", in: `"bcs_barcode"`, want: "bcs_barcode"},
		{name: "table only double quoted", in: `""bcs_barcode""`, want: "bcs_barcode"},
		{name: "table only double escaped", in: `\\\"bcs_barcode\\\"`, want: "bcs_barcode"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := normalizeKingbaseAgentTableName(tt.in); got != tt.want {
				t.Fatalf("normalizeKingbaseAgentTableName(%q) = %q, want %q", tt.in, got, tt.want)
			}
		})
	}
}

func TestNormalizeKingbaseAgentChangeSetByColumns(t *testing.T) {
	columns := []string{"andon_events_id", "event_name", "event_code"}
	input := connection.ChangeSet{
		Inserts: []map[string]interface{}{
			{"event name": "物料1", "event_code": "EV-0001", "andon_events_id": 1},
		},
		Updates: []connection.UpdateRow{
			{Keys: map[string]interface{}{"andon_events_id": 1}, Values: map[string]interface{}{"event name": "物料2"}},
		},
		Deletes: []map[string]interface{}{
			{"andon_events_id": 1},
		},
	}

	out, err := normalizeKingbaseAgentChangeSetByColumns(input, columns)
	if err != nil {
		t.Fatalf("normalizeKingbaseAgentChangeSetByColumns error: %v", err)
	}

	if _, ok := out.Inserts[0]["event_name"]; !ok {
		t.Fatalf("expected insert to map \"event name\" -> \"event_name\"")
	}
	if _, ok := out.Inserts[0]["event name"]; ok {
		t.Fatalf("unexpected insert key \"event name\" after normalization")
	}
	if _, ok := out.Updates[0].Values["event_name"]; !ok {
		t.Fatalf("expected update values to map \"event name\" -> \"event_name\"")
	}
	if _, ok := out.Updates[0].Values["event name"]; ok {
		t.Fatalf("unexpected update value key \"event name\" after normalization")
	}
}

type optionalAgentTestWriteCloser struct {
	bytes.Buffer
}

func (w *optionalAgentTestWriteCloser) Close() error { return nil }

func TestOptionalDriverAgentTableExistsUsesCapabilityMethod(t *testing.T) {
	var stdin optionalAgentTestWriteCloser
	client := &optionalDriverAgentClient{
		stdin:  &stdin,
		reader: bufio.NewReader(strings.NewReader(`{"id":1,"success":true,"data":true}` + "\n")),
		driver: "elasticsearch",
	}
	database := &OptionalDriverAgentDB{driverType: "elasticsearch", client: client}

	exists, err := database.TableExists("analytics", "orders-2026")
	if err != nil {
		t.Fatalf("TableExists returned error: %v", err)
	}
	if !exists {
		t.Fatal("TableExists should decode the agent response")
	}

	var request optionalAgentRequest
	if err := json.Unmarshal(bytes.TrimSpace(stdin.Bytes()), &request); err != nil {
		t.Fatalf("decode agent request: %v", err)
	}
	if request.Method != optionalAgentMethodTableExists || request.DBName != "analytics" || request.TableName != "orders-2026" {
		t.Fatalf("unexpected agent request: %#v", request)
	}
}

func TestOptionalDriverAgentTableExistsFallsBackForLegacyAgent(t *testing.T) {
	var stdin optionalAgentTestWriteCloser
	stdout := strings.Join([]string{
		`{"id":1,"success":false,"error":"不支持的方法"}`,
		`{"id":2,"success":true,"data":["dbo.users","audit.Users"]}`,
	}, "\n") + "\n"
	client := &optionalDriverAgentClient{
		stdin:  &stdin,
		reader: bufio.NewReader(strings.NewReader(stdout)),
		driver: "sqlserver",
	}
	database := &OptionalDriverAgentDB{driverType: "sqlserver", client: client}

	exists, err := database.TableExists("main", "dbo.users")
	if err != nil {
		t.Fatalf("legacy fallback returned error: %v", err)
	}
	if !exists {
		t.Fatal("legacy fallback should use the exact table list")
	}

	lines := bytes.Split(bytes.TrimSpace(stdin.Bytes()), []byte("\n"))
	if len(lines) != 2 {
		t.Fatalf("expected capability probe and fallback request, got %d lines", len(lines))
	}
	var first, second optionalAgentRequest
	if err := json.Unmarshal(lines[0], &first); err != nil {
		t.Fatalf("decode capability request: %v", err)
	}
	if err := json.Unmarshal(lines[1], &second); err != nil {
		t.Fatalf("decode fallback request: %v", err)
	}
	if first.Method != optionalAgentMethodTableExists || second.Method != optionalAgentMethodGetTables {
		t.Fatalf("unexpected fallback sequence: %q then %q", first.Method, second.Method)
	}
}

func TestOptionalDriverAgentTableExistsDoesNotHideCapabilityErrors(t *testing.T) {
	var stdin optionalAgentTestWriteCloser
	client := &optionalDriverAgentClient{
		stdin:  &stdin,
		reader: bufio.NewReader(strings.NewReader(`{"id":1,"success":false,"error":"metadata permission denied"}` + "\n")),
		driver: "elasticsearch",
	}
	database := &OptionalDriverAgentDB{driverType: "elasticsearch", client: client}

	if _, err := database.TableExists("analytics", "orders-2026"); err == nil || !strings.Contains(err.Error(), "permission denied") {
		t.Fatalf("expected capability error without fallback, got %v", err)
	}
	if lines := bytes.Count(bytes.TrimSpace(stdin.Bytes()), []byte("\n")); lines != 0 {
		t.Fatalf("unexpected fallback request after capability error: %q", stdin.String())
	}
}

type optionalAgentSignalingWriteCloser struct {
	writes chan []byte
}

func (w *optionalAgentSignalingWriteCloser) Write(payload []byte) (int, error) {
	copied := append([]byte(nil), payload...)
	w.writes <- copied
	return len(payload), nil
}

func (w *optionalAgentSignalingWriteCloser) Close() error { return nil }

type optionalAgentBlockingTransport struct {
	mu           sync.Mutex
	writes       bytes.Buffer
	readStarted  chan struct{}
	closed       chan struct{}
	readFinished chan struct{}
	startOnce    sync.Once
	closeOnce    sync.Once
	finishOnce   sync.Once
}

func newOptionalAgentBlockingTransport() *optionalAgentBlockingTransport {
	return &optionalAgentBlockingTransport{
		readStarted:  make(chan struct{}),
		closed:       make(chan struct{}),
		readFinished: make(chan struct{}),
	}
}

func (t *optionalAgentBlockingTransport) Write(payload []byte) (int, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.writes.Write(payload)
}

func (t *optionalAgentBlockingTransport) Read([]byte) (int, error) {
	t.startOnce.Do(func() {
		close(t.readStarted)
	})
	<-t.closed
	t.finishOnce.Do(func() {
		close(t.readFinished)
	})
	return 0, io.ErrClosedPipe
}

func (t *optionalAgentBlockingTransport) Close() error {
	t.closeOnce.Do(func() {
		close(t.closed)
	})
	return nil
}

func TestOptionalDriverAgentQueryContextStopsUnresponsiveTransport(t *testing.T) {
	transport := newOptionalAgentBlockingTransport()
	defer transport.Close()
	client := &optionalDriverAgentClient{
		stdin:  transport,
		reader: bufio.NewReader(transport),
		driver: "dameng",
	}
	dbInst := &OptionalDriverAgentDB{driverType: "dameng", client: client}

	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Millisecond)
	defer cancel()
	result := make(chan error, 1)
	go func() {
		_, _, err := dbInst.QueryContext(ctx, "SELECT 1")
		result <- err
	}()

	select {
	case <-transport.readStarted:
	case <-time.After(time.Second):
		t.Fatal("driver-agent call did not start reading its response")
	}

	select {
	case err := <-result:
		if !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("expected context deadline error, got %v", err)
		}
	case <-time.After(250 * time.Millisecond):
		t.Fatal("QueryContext remained blocked after its context deadline")
	}

	select {
	case <-transport.readFinished:
	case <-time.After(250 * time.Millisecond):
		t.Fatal("timed-out transport read remained blocked")
	}

	retryStartedAt := time.Now()
	err := client.call(optionalAgentRequest{Method: optionalAgentMethodPing}, nil, nil, nil, nil)
	if !errors.Is(err, errOptionalAgentTransportStopped) {
		t.Fatalf("expected terminated transport error on retry, got %v", err)
	}
	if elapsed := time.Since(retryStartedAt); elapsed > 50*time.Millisecond {
		t.Fatalf("retry on terminated transport did not fail fast: %s", elapsed)
	}
}

func TestOptionalDriverAgentCloseDoesNotWaitForStuckCallLock(t *testing.T) {
	transport := newOptionalAgentBlockingTransport()
	defer transport.Close()
	client := &optionalDriverAgentClient{
		stdin:           transport,
		reader:          bufio.NewReader(transport),
		driver:          "dameng",
		shutdownTimeout: 25 * time.Millisecond,
	}
	dbInst := &OptionalDriverAgentDB{driverType: "dameng", client: client}

	queryDone := make(chan error, 1)
	go func() {
		_, _, err := dbInst.Query("SELECT 1")
		queryDone <- err
	}()

	select {
	case <-transport.readStarted:
	case <-time.After(time.Second):
		t.Fatal("driver-agent call did not start reading its response")
	}

	closeDone := make(chan error, 1)
	go func() {
		closeDone <- dbInst.Close()
	}()

	select {
	case err := <-queryDone:
		if err == nil {
			t.Fatal("expected the terminated in-flight query to return an error")
		}
	case <-time.After(250 * time.Millisecond):
		t.Fatal("Close did not terminate the in-flight unbounded IPC call")
	}
	select {
	case <-closeDone:
	case <-time.After(250 * time.Millisecond):
		t.Fatal("Close remained blocked behind the in-flight IPC lock")
	}
}

func TestOptionalDriverAgentPingUsesBoundedTransport(t *testing.T) {
	transport := newOptionalAgentBlockingTransport()
	defer transport.Close()
	client := &optionalDriverAgentClient{
		stdin:  transport,
		reader: bufio.NewReader(transport),
		driver: "dameng",
	}
	dbInst := &OptionalDriverAgentDB{
		driverType:  "dameng",
		client:      client,
		pingTimeout: 25 * time.Millisecond,
	}

	startedAt := time.Now()
	err := dbInst.Ping()
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("expected context deadline error, got %v", err)
	}
	if elapsed := time.Since(startedAt); elapsed > 250*time.Millisecond {
		t.Fatalf("Ping exceeded its transport timeout: %s", elapsed)
	}
	select {
	case <-transport.readFinished:
	case <-time.After(250 * time.Millisecond):
		t.Fatal("timed-out ping left its transport read blocked")
	}
}

func TestOptionalDriverAgentQueryWithoutContextKeepsLongRunningSemantics(t *testing.T) {
	var stdin optionalAgentTestWriteCloser
	stdoutReader, stdoutWriter := io.Pipe()
	defer stdoutReader.Close()
	defer stdoutWriter.Close()
	client := &optionalDriverAgentClient{
		stdin:  &stdin,
		stdout: stdoutReader,
		reader: bufio.NewReader(stdoutReader),
		driver: "dameng",
	}
	dbInst := &OptionalDriverAgentDB{
		driverType:  "dameng",
		client:      client,
		pingTimeout: 5 * time.Millisecond,
	}

	type queryResult struct {
		rows   []map[string]interface{}
		fields []string
		err    error
	}
	result := make(chan queryResult, 1)
	go func() {
		rows, fields, err := dbInst.Query("SELECT slow_value")
		result <- queryResult{rows: rows, fields: fields, err: err}
	}()

	select {
	case early := <-result:
		t.Fatalf("query unexpectedly inherited the control timeout: %v", early.err)
	case <-time.After(25 * time.Millisecond):
	}

	if _, err := stdoutWriter.Write([]byte(`{"id":1,"success":true,"data":[{"slow_value":42}],"fields":["slow_value"]}` + "\n")); err != nil {
		t.Fatalf("write delayed agent response: %v", err)
	}
	select {
	case got := <-result:
		if got.err != nil {
			t.Fatalf("long-running query returned error: %v", got.err)
		}
		if len(got.rows) != 1 || got.rows[0]["slow_value"] != int64(42) {
			t.Fatalf("unexpected query rows: %#v", got.rows)
		}
		if len(got.fields) != 1 || got.fields[0] != "slow_value" {
			t.Fatalf("unexpected query fields: %#v", got.fields)
		}
	case <-time.After(time.Second):
		t.Fatal("query did not consume its delayed response")
	}
}

func TestOptionalDriverAgentQueuedPingTimeoutDoesNotTerminateLongQuery(t *testing.T) {
	stdin := &optionalAgentSignalingWriteCloser{writes: make(chan []byte, 3)}
	stdoutReader, stdoutWriter := io.Pipe()
	defer stdoutReader.Close()
	defer stdoutWriter.Close()
	client := &optionalDriverAgentClient{
		stdin:  stdin,
		stdout: stdoutReader,
		reader: bufio.NewReader(stdoutReader),
		driver: "dameng",
	}
	dbInst := &OptionalDriverAgentDB{driverType: "dameng", client: client}

	type queryResult struct {
		rows []map[string]interface{}
		err  error
	}
	queryDone := make(chan queryResult, 1)
	go func() {
		rows, _, err := dbInst.Query("SELECT slow_value")
		queryDone <- queryResult{rows: rows, err: err}
	}()

	select {
	case payload := <-stdin.writes:
		if !bytes.Contains(payload, []byte(`"method":"query"`)) {
			t.Fatalf("first request was not the long query: %s", payload)
		}
	case <-time.After(time.Second):
		t.Fatal("long query did not acquire the agent transport")
	}

	pingCtx, cancelPing := context.WithTimeout(context.Background(), 25*time.Millisecond)
	defer cancelPing()
	pingDone := make(chan error, 1)
	go func() {
		pingDone <- dbInst.PingContext(pingCtx)
	}()
	select {
	case err := <-pingDone:
		if !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("queued ping returned %v, want context deadline", err)
		}
	case <-time.After(250 * time.Millisecond):
		t.Fatal("queued ping did not honor its context deadline")
	}
	select {
	case payload := <-stdin.writes:
		t.Fatalf("timed-out queued ping was written to the agent: %s", payload)
	default:
	}
	if err := client.stoppedError(); err != nil {
		t.Fatalf("queued ping timeout terminated the active transport: %v", err)
	}

	if _, err := stdoutWriter.Write([]byte(`{"id":1,"success":true,"data":[{"slow_value":42}],"fields":["slow_value"]}` + "\n")); err != nil {
		t.Fatalf("write long query response: %v", err)
	}
	select {
	case result := <-queryDone:
		if result.err != nil {
			t.Fatalf("long query failed after queued ping timeout: %v", result.err)
		}
		if len(result.rows) != 1 || result.rows[0]["slow_value"] != int64(42) {
			t.Fatalf("unexpected long query rows: %#v", result.rows)
		}
	case <-time.After(time.Second):
		t.Fatal("long query did not complete after its response")
	}

	finalPingDone := make(chan error, 1)
	go func() {
		finalPingDone <- dbInst.PingContext(context.Background())
	}()
	select {
	case payload := <-stdin.writes:
		if !bytes.Contains(payload, []byte(`"method":"ping"`)) {
			t.Fatalf("transport reuse request was not ping: %s", payload)
		}
	case <-time.After(time.Second):
		t.Fatal("transport was not reusable after queued timeout")
	}
	if _, err := stdoutWriter.Write([]byte(`{"id":2,"success":true}` + "\n")); err != nil {
		t.Fatalf("write final ping response: %v", err)
	}
	select {
	case err := <-finalPingDone:
		if err != nil {
			t.Fatalf("reused transport ping failed: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("reused transport ping did not complete")
	}
}

func TestOptionalDriverAgentCancellationAfterGateAcquisitionDoesNotStartOperation(t *testing.T) {
	for i := 0; i < 128; i++ {
		baseCtx, cancel := context.WithCancel(context.Background())
		ctx := &optionalAgentCancelWhenDoneObservedContext{
			Context: baseCtx,
			cancel:  cancel,
		}
		client := &optionalDriverAgentClient{driver: "dameng"}
		operationStarted := false

		err := client.runWithContext(ctx, optionalAgentMethodPing, func() error {
			operationStarted = true
			return nil
		})
		cancel()

		if !errors.Is(err, context.Canceled) {
			t.Fatalf("iteration %d returned %v, want context cancellation", i, err)
		}
		if operationStarted {
			t.Fatalf("iteration %d started an operation after cancellation", i)
		}
		if err := client.stoppedError(); err != nil {
			t.Fatalf("iteration %d terminated an idle transport: %v", i, err)
		}
	}
}

func TestOptionalDriverAgentUnresponsiveProcessIsReapedAfterTimeout(t *testing.T) {
	const helperMarker = "gonavi-optional-agent-hang-helper"
	if os.Getenv("GONAVI_OPTIONAL_AGENT_HANG_HELPER") == "1" &&
		len(os.Args) > 0 &&
		os.Args[len(os.Args)-1] == helperMarker {
		time.Sleep(time.Hour)
		return
	}

	cmd := exec.Command(
		os.Args[0],
		"-test.run=^TestOptionalDriverAgentUnresponsiveProcessIsReapedAfterTimeout$",
		"--",
		helperMarker,
	)
	cmd.Env = append(os.Environ(), "GONAVI_OPTIONAL_AGENT_HANG_HELPER=1")
	configureAgentProcess(cmd)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		t.Fatalf("create helper stdin: %v", err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatalf("create helper stdout: %v", err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatalf("start helper process: %v", err)
	}
	t.Cleanup(func() {
		if cmd.ProcessState == nil {
			_ = cmd.Process.Kill()
			_ = cmd.Wait()
		}
	})

	client := &optionalDriverAgentClient{
		cmd:    cmd,
		stdin:  stdin,
		stdout: stdout,
		reader: bufio.NewReader(stdout),
		driver: "dameng",
	}
	err = client.callWithTimeout(
		optionalAgentRequest{Method: optionalAgentMethodPing},
		nil,
		nil,
		nil,
		nil,
		50*time.Millisecond,
	)
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("expected context deadline error, got %v", err)
	}
	if cmd.ProcessState == nil {
		t.Fatal("timed-out driver-agent process was not reaped")
	}
}

type optionalAgentTestStreamConsumer struct {
	columns []string
	rows    [][]interface{}
}

func (c *optionalAgentTestStreamConsumer) SetColumns(columns []string) error {
	c.columns = append([]string(nil), columns...)
	return nil
}

func (c *optionalAgentTestStreamConsumer) ConsumeRow(row map[string]interface{}) error {
	values := make([]interface{}, len(c.columns))
	for idx, column := range c.columns {
		values[idx] = row[column]
	}
	c.rows = append(c.rows, values)
	return nil
}

func (c *optionalAgentTestStreamConsumer) ConsumeRowValues(values []interface{}) error {
	c.rows = append(c.rows, append([]interface{}(nil), values...))
	return nil
}

func TestOptionalDriverAgentClientCallStreamQueryConsumesChunks(t *testing.T) {
	var stdin optionalAgentTestWriteCloser
	stdout := strings.Join([]string{
		`{"id":1,"success":true,"chunkType":"columns","fields":["id","name"]}`,
		`{"id":1,"success":true,"chunkType":"rows","data":[[1,"alice"],[2,"bob"]]}`,
		`{"id":1,"success":true,"chunkType":"done"}`,
	}, "\n") + "\n"

	client := &optionalDriverAgentClient{
		stdin:  &stdin,
		reader: bufio.NewReader(strings.NewReader(stdout)),
		driver: "oceanbase",
	}
	consumer := &optionalAgentTestStreamConsumer{}
	if err := client.callStreamQuery(optionalAgentRequest{
		Method: optionalAgentMethodStreamQuery,
		Query:  "SELECT 1",
	}, consumer); err != nil {
		t.Fatalf("callStreamQuery 返回错误: %v", err)
	}

	if len(consumer.columns) != 2 || consumer.columns[0] != "id" || consumer.columns[1] != "name" {
		t.Fatalf("流式列定义异常: %#v", consumer.columns)
	}
	if len(consumer.rows) != 2 {
		t.Fatalf("流式行数异常: %#v", consumer.rows)
	}
	if got := consumer.rows[0][1]; got != "alice" {
		t.Fatalf("第 1 行数据异常，want=%q got=%v", "alice", got)
	}
	if got := consumer.rows[1][0]; got != int64(2) {
		t.Fatalf("第 2 行 ID 异常，want=%d got=%v (%T)", 2, got, got)
	}
	if !strings.Contains(stdin.String(), `"method":"streamQuery"`) {
		t.Fatalf("请求未使用 streamQuery 方法: %s", stdin.String())
	}
}

func TestOptionalDriverAgentDBQueryWithMessagesParsesAgentMessages(t *testing.T) {
	var stdin optionalAgentTestWriteCloser
	stdout := `{"id":1,"success":true,"data":[{"sql_text":"select 1"}],"fields":["sql_text"],"messages":["PRINT sql line 1","PRINT sql line 2"]}` + "\n"

	dbInst := &OptionalDriverAgentDB{
		driverType: "sqlserver",
		client: &optionalDriverAgentClient{
			stdin:  &stdin,
			reader: bufio.NewReader(strings.NewReader(stdout)),
			driver: "sqlserver",
		},
	}

	rows, fields, messages, err := dbInst.QueryWithMessages("exec dbo.p_get_select")
	if err != nil {
		t.Fatalf("QueryWithMessages 返回错误: %v", err)
	}
	if len(rows) != 1 || rows[0]["sql_text"] != "select 1" {
		t.Fatalf("查询结果异常: %#v", rows)
	}
	if len(fields) != 1 || fields[0] != "sql_text" {
		t.Fatalf("字段异常: %#v", fields)
	}
	if len(messages) != 2 || messages[0] != "PRINT sql line 1" {
		t.Fatalf("消息异常: %#v", messages)
	}
	if !strings.Contains(stdin.String(), `"method":"query"`) {
		t.Fatalf("请求未使用 query 方法: %s", stdin.String())
	}
}

func TestOptionalDriverAgentDBExecutesElasticsearchConsoleRequest(t *testing.T) {
	var stdin optionalAgentTestWriteCloser
	stdout := `{"id":1,"success":true,"data":{"statusCode":400,"contentType":"application/json","rawBody":"{\"error\":{\"type\":\"parsing_exception\"},\"status\":400}","serverMajor":8}}` + "\n"
	database := &OptionalDriverAgentDB{
		driverType: "elasticsearch",
		client: &optionalDriverAgentClient{
			stdin:  &stdin,
			reader: bufio.NewReader(strings.NewReader(stdout)),
			driver: "elasticsearch",
		},
	}
	request := ElasticsearchConsoleRequest{
		Method:   "POST",
		Path:     "/orders/_search",
		Body:     `{"query":`,
		BodyKind: ElasticsearchConsoleBodyKindJSON,
	}

	response, err := database.ExecuteElasticsearchConsoleRequest(context.Background(), request)
	if err != nil {
		t.Fatalf("execute console request: %v", err)
	}
	if response.StatusCode != 400 || response.ServerMajor != 8 {
		t.Fatalf("unexpected response: %#v", response)
	}
	if !strings.Contains(response.RawBody, `"parsing_exception"`) {
		t.Fatalf("raw response was not preserved: %q", response.RawBody)
	}

	var wireRequest struct {
		Method               string                       `json:"method"`
		ElasticsearchRequest *ElasticsearchConsoleRequest `json:"elasticsearchRequest"`
	}
	if err := json.Unmarshal(bytes.TrimSpace(stdin.Bytes()), &wireRequest); err != nil {
		t.Fatalf("decode agent request: %v", err)
	}
	if wireRequest.Method != optionalAgentMethodElasticsearchConsole {
		t.Fatalf("unexpected agent method: %q", wireRequest.Method)
	}
	if wireRequest.ElasticsearchRequest == nil || *wireRequest.ElasticsearchRequest != request {
		t.Fatalf("console request was not preserved: %#v", wireRequest.ElasticsearchRequest)
	}
}

func TestOptionalDriverAgentDBProvidesCachedElasticsearchServerMajor(t *testing.T) {
	var provider ElasticsearchServerVersionProvider = &OptionalDriverAgentDB{
		driverType:  "elasticsearch",
		serverMajor: 8,
	}
	if got := provider.ElasticsearchServerMajor(); got != 8 {
		t.Fatalf("unexpected cached Elasticsearch server major: %d", got)
	}
}

func TestOptionalDriverAgentDBProvidesSQLiteTableStats(t *testing.T) {
	var stdin optionalAgentTestWriteCloser
	stdout := strings.Join([]string{
		`{"id":1,"success":true,"data":[{"table_rows":2}],"fields":["table_rows"]}`,
		`{"id":2,"success":true,"data":[{"table_name":"orders","data_length":4096,"index_length":8192}],"fields":["table_name","data_length","index_length"]}`,
	}, "\n") + "\n"

	dbInst := &OptionalDriverAgentDB{
		driverType: "sqlite",
		client: &optionalDriverAgentClient{
			stdin:  &stdin,
			reader: bufio.NewReader(strings.NewReader(stdout)),
			driver: "sqlite",
		},
	}

	rowCounts, err := dbInst.GetTableRowCounts("main", []string{"orders"})
	if err != nil {
		t.Fatalf("GetTableRowCounts 返回错误: %v", err)
	}
	if rowCounts["orders"] != 2 {
		t.Fatalf("SQLite driver-agent 行数异常: %#v", rowCounts)
	}

	storageStats, err := dbInst.GetTableStorageStats("main", []string{"orders"})
	if err != nil {
		t.Fatalf("GetTableStorageStats 返回错误: %v", err)
	}
	if storageStats["orders"].DataLength != 4096 || storageStats["orders"].IndexLength != 8192 {
		t.Fatalf("SQLite driver-agent 存储统计异常: %#v", storageStats)
	}

	requests := stdin.String()
	if !strings.Contains(requests, `SELECT COUNT(*) AS table_rows FROM \"orders\"`) {
		t.Fatalf("driver-agent 未执行 SQLite 行数查询: %s", requests)
	}
	if !strings.Contains(requests, "FROM dbstat") {
		t.Fatalf("driver-agent 未执行 SQLite dbstat 查询: %s", requests)
	}
}

func TestOptionalDriverAgentDBQueryMultiWithMessagesParsesResultSets(t *testing.T) {
	var stdin optionalAgentTestWriteCloser
	stdout := `{"id":1,"success":true,"data":[{"statementIndex":1,"rows":[{"name":"master"}],"columns":["name"]},{"statementIndex":1,"rows":[],"columns":[],"messages":["PRINT generated sql"]}],"messages":["batch top-level message"]}` + "\n"

	dbInst := &OptionalDriverAgentDB{
		driverType: "sqlserver",
		client: &optionalDriverAgentClient{
			stdin:  &stdin,
			reader: bufio.NewReader(strings.NewReader(stdout)),
			driver: "sqlserver",
		},
	}

	resultSets, messages, err := dbInst.QueryMultiWithMessages("exec dbo.p_get_select")
	if err != nil {
		t.Fatalf("QueryMultiWithMessages 返回错误: %v", err)
	}
	if len(resultSets) != 2 {
		t.Fatalf("结果集数量异常: %#v", resultSets)
	}
	if got := resultSets[0].Rows[0]["name"]; got != "master" {
		t.Fatalf("首个结果集异常，got=%v", got)
	}
	if len(resultSets[1].Messages) != 1 || resultSets[1].Messages[0] != "PRINT generated sql" {
		t.Fatalf("消息结果集异常: %#v", resultSets[1])
	}
	if len(messages) != 1 || messages[0] != "batch top-level message" {
		t.Fatalf("顶层消息异常: %#v", messages)
	}
	if !strings.Contains(stdin.String(), `"method":"queryMulti"`) {
		t.Fatalf("请求未使用 queryMulti 方法: %s", stdin.String())
	}
}

func TestKingbaseOptionalDriverAgentSessionInitializesSearchPath(t *testing.T) {
	var stdin optionalAgentTestWriteCloser
	stdout := strings.Join([]string{
		`{"id":1,"success":true,"data":"session-1"}`,
		`{"id":2,"success":true,"rowsAffected":0}`,
		`{"id":3,"success":true}`,
	}, "\n") + "\n"

	dbInst := &OptionalDriverAgentDB{
		driverType:         "kingbase",
		kingbaseSearchPath: `"$user",public,ldf_server`,
		client: &optionalDriverAgentClient{
			stdin:  &stdin,
			reader: bufio.NewReader(strings.NewReader(stdout)),
			driver: "kingbase",
		},
	}

	session, err := dbInst.OpenSessionExecer(context.Background())
	if err != nil {
		t.Fatalf("OpenSessionExecer returned error: %v", err)
	}
	if err := session.Close(); err != nil {
		t.Fatalf("Close returned error: %v", err)
	}

	requests := stdin.String()
	for _, fragment := range []string{
		`"method":"openSession"`,
		`"method":"exec","sessionId":"session-1","query":"SET search_path TO \"$user\",public,ldf_server"`,
		`"method":"closeSession","sessionId":"session-1"`,
	} {
		if !strings.Contains(requests, fragment) {
			t.Fatalf("expected request fragment %q, got %s", fragment, requests)
		}
	}
}

func TestDamengOptionalDriverAgentSupportsManagedTransactions(t *testing.T) {
	damengDB, err := NewDatabase("dameng")
	if err != nil {
		t.Fatalf("create Dameng optional driver database: %v", err)
	}
	if _, ok := damengDB.(TransactionExecerProvider); !ok {
		t.Fatal("expected Dameng optional driver database to expose managed transactions")
	}

	for _, dbType := range []string{"sqlserver", "kingbase"} {
		dbInst, err := NewDatabase(dbType)
		if err != nil {
			t.Fatalf("create %s optional driver database: %v", dbType, err)
		}
		if _, ok := dbInst.(TransactionExecerProvider); ok {
			t.Fatalf("expected %s to keep using its existing session transaction path", dbType)
		}
	}
}

func TestOptionalDriverAgentTransactionUsesTransactionRPC(t *testing.T) {
	for _, tc := range []struct {
		name         string
		finishMethod string
		finish       func(TransactionExecer) error
	}{
		{name: "commit", finishMethod: optionalAgentMethodCommitTransaction, finish: func(tx TransactionExecer) error { return tx.Commit() }},
		{name: "rollback", finishMethod: optionalAgentMethodRollbackTransaction, finish: func(tx TransactionExecer) error { return tx.Rollback() }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var stdin optionalAgentTestWriteCloser
			stdout := strings.Join([]string{
				`{"id":1,"success":true,"data":"transaction-1"}`,
				`{"id":2,"success":true,"rowsAffected":1}`,
				`{"id":3,"success":true}`,
				`{"id":4,"success":true}`,
			}, "\n") + "\n"
			dbInst := &optionalDriverAgentTransactionalDB{
				OptionalDriverAgentDB: &OptionalDriverAgentDB{
					driverType: "dameng",
					client: &optionalDriverAgentClient{
						stdin:  &stdin,
						reader: bufio.NewReader(strings.NewReader(stdout)),
						driver: "dameng",
					},
				},
			}

			tx, err := dbInst.OpenTransactionExecer(context.Background())
			if err != nil {
				t.Fatalf("OpenTransactionExecer returned error: %v", err)
			}
			if _, err := tx.ExecContext(context.Background(), "UPDATE t SET v = 1"); err != nil {
				t.Fatalf("ExecContext returned error: %v", err)
			}
			if err := tc.finish(tx); err != nil {
				t.Fatalf("finish transaction returned error: %v", err)
			}
			if err := tx.Close(); err != nil {
				t.Fatalf("Close returned error: %v", err)
			}

			requests := stdin.String()
			for _, fragment := range []string{
				`"method":"openTransaction"`,
				`"method":"exec","sessionId":"transaction-1"`,
				`"method":"` + tc.finishMethod + `","sessionId":"transaction-1"`,
				`"method":"closeSession","sessionId":"transaction-1"`,
			} {
				if !strings.Contains(requests, fragment) {
					t.Fatalf("expected request fragment %q, got %s", fragment, requests)
				}
			}
		})
	}
}
