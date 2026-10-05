// Package deeplink lets a link in a web page bring the running GoNavi to the front.
//
// The built-in AI signs in through the browser: the person authorizes the device on the
// Gateway's page, and that page ends with a "Return to GoNavi" button, which is a
// gonavi://ai-login?status=... link. For it to do anything the operating system must know
// which program handles gonavi:// (see Register), and a second process started by the link
// must hand over to the GoNavi that is already running instead of opening another window
// (see SignalRunning and Listen).
//
// Any web page can open a gonavi:// link, so a link is treated as a knock on the door and
// nothing more: it is parsed against a short list of known words and is only ever used to
// bring the window forward and let the sign-in check its state at once. Nothing in a link is
// executed, opened or stored.
package deeplink

import (
	"net/url"
	"regexp"
	"strings"
)

// Scheme is the URL scheme GoNavi answers to.
const Scheme = "gonavi"

// ActionAILogin is the only link GoNavi acts on: the built-in AI's browser sign-in finished.
const ActionAILogin = "ai-login"

// Link is a gonavi:// link that GoNavi recognizes.
type Link struct {
	Action string
	// Status is the outcome the page reported (authorized, invalid_credentials, ...), or empty.
	// It is a hint for the sign-in, which asks the Gateway for the truth itself.
	Status string
}

var statusWord = regexp.MustCompile(`^[a-z][a-z_]{0,31}$`)

// Parse reads a gonavi:// link. It refuses anything it does not know: another scheme or
// action, user information, a port, a stray path, or a status that is not a plain word.
func Parse(raw string) (Link, bool) {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || !strings.EqualFold(parsed.Scheme, Scheme) {
		return Link{}, false
	}
	if parsed.User != nil || parsed.Port() != "" || !strings.EqualFold(parsed.Hostname(), ActionAILogin) {
		return Link{}, false
	}
	if path := strings.Trim(parsed.Path, "/"); path != "" {
		return Link{}, false
	}
	link := Link{Action: ActionAILogin}
	if status := parsed.Query().Get("status"); statusWord.MatchString(status) {
		link.Status = status
	}
	return link, true
}

// FindURLArg returns the first command-line argument that is a gonavi:// link (recognized or
// not: a process started by an unknown link should still hand over and exit, not open a window).
func FindURLArg(args []string) (string, bool) {
	prefix := Scheme + ":"
	for _, arg := range args {
		if len(arg) >= len(prefix) && strings.EqualFold(arg[:len(prefix)], prefix) {
			return arg, true
		}
	}
	return "", false
}
