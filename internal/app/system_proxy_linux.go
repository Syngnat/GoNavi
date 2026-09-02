//go:build linux

package app

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

var (
	errLinuxSystemProxyUnavailable = errors.New("Linux desktop proxy settings are unavailable")
	errLinuxSystemProxyKeyMissing  = errors.New("Linux desktop proxy setting key is unavailable")
)

type linuxSystemProxySource int

const (
	linuxSystemProxySourceUnknown linuxSystemProxySource = iota
	linuxSystemProxySourceGNOME
	linuxSystemProxySourceKDE
)

type linuxSystemProxySnapshot struct {
	source linuxSystemProxySource
	gnome  gnomeSystemProxySettings
	kde    kdeSystemProxySettings
}

var linuxSystemProxyCache = systemProxySnapshotCache[linuxSystemProxySnapshot]{ttl: 5 * time.Second}

func resolvePlatformSystemProxy(target *url.URL) (*url.URL, error) {
	snapshot, err := linuxSystemProxyCache.get(loadLinuxSystemProxySnapshot)
	if err != nil {
		return nil, err
	}
	switch snapshot.source {
	case linuxSystemProxySourceGNOME:
		return resolveGNOMESystemProxySettings(target, snapshot.gnome)
	case linuxSystemProxySourceKDE:
		return resolveKDESystemProxySettings(target, snapshot.kde, os.Getenv)
	default:
		return nil, nil
	}
}

func loadLinuxSystemProxySnapshot() (linuxSystemProxySnapshot, error) {
	preference := currentLinuxSystemProxySource()
	switch preference {
	case linuxSystemProxySourceKDE:
		if settings, found, err := loadKDESystemProxySettings(); err != nil {
			return linuxSystemProxySnapshot{}, err
		} else if found {
			return linuxSystemProxySnapshot{source: linuxSystemProxySourceKDE, kde: settings}, nil
		}
		if settings, available, err := loadGNOMESystemProxySettings(readGSettingsValue); err != nil {
			return linuxSystemProxySnapshot{}, err
		} else if available {
			return linuxSystemProxySnapshot{source: linuxSystemProxySourceGNOME, gnome: settings}, nil
		}
		return linuxSystemProxySnapshot{}, nil
	case linuxSystemProxySourceGNOME:
		if settings, available, err := loadGNOMESystemProxySettings(readGSettingsValue); err != nil {
			return linuxSystemProxySnapshot{}, err
		} else if available {
			return linuxSystemProxySnapshot{source: linuxSystemProxySourceGNOME, gnome: settings}, nil
		}
		if settings, found, err := loadKDESystemProxySettings(); err != nil {
			return linuxSystemProxySnapshot{}, err
		} else if found {
			return linuxSystemProxySnapshot{source: linuxSystemProxySourceKDE, kde: settings}, nil
		}
		return linuxSystemProxySnapshot{}, nil
	}

	gnome, gnomeAvailable, gnomeErr := loadGNOMESystemProxySettings(readGSettingsValue)
	if gnomeErr != nil {
		return linuxSystemProxySnapshot{}, gnomeErr
	}
	kde, kdeFound, kdeErr := loadKDESystemProxySettings()
	if kdeErr != nil {
		return linuxSystemProxySnapshot{}, kdeErr
	}
	if gnomeAvailable && !strings.EqualFold(strings.TrimSpace(gnome.Mode), "none") && strings.TrimSpace(gnome.Mode) != "" {
		return linuxSystemProxySnapshot{source: linuxSystemProxySourceGNOME, gnome: gnome}, nil
	}
	if kdeFound && kdeSystemProxyIsConfigured(kde) {
		return linuxSystemProxySnapshot{source: linuxSystemProxySourceKDE, kde: kde}, nil
	}
	if gnomeAvailable {
		return linuxSystemProxySnapshot{source: linuxSystemProxySourceGNOME, gnome: gnome}, nil
	}
	if kdeFound {
		return linuxSystemProxySnapshot{source: linuxSystemProxySourceKDE, kde: kde}, nil
	}
	return linuxSystemProxySnapshot{}, nil
}

