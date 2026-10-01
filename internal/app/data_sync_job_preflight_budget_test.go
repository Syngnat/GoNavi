package app

import (
	"context"
	"testing"
	"time"

	"GoNavi-Wails/internal/syncjob"
)

func TestDataSyncJobPreflightTimeoutScalesWithEnabledMappings(t *testing.T) {
	mapping := func(enabled bool) syncjob.TableMapping {
		return syncjob.TableMapping{SourceTable: "t", TargetTable: "t", Enabled: enabled}
	}
	cases := []struct {
		name    string
		mapping []syncjob.TableMapping
		want    time.Duration
	}{
		{"no mappings keeps the base budget", nil, dataSyncJobPreflightBaseTimeout},
		{
			"disabled mappings do not consume budget",
			[]syncjob.TableMapping{mapping(false), mapping(false)},
			dataSyncJobPreflightBaseTimeout,
		},
		{
			"each enabled mapping widens the budget",
			[]syncjob.TableMapping{mapping(true), mapping(true), mapping(true)},
			dataSyncJobPreflightBaseTimeout + 3*dataSyncJobPreflightPerMapping,
		},
		{
			"the budget is capped for very large tasks",
			[]syncjob.TableMapping{mapping(true), mapping(true), mapping(true), mapping(true)},
			dataSyncJobPreflightBaseTimeout + 4*dataSyncJobPreflightPerMapping,
		},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			got := dataSyncJobPreflightTimeoutFor(syncjob.JobDefinition{Mappings: test.mapping})
			if got != test.want {
				t.Fatalf("timeout = %s, want %s", got, test.want)
			}
		})
	}
}

func TestDataSyncJobPreflightTimeoutIsCappedForHugeTasks(t *testing.T) {
	mappings := make([]syncjob.TableMapping, 0, 400)
	for index := 0; index < 400; index++ {
		mappings = append(mappings, syncjob.TableMapping{SourceTable: "t", TargetTable: "t", Enabled: true})
	}
	got := dataSyncJobPreflightTimeoutFor(syncjob.JobDefinition{Mappings: mappings})
	if got != dataSyncJobPreflightMaxTimeout {
		t.Fatalf("timeout = %s, want the %s cap", got, dataSyncJobPreflightMaxTimeout)
	}
}

func TestDataSyncJobMappingKeyIsStableAndCaseInsensitive(t *testing.T) {
	left := dataSyncJobMappingKey(syncjob.TableMapping{SourceSchema: "SRC", SourceTable: "Orders", TargetSchema: "TGT", TargetTable: "orders"})
	right := dataSyncJobMappingKey(syncjob.TableMapping{SourceSchema: " src ", SourceTable: "orders", TargetSchema: "tgt", TargetTable: "ORDERS"})
	if left != right {
		t.Fatalf("mapping keys differ across case/whitespace: %q vs %q", left, right)
	}
	if want := "src.orders -> tgt.orders"; left != want {
		t.Fatalf("mapping key = %q, want %q", left, want)
	}
}

func TestDataSyncJobMappingKeyFallsBackToUnqualifiedName(t *testing.T) {
	got := dataSyncJobMappingKey(syncjob.TableMapping{SourceTable: "orders", TargetTable: "orders"})
	if want := "orders -> orders"; got != want {
		t.Fatalf("mapping key = %q, want %q", got, want)
	}
}

func TestDataSyncJobContextIssueCodeSeparatesTimeoutFromCancel(t *testing.T) {
	if got := dataSyncJobContextIssueCode(context.DeadlineExceeded); got != "preflight_timeout" {
		t.Fatalf("deadline code = %q, want preflight_timeout", got)
	}
	if got := dataSyncJobContextIssueCode(context.Canceled); got != "request_cancelled" {
		t.Fatalf("cancel code = %q, want request_cancelled", got)
	}
}

func TestPreflightMappingsRecordsProgressWhenCancelled(t *testing.T) {
	definition := syncjob.NormalizeDefinition(syncjob.JobDefinition{
		Name: "progress", Kind: syncjob.JobKindReconcile, Lifecycle: syncjob.JobLifecycleReady,
		Source: syncjob.EndpointRef{ConnectionID: "source", Database: "db"},
		Target: syncjob.EndpointRef{ConnectionID: "target", Database: "db"},
		Mappings: []syncjob.TableMapping{
			{SourceTable: "t1", TargetTable: "t1", Enabled: true},
			{SourceTable: "t2", TargetTable: "t2", Enabled: true},
		},
	})
	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	progress := DataSyncJobPreflightProgress{}
	application := NewAppWithSecretStore(newFakeAppSecretStore())
	application.configDir = t.TempDir()
	t.Cleanup(application.Shutdown)

	// 已取消的 ctx 让循环在第一次迭代前就返回；进度对象仍需保留分母，
	// 使调用方能报出「已检查 0/2」而不是一个没有分母的超时。
	application.preflightDataSyncMappingsWithProgress(
		cancelled,
		definition,
		resolvedDataSyncJobEndpoint{},
		resolvedDataSyncJobEndpoint{},
		&progress,
	)
	if progress.Total != 2 {
		t.Fatalf("progress total = %d, want 2", progress.Total)
	}
	if progress.Checked != 0 {
		t.Fatalf("progress checked = %d, want 0", progress.Checked)
	}
}
