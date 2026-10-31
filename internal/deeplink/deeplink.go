// Package deeplink lets a link in a web page bring the running GoNavi to the front.
//
// The built-in AI signs in through the browser: the person authorizes the device on the
// Gateway's page, and that page ends with a "Return to GoNavi" button, which is a
// gonavi://ai-login?status=... link. The plugin market website uses a second link,
// gonavi://plugin/install?... to hand a plugin to the running client. For either to do
// anything the operating system must know which program handles gonavi:// (see Register),
// and a second process started by a link must hand over to the GoNavi that is already
// running instead of opening another window (see SignalRunning and Listen).
//
// Any web page can open a gonavi:// link, so a link is treated as a knock on the door and
// nothing more: it is parsed against a short list of known words and nothing in it is
// executed or opened. A plugin-install link only ever prefills the install panel, which
// then walks the same inspect-confirm-install pipeline as a spec the user typed; the
// link itself is never installed from. The raw link of a knock is stored briefly in a
// per-executable temp file (see handoff.go) so the running GoNavi can read which link
// knocked; the file holds nothing but the link and expires in minutes.
package deeplink

import (
	"net/url"
	"regexp"
	"strings"
)

// Scheme is the URL scheme GoNavi answers to.
const Scheme = "gonavi"

// ActionAILogin is the sign-in link: the built-in AI's browser sign-in finished.
const ActionAILogin = "ai-login"

// ActionPluginInstall is the market link: a web page asks GoNavi to install a plugin.
// The client still inspects the package and asks for confirmation before anything is installed.
const ActionPluginInstall = "plugin-install"

const (
	pluginHost        = "plugin"
	pluginInstallPath = "install"
)

// Link is a gonavi:// link that GoNavi recognizes.
type Link struct {
	Action string
	// Status is the outcome the page reported (authorized, invalid_credentials, ...), or empty.
	// It is a hint for the sign-in, which asks the Gateway for the truth itself.
	Status string
	// Spec is the install source the page suggested (github:owner/repo, an npm name), or empty.
	// A hint only: the install panel parses it again and inspects before installing.
	Spec string
	// PluginID is the market id of the plugin the page showed, or empty.
	PluginID string
}

var statusWord = regexp.MustCompile(`^[a-z][a-z_]{0,31}$`)

// pluginSpecWord bounds what a page may suggest as an install source: identifiers and
// separators only, so drive letters, backslashes (local paths), spaces and shell punctuation
// never survive. The panel re-parses the spec with its own stricter grammar anyway.
var pluginSpecWord = regexp.MustCompile(`^[A-Za-z0-9._@/+:%-]{1,200}$`)

var pluginIDWord = regexp.MustCompile(`^[A-Za-z0-9._-]{1,120}$`)

// Parse reads a gonavi:// link. It refuses anything it does not know: another scheme or
// action, user information, a port, or values that are not plain words.
func Parse(raw string) (Link, bool) {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || !strings.EqualFold(parsed.Scheme, Scheme) {
		return Link{}, false
	}
	if parsed.User != nil || parsed.Port() != "" {
		return Link{}, false
	}
	if strings.EqualFold(parsed.Hostname(), ActionAILogin) {
		if path := strings.Trim(parsed.Path, "/"); path != "" {
			return Link{}, false
		}
		link := Link{Action: ActionAILogin}
		if status := parsed.Query().Get("status"); statusWord.MatchString(status) {
			link.Status = status
		}
		return link, true
	}
	if strings.EqualFold(parsed.Hostname(), pluginHost) {
		if strings.Trim(parsed.Path, "/") != pluginInstallPath {
			return Link{}, false
		}
		query := parsed.Query()
		link := Link{Action: ActionPluginInstall}
		if spec := query.Get("spec"); pluginSpecWord.MatchString(spec) {
			link.Spec = spec
		}
		if id := query.Get("id"); pluginIDWord.MatchString(id) {
			link.PluginID = id
		}
		if link.Spec == "" && link.PluginID == "" {
			return Link{}, false
		}
		return link, true
	}
	return Link{}, false
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
