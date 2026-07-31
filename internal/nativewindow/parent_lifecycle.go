package nativewindow

import (
	"context"
	"time"
)

const defaultDetachedParentCheckInterval = time.Second

type detachedParentWatcher interface {
	Alive() (bool, error)
	Close() error
}

func monitorDetachedParent(
	ctx context.Context,
	watcher detachedParentWatcher,
	interval time.Duration,
	onParentExit func(),
) {
	if watcher == nil {
		return
	}
	defer watcher.Close()
	if ctx == nil {
		ctx = context.Background()
	}
	if interval <= 0 {
		interval = defaultDetachedParentCheckInterval
	}

	for {
		alive, err := watcher.Alive()
		if err == nil && !alive {
			if onParentExit != nil {
				onParentExit()
			}
			return
		}

		timer := time.NewTimer(interval)
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
		}
	}
}
