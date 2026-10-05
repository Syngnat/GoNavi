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
	if woken != 1 {
		t.Fatalf("woken %d times, want 1 (only the sign-in link)", woken)
	}
}
