package sync

import (
	"fmt"
)

const maxSyncBatchSize = 10000

func normalizedSyncBatchSize(value int) (int, error) {
	if value < 0 {
		return 0, fmt.Errorf("同步批大小不能小于 0")
	}
	if value == 0 {
		return defaultSyncApplyBatchSize, nil
	}
	if value > maxSyncBatchSize {
		return 0, fmt.Errorf("同步批大小不能超过 %d", maxSyncBatchSize)
	}
	return value, nil
}
