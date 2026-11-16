package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"GoNavi-Wails/internal/connection"
	redislib "GoNavi-Wails/internal/redis"
	"GoNavi-Wails/internal/uievents"
)

func TestBuildRedisExportPayloadContextReportsPerKeyProgress(t *testing.T) {
	client := &redisTransferTestClient{
		scanPages: []*redislib.RedisScanResult{{
			Keys: []redislib.RedisKeyInfo{{Key: "alpha"}, {Key: "beta"}},
		}},
		keyTypes:     map[string]string{"alpha": "string", "beta": "string"},
		stringValues: map[string]string{"alpha": "1", "beta": "2"},
	}
	var progress [][2]int64
	payload, err := buildRedisExportPayloadContext(
		context.Background(),
		client,
		0,
		RedisExportKeysOptions{Scope: "all", Pattern: "*"},
		func(current, total int64) {
			progress = append(progress, [2]int64{current, total})
		},
	)
	if err != nil {
		t.Fatalf("buildRedisExportPayloadContext returned error: %v", err)
	}
	if len(payload.Keys) != 2 {
		t.Fatalf("exported keys = %d, want 2", len(payload.Keys))
	}
	want := [][2]int64{{0, 2}, {1, 2}, {2, 2}}
	if !reflect.DeepEqual(progress, want) {
		t.Fatalf("progress = %#v, want %#v", progress, want)
	}
}

func TestImportRedisTransferPayloadContextReportsSkippedProgress(t *testing.T) {
	payload := redisTransferFile{Keys: []redisTransferEntry{
		{Key: "alpha", Type: "string", TTL: -1, Value: "1"},
		{Key: "beta", Type: "string", TTL: -1, Value: "2"},
	}}
	client := &redisTransferTestClient{existingKeys: map[string]bool{"alpha": true}}

	var progress [][4]int
	summary, err := importRedisTransferPayloadContext(
		context.Background(),
		client,
		payload,
		RedisImportKeysOptions{ConflictMode: "skip"},
		func(current, success, skipped, total int) {
			progress = append(progress, [4]int{current, success, skipped, total})
		},
	)
	if err != nil {
		t.Fatalf("importRedisTransferPayloadContext returned error: %v", err)
	}
	if summary["imported"] != 1 || summary["skipped"] != 1 || summary["total"] != 2 {
		t.Fatalf("summary = %#v", summary)
	}
	want := [][4]int{{0, 0, 0, 2}, {1, 0, 1, 2}, {2, 1, 1, 2}}
	if !reflect.DeepEqual(progress, want) {
		t.Fatalf("progress = %#v, want %#v", progress, want)
	}
}

func TestRedisTransferProgressStopsOnCanceledContext(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	if _, err := buildRedisExportPayloadContext(
		ctx,
		&redisTransferTestClient{},
		0,
		RedisExportKeysOptions{Scope: "all", Pattern: "*"},
		nil,
	); !errors.Is(err, context.Canceled) {
		t.Fatalf("export error = %v, want context.Canceled", err)
	}

	summary, err := importRedisTransferPayloadContext(
		ctx,
		&redisTransferTestClient{},
		redisTransferFile{Keys: []redisTransferEntry{{Key: "alpha", Type: "string", TTL: -1, Value: "1"}}},
		RedisImportKeysOptions{},
		nil,
	)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("import error = %v, want context.Canceled", err)
	}
	if summary["total"] != 1 {
		t.Fatalf("partial summary = %#v, want total=1", summary)
	}
}

