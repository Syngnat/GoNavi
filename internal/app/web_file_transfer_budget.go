package app

import (
	"errors"
	"io"
	"os"
	"path/filepath"

	"github.com/google/uuid"
)

func newWebTransferBudget(root string, maxBytes int64, limitErr error) (*webTransferBudget, error) {
	root, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	root = filepath.Clean(root)

	webTransferBudgetRegistry.Lock()
	defer webTransferBudgetRegistry.Unlock()
	state, ok := webTransferBudgetRegistry.roots[root]
	if !ok {
		usage, err := readWebTransferStorageUsage(root)
		if err != nil {
			return nil, err
		}
		state = &webTransferStorageState{storedBytes: usage.bytes, storedTransfers: usage.transfers}
		webTransferBudgetRegistry.roots[root] = state
	}
	if state.storedBytes+state.activeBytes >= MaxWebTransferStorageBytes || state.storedTransfers+state.activeTransfers >= MaxWebTransferCount {
		return nil, ErrWebTransferStorageFull
	}
	state.activeTransfers++
	return &webTransferBudget{
		root:         root,
		maxBytes:     maxBytes,
		storageLimit: MaxWebTransferStorageBytes,
		limitErr:     limitErr,
		transfer:     true,
	}, nil
}

func refreshWebTransferBudget(root string) {
	root, err := filepath.Abs(root)
	if err != nil {
		return
	}
	root = filepath.Clean(root)

	webTransferBudgetRegistry.Lock()
	defer webTransferBudgetRegistry.Unlock()
	state, ok := webTransferBudgetRegistry.roots[root]
	if !ok {
		return
	}
	if state.activeBytes > 0 || state.activeTransfers > 0 {
		return
	}
	usage, err := readWebTransferStorageUsage(root)
	if err != nil {
		return
	}
	state.storedBytes = usage.bytes
	state.storedTransfers = usage.transfers
}

func readWebTransferStorageUsage(root string) (webTransferStorageUsage, error) {
	var usage webTransferStorageUsage
	err := filepath.Walk(root, func(_ string, info os.FileInfo, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if info.Mode().IsRegular() {
			usage.bytes += info.Size()
		}
		if info.IsDir() {
			if _, err := uuid.Parse(info.Name()); err == nil {
				usage.transfers++
			}
		}
		return nil
	})
	if os.IsNotExist(err) {
		return webTransferStorageUsage{}, nil
	}
	return usage, err
}

func (budget *webTransferBudget) reserve(bytes int64) error {
	if budget == nil || bytes <= 0 {
		return nil
	}
	webTransferBudgetRegistry.Lock()
	defer webTransferBudgetRegistry.Unlock()
	if budget.closed {
		return errors.New("web download is no longer writable")
	}
	state := webTransferBudgetRegistry.roots[budget.root]
	if state == nil {
		state = &webTransferStorageState{}
		webTransferBudgetRegistry.roots[budget.root] = state
	}
	if budget.bytes+bytes > budget.maxBytes {
		if budget.limitErr != nil {
			return budget.limitErr
		}
		return ErrWebDownloadTooLarge
	}
	if state.storedBytes+state.activeBytes+bytes > budget.storageLimit {
		return ErrWebTransferStorageFull
	}
	budget.bytes += bytes
	state.activeBytes += bytes
	return nil
}

func (budget *webTransferBudget) release(bytes int64) {
	if budget == nil || bytes <= 0 {
		return
	}
	webTransferBudgetRegistry.Lock()
	defer webTransferBudgetRegistry.Unlock()
	if bytes > budget.bytes {
		bytes = budget.bytes
	}
	budget.bytes -= bytes
	if state := webTransferBudgetRegistry.roots[budget.root]; state != nil {
		state.activeBytes -= bytes
		if state.activeBytes < 0 {
			state.activeBytes = 0
		}
	}
}

func (budget *webTransferBudget) abort(directories ...string) {
	if budget == nil {
		return
	}
	remaining := webTransferStorageUsage{}
	if len(directories) > 0 && directories[0] != "" {
		remaining, _ = readWebTransferStorageUsage(directories[0])
	}
	webTransferBudgetRegistry.Lock()
	defer webTransferBudgetRegistry.Unlock()
	if budget.closed {
		return
	}
	if state := webTransferBudgetRegistry.roots[budget.root]; state != nil {
		state.activeBytes -= budget.bytes
		if state.activeBytes < 0 {
			state.activeBytes = 0
		}
		if budget.transfer {
			state.activeTransfers--
			if state.activeTransfers < 0 {
				state.activeTransfers = 0
			}
		}
		if remaining.transfers > 0 {
			state.storedBytes += remaining.bytes
			state.storedTransfers += remaining.transfers
		}
		if state.activeBytes == 0 && state.activeTransfers == 0 {
			if usage, err := readWebTransferStorageUsage(budget.root); err == nil {
				state.storedBytes = usage.bytes
				state.storedTransfers = usage.transfers
			}
		}
	}
	budget.bytes = 0
	budget.transfer = false
	budget.closed = true
}

