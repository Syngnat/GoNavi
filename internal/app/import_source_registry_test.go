package app

import (
	"sync"
	"testing"
	"time"
)

type registryTestCloser struct {
	once   sync.Once
	closed chan struct{}
}

func newRegistryTestCloser() *registryTestCloser {
	return &registryTestCloser{closed: make(chan struct{})}
}

func (c *registryTestCloser) Close() error {
	c.once.Do(func() { close(c.closed) })
	return nil
}

func TestImportSourceRegistryClosesAttachedAndLateSources(t *testing.T) {
	attached := newRegistryTestCloser()
	registry := &importSourceRegistry{}
	registry.Attach(attached)
	registry.Close()
	select {
	case <-attached.closed:
	default:
		t.Fatal("attached source was not closed")
	}

	late := newRegistryTestCloser()
	registry.Attach(late)
	select {
	case <-late.closed:
	default:
		t.Fatal("source attached after close request was not closed")
	}
}

func TestScriptWorkbenchFileReaderCloseInterruptsSource(t *testing.T) {
	source := newRegistryTestCloser()
	registry := &importSourceRegistry{}
	registry.Attach(source)
	done := make(chan struct{})
	reader := &scriptWorkbenchFileReader{
		cancel:  func() {},
		sources: registry,
		done:    done,
	}
	finished := make(chan struct{})
	go func() {
		reader.Close()
		close(finished)
	}()

	select {
	case <-source.closed:
	case <-time.After(200 * time.Millisecond):
		t.Fatal("reader close did not interrupt the source immediately")
	}
	close(done)
	select {
	case <-finished:
	case <-time.After(time.Second):
		t.Fatal("reader close did not finish after the stream exited")
	}
}