func TestRedisImportKeysThrottlesProgressForLargePayload(t *testing.T) {
	app := NewAppWithSecretStore(newFakeAppSecretStore())
	app.configDir = t.TempDir()
	emitter := &redisTransferProgressEmitter{}
	app.ctx = uievents.WithEmitter(context.Background(), emitter)

	const keyCount = 500
	entries := make([]redisTransferEntry, 0, keyCount)
	for i := 0; i < keyCount; i++ {
		entries = append(entries, redisTransferEntry{Key: fmt.Sprintf("key-%03d", i), Type: "string", TTL: -1, Value: "v"})
	}
	payload, err := json.Marshal(redisTransferFile{
		Format:  redisTransferFileFormat,
		Version: redisTransferFileVersion,
		Keys:    entries,
	})
	if err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(t.TempDir(), "redis-keys.json")
	if err := os.WriteFile(file, payload, 0o600); err != nil {
		t.Fatal(err)
	}

	CloseAllRedisClients()
	originalNewRedisClientFunc := newRedisClientFunc
	originalResolveDialConfigWithProxyFunc := resolveDialConfigWithProxyFunc
	defer func() {
		newRedisClientFunc = originalNewRedisClientFunc
		resolveDialConfigWithProxyFunc = originalResolveDialConfigWithProxyFunc
		CloseAllRedisClients()
	}()
	newRedisClientFunc = func() redislib.RedisClient {
		return &redisTransferTestClient{}
	}
	resolveDialConfigWithProxyFunc = func(raw connection.ConnectionConfig) (connection.ConnectionConfig, error) {
		return raw, nil
	}

	result := app.RedisImportKeys(connection.ConnectionConfig{Type: "redis", Host: "redis.local", Port: 6379}, RedisImportKeysOptions{
		JobID:        "redis-import-throttle",
		File:         file,
		ConflictMode: "overwrite",
	})
	if !result.Success {
		t.Fatalf("RedisImportKeys failed: %+v", result)
	}

	progress := make([]importProgressState, 0)
	for _, event := range emitter.events {
		if event.name != "import:progress" {
			continue
		}
		state, ok := event.data.(importProgressState)
		if !ok {
			t.Fatalf("unexpected progress payload: %#v", event.data)
		}
		progress = append(progress, state)
	}
	if len(progress) == 0 {
		t.Fatal("no progress events emitted")
	}
	if len(progress) > keyCount/8 {
		t.Fatalf("progress events = %d, want throttled well below %d", len(progress), keyCount)
	}
	if progress[0].Current != 0 {
		t.Fatalf("first progress current = %d, want 0", progress[0].Current)
	}
	if last := progress[len(progress)-1]; last.Current != keyCount || last.Success != keyCount {
		t.Fatalf("final progress = %#v", last)
	}
}

type redisTransferProgressEmitter struct {
	events []struct {
		name string
		data any
	}
}

func (e *redisTransferProgressEmitter) Emit(name string, args ...any) {
	event := struct {
		name string
		data any
	}{name: name}
	if len(args) > 0 {
		event.data = args[0]
	}
	e.events = append(e.events, event)
}

func TestRedisImportKeysEmitsJobScopedProgress(t *testing.T) {
	app := NewAppWithSecretStore(newFakeAppSecretStore())
	app.configDir = t.TempDir()
	emitter := &redisTransferProgressEmitter{}
	app.ctx = uievents.WithEmitter(context.Background(), emitter)

	payload, err := json.Marshal(redisTransferFile{
		Format:  redisTransferFileFormat,
		Version: redisTransferFileVersion,
		Keys: []redisTransferEntry{{
			Key:   "alpha",
			Type:  "string",
			TTL:   -1,
			Value: "1",
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(t.TempDir(), "redis-keys.json")
	if err := os.WriteFile(file, payload, 0o600); err != nil {
		t.Fatal(err)
	}

	CloseAllRedisClients()
	originalNewRedisClientFunc := newRedisClientFunc
	originalResolveDialConfigWithProxyFunc := resolveDialConfigWithProxyFunc
	defer func() {
		newRedisClientFunc = originalNewRedisClientFunc
		resolveDialConfigWithProxyFunc = originalResolveDialConfigWithProxyFunc
		CloseAllRedisClients()
	}()
	newRedisClientFunc = func() redislib.RedisClient {
		return &redisTransferTestClient{}
	}
	resolveDialConfigWithProxyFunc = func(raw connection.ConnectionConfig) (connection.ConnectionConfig, error) {
		return raw, nil
	}

	const jobID = "redis-import-progress"
	result := app.RedisImportKeys(connection.ConnectionConfig{Type: "redis", Host: "redis.local", Port: 6379}, RedisImportKeysOptions{
		JobID:        jobID,
		File:         file,
		ConflictMode: "overwrite",
	})
	if !result.Success {
		t.Fatalf("RedisImportKeys failed: %+v", result)
	}

	var progress []importProgressState
	for _, event := range emitter.events {
		if event.name != "import:progress" {
			continue
		}
		state, ok := event.data.(importProgressState)
		if !ok {
			t.Fatalf("unexpected progress payload: %#v", event.data)
		}
		progress = append(progress, state)
	}
	if len(progress) < 2 {
		t.Fatalf("progress events = %#v, want initial and final events", progress)
	}
	if progress[0].JobID != jobID || progress[0].Current != 0 || progress[0].Total != 1 || !progress[0].TotalRowsKnown {
		t.Fatalf("initial progress = %#v", progress[0])
	}
	if last := progress[len(progress)-1]; last.JobID != jobID || last.Current != 1 || last.Success != 1 {
		t.Fatalf("final progress = %#v", last)
	}
}
