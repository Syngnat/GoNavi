package redis

import (
	"context"
	"errors"
	"fmt"
	"net"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"GoNavi-Wails/internal/connection"

	goredis "github.com/redis/go-redis/v9"
)

func TestListPushUsesRPushWithAllValues(t *testing.T) {
	commandCh := make(chan []string, 1)
	addr := startRedisProtocolTestServer(t, func(args []string) string {
		switch strings.ToUpper(strings.TrimSpace(args[0])) {
		case "HELLO":
			return "-ERR unknown command 'HELLO'\r\n"
		case "CLIENT":
			return "-ERR unknown subcommand\r\n"
		case "RPUSH":
			commandCh <- append([]string(nil), args...)
			return ":2\r\n"
		}
		return "+OK\r\n"
	})

	rawClient := goredis.NewClient(&goredis.Options{
		Addr:     addr,
		Protocol: 2,
	})
	client := &RedisClientImpl{
		client:       rawClient,
		singleClient: rawClient,
	}
	defer client.Close()

	if err := client.ListPush("tasks", "review", "ship"); err != nil {
		t.Fatalf("ListPush returned error: %v", err)
	}

	select {
	case command := <-commandCh:
		if len(command) != 4 || command[1] != "tasks" || command[2] != "review" || command[3] != "ship" {
			t.Fatalf("unexpected RPUSH command: %v", command)
		}
	case <-time.After(time.Second):
		t.Fatal("expected RPUSH command")
	}
}

func TestListPushLeftUsesLPushWithAllValues(t *testing.T) {
	commandCh := make(chan []string, 1)
	addr := startRedisProtocolTestServer(t, func(args []string) string {
		switch strings.ToUpper(strings.TrimSpace(args[0])) {
		case "HELLO":
			return "-ERR unknown command 'HELLO'\r\n"
		case "CLIENT":
			return "-ERR unknown subcommand\r\n"
		case "LPUSH":
			commandCh <- append([]string(nil), args...)
			return ":2\r\n"
		}
		return "+OK\r\n"
	})

	rawClient := goredis.NewClient(&goredis.Options{
		Addr:     addr,
		Protocol: 2,
	})
	client := &RedisClientImpl{
		client:       rawClient,
		singleClient: rawClient,
	}
	defer client.Close()

	if err := client.ListPushLeft("tasks", "review", "ship"); err != nil {
		t.Fatalf("ListPushLeft returned error: %v", err)
	}

	select {
	case command := <-commandCh:
		if len(command) != 4 || command[1] != "tasks" || command[2] != "review" || command[3] != "ship" {
			t.Fatalf("unexpected LPUSH command: %v", command)
		}
	case <-time.After(time.Second):
		t.Fatal("expected LPUSH command")
	}
}

func TestListRemoveAtUsesAtomicEvalWithPhysicalKeyAndExpectedValue(t *testing.T) {
	commandCh := make(chan []string, 1)
	addr := startRedisProtocolTestServer(t, func(args []string) string {
		switch strings.ToUpper(strings.TrimSpace(args[0])) {
		case "HELLO":
			return "-ERR unknown command 'HELLO'\r\n"
		case "CLIENT":
			return "-ERR unknown subcommand\r\n"
		case "EVAL":
			commandCh <- append([]string(nil), args...)
			return ":1\r\n"
		}
		return "+OK\r\n"
	})

	rawClient := goredis.NewClient(&goredis.Options{
		Addr:     addr,
		Protocol: 2,
	})
	client := &RedisClientImpl{
		client:       rawClient,
		singleClient: rawClient,
		isCluster:    true,
		currentDB:    3,
	}
	defer client.Close()

	if err := client.ListRemoveAt("tasks", 3, "review"); err != nil {
		t.Fatalf("ListRemoveAt returned error: %v", err)
	}

	select {
	case command := <-commandCh:
		if len(command) != 7 {
			t.Fatalf("unexpected EVAL command length: %v", command)
		}
		if command[2] != "1" || command[3] != "__gonavi_db_3__:tasks" {
			t.Fatalf("expected one physical Redis key, got %v", command)
		}
		if command[4] != "3" || command[5] != "review" {
			t.Fatalf("expected index and value arguments, got %v", command)
		}
		if !strings.HasPrefix(command[6], "\x00gonavi:list-remove:") {
			t.Fatalf("expected collision-resistant marker prefix, got %q", command[6])
		}
		for _, redisCommand := range []string{"LINDEX", "LSET", "LREM"} {
			if !strings.Contains(strings.ToUpper(command[1]), redisCommand) {
				t.Fatalf("expected script to contain %s, got %q", redisCommand, command[1])
			}
		}
		if !strings.Contains(command[1], `redis.pcall("LREM"`) ||
			!strings.Contains(command[1], `redis.pcall("LSET"`) ||
			!strings.Contains(command[1], "rollback failed") {
			t.Fatalf("expected script to restore the selected item after a removal error, got %q", command[1])
		}
	case <-time.After(time.Second):
		t.Fatal("expected EVAL command")
	}
}

