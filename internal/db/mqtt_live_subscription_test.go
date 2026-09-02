package db

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	"GoNavi-Wails/internal/connection"
)

// TestMQTTLiveConfiguredSubscriptionCapturesMessageBeforeQuery is an opt-in
// broker smoke test. It models the desktop workflow that exposed the bug:
// connect with a configured Topic, receive a non-retained message, then open
// the data preview. A configured MQTT subscription must stay active for the
// connection lifetime so that the message is still available to the query.
func TestMQTTLiveConfiguredSubscriptionCapturesMessageBeforeQuery(t *testing.T) {
	addr := strings.TrimSpace(os.Getenv("GONAVI_MQTT_TEST_ADDR"))
	if addr == "" {
		t.Skip("set GONAVI_MQTT_TEST_ADDR to run the live MQTT subscription smoke test")
	}
	host, portText, err := net.SplitHostPort(addr)
	if err != nil {
		t.Fatalf("parse GONAVI_MQTT_TEST_ADDR: %v", err)
	}
	port, err := strconv.Atoi(portText)
	if err != nil {
		t.Fatalf("parse MQTT port: %v", err)
	}

	topic := fmt.Sprintf("gonavi/debug/subscription/live-%d", time.Now().UnixNano())
	db := &MQTTDB{}
	if err := db.Connect(connection.ConnectionConfig{
		Type:             "mqtt",
		Host:             host,
		Port:             port,
		User:             strings.TrimSpace(os.Getenv("GONAVI_MQTT_TEST_USER")),
		Password:         os.Getenv("GONAVI_MQTT_TEST_PASSWORD"),
		Database:         topic,
		ConnectionParams: "qos=1&fetchWaitMs=1200",
		Timeout:          3,
	}); err != nil {
		t.Fatalf("connect live MQTT broker: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })

	payload := map[string]interface{}{
		"source":   "gonavi-live-regression",
		"sequence": time.Now().UnixNano(),
	}
	command, err := json.Marshal(map[string]interface{}{
		"publish": topic,
		"payload": payload,
		"qos":     1,
		"retain":  false,
	})
	if err != nil {
		t.Fatalf("marshal MQTT publish command: %v", err)
	}
	if _, err := db.ExecContext(context.Background(), string(command)); err != nil {
		t.Fatalf("publish live MQTT message: %v", err)
	}

	// Publish completed before the query begins. Without a connection-lifetime
	// subscription this non-retained message is irretrievably lost.
	time.Sleep(150 * time.Millisecond)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	rows, _, err := db.QueryContext(ctx, fmt.Sprintf(`CONSUME FROM %q LIMIT 10`, topic))
	if err != nil {
		t.Fatalf("consume live MQTT message: %v", err)
	}
	if len(rows) != 1 {
		t.Fatalf("configured subscription returned %d messages, want 1", len(rows))
	}
	gotPayload, ok := rows[0]["payload"].(map[string]interface{})
	if !ok || fmt.Sprint(gotPayload["source"]) != payload["source"] {
		t.Fatalf("unexpected MQTT payload: %#v", rows[0]["payload"])
	}
}
