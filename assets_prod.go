//go:build !dev

package main

import (
	"archive/tar"
	"bytes"
	_ "embed"
	"errors"
	"io"
	"io/fs"
	"path"
	"sort"
	"time"

	"github.com/andybalholm/brotli"
)

// frontend/scripts/pack-dist.mjs 在 vite build 之后产出 frontend/dist.tar.br:
// 整个 dist 打成 tar 后整体 brotli 压缩。固实压缩让各 JS chunk 之间的重复代码
// 互相引用,比逐文件 deflate 的 zip 小约 2.2 MB,且这部分节省会原样体现在安装包
// 与安装后体积上(安装包的 LZMA 对已压缩数据无能为力)。
//
//go:embed frontend/dist.tar.br
var embeddedDistBundle []byte

// 启动时在后台把包解到内存(约 27 MB、约 0.1 s),与 Wails / WebView 初始化并行;
// 首次访问资源时若尚未解完则等待。
var assets fs.FS = newBundleAssetFS(embeddedDistBundle)

// bundleAssetFS 是 tar.br 包解压后的只读 fs.FS。归档只存文件条目,目录从文件
// 路径推导出来,保证 fs.WalkDir/fs.ReadDir 可用(Wails 启动时靠它们定位 index.html)。
type bundleAssetFS struct {
	ready chan struct{}
	files map[string][]byte
	dirs  map[string]map[string]bool // 目录路径 -> 直接子项名(文件或子目录)
}

func newBundleAssetFS(bundle []byte) *bundleAssetFS {
	fsys := &bundleAssetFS{
		ready: make(chan struct{}),
		files: map[string][]byte{},
		dirs:  map[string]map[string]bool{".": {}},
	}
	go func() {
		defer close(fsys.ready)
		if err := fsys.load(bundle); err != nil {
			// 内置资源损坏属于构建缺陷,与原先 zip 解析失败一样直接中止启动。
			panic("加载内置前端资源失败: " + err.Error())
		}
	}()
	return fsys
}

func (b *bundleAssetFS) load(bundle []byte) error {
	reader := tar.NewReader(brotli.NewReader(bytes.NewReader(bundle)))
	for {
		header, err := reader.Next()
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return err
		}
		if header.Typeflag != tar.TypeReg {
			continue
		}
		name := path.Clean(header.Name)
		if !fs.ValidPath(name) || name == "." {
			continue
		}
		data := make([]byte, header.Size)
		if _, err := io.ReadFull(reader, data); err != nil {
			return err
		}
		b.files[name] = data
		parent := path.Dir(name)
		b.dir(parent)[path.Base(name)] = true
		b.ensureDirChain(parent)
	}
}

func (b *bundleAssetFS) dir(name string) map[string]bool {
	children, ok := b.dirs[name]
	if !ok {
		children = make(map[string]bool)
		b.dirs[name] = children
	}
	return children
}

func (b *bundleAssetFS) ensureDirChain(dir string) {
	for dir != "." {
		parent := path.Dir(dir)
		b.dir(parent)[path.Base(dir)] = true
		dir = parent
	}
}

func (b *bundleAssetFS) Open(name string) (fs.File, error) {
	if !fs.ValidPath(name) {
		return nil, &fs.PathError{Op: "open", Path: name, Err: fs.ErrInvalid}
	}
	<-b.ready
	if _, ok := b.dirs[name]; ok {
		return newBundleAssetDir(b, name), nil
	}
	data, ok := b.files[name]
	if !ok {
		return nil, &fs.PathError{Op: "open", Path: name, Err: fs.ErrNotExist}
	}
	return &bundleAssetFile{info: bundleAssetFileInfo{name: path.Base(name), size: int64(len(data))}, Reader: bytes.NewReader(data)}, nil
}

func (b *bundleAssetFS) childEntry(dir, child string) fs.DirEntry {
	if data, ok := b.files[path.Join(dir, child)]; ok {
		return bundleAssetFileEntry{info: bundleAssetFileInfo{name: child, size: int64(len(data))}}
	}
	return bundleAssetDirEntry{name: child}
}

// bundleAssetDir 实现 fs.File + fs.ReadDirFile 的合成目录。
type bundleAssetDir struct {
	fsys     *bundleAssetFS
	name     string
	children []string
	offset   int
}

