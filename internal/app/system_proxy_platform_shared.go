package app

import (
	"bufio"
	"errors"
	"fmt"
	"net"
	"net/url"
	"path"
	"strconv"
	"strings"
)

type windowsSystemProxySettings struct {
	AutoDetect    bool
	AutoConfigURL string
	Proxy         string
	ProxyBypass   string
}

func resolveWindowsSystemProxySettings(target *url.URL, settings windowsSystemProxySettings) (*url.URL, error) {
	if target == nil || !isSystemProxyTargetScheme(target.Scheme) {
		return nil, nil
	}
	// Windows commonly leaves AutoDetect enabled even when no proxy is actually
	// configured. PAC/WPAD evaluation is outside the HTTP transport's scope. A
	// bare AutoDetect flag therefore means direct access, while an explicit PAC
	// URL remains an actionable unsupported configuration.
	if strings.TrimSpace(settings.Proxy) == "" {
		if strings.TrimSpace(settings.AutoConfigURL) != "" {
			return nil, errors.New("Windows automatic proxy configuration (PAC/WPAD) is not supported; configure an explicit proxy in GoNavi")
		}
		if settings.AutoDetect {
			return nil, nil
		}
	}
	if systemProxyPatternsMatch(target, splitSystemProxyPatterns(settings.ProxyBypass)) {
		return nil, nil
	}

	address, socks, err := selectWindowsManualProxy(target.Scheme, settings.Proxy)
	if err != nil || address == "" {
		return nil, err
	}
	proxyURL, err := parseSystemProxyAddress(address, socks)
	if err != nil {
		return nil, fmt.Errorf("invalid Windows system proxy: %w", err)
	}
	return proxyURL, nil
}

func selectWindowsManualProxy(targetScheme, raw string) (address string, socks bool, err error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", false, nil
	}

	byScheme := make(map[string]string)
	defaultAddress := ""
	for _, part := range strings.Split(raw, ";") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		key, value, hasKey := strings.Cut(part, "=")
		if !hasKey {
			if defaultAddress != "" {
				return "", false, errors.New("multiple unqualified proxy addresses")
			}
			defaultAddress = part
			continue
		}
		key = strings.ToLower(strings.TrimSpace(key))
		value = strings.TrimSpace(value)
		if value == "" {
			continue
		}
		switch key {
		case "http", "https", "ftp", "socks", "socks4", "socks5":
			byScheme[key] = value
		}
	}

	targetScheme = strings.ToLower(strings.TrimSpace(targetScheme))
	if value := byScheme[targetScheme]; value != "" {
		return value, false, nil
	}
	if defaultAddress != "" {
		return defaultAddress, false, nil
	}
	for _, key := range []string{"socks5", "socks", "socks4"} {
		if value := byScheme[key]; value != "" {
			return value, true, nil
		}
	}
	return "", false, nil
}

type gnomeSystemProxySettings struct {
	Mode          string
	AutoConfigURL string
	IgnoreHosts   []string
	UseSameProxy  bool
	HTTP          string
	HTTPS         string
	SOCKS         string
}

func resolveGNOMESystemProxySettings(target *url.URL, settings gnomeSystemProxySettings) (*url.URL, error) {
	if target == nil || !isSystemProxyTargetScheme(target.Scheme) {
		return nil, nil
	}
	switch strings.ToLower(strings.TrimSpace(settings.Mode)) {
	case "", "none":
		return nil, nil
	case "auto":
		return nil, errors.New("GNOME automatic proxy configuration (PAC) is not supported; configure an explicit proxy in GoNavi")
	case "manual":
	default:
		return nil, fmt.Errorf("unsupported GNOME system proxy mode %q", strings.TrimSpace(settings.Mode))
	}

	if systemProxyPatternsMatch(target, settings.IgnoreHosts) {
		return nil, nil
	}
	address := settings.HTTP
	if strings.EqualFold(target.Scheme, "https") && !settings.UseSameProxy {
		address = settings.HTTPS
	}
	forceSOCKS := false
	if strings.TrimSpace(address) == "" {
		address = settings.SOCKS
		forceSOCKS = strings.TrimSpace(address) != ""
	}
	if strings.TrimSpace(address) == "" {
		return nil, nil
	}
	proxyURL, err := parseSystemProxyAddress(address, forceSOCKS)
	if err != nil {
		return nil, fmt.Errorf("invalid GNOME system proxy: %w", err)
	}
	return proxyURL, nil
}

