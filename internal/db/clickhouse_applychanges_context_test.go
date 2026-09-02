//go:build gonavi_full_drivers || gonavi_clickhouse_driver

package db

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"testing"
	"time"

	"GoNavi-Wails/internal/connection"
)

const clickHouseApplyTestTable = "`analytics`.`events`"

type clickHouseApplyRoundTripFunc func(*http.Request) (*http.Response, error)

func (fn clickHouseApplyRoundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return fn(request)
}

func TestApplyClickHouseChangesContextCancellationBeforeDispatchIsKnown(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	calls := 0
	err := applyClickHouseChangesContext(ctx, clickHouseApplyTestTable, connection.ChangeSet{
		Deletes: []map[string]interface{}{{"id": 1}},
	}, func(context.Context, string) (int64, error) {
		calls++
		return 1, nil
	})
	if !errors.Is(err, context.Canceled) || IsWriteOutcomeUnknown(err) {
		t.Fatalf("preflight cancellation = %v, unknown=%t", err, IsWriteOutcomeUnknown(err))
	}
	if calls != 0 {
		t.Fatalf("driver calls = %d, want 0", calls)
	}
}

func TestApplyClickHouseChangesContextCancellationInFlightIsUnknown(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	started := make(chan struct{})
	errCh := make(chan error, 1)
	go func() {
		errCh <- applyClickHouseChangesContext(ctx, clickHouseApplyTestTable, connection.ChangeSet{
			Deletes: []map[string]interface{}{{"id": 1}},
		}, func(callCtx context.Context, _ string) (int64, error) {
			close(started)
			<-callCtx.Done()
			return 0, callCtx.Err()
		})
	}()

	select {
	case <-started:
	case <-time.After(2 * time.Second):
		t.Fatal("ClickHouse write did not start")
	}
	cancel()

	select {
	case err := <-errCh:
		if !errors.Is(err, context.Canceled) || !IsWriteOutcomeUnknown(err) {
			t.Fatalf("in-flight cancellation = %v, unknown=%t", err, IsWriteOutcomeUnknown(err))
		}
	case <-time.After(2 * time.Second):
		t.Fatal("ClickHouse write did not stop after cancellation")
	}
}

func TestApplyClickHouseChangesContextFirstSemanticFailureIsKnown(t *testing.T) {
	cause := errors.New("mutation rejected")
	err := applyClickHouseChangesContext(context.Background(), clickHouseApplyTestTable, connection.ChangeSet{
		Deletes: []map[string]interface{}{{"id": 1}},
	}, func(context.Context, string) (int64, error) {
		return 0, cause
	})
	if !errors.Is(err, cause) || IsWriteOutcomeUnknown(err) {
		t.Fatalf("semantic failure = %v, unknown=%t", err, IsWriteOutcomeUnknown(err))
	}
}

func TestApplyClickHouseChangesContextFailureAfterSuccessfulWriteIsUnknown(t *testing.T) {
	cause := errors.New("update rejected")
	calls := 0
	err := applyClickHouseChangesContext(context.Background(), clickHouseApplyTestTable, connection.ChangeSet{
		Deletes: []map[string]interface{}{{"id": 1}},
		Updates: []connection.UpdateRow{{
			Keys: map[string]interface{}{"id": 2}, Values: map[string]interface{}{"name": "updated"},
		}},
	}, func(context.Context, string) (int64, error) {
		calls++
		if calls == 2 {
			return 0, cause
		}
		return 1, nil
	})
	if !errors.Is(err, cause) || !IsWriteOutcomeUnknown(err) {
		t.Fatalf("failure after successful delete = %v, unknown=%t", err, IsWriteOutcomeUnknown(err))
	}
	if calls != 2 {
		t.Fatalf("driver calls = %d, want 2", calls)
	}
}

func TestApplyClickHouseChangesContextCancellationAfterSuccessfulWriteStopsBeforeNextDispatch(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	calls := 0
	err := applyClickHouseChangesContext(ctx, clickHouseApplyTestTable, connection.ChangeSet{
		Deletes: []map[string]interface{}{{"id": 1}, {"id": 2}},
	}, func(context.Context, string) (int64, error) {
		calls++
		cancel()
		return 1, nil
	})
	if !errors.Is(err, context.Canceled) || !IsWriteOutcomeUnknown(err) {
		t.Fatalf("cancellation after successful write = %v, unknown=%t", err, IsWriteOutcomeUnknown(err))
	}
	if calls != 1 {
		t.Fatalf("driver calls = %d, want 1", calls)
	}
}

