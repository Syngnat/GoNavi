//go:build windows

package deeplink

import (
	"fmt"
	"testing"
	"time"
)

// These tests use made-up executable paths, so the event names are theirs alone: they can
// neither wake nor be woken by a real GoNavi that happens to be running on this machine.
func fakeExe(t *testing.T) string {
	return fmt.Sprintf(`C:\deeplink-test\%s-%d\GoNavi.exe`, t.Name(), time.Now().UnixNano())
}

func TestSignalRunningWakesTheProcessThatIsListening(t *testing.T) {
	exe := fakeExe(t)
	woken := make(chan struct{}, 4)
	stop, err := Listen(exe, func() { woken <- struct{}{} })
	if err != nil {
		t.Fatal(err)
	}
	defer stop()

	// A process started by a link finds the running one and wakes it, once per link.
	for i := 0; i < 2; i++ {
		signaled, err := SignalRunning(exe)
		if err != nil || !signaled {
			t.Fatalf("signal %d: %v %v", i, signaled, err)
		}
		select {
		case <-woken:
		case <-time.After(3 * time.Second):
			t.Fatalf("link %d did not wake the running process", i)
		}
	}
}

func TestWithNothingRunningTheLinkProcessCarriesOnAndStartsNormally(t *testing.T) {
	signaled, err := SignalRunning(fakeExe(t))
	if err != nil || signaled {
		t.Fatalf("signaled=%v err=%v; with nothing running there is nobody to wake", signaled, err)
	}
}

func TestAnotherBuildIsNotWokenByALinkForThisOne(t *testing.T) {
	mine, theirs := fakeExe(t), fakeExe(t)+".other"
	woken := make(chan struct{}, 1)
	stop, err := Listen(theirs, func() { woken <- struct{}{} })
	if err != nil {
		t.Fatal(err)
	}
	defer stop()
	if signaled, _ := SignalRunning(mine); signaled {
		t.Fatal("a link for one executable woke another")
	}
	select {
	case <-woken:
		t.Fatal("the other build was woken")
	case <-time.After(300 * time.Millisecond):
	}
}

func TestPathsThatDifferOnlyInCaseShareOneEvent(t *testing.T) {
	if wakeEventName(`D:\Apps\GoNavi\GoNavi.exe`) != wakeEventName(`d:\apps\gonavi\gonavi.exe`) {
		t.Fatal("Windows paths are case-insensitive: one executable, one event")
	}
	if wakeEventName(`D:\Apps\GoNavi\GoNavi.exe`) == wakeEventName(`D:\Apps\GoNavi\GoNavi-dev.exe`) {
		t.Fatal("two executables share an event")
	}
}

func TestAStoppedListenerIsGoneAndASecondListenerForTheSameExeDoesNotCompete(t *testing.T) {
	exe := fakeExe(t)
	first, err := Listen(exe, func() {})
	if err != nil {
		t.Fatal(err)
	}
	var secondWoken bool
	second, err := Listen(exe, func() { secondWoken = true })
	if err != nil {
		t.Fatal(err)
	}
	second() // the one that never listened can be stopped harmlessly
	if signaled, _ := SignalRunning(exe); !signaled {
		t.Fatal("the first listener should still own the event")
	}
	time.Sleep(100 * time.Millisecond)
	if secondWoken {
		t.Fatal("the second listener must not be woken")
	}
	first()
	first() // stopping twice is fine
	if signaled, _ := SignalRunning(exe); signaled {
		t.Fatal("the event outlived its listener")
	}
}
