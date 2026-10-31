package main

import "testing"

func TestAProcessStartedWithoutALinkStartsNormally(t *testing.T) {
	for _, args := range [][]string{nil, {}, {"mcp-server"}, {"--restart-parent", "123"}} {
		if handOffDeepLink(args, `C:\deeplink-test\GoNavi.exe`) {
			t.Errorf("%v: handed off without a link", args)
		}
	}
}

func TestALinkWithNoGoNaviRunningStartsGoNavi(t *testing.T) {
	// A made-up executable: no process listens for it, so nothing is woken and GoNavi opens.
	if handOffDeepLink([]string{"gonavi://ai-login?status=authorized"}, `C:\deeplink-test\nobody-runs-this\GoNavi.exe`) {
		t.Fatal("handed off to a GoNavi that is not running")
	}
	if handOffDeepLink([]string{"gonavi://ai-login"}, "") {
		t.Fatal("handed off without knowing which executable")
	}
}

func TestTheMacLinkHandlerWakesOnlyForKnownLinks(t *testing.T) {
	woken := 0
	waker := &deepLinkWaker{activator: &primaryWindowActivator{show: nil}}
	waker.activator.show = nil
	// wake() with no runtime context only records a pending activation; count through a wrapper.
	open := func(raw string) {
		before := waker.activator.pending
		waker.openURL(raw)
		if waker.activator.pending && !before {
			woken++
			waker.activator.pending = false
		}
	}
	open("gonavi://ai-login?status=authorized")
	open("gonavi://something-else")
	open("https://example.com")
	open("gonavi://plugin/install?spec=github%3Aa%2Fb")
	open("gonavi://plugin/install?spec=")
	if woken != 2 {
		t.Fatalf("woken %d times, want 2 (the sign-in and the market install links)", woken)
	}
}

func TestAWakeWithoutLinkContentKeepsTheSignInBehavior(t *testing.T) {
	waker := &deepLinkWaker{activator: &primaryWindowActivator{show: nil}}
	// No pending file for the empty executable path: a plain knock must still activate
	// and behave exactly like the sign-in wake did before the market link existed.
	waker.wake()
	if !waker.activator.pending {
		t.Fatal("a plain knock must bring the window forward")
	}
}