func TestApplyClickHouseChangesContextLaterInsertBatchFailureIsUnknown(t *testing.T) {
	rows := make([]map[string]interface{}, defaultBatchInsertRows+1)
	for index := range rows {
		rows[index] = map[string]interface{}{"id": index}
	}
	cause := errors.New("second insert batch rejected")
	calls := 0
	err := applyClickHouseChangesContext(context.Background(), clickHouseApplyTestTable, connection.ChangeSet{Inserts: rows}, func(context.Context, string) (int64, error) {
		calls++
		if calls == 2 {
			return 0, cause
		}
		return 1, nil
	})
	if !errors.Is(err, cause) || !IsWriteOutcomeUnknown(err) {
		t.Fatalf("later insert failure = %v, unknown=%t", err, IsWriteOutcomeUnknown(err))
	}
	if calls != 2 {
		t.Fatalf("insert calls = %d, want 2", calls)
	}
}

func TestApplyClickHouseChangesContextFirstInsertSemanticFailureIsKnown(t *testing.T) {
	cause := errors.New("insert rejected")
	err := applyClickHouseChangesContext(context.Background(), clickHouseApplyTestTable, connection.ChangeSet{
		Inserts: []map[string]interface{}{{"id": 1}},
	}, func(context.Context, string) (int64, error) {
		return 0, cause
	})
	if !errors.Is(err, cause) || IsWriteOutcomeUnknown(err) {
		t.Fatalf("first insert failure = %v, unknown=%t", err, IsWriteOutcomeUnknown(err))
	}
}

func TestApplyClickHouseChangesContextInsertCancellationInFlightIsUnknown(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	err := applyClickHouseChangesContext(ctx, clickHouseApplyTestTable, connection.ChangeSet{
		Inserts: []map[string]interface{}{{"id": 1}},
	}, func(callCtx context.Context, _ string) (int64, error) {
		cancel()
		return 0, callCtx.Err()
	})
	if !errors.Is(err, context.Canceled) || !IsWriteOutcomeUnknown(err) {
		t.Fatalf("insert cancellation = %v, unknown=%t", err, IsWriteOutcomeUnknown(err))
	}
}

func TestApplyClickHouseChangesContextSuccess(t *testing.T) {
	calls := 0
	err := applyClickHouseChangesContext(context.Background(), clickHouseApplyTestTable, connection.ChangeSet{
		Deletes: []map[string]interface{}{{"id": 1}},
		Updates: []connection.UpdateRow{{
			Keys: map[string]interface{}{"id": 2}, Values: map[string]interface{}{"name": "updated"},
		}},
		Inserts: []map[string]interface{}{{"id": 3}},
	}, func(context.Context, string) (int64, error) {
		calls++
		return 1, nil
	})
	if err != nil || calls != 3 {
		t.Fatalf("successful changes = %v, calls=%d", err, calls)
	}
}

func TestClickHouseApplyChangesContextCancelsLegacyHTTPRequest(t *testing.T) {
	started := make(chan struct{})
	requestCanceled := make(chan struct{})
	legacyClient := &clickHouseLegacyHTTPClient{
		endpoint: &url.URL{Scheme: "http", Host: "clickhouse.test"},
		http: &http.Client{Transport: clickHouseApplyRoundTripFunc(func(request *http.Request) (*http.Response, error) {
			close(started)
			<-request.Context().Done()
			close(requestCanceled)
			return nil, request.Context().Err()
		})},
		headers: make(http.Header),
		params:  make(url.Values),
	}

	client := &ClickHouseDB{legacyHTTP: legacyClient, database: "analytics"}
	ctx, cancel := context.WithCancel(context.Background())
	errCh := make(chan error, 1)
	go func() {
		errCh <- client.ApplyChangesContext(ctx, "events", connection.ChangeSet{
			Deletes: []map[string]interface{}{{"id": 1}},
		})
	}()

	select {
	case <-started:
	case <-time.After(2 * time.Second):
		t.Fatal("legacy HTTP write did not start")
	}
	cancel()

	select {
	case <-requestCanceled:
	case <-time.After(2 * time.Second):
		t.Fatal("legacy HTTP request context was not canceled")
	}
	select {
	case err := <-errCh:
		if !errors.Is(err, context.Canceled) || !IsWriteOutcomeUnknown(err) {
			t.Fatalf("legacy HTTP cancellation = %v, unknown=%t", err, IsWriteOutcomeUnknown(err))
		}
	case <-time.After(2 * time.Second):
		t.Fatal("legacy HTTP ApplyChangesContext did not return")
	}
}
