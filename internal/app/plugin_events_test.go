package app

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"
	"time"

	"GoNavi-Wails/internal/plugin"
	"GoNavi-Wails/shared/i18n"
)

func pluginEventsTestStatus() plugin.Status {
	return plugin.Status{
		Manifest:       plugin.Manifest{ID: "test.events", Name: "Events", Version: "1.0.0"},
		State:          plugin.StateRunning,
		DesiredEnabled: true,
		Generation:     7,
	}
}

func subscribePluginEvents(t *testing.T, a *App, status plugin.Status, topics string) (string, map[string]any) {
	t.Helper()
	value, code := pluginCapabilityEventsSubscribe(context.Background(), a, pluginCapabilityRequest{
		Status: status, Arguments: json.RawMessage(`{"topics":` + topics + `}`),
	})
	if code != "" {
		t.Fatalf("subscribe failed: %s", code)
	}
	result := value.(map[string]any)
	return result["subscriptionId"].(string), result["snapshot"].(map[string]any)
}

func TestPluginEventsSubscribeReturnsTheCurrentSnapshot(t *testing.T) {
	a := newPluginTestApp(t)
	id, snapshot := subscribePluginEvents(t, a, pluginEventsTestStatus(), `["preferences"]`)
	if id == "" {
		t.Fatal("subscription id missing")
	}
	if snapshot["preferences"] == nil {
		t.Fatalf("snapshot missing preferences: %#v", snapshot)
	}
}

func TestPluginEventsPollDeliversAChange(t *testing.T) {
	a := newPluginTestApp(t)
	localizer, err := i18n.NewLocalizer(i18n.LanguageZhCN)
	if err != nil {
		t.Fatal(err)
	}
	a.i18nMu.Lock()
	a.localizer = localizer
	a.i18nMu.Unlock()
	status := pluginEventsTestStatus()
	id, _ := subscribePluginEvents(t, a, status, `["preferences"]`)

	type pollResult struct {
		value any
		code  string
	}
	done := make(chan pollResult, 1)
	go func() {
		value, code := pluginCapabilityEventsPoll(context.Background(), a, pluginCapabilityRequest{
			Status: status,
			Arguments: json.RawMessage(fmt.Sprintf(`{"subscriptionId":%q,"waitMs":3000}`, id)),
		})
		done <- pollResult{value: value, code: code}
	}()

	time.Sleep(300 * time.Millisecond)
	localizer.SetLanguage(i18n.LanguageEnUS)

	select {
	case result := <-done:
		if result.code != "" {
			t.Fatalf("poll failed: %s", result.code)
		}
		events, ok := result.value.(map[string]any)["events"].([]pluginEvent)
		if !ok || len(events) == 0 || events[0].Topic != "preferences" {
			t.Fatalf("unexpected events: %#v", result.value)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("poll did not return")
	}
}

func TestPluginEventsPollTimesOutWithAnEmptyList(t *testing.T) {
	a := newPluginTestApp(t)
	status := pluginEventsTestStatus()
	id, _ := subscribePluginEvents(t, a, status, `["lifecycle"]`)
	value, code := pluginCapabilityEventsPoll(context.Background(), a, pluginCapabilityRequest{
		Status: status, Arguments: json.RawMessage(fmt.Sprintf(`{"subscriptionId":%q,"waitMs":200}`, id)),
	})
	if code != "" {
		t.Fatalf("poll failed: %s", code)
	}
	events := value.(map[string]any)["events"].([]pluginEvent)
	if len(events) != 0 {
		t.Fatalf("unexpected events: %#v", events)
	}
}

func TestPluginEventsRejectUnknownTopicsAndForeignSubscriptions(t *testing.T) {
	a := newPluginTestApp(t)
	status := pluginEventsTestStatus()
	if _, code := pluginCapabilityEventsSubscribe(context.Background(), a, pluginCapabilityRequest{
		Status: status, Arguments: json.RawMessage(`{"topics":["secret"]}`),
	}); code != "invalid_arguments" {
		t.Fatalf("unknown topic accepted: %s", code)
	}
	id, _ := subscribePluginEvents(t, a, status, `["preferences"]`)
	foreign := status
	foreign.Manifest.ID = "test.other"
	if _, code := pluginCapabilityEventsPoll(context.Background(), a, pluginCapabilityRequest{
		Status: foreign, Arguments: json.RawMessage(fmt.Sprintf(`{"subscriptionId":%q}`, id)),
	}); code != "unknown_subscription" {
		t.Fatalf("foreign subscription was readable: %s", code)
	}
}

func TestPluginEventsUnsubscribeReleasesTheSubscription(t *testing.T) {
	a := newPluginTestApp(t)
	status := pluginEventsTestStatus()
	id, _ := subscribePluginEvents(t, a, status, `["preferences"]`)
	value, code := pluginCapabilityEventsUnsubscribe(context.Background(), a, pluginCapabilityRequest{
		Status: status, Arguments: json.RawMessage(fmt.Sprintf(`{"subscriptionId":%q}`, id)),
	})
	if code != "" || value.(map[string]any)["removed"] != true {
		t.Fatalf("unsubscribe failed: %s %#v", code, value)
	}
	if _, code := pluginCapabilityEventsPoll(context.Background(), a, pluginCapabilityRequest{
		Status: status, Arguments: json.RawMessage(fmt.Sprintf(`{"subscriptionId":%q}`, id)),
	}); code != "unknown_subscription" {
		t.Fatalf("released subscription still readable: %s", code)
	}
}
