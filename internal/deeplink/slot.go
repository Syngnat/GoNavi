package deeplink

import (
	"crypto/sha256"
	"encoding/hex"
	"strings"
)

// slotHash derives the per-executable suffix shared by the wake event (Windows) and the
// pending-link file: a link must reach the very GoNavi that registered itself, not another
// build that happens to run for the same user.
func slotHash(exePath string) string {
	sum := sha256.Sum256([]byte(strings.ToLower(strings.TrimSpace(exePath))))
	return hex.EncodeToString(sum[:8])
}
