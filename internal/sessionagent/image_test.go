package sessionagent

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// 本机图片读取：只认受支持的图片类型、只读、限制大小。
func TestReadLocalImageDataURL(t *testing.T) {
	dir := t.TempDir()

	ok := filepath.Join(dir, "shot.png")
	if err := os.WriteFile(ok, []byte("\x89PNG\r\n\x1a\npayload"), 0o644); err != nil {
		t.Fatalf("write png: %v", err)
	}
	dataURL, err := ReadLocalImageDataURL(ok)
	if err != nil {
		t.Fatalf("read png: %v", err)
	}
	if !strings.HasPrefix(dataURL, "data:image/png;base64,") {
		t.Fatalf("unexpected data url prefix: %.40s", dataURL)
	}

	jpg := filepath.Join(dir, "a.JPG")
	if err := os.WriteFile(jpg, []byte("jpegdata"), 0o644); err != nil {
		t.Fatalf("write jpg: %v", err)
	}
	if _, err := ReadLocalImageDataURL(jpg); err != nil {
		t.Fatalf("jpg extension should be case-insensitive: %v", err)
	}

	// 非图片扩展名必须拒绝。
	txt := filepath.Join(dir, "note.txt")
	if err := os.WriteFile(txt, []byte("hi"), 0o644); err != nil {
		t.Fatalf("write txt: %v", err)
	}
	if _, err := ReadLocalImageDataURL(txt); err == nil {
		t.Fatal("txt file must be rejected")
	}

	// 相对路径必须拒绝。
	if _, err := ReadLocalImageDataURL("relative/path.png"); err == nil {
		t.Fatal("relative path must be rejected")
	}
	// 空路径必须拒绝。
	if _, err := ReadLocalImageDataURL("  "); err == nil {
		t.Fatal("empty path must be rejected")
	}
	// 目录必须拒绝。
	if _, err := ReadLocalImageDataURL(dir); err == nil {
		t.Fatal("directory must be rejected")
	}
	// 不存在的文件必须报错而不是 panic。
	if _, err := ReadLocalImageDataURL(filepath.Join(dir, "missing.png")); err == nil {
		t.Fatal("missing file must fail")
	}
}

// 超过大小上限的图片必须被拒绝。
func TestReadLocalImageDataURLTooLarge(t *testing.T) {
	dir := t.TempDir()
	big := filepath.Join(dir, "big.png")
	// 只写头部即可：判定基于文件大小，不读全量。
	if err := os.WriteFile(big, make([]byte, 1024), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	info, err := os.Stat(big)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if info.Size() > MaxLocalImageBytes {
		t.Fatalf("test fixture larger than cap")
	}
	if _, err := ReadLocalImageDataURL(big); err != nil {
		t.Fatalf("small file must pass: %v", err)
	}
}
