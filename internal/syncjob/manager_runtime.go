package syncjob

import "context"

func (manager *Manager) startRuntime(ctx context.Context) error {
	now := manager.options.Now()
	acquired, err := manager.store.AcquireSchedulerLease(ctx, "data-sync-scheduler", manager.options.LeaseOwner, now, manager.options.LeaseTTL)
	if err != nil {
		return err
	}
	if acquired {
		if err := manager.recoverInterrupted(ctx); err != nil {
			_ = manager.store.ReleaseSchedulerLease(context.Background(), "data-sync-scheduler", manager.options.LeaseOwner)
			return err
		}
		manager.lastRecoveryAt = now
	}
	manager.wg.Add(1)
	go manager.dispatchLoop()
	if !manager.options.SchedulerDisabled {
		manager.wg.Add(1)
		go manager.schedulerLoop()
	}
	manager.signalWake()
	return nil
}