func TestListRemoveAtReturnsItemChangedWhenIndexNoLongerMatches(t *testing.T) {
	addr := startRedisProtocolTestServer(t, func(args []string) string {
		switch strings.ToUpper(strings.TrimSpace(args[0])) {
		case "HELLO":
			return "-ERR unknown command 'HELLO'\r\n"
		case "CLIENT":
			return "-ERR unknown subcommand\r\n"
		case "EVAL":
			return ":0\r\n"
		}
		return "+OK\r\n"
	})

	rawClient := goredis.NewClient(&goredis.Options{
		Addr:     addr,
		Protocol: 2,
	})
	client := &RedisClientImpl{
		client:       rawClient,
		singleClient: rawClient,
	}
	defer client.Close()

	err := client.ListRemoveAt("tasks", 3, "review")
	if !errors.Is(err, ErrRedisListItemChanged) {
		t.Fatalf("expected ErrRedisListItemChanged, got %v", err)
	}
}

func TestListRemoveAtRejectsUnexpectedScriptResult(t *testing.T) {
	addr := startRedisProtocolTestServer(t, func(args []string) string {
		switch strings.ToUpper(strings.TrimSpace(args[0])) {
		case "HELLO":
			return "-ERR unknown command 'HELLO'\r\n"
		case "CLIENT":
			return "-ERR unknown subcommand\r\n"
		case "EVAL":
			return ":2\r\n"
		}
		return "+OK\r\n"
	})

	rawClient := goredis.NewClient(&goredis.Options{
		Addr:     addr,
		Protocol: 2,
	})
	client := &RedisClientImpl{
		client:       rawClient,
		singleClient: rawClient,
	}
	defer client.Close()

	err := client.ListRemoveAt("tasks", 3, "review")
	if err == nil {
		t.Fatal("expected unexpected script result to fail")
	}
	if errors.Is(err, ErrRedisListItemChanged) {
		t.Fatalf("expected protocol error, got item-changed sentinel: %v", err)
	}
}

