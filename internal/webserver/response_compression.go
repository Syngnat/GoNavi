package webserver

import (
	"bytes"
	"compress/gzip"
	"io"
	"io/fs"
	"mime"
	"net/http"
	"path"
	"strconv"
	"strings"
	"sync"
)

const compressedAssetCacheLimit = 64 << 20

var gzipWriterPool = sync.Pool{
	New: func() any {
		writer, _ := gzip.NewWriterLevel(io.Discard, gzip.BestSpeed)
		return writer
	},
}

type compressedAssetCache struct {
	mu    sync.Mutex
	items map[string][]byte
	bytes int64
}

func newCompressedAssetCache() *compressedAssetCache {
	return &compressedAssetCache{items: make(map[string][]byte)}
}

func (c *compressedAssetCache) get(key string) ([]byte, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	payload, ok := c.items[key]
	return payload, ok
}

func (c *compressedAssetCache) put(key string, payload []byte) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if _, exists := c.items[key]; exists {
		return
	}
	if c.bytes+int64(len(payload)) > compressedAssetCacheLimit {
		return
	}
	c.items[key] = payload
	c.bytes += int64(len(payload))
}

func acceptsGzip(r *http.Request) bool {
	if r == nil {
		return false
	}
	for _, part := range strings.Split(r.Header.Get("Accept-Encoding"), ",") {
		if strings.EqualFold(strings.TrimSpace(strings.SplitN(part, ";", 2)[0]), "gzip") {
			return true
		}
	}
	return false
}

// compressibleAssetPath 只压缩文本类静态资源。图片/字体/压缩包跳过，
// 避免用 CPU 换更大的响应体。
func compressibleAssetPath(requestPath string) bool {
	switch strings.ToLower(path.Ext(requestPath)) {
	case ".js", ".mjs", ".css", ".html", ".json", ".svg", ".txt", ".map", ".wasm":
		return true
	default:
		return false
	}
}

func staticCacheControl(requestPath string) string {
	if strings.HasPrefix(requestPath, "/assets/") {
		// Vite 产物文件名带内容哈希，可以长期强缓存。
		return "public, max-age=31536000, immutable"
	}
	if requestPath == "/" || strings.HasSuffix(requestPath, "/index.html") {
		return "no-cache"
	}
	return "public, max-age=3600"
}

// serveCompressedAsset 命中文本资源时直接返回 gzip 字节并写入缓存。
// 返回 false 表示交给 FileServer 处理。
func (s *Server) serveCompressedAsset(w http.ResponseWriter, r *http.Request) bool {
	if s == nil || s.assets == nil || r == nil {
		return false
	}
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		return false
	}
	requestPath := path.Clean("/" + r.URL.Path)
	if requestPath == "/" || strings.HasPrefix(requestPath, internalRoutePrefix+"/") {
		return false
	}
	if !compressibleAssetPath(requestPath) || !acceptsGzip(r) {
		return false
	}
	cleanPath := strings.TrimPrefix(requestPath, "/")
	info, err := fs.Stat(s.assets, cleanPath)
	if err != nil || info.IsDir() {
		return false
	}
	cacheKey := cleanPath + ":" + info.ModTime().UTC().Format("20060102150405") + ":" + strconv.FormatInt(info.Size(), 10)
	payload, ok := s.assetCache.get(cacheKey)
	if !ok {
		source, readErr := fs.ReadFile(s.assets, cleanPath)
		if readErr != nil {
			return false
		}
		var buffer bytes.Buffer
		writer := gzipWriterPool.Get().(*gzip.Writer)
		writer.Reset(&buffer)
		_, writeErr := writer.Write(source)
		closeErr := writer.Close()
		writer.Reset(io.Discard)
		gzipWriterPool.Put(writer)
		if writeErr != nil || closeErr != nil {
			return false
		}
		payload = buffer.Bytes()
		s.assetCache.put(cacheKey, payload)
	}
	if contentType := mime.TypeByExtension(path.Ext(requestPath)); contentType != "" {
		w.Header().Set("Content-Type", contentType)
	}
	w.Header().Set("Content-Encoding", "gzip")
	w.Header().Set("Vary", "Accept-Encoding")
	w.Header().Set("Cache-Control", staticCacheControl(requestPath))
	w.Header().Set("Content-Length", strconv.Itoa(len(payload)))
	w.WriteHeader(http.StatusOK)
	if r.Method != http.MethodHead {
		_, _ = w.Write(payload)
	}
	return true
}

// gzipResponseWriter 让处理器先看到普通 ResponseWriter，实际写入走 gzip。
// Unwrap 保证 http.ResponseController 仍能设置底层连接的写超时。
type gzipResponseWriter struct {
	http.ResponseWriter
	writer *gzip.Writer
}

func (w *gzipResponseWriter) Write(payload []byte) (int, error) {
	return w.writer.Write(payload)
}

func (w *gzipResponseWriter) Unwrap() http.ResponseWriter {
	return w.ResponseWriter
}

// withGzipJSON 压缩 /api/invoke 的 JSON 响应。SSE、上传、下载不经过这里。
func withGzipJSON(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !acceptsGzip(r) {
			next.ServeHTTP(w, r)
			return
		}
		writer := gzipWriterPool.Get().(*gzip.Writer)
		writer.Reset(w)
		defer func() {
			_ = writer.Close()
			writer.Reset(io.Discard)
			gzipWriterPool.Put(writer)
		}()
		w.Header().Set("Content-Encoding", "gzip")
		w.Header().Add("Vary", "Accept-Encoding")
		next.ServeHTTP(&gzipResponseWriter{ResponseWriter: w, writer: writer}, r)
	})
}