type kdeSystemProxySettings struct {
	Values map[string]string
}

func parseKDEProxySettings(data []byte) (kdeSystemProxySettings, bool, error) {
	values := make(map[string]string)
	scanner := bufio.NewScanner(strings.NewReader(string(data)))
	section := ""
	found := false
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") || strings.HasPrefix(line, ";") {
			continue
		}
		if strings.HasPrefix(line, "[") && strings.HasSuffix(line, "]") {
			section = strings.TrimSpace(line[1 : len(line)-1])
			if bracket := strings.Index(section, "]["); bracket >= 0 {
				section = section[:bracket]
			}
			continue
		}
		if !strings.EqualFold(section, "Proxy Settings") {
			continue
		}
		key, value, ok := strings.Cut(line, "=")
		if !ok {
			return kdeSystemProxySettings{}, false, fmt.Errorf("invalid KDE proxy setting line")
		}
		key = strings.TrimSpace(key)
		if bracket := strings.IndexByte(key, '['); bracket >= 0 {
			key = key[:bracket]
		}
		key = strings.ToLower(strings.TrimSpace(key))
		if key == "" {
			return kdeSystemProxySettings{}, false, fmt.Errorf("empty KDE proxy setting key")
		}
		values[key] = decodeKConfigValue(value)
		found = true
	}
	if err := scanner.Err(); err != nil {
		return kdeSystemProxySettings{}, false, err
	}
	return kdeSystemProxySettings{Values: values}, found, nil
}

func resolveKDESystemProxySettings(
	target *url.URL,
	settings kdeSystemProxySettings,
	getenv func(string) string,
) (*url.URL, error) {
	if target == nil || !isSystemProxyTargetScheme(target.Scheme) {
		return nil, nil
	}
	values := settings.Values
	if values == nil {
		return nil, nil
	}
	proxyTypeText := strings.TrimSpace(values["proxytype"])
	if proxyTypeText == "" {
		proxyTypeText = "0"
	}
	proxyType, err := strconv.Atoi(proxyTypeText)
	if err != nil {
		return nil, fmt.Errorf("invalid KDE system proxy type %q", proxyTypeText)
	}
	switch proxyType {
	case 0:
		return nil, nil
	case 2:
		return nil, errors.New("KDE automatic proxy configuration (PAC) is not supported; configure an explicit proxy in GoNavi")
	case 3:
		return nil, errors.New("KDE automatic proxy discovery (WPAD) is not supported; configure an explicit proxy in GoNavi")
	case 1, 4:
	default:
		return nil, fmt.Errorf("unsupported KDE system proxy type %d", proxyType)
	}

	lookup := func(key string) string {
		value := strings.TrimSpace(values[strings.ToLower(key)])
		if proxyType == 4 {
			if getenv == nil || value == "" {
				return ""
			}
			return strings.TrimSpace(getenv(value))
		}
		return value
	}

	patterns := splitSystemProxyPatterns(lookup("NoProxyFor"))
	matched := systemProxyPatternsMatch(target, patterns)
	reversed := proxyType == 1 && parseLooseBool(values["reversedexception"])
	if reversed != matched {
		return nil, nil
	}

	address := lookup(strings.ToLower(target.Scheme) + "Proxy")
	forceSOCKS := false
	if address == "" {
		address = lookup("socksProxy")
		forceSOCKS = address != ""
	}
	if address == "" {
		return nil, nil
	}
	proxyURL, err := parseSystemProxyAddress(address, forceSOCKS)
	if err != nil {
		return nil, fmt.Errorf("invalid KDE system proxy: %w", err)
	}
	return proxyURL, nil
}

