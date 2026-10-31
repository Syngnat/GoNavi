package deeplink

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
	"time"
)

func TestStoreAndTakePendingCarryTheLinkToTheSameExecutable(t *testing.T) {
	exe := `C:\deeplink-test\GoNavi.exe`
	t.Cleanup(func() { _ = os.Remove(pendingPath(exe)) })

	if err := StorePending(exe, "gonavi://plugin/install?spec=github%3Aa%2Fb"); err != nil {
		t.Fatalf("StorePending: %v", err)
	}
	got, ok := TakePending(exe)
	if !ok || got != "gonavi://plugin/install?spec=github%3Aa%2Fb" {
		t.Fatalf("TakePending = %q, %v", got, ok)
	}
	// Reading consumes the file: a second knock must not replay an old link.
	if _, ok := TakePending(exe); ok {
		t.Fatal("a stored link must be removed when taken")
	}
}

func TestPendingLinksAreScopedPerExecutable(t *testing.T) {
	a, b := `C:\deeplink-test\A\GoNavi.exe`, `C:\deeplink-test\B\GoNavi-dev.exe`
	t.Cleanup(func() {
		_ = os.Remove(pendingPath(a))
		_ = os.Remove(pendingPath(b))
	})

	if err := StorePending(a, "gonavi://plugin/install?id=a"); err != nil {
		t.Fatalf("StorePending: %v", err)
	}
	if _, ok := TakePending(b); ok {
		t.Fatal("another executable must not read a link stored for a different build")
	}
	if got, ok := TakePending(a); !ok || got != "gonavi://plugin/install?id=a" {
		t.Fatalf("the owning executable lost its link: %q %v", got, ok)
	}
}

func TestTakePendingRefusesGarbageAndStaleLinks(t *testing.T) {
	exe := `C:\deeplink-test\stale\GoNavi.exe`
	path := pendingPath(exe)
	t.Cleanup(func() { _ = os.Remove(path) })

	write := func(entry pendingLink) {
		data, err := json.Marshal(entry)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, data, 0600); err != nil {
			t.Fatal(err)
		}
	}

	write(pendingLink{URL: "", At: time.Now().Unix()})
	if _, ok := TakePending(exe); ok {
		t.Fatal("an empty link must be refused")
	}
	write(pendingLink{URL: "gonavi://plugin/install?id=x", At: time.Now().Add(-pendingMaxAge - time.Minute).Unix()})
	if _, ok := TakePending(exe); ok {
		t.Fatal("a stale link must be refused")
	}
	if err := os.WriteFile(path, []byte("{not json"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, ok := TakePending(exe); ok {
		t.Fatal("an unreadable link must be refused")
	}
	if err := StorePending("", "gonavi://plugin/install?id=x"); err == nil {
		t.Fatal("storing without an executable path must fail")
	}
	if err := StorePending(exe, strings.Repeat("x", pendingMaxURLLength+1)); err == nil {
		t.Fatal("an oversize link must be refused")
	}
}
