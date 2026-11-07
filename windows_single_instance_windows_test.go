//go:build windows && !wails3

package main

import (
	"fmt"
	"os"
	"sync"
	"testing"
	"time"
)

func TestAcquireWindowsMSISingleInstanceRejectsAndSignalsSecondLaunch(t *testing.T) {
	uniqueID := fmt.Sprintf("test-%d-%d", os.Getpid(), time.Now().UnixNano())
	activated := make(chan struct{}, 1)

	releasePrimary, isPrimary, err := acquireWindowsMSISingleInstance(uniqueID, func() {
		activated <- struct{}{}
	})
	if err != nil {
		t.Fatalf("acquire primary single-instance lock: %v", err)
	}
	if !isPrimary || releasePrimary == nil {
		t.Fatalf("first acquisition = primary %v release %v, want primary with release", isPrimary, releasePrimary != nil)
	}
	t.Cleanup(releasePrimary)

	releaseSecond, isPrimary, err := acquireWindowsMSISingleInstance(uniqueID, nil)
	if err != nil {
		t.Fatalf("acquire secondary single-instance lock: %v", err)
	}
	if isPrimary || releaseSecond != nil {
		t.Fatalf("second acquisition = primary %v release %v, want rejected secondary", isPrimary, releaseSecond != nil)
	}

	select {
	case <-activated:
	case <-time.After(2 * time.Second):
		t.Fatal("secondary acquisition did not activate the primary instance")
	}

	releasePrimary()
	releaseReplacement, isPrimary, err := acquireWindowsMSISingleInstance(uniqueID, nil)
	if err != nil {
		t.Fatalf("reacquire single-instance lock after release: %v", err)
	}
	if !isPrimary || releaseReplacement == nil {
		t.Fatalf("replacement acquisition = primary %v release %v, want new primary", isPrimary, releaseReplacement != nil)
	}
	releaseReplacement()
}

func TestAcquireWindowsMSISingleInstanceAllowsOnlyOneConcurrentPrimary(t *testing.T) {
	uniqueID := fmt.Sprintf("concurrent-test-%d-%d", os.Getpid(), time.Now().UnixNano())
	const launchCount = 32
	type claimResult struct {
		release   func()
		isPrimary bool
		err       error
	}

	start := make(chan struct{})
	results := make(chan claimResult, launchCount)
	var claims sync.WaitGroup
	for range launchCount {
		claims.Add(1)
		go func() {
			defer claims.Done()
			<-start
			release, isPrimary, err := acquireWindowsMSISingleInstance(uniqueID, nil)
			results <- claimResult{release: release, isPrimary: isPrimary, err: err}
		}()
	}
	close(start)
	claims.Wait()
	close(results)

	primaryCount := 0
	var releasePrimary func()
	for result := range results {
		if result.err != nil {
			t.Fatalf("concurrent single-instance claim failed: %v", result.err)
		}
		if result.isPrimary {
			primaryCount++
			releasePrimary = result.release
		} else if result.release != nil {
			t.Fatal("secondary concurrent claim unexpectedly returned a release function")
		}
	}
	if primaryCount != 1 || releasePrimary == nil {
		t.Fatalf("concurrent primary count = %d release %v, want exactly one primary", primaryCount, releasePrimary != nil)
	}
	releasePrimary()
}
