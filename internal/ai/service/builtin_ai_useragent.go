package aiservice

import (
	"strings"
	"sync"
)

const builtinAIUserAgentProduct = "GoNavi"

var (
	builtinAIClientVersionMu sync.RWMutex
	builtinAIClientVersion   string
)

// SetBuiltinAIClientVersion records the desktop build version sent to the
// Gateway as "GoNavi/<version>". Without it every request would arrive as
// "Go-http-client/1.1" and the admin device list could not tell clients apart.
func SetBuiltinAIClientVersion(version string) {
	builtinAIClientVersionMu.Lock()
	defer builtinAIClientVersionMu.Unlock()
	builtinAIClientVersion = sanitizeBuiltinAIClientVersion(version)
}

// builtinAIUserAgent is a single product token. The Gateway keeps only that
// token, so nothing about the machine is sent.
func builtinAIUserAgent() string {
	builtinAIClientVersionMu.RLock()
	defer builtinAIClientVersionMu.RUnlock()
	if builtinAIClientVersion == "" {
		return builtinAIUserAgentProduct
	}
	return builtinAIUserAgentProduct + "/" + builtinAIClientVersion
}

func sanitizeBuiltinAIClientVersion(version string) string {
	version = strings.TrimPrefix(strings.TrimSpace(version), "v")
	var b strings.Builder
	for _, r := range version {
		switch {
		case r >= '0' && r <= '9', r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r == '.', r == '-', r == '+':
			b.WriteRune(r)
		default:
			return b.String()
		}
		if b.Len() >= 32 {
			break
		}
	}
	return b.String()
}
