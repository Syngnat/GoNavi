package deeplink

import (
	"fmt"
	"strings"
)

// Registration tells Windows that gonavi:// links are opened by this program:
//
//	HKCU\Software\Classes\gonavi                       "URL:GoNavi", "URL Protocol"=""
//	HKCU\Software\Classes\gonavi\DefaultIcon           "<exe>",0
//	HKCU\Software\Classes\gonavi\shell\open\command    "<exe>" "%1"
//
// It is per user (no administrator rights, nothing for other accounts) and is written only
// when the sign-in to the built-in AI starts, by the GoNavi that started it, so the link in
// the browser always opens the GoNavi that is waiting for it, installed or portable, release
// or development. A value that is already right is not written again.

const classesRoot = `Software\Classes\` + Scheme

type registryEntry struct {
	path  string // below HKEY_CURRENT_USER
	name  string // "" is the key's default value
	value string
}

// registryEntries is what has to be in the registry for exePath to handle gonavi:// links.
func registryEntries(exePath string) []registryEntry {
	return []registryEntry{
		{classesRoot, "", "URL:GoNavi"},
		{classesRoot, "URL Protocol", ""},
		{classesRoot + `\DefaultIcon`, "", fmt.Sprintf(`"%s",0`, exePath)},
		{classesRoot + `\shell\open\command`, "", fmt.Sprintf(`"%s" "%%1"`, exePath)},
	}
}

// registryStore is the part of the registry Register uses, so tests never touch the real one.
type registryStore interface {
	Get(path, name string) (string, bool)
	Set(path, name, value string) error
}

// register writes what is missing or different and reports whether it changed anything.
func register(store registryStore, exePath string) (bool, error) {
	exePath = strings.TrimSpace(exePath)
	if exePath == "" || strings.ContainsAny(exePath, "\"\r\n") {
		return false, fmt.Errorf("cannot register %q as the handler of %s:// links", exePath, Scheme)
	}
	changed := false
	for _, entry := range registryEntries(exePath) {
		if current, ok := store.Get(entry.path, entry.name); ok && current == entry.value {
			continue
		}
		if err := store.Set(entry.path, entry.name, entry.value); err != nil {
			return changed, fmt.Errorf("register %s:// links: %w", Scheme, err)
		}
		changed = true
	}
	return changed, nil
}