func TestRedisSearchScanContinuesPastEmptyMatchedPages(t *testing.T) {
	var mu sync.Mutex
	scanCalls := 0
	const searchPattern = "*[lL][aA][tT][eE]*"

	redisScanResponse := func(cursor string, keys ...string) string {
		var builder strings.Builder
		builder.WriteString("*2\r\n")
		builder.WriteString(redisBulkString(cursor))
		builder.WriteString(fmt.Sprintf("*%d\r\n", len(keys)))
		for _, key := range keys {
			builder.WriteString(redisBulkString(key))
		}
		return builder.String()
	}

	addr := startRedisProtocolTestServer(t, func(args []string) string {
		command := strings.ToUpper(strings.TrimSpace(args[0]))
		switch command {
		case "HELLO":
			return "-ERR unknown command 'HELLO'\r\n"
		case "CLIENT":
			return "-ERR unknown subcommand\r\n"
		case "SCAN":
			mu.Lock()
			defer mu.Unlock()
			scanCalls++
			for i := 0; i+1 < len(args); i++ {
				if strings.EqualFold(args[i], "MATCH") && args[i+1] != searchPattern {
					t.Fatalf("expected SCAN MATCH %q, got command %v", searchPattern, args)
				}
			}
			if scanCalls <= 16 {
				return redisScanResponse(strconv.Itoa(scanCalls))
			}
			return redisScanResponse("0", "late:user:1")
		case "TYPE":
			return "+string\r\n"
		case "TTL":
			return ":-1\r\n"
		}
		return "+OK\r\n"
	})

	rawClient := goredis.NewClient(&goredis.Options{
		Addr:     addr,
		Protocol: 2,
	})
	client := &RedisClientImpl{
		client:       rawClient,
		singleClient: rawClient,
	}
	defer client.Close()

	result, err := client.ScanKeys(searchPattern, 0, 10)
	if err != nil {
		t.Fatalf("ScanKeys returned error: %v", err)
	}
	if result == nil || len(result.Keys) != 1 {
		t.Fatalf("expected one searched key after empty pages, got %#v", result)
	}
	if result.Keys[0].Key != "late:user:1" {
		t.Fatalf("expected late:user:1, got %#v", result.Keys[0])
	}
	if result.Cursor != "0" {
		t.Fatalf("expected completed cursor, got %q", result.Cursor)
	}

	mu.Lock()
	defer mu.Unlock()
	if scanCalls <= 16 {
		t.Fatalf("expected ScanKeys to continue past 16 empty search pages, got %d calls", scanCalls)
	}
}

func TestRedisSearchScanPaginatesMoreThanOneThousandKeys(t *testing.T) {
	var mu sync.Mutex
	scanCalls := 0
	const searchPattern = "matched:*"

	redisScanResponse := func(cursor string, keys ...string) string {
		var builder strings.Builder
		builder.WriteString("*2\r\n")
		builder.WriteString(redisBulkString(cursor))
		builder.WriteString(fmt.Sprintf("*%d\r\n", len(keys)))
		for _, key := range keys {
			builder.WriteString(redisBulkString(key))
		}
		return builder.String()
	}

	firstBatch := make([]string, 1000)
	for i := range firstBatch {
		firstBatch[i] = fmt.Sprintf("matched:%d", i)
	}

	addr := startRedisProtocolTestServer(t, func(args []string) string {
		command := strings.ToUpper(strings.TrimSpace(args[0]))
		switch command {
		case "HELLO":
			return "-ERR unknown command 'HELLO'\r\n"
		case "CLIENT":
			return "-ERR unknown subcommand\r\n"
		case "SCAN":
			mu.Lock()
			defer mu.Unlock()
			scanCalls++
			if scanCalls == 1 {
				if args[1] != "0" {
					t.Fatalf("expected initial cursor 0, got %q", args[1])
				}
				return redisScanResponse("1", firstBatch...)
			}
			if args[1] != "1" {
				t.Fatalf("expected continuation cursor 1, got %q", args[1])
			}
			return redisScanResponse("0", "matched:1000")
		case "TYPE":
			return "+string\r\n"
		case "TTL":
			return ":-1\r\n"
		}
		return "+OK\r\n"
	})

	rawClient := goredis.NewClient(&goredis.Options{
		Addr:     addr,
		Protocol: 2,
	})
	client := &RedisClientImpl{
		client:       rawClient,
		singleClient: rawClient,
	}
	defer client.Close()

	firstResult, err := client.ScanKeys(searchPattern, 0, redisScanDefaultTargetCount)
	if err != nil {
		t.Fatalf("first ScanKeys returned error: %v", err)
	}
	if firstResult == nil || len(firstResult.Keys) != 1000 || firstResult.Cursor != "1" {
		t.Fatalf("expected first 1000 keys with continuation cursor, got %#v", firstResult)
	}

	secondResult, err := client.ScanKeys(searchPattern, 1, redisScanDefaultTargetCount)
	if err != nil {
		t.Fatalf("second ScanKeys returned error: %v", err)
	}
	if secondResult == nil || len(secondResult.Keys) != 1 || secondResult.Cursor != "0" {
		t.Fatalf("expected final searched key with completed cursor, got %#v", secondResult)
	}

	mu.Lock()
	defer mu.Unlock()
	if scanCalls != 2 {
		t.Fatalf("expected exactly two paged SCAN calls, got %d", scanCalls)
	}
}

