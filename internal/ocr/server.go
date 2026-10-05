package ocr

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"mime"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// The recognition worker runs in the web view and loads its engine and language
// data by URL. How the web view reaches local files differs between the desktop
// runtime in development and in production, so the files are served by a small
// HTTP server of their own: bound to the loopback interface only, on a random port,
// under a random path prefix, and only the component's own files, by exact name.
// Nothing here lists a directory or follows a path the manifest does not name.

type fileServer struct {
	listener net.Listener
	server   *http.Server
	token    string
	host     string // "127.0.0.1:port", the only Host a request may carry
	root     string
	files    map[string]File
}

func newFileServer(root string, component Component) (*fileServer, error) {
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		return nil, fmt.Errorf("listen for component files: %w", err)
	}
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		_ = listener.Close()
		return nil, fmt.Errorf("create access token: %w", err)
	}
	s := &fileServer{
		listener: listener,
		token:    hex.EncodeToString(buf),
		host:     listener.Addr().String(),
		root:     root,
		files:    make(map[string]File, len(component.Files)),
	}
	for _, file := range component.Files {
		s.files[file.Path] = file
	}
	s.server = &http.Server{
		Handler:           s,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       30 * time.Second,
	}
	go func() { _ = s.server.Serve(listener) }()
	return s, nil
}

// baseURL is what the worker is given as the prefix of every file path.
func (s *fileServer) baseURL() string { return "http://" + s.host + "/" + s.token }

func (s *fileServer) close() {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := s.server.Shutdown(ctx); err != nil {
		_ = s.server.Close()
	}
}

func (s *fileServer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// A page on the internet can make the browser send requests to 127.0.0.1; a
	// DNS-rebinding page arrives with its own host name. Only our own address is served.
	if r.Host != s.host {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	header := w.Header()
	header.Set("Access-Control-Allow-Origin", "*")
	header.Set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
	header.Set("Access-Control-Max-Age", "600")
	header.Set("Cross-Origin-Resource-Policy", "cross-origin")
	header.Set("X-Content-Type-Options", "nosniff")
	header.Set("Cache-Control", "no-store")
	switch r.Method {
	case http.MethodOptions:
		w.WriteHeader(http.StatusNoContent)
		return
	case http.MethodGet, http.MethodHead:
	default:
		w.Header().Set("Allow", "GET, HEAD, OPTIONS")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	prefix := "/" + s.token + "/"
	if !strings.HasPrefix(r.URL.Path, prefix) {
		http.NotFound(w, r)
		return
	}
	file, ok := s.files[strings.TrimPrefix(r.URL.Path, prefix)]
	if !ok {
		http.NotFound(w, r)
		return
	}
	s.serveFile(w, r, file)
}

func (s *fileServer) serveFile(w http.ResponseWriter, r *http.Request, file File) {
	path := filepath.Join(s.root, currentDir, filepath.FromSlash(file.Path))
	handle, err := os.Open(path)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer handle.Close()
	info, err := handle.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() != file.Size {
		// Gone or changed since it was installed: not ours to serve.
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", contentTypeFor(file.Path))
	http.ServeContent(w, r, "", info.ModTime(), handle)
}

// contentTypeFor is explicit rather than guessed: the language data is gzip bytes
// the worker unpacks itself, so it must reach it exactly as stored.
func contentTypeFor(path string) string {
	if strings.HasSuffix(path, ".js") {
		return "text/javascript; charset=utf-8"
	}
	if t := mime.TypeByExtension(filepath.Ext(path)); t != "" && !strings.HasSuffix(path, ".gz") {
		return t
	}
	return "application/octet-stream"
}

// Serve starts the file server if it is not running and returns the URL prefix the
// recognition worker loads its files from.
func (m *Manager) Serve() (string, error) {
	m.serverMu.Lock()
	defer m.serverMu.Unlock()
	if m.server != nil {
		return m.server.baseURL(), nil
	}
	if !m.intact() {
		return "", ErrNotInstalled
	}
	server, err := newFileServer(m.root, m.component)
	if err != nil {
		return "", err
	}
	m.server = server
	return server.baseURL(), nil
}

func (m *Manager) closeServer() {
	m.serverMu.Lock()
	server := m.server
	m.server = nil
	m.serverMu.Unlock()
	if server != nil {
		server.close()
	}
}

// Close stops the file server. The installed files stay.
func (m *Manager) Close() { m.closeServer() }