func parseSystemProxyAddress(raw string, forceSOCKS bool) (*url.URL, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, errors.New("proxy address is empty")
	}
	if fields := strings.Fields(raw); len(fields) == 2 {
		if _, err := strconv.ParseUint(fields[1], 10, 16); err == nil {
			raw = strings.TrimSuffix(fields[0], "/") + ":" + fields[1]
		}
	}
	if !strings.Contains(raw, "://") {
		raw = "http://" + raw
	}
	parsed, err := url.Parse(raw)
	if err != nil {
		return nil, errors.New("proxy address cannot be parsed")
	}
	if parsed.Hostname() == "" || parsed.Port() == "" {
		return nil, errors.New("proxy host or port is missing")
	}
	port, err := strconv.Atoi(parsed.Port())
	if err != nil || port <= 0 || port > 65535 {
		return nil, errors.New("proxy port is invalid")
	}
	if (parsed.Path != "" && parsed.Path != "/") || parsed.RawQuery != "" || parsed.Fragment != "" {
		return nil, errors.New("proxy address must not contain a path, query, or fragment")
	}

	scheme := strings.ToLower(parsed.Scheme)
	isSOCKS := forceSOCKS || scheme == "socks" || scheme == "socks4" || scheme == "socks5" || scheme == "socks5h"
	if !isSOCKS && scheme != "http" && scheme != "https" {
		return nil, fmt.Errorf("unsupported proxy scheme %q", scheme)
	}
	resultScheme := "http"
	if isSOCKS {
		resultScheme = "socks5"
	}
	return &url.URL{
		Scheme: resultScheme,
		User:   parsed.User,
		Host:   net.JoinHostPort(parsed.Hostname(), strconv.Itoa(port)),
	}, nil
}

func isSystemProxyTargetScheme(scheme string) bool {
	return strings.EqualFold(scheme, "http") || strings.EqualFold(scheme, "https")
}

func splitSystemProxyPatterns(raw string) []string {
	return strings.FieldsFunc(raw, func(r rune) bool {
		return r == ',' || r == ';'
	})
}

func systemProxyPatternsMatch(target *url.URL, patterns []string) bool {
	if target == nil {
		return false
	}
	host := strings.ToLower(strings.TrimSuffix(strings.TrimSpace(target.Hostname()), "."))
	if host == "" {
		return false
	}
	targetPort := target.Port()
	if targetPort == "" {
		switch strings.ToLower(target.Scheme) {
		case "http":
			targetPort = "80"
		case "https":
			targetPort = "443"
		}
	}
	for _, rawPattern := range patterns {
		pattern := strings.ToLower(strings.TrimSpace(rawPattern))
		pattern = strings.Trim(pattern, "\"'")
		if pattern == "" {
			continue
		}
		if pattern == "<local>" {
			if !strings.Contains(host, ".") && net.ParseIP(host) == nil {
				return true
			}
			continue
		}
		if pattern == "*" {
			return true
		}
		if strings.Contains(pattern, "://") {
			if parsed, err := url.Parse(pattern); err == nil && parsed.Hostname() != "" {
				pattern = parsed.Host
			}
		}
		if _, network, err := net.ParseCIDR(pattern); err == nil {
			if address := net.ParseIP(host); address != nil && network.Contains(address) {
				return true
			}
			continue
		}

		patternHost, patternPort := splitSystemProxyPatternHostPort(pattern)
		if patternPort != "" && patternPort != targetPort {
			continue
		}
		patternHost = strings.TrimSuffix(strings.TrimSpace(patternHost), ".")
		if patternHost == "" {
			continue
		}
		if strings.ContainsAny(patternHost, "*?") {
			if matched, err := path.Match(patternHost, host); err == nil && matched {
				return true
			}
			continue
		}
		if strings.HasPrefix(patternHost, ".") {
			patternHost = strings.TrimPrefix(patternHost, ".")
		}
		if host == patternHost || strings.HasSuffix(host, "."+patternHost) {
			return true
		}
	}
	return false
}