func newBundleAssetDir(fsys *bundleAssetFS, name string) *bundleAssetDir {
	children := make([]string, 0, len(fsys.dirs[name]))
	for child := range fsys.dirs[name] {
		children = append(children, child)
	}
	sort.Strings(children)
	return &bundleAssetDir{fsys: fsys, name: name, children: children}
}

func (d *bundleAssetDir) Stat() (fs.FileInfo, error) {
	return bundleAssetDirInfo{name: path.Base(d.name)}, nil
}

func (d *bundleAssetDir) Read([]byte) (int, error) {
	return 0, &fs.PathError{Op: "read", Path: d.name, Err: errors.New("is a directory")}
}

func (d *bundleAssetDir) Close() error { return nil }

func (d *bundleAssetDir) ReadDir(count int) ([]fs.DirEntry, error) {
	remaining := d.children[d.offset:]
	if count <= 0 {
		d.offset = len(d.children)
		entries := make([]fs.DirEntry, 0, len(remaining))
		for _, child := range remaining {
			entries = append(entries, d.fsys.childEntry(d.name, child))
		}
		return entries, nil
	}
	if len(remaining) == 0 {
		return nil, io.EOF
	}
	if count > len(remaining) {
		count = len(remaining)
	}
	d.offset += count
	entries := make([]fs.DirEntry, 0, count)
	for _, child := range remaining[:count] {
		entries = append(entries, d.fsys.childEntry(d.name, child))
	}
	return entries, nil
}

// bundleAssetFile 是内存文件的 fs.File 视图;嵌入的 *bytes.Reader 额外提供 Seek,
// 资源服务可据此支持 Range 请求。
type bundleAssetFile struct {
	info bundleAssetFileInfo
	*bytes.Reader
}

func (f *bundleAssetFile) Stat() (fs.FileInfo, error) { return f.info, nil }
func (f *bundleAssetFile) Close() error               { return nil }

// bundleAssetFileInfo 是内存文件的 fs.FileInfo 视图。
type bundleAssetFileInfo struct {
	name string
	size int64
}

func (i bundleAssetFileInfo) Name() string       { return i.name }
func (i bundleAssetFileInfo) Size() int64        { return i.size }
func (i bundleAssetFileInfo) Mode() fs.FileMode  { return 0o444 }
func (i bundleAssetFileInfo) ModTime() time.Time { return time.Time{} }
func (i bundleAssetFileInfo) IsDir() bool        { return false }
func (i bundleAssetFileInfo) Sys() any           { return nil }

// bundleAssetFileEntry 是内存文件的 fs.DirEntry 视图。
type bundleAssetFileEntry struct{ info bundleAssetFileInfo }

func (e bundleAssetFileEntry) Name() string               { return e.info.name }
func (e bundleAssetFileEntry) IsDir() bool                { return false }
func (e bundleAssetFileEntry) Type() fs.FileMode          { return 0 }
func (e bundleAssetFileEntry) Info() (fs.FileInfo, error) { return e.info, nil }

// bundleAssetDirEntry 是推导目录的 fs.DirEntry 视图。
type bundleAssetDirEntry struct{ name string }

func (e bundleAssetDirEntry) Name() string               { return e.name }
func (e bundleAssetDirEntry) IsDir() bool                { return true }
func (e bundleAssetDirEntry) Type() fs.FileMode          { return fs.ModeDir }
func (e bundleAssetDirEntry) Info() (fs.FileInfo, error) { return bundleAssetDirInfo{name: e.name}, nil }

// bundleAssetDirInfo 是推导目录的 fs.FileInfo 视图。
type bundleAssetDirInfo struct{ name string }

func (i bundleAssetDirInfo) Name() string       { return i.name }
func (i bundleAssetDirInfo) Size() int64        { return 0 }
func (i bundleAssetDirInfo) Mode() fs.FileMode  { return fs.ModeDir | 0o555 }
func (i bundleAssetDirInfo) ModTime() time.Time { return time.Time{} }
func (i bundleAssetDirInfo) IsDir() bool        { return true }
func (i bundleAssetDirInfo) Sys() any           { return nil }