func newRedisProtocolClusterClient(t *testing.T, addrs ...string) *goredis.ClusterClient {
	t.Helper()
	slots := make([]goredis.ClusterSlot, 0, len(addrs))
	for index, addr := range addrs {
		start := index * 16384 / len(addrs)
		end := (index+1)*16384/len(addrs) - 1
		slots = append(slots, goredis.ClusterSlot{
			Start: start,
			End:   end,
			Nodes: []goredis.ClusterNode{{Addr: addr}},
		})
	}
	client := goredis.NewClusterClient(&goredis.ClusterOptions{
		ClusterSlots: func(context.Context) ([]goredis.ClusterSlot, error) {
			return slots, nil
		},
		Protocol:              2,
		ContextTimeoutEnabled: true,
	})
	t.Cleanup(func() {
		_ = client.Close()
	})
	return client
}

func TestRedisClusterConnectEnablesContextTimeouts(t *testing.T) {
	var addr string
	addr = startRedisProtocolTestServer(t, func(args []string) string {
		switch strings.ToUpper(strings.TrimSpace(args[0])) {
		case "HELLO":
			return "-ERR unknown command 'HELLO'\r\n"
		case "CLIENT":
			return "-ERR unknown subcommand\r\n"
		case "CLUSTER":
			host, port, err := net.SplitHostPort(addr)
			if err != nil {
				t.Fatalf("split cluster test address: %v", err)
			}
			return fmt.Sprintf("*1\r\n*3\r\n:0\r\n:16383\r\n*3\r\n%s%s%s", redisBulkString(host), redisBulkString(port), redisBulkString("node-1"))
		case "PING":
			return "+PONG\r\n"
		}
		return "+OK\r\n"
	})
	host, portText, err := net.SplitHostPort(addr)
	if err != nil {
		t.Fatalf("split cluster test address: %v", err)
	}
	port, err := strconv.Atoi(portText)
	if err != nil {
		t.Fatalf("parse cluster test port: %v", err)
	}

	client := &RedisClientImpl{}
	if err := client.Connect(connection.ConnectionConfig{
		Type:     "redis",
		Host:     host,
		Port:     port,
		Topology: "cluster",
		Timeout:  2,
	}); err != nil {
		t.Fatalf("Connect returned error: %v", err)
	}
	defer client.Close()

	if client.clusterClient == nil || !client.clusterClient.Options().ContextTimeoutEnabled {
		t.Fatalf("expected production cluster client to enable context timeouts")
	}
}

