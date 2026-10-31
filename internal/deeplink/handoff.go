package deeplink

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// The wake-up signal between the process a link started and the running GoNavi carries no
// payload, so the raw link travels in a small file next to it: the new process stores the
// link (StorePending) before it knocks, and the running GoNavi picks it up when the knock
// arrives (TakePending). The file lives in the temp directory under a per-executable name,
// holds nothing but the link and is removed on read; a file older than pendingMaxAge is
// ignored, so a link that never found a listener cannot resurface later.

const pendingMaxAge = 2 * time.Minute

const pendingMaxURLLength = 4096

type pendingLink struct {
	URL string `json:"url"`
	At  int64  `json:"at"`
}

func pendingPath(exePath string) string {
	return filepath.Join(os.TempDir(), "gonavi-deeplink-"+slotHash(exePath)+".json")
}

// StorePending remembers rawURL for the GoNavi running from exePath.
func StorePending(exePath, rawURL string) error {
	exePath = strings.TrimSpace(exePath)
	rawURL = strings.TrimSpace(rawURL)
	if exePath == "" || rawURL == "" {
		return errors.New("deep link hand-off needs an executable path and a link")
	}
	if len(rawURL) > pendingMaxURLLength {
		return fmt.Errorf("deep link longer than %d bytes", pendingMaxURLLength)
	}
	data, err := json.Marshal(pendingLink{URL: rawURL, At: time.Now().Unix()})
	if err != nil {
		return err
	}
	return os.WriteFile(pendingPath(exePath), data, 0600)
}

// TakePending returns and removes the link stored for exePath. It reports false when there
// is none, when it is unreadable or when it is too old to trust.
func TakePending(exePath string) (string, bool) {
	exePath = strings.TrimSpace(exePath)
	if exePath == "" {
		return "", false
	}
	path := pendingPath(exePath)
	data, err := os.ReadFile(path)
	if err != nil {
		return "", false
	}
	_ = os.Remove(path)
	var entry pendingLink
	if json.Unmarshal(data, &entry) != nil {
		return "", false
	}
	if strings.TrimSpace(entry.URL) == "" || len(entry.URL) > pendingMaxURLLength {
		return "", false
	}
	if entry.At < time.Now().Add(-pendingMaxAge).Unix() {
		return "", false
	}
	return entry.URL, true
}
