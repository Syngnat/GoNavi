//go:build wails3

package main

import (
	"reflect"
	"testing"
)

func resetPendingState(t *testing.T) {
	t.Helper()
	pendingMu.Lock()
	frontendReady = false
	pendingOpenFiles = nil
	pendingDeepLinks = nil
	pendingMu.Unlock()
	t.Cleanup(func() {
		pendingMu.Lock()
		frontendReady = false
		pendingOpenFiles = nil
		pendingDeepLinks = nil
		pendingMu.Unlock()
	})
}

func TestSQLFileArgsAcceptsFileURLsAndDeduplicates(t *testing.T) {
	got := sqlFileArgs([]string{
		"file:///tmp/orders.sql",
		"/tmp/orders.sql",
		"  inventory.sql  ",
		"notes.txt",
		"file:///tmp/orders.sql",
	})
	want := []string{"/tmp/orders.sql", "inventory.sql"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("sqlFileArgs = %#v, want %#v", got, want)
	}
}

func TestQueueOrOpenFilesDeduplicatesBeforeReady(t *testing.T) {
	resetPendingState(t)

	queueOrOpenFiles(nil, []string{"a.sql", "a.sql"})
	queueOrOpenFiles(nil, []string{"a.sql", "b.sql"})

	pendingMu.Lock()
	got := append([]string(nil), pendingOpenFiles...)
	pendingMu.Unlock()
	want := []string{"a.sql", "b.sql"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("pendingOpenFiles = %#v, want %#v", got, want)
	}
}

func TestQueueOrDispatchDeepLinkQueuesBeforeReady(t *testing.T) {
	resetPendingState(t)

	queueOrDispatchDeepLink(nil, "gonavi://plugin/install?id=demo")
	queueOrDispatchDeepLink(nil, " gonavi://plugin/install?id=demo ")

	pendingMu.Lock()
	got := append([]string(nil), pendingDeepLinks...)
	pendingMu.Unlock()
	if len(got) != 1 || got[0] != "gonavi://plugin/install?id=demo" {
		t.Fatalf("pendingDeepLinks = %#v", got)
	}
}