func TestRedisClusterSearchScansEveryMasterToCompletion(t *testing.T) {
	var mu sync.Mutex
	scanCalls := map[string]int{}
	redisScanResponse := func(cursor string, keys ...string) string {
		var builder strings.Builder
		builder.WriteString("*2\r\n")
		builder.WriteString(redisBulkString(cursor))
		builder.WriteString(fmt.Sprintf("*%d\r\n", len(keys)))
		for _, key := range keys {
			builder.WriteString(redisBulkString(key))
		}
		return builder.String()
	}
	startNode := func(name string, pages []string) string {
		return startRedisProtocolTestServer(t, func(args []string) string {
			switch strings.ToUpper(strings.TrimSpace(args[0])) {
			case "HELLO":
				return "-ERR unknown command 'HELLO'\r\n"
			case "CLIENT":
				return "-ERR unknown subcommand\r\n"
			case "SCAN":
				mu.Lock()
				page := scanCalls[name]
				scanCalls[name]++
				mu.Unlock()
				if page >= len(pages) {
					t.Fatalf("unexpected extra SCAN on %s", name)
				}
				if page+1 < len(pages) {
					return redisScanResponse(strconv.Itoa(page+1), pages[page])
				}
				return redisScanResponse("0", pages[page])
			case "TYPE":
				return "+string\r\n"
			case "TTL":
				return ":-1\r\n"
			}
			return "+OK\r\n"
		})
	}

	firstAddr := startNode("first", []string{"matched:first:1", "matched:first:2"})
	secondAddr := startNode("second", []string{"matched:second:1", "matched:second:2"})
	clusterClient := newRedisProtocolClusterClient(t, firstAddr, secondAddr)
	client := &RedisClientImpl{
		client:        clusterClient,
		clusterClient: clusterClient,
		isCluster:     true,
	}

	result, err := client.ScanKeys("matched:*", 0, 1)
	if err != nil {
		t.Fatalf("ScanKeys returned error: %v", err)
	}
	if result == nil || len(result.Keys) != 4 {
		t.Fatalf("expected all four cluster search results, got %#v", result)
	}
	if result.Cursor != "0" {
		t.Fatalf("expected completed cluster cursor, got %q", result.Cursor)
	}

	mu.Lock()
	defer mu.Unlock()
	if scanCalls["first"] != 2 || scanCalls["second"] != 2 {
		t.Fatalf("expected every master to reach cursor 0, got %#v", scanCalls)
	}
}

func TestRedisClusterExactSearchKeepsTargetCountLimit(t *testing.T) {
	keys := make([]string, redisSearchMaxResultCount+1)
	for i := range keys {
		keys[i] = fmt.Sprintf("folder:item:%d", i)
	}
	var response strings.Builder
	response.WriteString("*2\r\n$1\r\n0\r\n")
	response.WriteString(fmt.Sprintf("*%d\r\n", len(keys)))
	for _, key := range keys {
		response.WriteString(redisBulkString(key))
	}

	addr := startRedisProtocolTestServer(t, func(args []string) string {
		switch strings.ToUpper(strings.TrimSpace(args[0])) {
		case "HELLO":
			return "-ERR unknown command 'HELLO'\r\n"
		case "CLIENT":
			return "-ERR unknown subcommand\r\n"
		case "SCAN":
			return response.String()
		case "TYPE":
			return "+string\r\n"
		case "TTL":
			return ":-1\r\n"
		}
		return "+OK\r\n"
	})
	clusterClient := newRedisProtocolClusterClient(t, addr)
	client := &RedisClientImpl{
		client:        clusterClient,
		clusterClient: clusterClient,
		isCluster:     true,
	}

	result, err := client.ScanKeys("folder", 0, 2)
	if err != nil {
		t.Fatalf("ScanKeys returned error: %v", err)
	}
	if result == nil || len(result.Keys) != 2 {
		t.Fatalf("expected exact search to keep the target count, got %#v", result)
	}
}

func TestRedisClusterSearchKeepsEntireScanBatch(t *testing.T) {
	addr := startRedisProtocolTestServer(t, func(args []string) string {
		switch strings.ToUpper(strings.TrimSpace(args[0])) {
		case "HELLO":
			return "-ERR unknown command 'HELLO'\r\n"
		case "CLIENT":
			return "-ERR unknown subcommand\r\n"
		case "SCAN":
			return "*2\r\n$1\r\n0\r\n*2\r\n$15\r\nmatched:first:1\r\n$15\r\nmatched:first:2\r\n"
		case "TYPE":
			return "+string\r\n"
		case "TTL":
			return ":-1\r\n"
		}
		return "+OK\r\n"
	})
	clusterClient := newRedisProtocolClusterClient(t, addr)
	client := &RedisClientImpl{
		client:        clusterClient,
		clusterClient: clusterClient,
		isCluster:     true,
	}

	result, err := client.ScanKeys("matched:*", 0, 1)
	if err != nil {
		t.Fatalf("ScanKeys returned error: %v", err)
	}
	if result == nil || len(result.Keys) != 2 {
		t.Fatalf("expected the entire Redis SCAN batch, got %#v", result)
	}
}

