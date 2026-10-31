package pluginmarket

func (s *Service) downloadOwner() *Service {
	if s.owner != nil {
		return s.owner
	}
	return s
}

func (s *Service) reserveReceiptLocked(source sourceSnapshot, id, path string, receipt downloadReceipt) error {
	if err := s.checkInstallSourceLocked(source, id); err != nil {
		return err
	}
	owner := s.downloadOwner()
	if owner != s {
		owner.mu.Lock()
		defer owner.mu.Unlock()
	}
	if len(s.receipts) >= 32 || owner.totalReceipts >= 32 {
		return ErrBusy
	}
	s.receipts[path] = receipt
	owner.totalReceipts++
	return nil
}

func (s *Service) releaseReceiptLocked(path string) {
	if _, ok := s.receipts[path]; !ok {
		return
	}
	owner := s.downloadOwner()
	if owner != s {
		owner.mu.Lock()
		defer owner.mu.Unlock()
	}
	delete(s.receipts, path)
	owner.totalReceipts--
}