func currentLinuxSystemProxySource() linuxSystemProxySource {
	desktop := strings.ToLower(strings.Join([]string{
		os.Getenv("XDG_CURRENT_DESKTOP"),
		os.Getenv("XDG_SESSION_DESKTOP"),
		os.Getenv("DESKTOP_SESSION"),
	}, ":"))
	if strings.Contains(desktop, "kde") || strings.Contains(desktop, "plasma") || os.Getenv("KDE_FULL_SESSION") != "" {
		return linuxSystemProxySourceKDE
	}
	for _, marker := range []string{"gnome", "cinnamon", "unity", "budgie"} {
		if strings.Contains(desktop, marker) {
			return linuxSystemProxySourceGNOME
		}
	}
	return linuxSystemProxySourceUnknown
}

type gsettingsValueReader func(schema, key string) (string, error)

func loadGNOMESystemProxySettings(reader gsettingsValueReader) (gnomeSystemProxySettings, bool, error) {
	if reader == nil {
		return gnomeSystemProxySettings{}, false, nil
	}
	modeRaw, err := reader("org.gnome.system.proxy", "mode")
	if errors.Is(err, errLinuxSystemProxyUnavailable) {
		return gnomeSystemProxySettings{}, false, nil
	}
	if err != nil {
		return gnomeSystemProxySettings{}, false, fmt.Errorf("failed to read GNOME system proxy mode: %w", err)
	}
	mode, err := parseGSettingsString(modeRaw)
	if err != nil {
		return gnomeSystemProxySettings{}, true, fmt.Errorf("failed to parse GNOME system proxy mode: %w", err)
	}
	settings := gnomeSystemProxySettings{Mode: mode}
	switch strings.ToLower(strings.TrimSpace(mode)) {
	case "", "none":
		return settings, true, nil
	case "auto":
		if raw, readErr := reader("org.gnome.system.proxy", "autoconfig-url"); readErr == nil {
			settings.AutoConfigURL, _ = parseGSettingsString(raw)
		}
		return settings, true, nil
	case "manual":
	default:
		return settings, true, nil
	}

	if raw, readErr := reader("org.gnome.system.proxy", "ignore-hosts"); readErr == nil {
		settings.IgnoreHosts, err = parseGSettingsStringArray(raw)
		if err != nil {
			return gnomeSystemProxySettings{}, true, fmt.Errorf("failed to parse GNOME proxy ignore-hosts: %w", err)
		}
	} else if !errors.Is(readErr, errLinuxSystemProxyKeyMissing) {
		return gnomeSystemProxySettings{}, true, fmt.Errorf("failed to read GNOME proxy ignore-hosts: %w", readErr)
	}
	if raw, readErr := reader("org.gnome.system.proxy", "use-same-proxy"); readErr == nil {
		settings.UseSameProxy = parseLooseBool(raw)
	} else if !errors.Is(readErr, errLinuxSystemProxyKeyMissing) {
		return gnomeSystemProxySettings{}, true, fmt.Errorf("failed to read GNOME use-same-proxy: %w", readErr)
	}

	settings.HTTP, err = readGNOMEProxyAddress(reader, "http")
	if err != nil {
		return gnomeSystemProxySettings{}, true, err
	}
	settings.HTTPS, err = readGNOMEProxyAddress(reader, "https")
	if err != nil {
		return gnomeSystemProxySettings{}, true, err
	}
	settings.SOCKS, err = readGNOMEProxyAddress(reader, "socks")
	if err != nil {
		return gnomeSystemProxySettings{}, true, err
	}
	return settings, true, nil
}