func (budget *webTransferBudget) commit(directory string, fallbackBytes int64) {
	if budget == nil {
		return
	}
	if fallbackBytes < 0 {
		fallbackBytes = 0
	}
	stored := webTransferStorageUsage{bytes: fallbackBytes, transfers: 1}
	if usage, err := readWebTransferStorageUsage(directory); err == nil {
		stored = usage
	}
	webTransferBudgetRegistry.Lock()
	defer webTransferBudgetRegistry.Unlock()
	if budget.closed {
		return
	}
	state := webTransferBudgetRegistry.roots[budget.root]
	if state == nil {
		state = &webTransferStorageState{}
		webTransferBudgetRegistry.roots[budget.root] = state
	}
	state.activeBytes -= budget.bytes
	if state.activeBytes < 0 {
		state.activeBytes = 0
	}
	if budget.transfer {
		state.activeTransfers--
		if state.activeTransfers < 0 {
			state.activeTransfers = 0
		}
	}
	if state.activeBytes == 0 && state.activeTransfers == 0 {
		if usage, err := readWebTransferStorageUsage(budget.root); err == nil {
			state.storedBytes = usage.bytes
			state.storedTransfers = usage.transfers
		} else {
			state.storedBytes += stored.bytes
			state.storedTransfers += stored.transfers
		}
	} else {
		state.storedBytes += stored.bytes
		state.storedTransfers += stored.transfers
	}
	budget.bytes = 0
	budget.transfer = false
	budget.closed = true
}

func newWebTransferFile(file *os.File, budget *webTransferBudget) (*webTransferFile, error) {
	if file == nil {
		return nil, errors.New("web download file is required")
	}
	info, err := file.Stat()
	if err != nil {
		return nil, err
	}
	offset, err := file.Seek(0, io.SeekCurrent)
	if err != nil {
		return nil, err
	}
	return &webTransferFile{file: file, budget: budget, offset: offset, size: info.Size()}, nil
}

func (file *webTransferFile) Write(payload []byte) (int, error) {
	if file == nil || file.file == nil {
		return 0, errors.New("web download file is unavailable")
	}
	if len(payload) == 0 {
		return 0, nil
	}
	end := file.offset + int64(len(payload))
	growth := end - file.size
	if growth > 0 {
		if err := file.budget.reserve(growth); err != nil {
			return 0, err
		}
	}
	written, writeErr := file.file.Write(payload)
	file.offset += int64(written)
	actualSize := file.size
	if file.offset > actualSize {
		actualSize = file.offset
	}
	actualGrowth := actualSize - file.size
	if growth > actualGrowth {
		file.budget.release(growth - actualGrowth)
	}
	file.size = actualSize
	if writeErr == nil && written != len(payload) {
		writeErr = io.ErrShortWrite
	}
	return written, writeErr
}

func (file *webTransferFile) Close() error {
	if file == nil || file.file == nil {
		return nil
	}
	return file.file.Close()
}

func (file *webTransferFile) Sync() error {
	if file == nil || file.file == nil {
		return errors.New("web download file is unavailable")
	}
	return file.file.Sync()
}

func (file *webTransferFile) Seek(offset int64, whence int) (int64, error) {
	if file == nil || file.file == nil {
		return 0, errors.New("web download file is unavailable")
	}
	position, err := file.file.Seek(offset, whence)
	if err == nil {
		file.offset = position
	}
	return position, err
}

func (file *webTransferFile) Truncate(size int64) error {
	if file == nil || file.file == nil {
		return errors.New("web download file is unavailable")
	}
	growth := size - file.size
	if growth > 0 {
		if err := file.budget.reserve(growth); err != nil {
			return err
		}
	}
	if err := file.file.Truncate(size); err != nil {
		if growth > 0 {
			file.budget.release(growth)
		}
		return err
	}
	if growth < 0 {
		file.budget.release(-growth)
	}
	file.size = size
	return nil
}