func splitSystemProxyPatternHostPort(pattern string) (string, string) {
	if host, port, err := net.SplitHostPort(pattern); err == nil {
		return strings.Trim(host, "[]"), port
	}
	if strings.Count(pattern, ":") == 1 {
		host, port, _ := strings.Cut(pattern, ":")
		if _, err := strconv.ParseUint(port, 10, 16); err == nil {
			return host, port
		}
	}
	return strings.Trim(pattern, "[]"), ""
}

func parseGSettingsString(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", errors.New("empty GSettings string")
	}
	if raw == "nothing" {
		return "", nil
	}
	if raw[0] != '\'' && raw[0] != '"' {
		return raw, nil
	}
	quote := raw[0]
	var result strings.Builder
	escaped := false
	for index := 1; index < len(raw); index++ {
		current := raw[index]
		if escaped {
			result.WriteByte(current)
			escaped = false
			continue
		}
		if current == '\\' {
			escaped = true
			continue
		}
		if current == quote {
			if strings.TrimSpace(raw[index+1:]) != "" {
				return "", errors.New("unexpected content after GSettings string")
			}
			return result.String(), nil
		}
		result.WriteByte(current)
	}
	return "", errors.New("unterminated GSettings string")
}

func parseGSettingsStringArray(raw string) ([]string, error) {
	raw = strings.TrimSpace(raw)
	if strings.HasPrefix(raw, "@as ") {
		raw = strings.TrimSpace(strings.TrimPrefix(raw, "@as "))
	}
	if len(raw) < 2 || raw[0] != '[' || raw[len(raw)-1] != ']' {
		return nil, errors.New("invalid GSettings string array")
	}
	raw = strings.TrimSpace(raw[1 : len(raw)-1])
	if raw == "" {
		return nil, nil
	}
	values := make([]string, 0)
	for len(raw) > 0 {
		raw = strings.TrimSpace(raw)
		if raw == "" {
			break
		}
		if raw[0] != '\'' && raw[0] != '"' {
			return nil, errors.New("invalid GSettings array element")
		}
		quote := raw[0]
		escaped := false
		end := -1
		for index := 1; index < len(raw); index++ {
			if escaped {
				escaped = false
				continue
			}
			if raw[index] == '\\' {
				escaped = true
				continue
			}
			if raw[index] == quote {
				end = index
				break
			}
		}
		if end < 0 {
			return nil, errors.New("unterminated GSettings array element")
		}
		value, err := parseGSettingsString(raw[:end+1])
		if err != nil {
			return nil, err
		}
		values = append(values, value)
		raw = strings.TrimSpace(raw[end+1:])
		if raw == "" {
			break
		}
		if raw[0] != ',' {
			return nil, errors.New("invalid GSettings array separator")
		}
		raw = raw[1:]
	}
	return values, nil
}

func parseGSettingsPort(raw string) (int, error) {
	fields := strings.Fields(strings.TrimSpace(raw))
	if len(fields) == 0 {
		return 0, errors.New("empty GSettings port")
	}
	port, err := strconv.Atoi(fields[len(fields)-1])
	if err != nil || port <= 0 || port > 65535 {
		return 0, errors.New("invalid GSettings port")
	}
	return port, nil
}

func parseLooseBool(raw string) bool {
	value, err := strconv.ParseBool(strings.TrimSpace(raw))
	return err == nil && value
}

func decodeKConfigValue(raw string) string {
	raw = strings.TrimSpace(raw)
	var result strings.Builder
	for index := 0; index < len(raw); index++ {
		if raw[index] != '\\' || index+1 >= len(raw) {
			result.WriteByte(raw[index])
			continue
		}
		index++
		switch raw[index] {
		case 's':
			result.WriteByte(' ')
		case 'n':
			result.WriteByte('\n')
		case 'r':
			result.WriteByte('\r')
		case 't':
			result.WriteByte('\t')
		default:
			result.WriteByte(raw[index])
		}
	}
	return result.String()
}