func TestRedisClusterSearchRejectsResultsOverSafetyLimit(t *testing.T) {
	keys := make([]string, redisSearchMaxResultCount+1)
	for i := range keys {
		keys[i] = fmt.Sprintf("matched:%d", i)
	}
	var response strings.Builder
	response.WriteString("*2\r\n$1\r\n0\r\n")
	response.WriteString(fmt.Sprintf("*%d\r\n", len(keys)))
	for _, key := range keys {
		response.WriteString(redisBulkString(key))
	}

	addr := startRedisProtocolTestServer(t, func(args []string) string {
		switch strings.ToUpper(strings.TrimSpace(args[0])) {
		case "HELLO":
			return "-ERR unknown command 'HELLO'\r\n"
		case "CLIENT":
			return "-ERR unknown subcommand\r\n"
		case "SCAN":
			return response.String()
		}
		return "+OK\r\n"
	})
	clusterClient := newRedisProtocolClusterClient(t, addr)
	client := &RedisClientImpl{
		client:        clusterClient,
		clusterClient: clusterClient,
		isCluster:     true,
	}

	result, err := client.ScanKeys("matched:*", 0, redisScanDefaultTargetCount)
	if err == nil || !strings.Contains(err.Error(), strconv.Itoa(redisSearchMaxResultCount)) {
		t.Fatalf("expected safety-limit error, got result=%#v err=%v", result, err)
	}
}

func TestRedisClusterSearchHonorsSharedDeadline(t *testing.T) {
	addr := startRedisProtocolTestServer(t, func(args []string) string {
		switch strings.ToUpper(strings.TrimSpace(args[0])) {
		case "HELLO":
			return "-ERR unknown command 'HELLO'\r\n"
		case "CLIENT":
			return "-ERR unknown subcommand\r\n"
		case "SCAN":
			time.Sleep(redisSearchMaxDuration + 2*time.Second)
			return "*2\r\n$1\r\n0\r\n*0\r\n"
		}
		return "+OK\r\n"
	})
	clusterClient := newRedisProtocolClusterClient(t, addr)
	client := &RedisClientImpl{
		client:        clusterClient,
		clusterClient: clusterClient,
		isCluster:     true,
	}

	startedAt := time.Now()
	result, err := client.ScanKeys("matched:*", 0, 10)
	elapsed := time.Since(startedAt)
	if err == nil {
		t.Fatalf("expected cluster search deadline error, got result %#v", result)
	}
	if elapsed >= redisSearchMaxDuration+time.Second {
		t.Fatalf("expected shared %s deadline, elapsed %s", redisSearchMaxDuration, elapsed)
	}
}

func TestRedisClusterSearchReturnsMetadataErrors(t *testing.T) {
	addr := startRedisProtocolTestServer(t, func(args []string) string {
		switch strings.ToUpper(strings.TrimSpace(args[0])) {
		case "HELLO":
			return "-ERR unknown command 'HELLO'\r\n"
		case "CLIENT":
			return "-ERR unknown subcommand\r\n"
		case "SCAN":
			return "*2\r\n$1\r\n0\r\n*1\r\n$13\r\nmatched:first\r\n"
		case "TYPE":
			return "-ERR TYPE forbidden\r\n"
		case "TTL":
			return ":-1\r\n"
		}
		return "+OK\r\n"
	})
	clusterClient := newRedisProtocolClusterClient(t, addr)
	client := &RedisClientImpl{
		client:        clusterClient,
		clusterClient: clusterClient,
		isCluster:     true,
	}

	result, err := client.ScanKeys("matched:*", 0, 10)
	if err == nil {
		t.Fatalf("expected metadata error, got result %#v", result)
	}
}