func readGNOMEProxyAddress(reader gsettingsValueReader, scheme string) (string, error) {
	schema := "org.gnome.system.proxy." + scheme
	hostRaw, err := reader(schema, "host")
	if errors.Is(err, errLinuxSystemProxyKeyMissing) || errors.Is(err, errLinuxSystemProxyUnavailable) {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("failed to read GNOME %s proxy host: %w", scheme, err)
	}
	host, err := parseGSettingsString(hostRaw)
	if err != nil {
		return "", fmt.Errorf("failed to parse GNOME %s proxy host: %w", scheme, err)
	}
	host = strings.TrimSpace(host)
	if host == "" {
		return "", nil
	}
	portRaw, err := reader(schema, "port")
	if err != nil {
		return "", fmt.Errorf("failed to read GNOME %s proxy port: %w", scheme, err)
	}
	port, err := parseGSettingsPort(portRaw)
	if err != nil {
		return "", fmt.Errorf("failed to parse GNOME %s proxy port: %w", scheme, err)
	}
	return net.JoinHostPort(host, strconv.Itoa(port)), nil
}

func readGSettingsValue(schema, key string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, "gsettings", "get", schema, key)
	command.Env = append(os.Environ(), "LC_ALL=C", "LANG=C")
	output, err := command.CombinedOutput()
	if err == nil {
		return strings.TrimSpace(string(output)), nil
	}
	if errors.Is(err, exec.ErrNotFound) {
		return "", errLinuxSystemProxyUnavailable
	}
	message := strings.TrimSpace(string(output))
	if strings.Contains(message, "No such schema") {
		return "", errLinuxSystemProxyUnavailable
	}
	if strings.Contains(message, "No such key") {
		return "", errLinuxSystemProxyKeyMissing
	}
	if ctx.Err() != nil {
		return "", fmt.Errorf("gsettings timed out: %w", ctx.Err())
	}
	if message == "" {
		return "", err
	}
	return "", fmt.Errorf("gsettings failed: %s", message)
}

func loadKDESystemProxySettings() (kdeSystemProxySettings, bool, error) {
	merged := kdeSystemProxySettings{Values: make(map[string]string)}
	found := false
	for _, configPath := range kdeSystemProxyConfigPaths() {
		data, err := os.ReadFile(configPath)
		if os.IsNotExist(err) {
			continue
		}
		if err != nil {
			return kdeSystemProxySettings{}, false, fmt.Errorf("failed to read KDE system proxy settings: %w", err)
		}
		settings, hasProxySettings, err := parseKDEProxySettings(data)
		if err != nil {
			return kdeSystemProxySettings{}, false, fmt.Errorf("failed to parse KDE system proxy settings: %w", err)
		}
		if !hasProxySettings {
			continue
		}
		found = true
		for key, value := range settings.Values {
			merged.Values[key] = value
		}
	}
	return merged, found, nil
}

func kdeSystemProxyConfigPaths() []string {
	directories := strings.Split(os.Getenv("XDG_CONFIG_DIRS"), string(os.PathListSeparator))
	if len(directories) == 1 && strings.TrimSpace(directories[0]) == "" {
		directories = []string{"/etc/xdg"}
	}
	paths := make([]string, 0, len(directories)+1)
	seen := make(map[string]struct{})
	// XDG_CONFIG_DIRS is ordered from highest to lowest priority. Load it in
	// reverse so later values override earlier ones like KConfig does.
	for index := len(directories) - 1; index >= 0; index-- {
		directory := strings.TrimSpace(directories[index])
		if directory == "" {
			continue
		}
		configPath := filepath.Join(directory, "kioslaverc")
		if _, exists := seen[configPath]; !exists {
			paths = append(paths, configPath)
			seen[configPath] = struct{}{}
		}
	}
	if userConfigDirectory, err := os.UserConfigDir(); err == nil && strings.TrimSpace(userConfigDirectory) != "" {
		configPath := filepath.Join(userConfigDirectory, "kioslaverc")
		if _, exists := seen[configPath]; !exists {
			paths = append(paths, configPath)
		}
	}
	return paths
}

func kdeSystemProxyIsConfigured(settings kdeSystemProxySettings) bool {
	proxyType := strings.TrimSpace(settings.Values["proxytype"])
	return proxyType != "" && proxyType != "0"
}
