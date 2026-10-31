//go:build !windows && !unix

package appdata

// tryAcquireBootstrapFileLock 在无锁实现的平台上与阻塞版一致地直接成功，
// 不提供互斥保证（与 acquireBootstrapFileLock 的 stub 语义相同）。
func tryAcquireBootstrapFileLock(path string) (*bootstrapFileLock, error) {
	return acquireBootstrapFileLock(path)
}
