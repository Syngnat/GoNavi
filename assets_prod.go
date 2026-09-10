//go:build !dev

package main

import (
	"archive/zip"
	"bytes"
	"embed"
	"errors"
	"io"
	"io/fs"
	"path"
	"sort"
	"time"
)

//go:embed frontend/dist.zip
var embeddedDistZip embed.FS

// frontend/scripts/zip-dist.mjs 在 vite build 之后产出 frontend/dist.zip;
// 启动时把 zip 挂成只读 fs.FS 交给 Wails assetserver,前端资源以压缩形态
// 驻留二进制,避免未压缩 dist 直接撑大安装包与绿色版体积。
var assets fs.FS = mustEmbedDistFS()

func mustEmbedDistFS() fs.FS {
	f, err := embeddedDistZip.Open("frontend/dist.zip")
	if err != nil {
		panic("加载内置前端资源失败: " + err.Error())
	}
	defer f.Close()
	data, err := io.ReadAll(f)
	if err != nil {
		panic("读取内置前端资源失败: " + err.Error())
	}
	reader, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		panic("解析内置前端资源失败: " + err.Error())
	}
	return newZipAssetFS(reader)
}

// zipAssetFS 将 archive/zip 适配为 fs.FS。归档只存文件条目,目录从文件路径
// 推导出来,保证 fs.WalkDir/fs.ReadDir 可用(Wails 启动时靠它们定位 index.html)。
type zipAssetFS struct {
	files map[string]*zip.File
	dirs  map[string]map[string]bool // 目录路径 -> 直接子项名(文件或子目录)
}

func newZipAssetFS(reader *zip.Reader) *zipAssetFS {
	za := &zipAssetFS{
		files: make(map[string]*zip.File, len(reader.File)),
		dirs:  map[string]map[string]bool{".": {}},
	}
	for _, file := range reader.File {
		if file.FileInfo().IsDir() {
			continue
		}
		name := path.Clean(file.Name)
		if !fs.ValidPath(name) || name == "." {
			continue
		}
		za.files[name] = file
		parent := path.Dir(name)
		za.dir(parent)[path.Base(name)] = true
		za.ensureDirChain(parent)
	}
	return za
}

func (za *zipAssetFS) dir(name string) map[string]bool {
	children, ok := za.dirs[name]
	if !ok {
		children = make(map[string]bool)
		za.dirs[name] = children
	}
	return children
}

func (za *zipAssetFS) ensureDirChain(dir string) {
	for dir != "." {
		parent := path.Dir(dir)
		za.dir(parent)[path.Base(dir)] = true
		dir = parent
	}
}

func (za *zipAssetFS) Open(name string) (fs.File, error) {
	if !fs.ValidPath(name) {
		return nil, &fs.PathError{Op: "open", Path: name, Err: fs.ErrInvalid}
	}
	if _, ok := za.dirs[name]; ok {
		return newZipAssetDir(za, name), nil
	}
	file, ok := za.files[name]
	if !ok {
		return nil, &fs.PathError{Op: "open", Path: name, Err: fs.ErrNotExist}
	}
	rc, err := file.Open()
	if err != nil {
		return nil, &fs.PathError{Op: "open", Path: name, Err: err}
	}
	return &zipAssetFile{file: file, rc: rc}, nil
}

func (za *zipAssetFS) childEntry(dir, child string) fs.DirEntry {
	if file, ok := za.files[path.Join(dir, child)]; ok {
		return zipAssetFileEntry{file: file}
	}
	return zipAssetDirEntry{name: child}
}

// zipAssetDir 实现 fs.File + fs.ReadDirFile 的合成目录。
type zipAssetDir struct {
	za       *zipAssetFS
	name     string
	children []string
	offset   int
}

func newZipAssetDir(za *zipAssetFS, name string) *zipAssetDir {
	children := make([]string, 0, len(za.dirs[name]))
	for child := range za.dirs[name] {
		children = append(children, child)
	}
	sort.Strings(children)
	return &zipAssetDir{za: za, name: name, children: children}
}

func (d *zipAssetDir) Stat() (fs.FileInfo, error) {
	return zipAssetDirInfo{name: path.Base(d.name)}, nil
}

func (d *zipAssetDir) Read([]byte) (int, error) {
	return 0, &fs.PathError{Op: "read", Path: d.name, Err: errors.New("is a directory")}
}

func (d *zipAssetDir) Close() error { return nil }

func (d *zipAssetDir) ReadDir(count int) ([]fs.DirEntry, error) {
	remaining := d.children[d.offset:]
	if count <= 0 {
		d.offset = len(d.children)
		entries := make([]fs.DirEntry, 0, len(remaining))
		for _, child := range remaining {
			entries = append(entries, d.za.childEntry(d.name, child))
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
		entries = append(entries, d.za.childEntry(d.name, child))
	}
	return entries, nil
}

// zipAssetFile 是 zip 文件条目的 fs.File 视图(archive/zip 只给出 io.ReadCloser)。
type zipAssetFile struct {
	file *zip.File
	rc   io.ReadCloser
}

func (f *zipAssetFile) Stat() (fs.FileInfo, error) { return f.file.FileInfo(), nil }
func (f *zipAssetFile) Read(p []byte) (int, error) { return f.rc.Read(p) }
func (f *zipAssetFile) Close() error               { return f.rc.Close() }

// zipAssetFileEntry 是 zip 文件条目的 fs.DirEntry 视图。
type zipAssetFileEntry struct{ file *zip.File }

func (e zipAssetFileEntry) Name() string { return path.Base(e.file.Name) }
func (e zipAssetFileEntry) IsDir() bool  { return false }
func (e zipAssetFileEntry) Type() fs.FileMode {
	return e.file.FileInfo().Mode().Type()
}
func (e zipAssetFileEntry) Info() (fs.FileInfo, error) { return e.file.FileInfo(), nil }

// zipAssetDirEntry 是推导目录的 fs.DirEntry 视图。
type zipAssetDirEntry struct{ name string }

func (e zipAssetDirEntry) Name() string               { return e.name }
func (e zipAssetDirEntry) IsDir() bool                { return true }
func (e zipAssetDirEntry) Type() fs.FileMode          { return fs.ModeDir }
func (e zipAssetDirEntry) Info() (fs.FileInfo, error) { return zipAssetDirInfo{name: e.name}, nil }

// zipAssetDirInfo 是推导目录的 fs.FileInfo 视图。
type zipAssetDirInfo struct{ name string }

func (i zipAssetDirInfo) Name() string       { return i.name }
func (i zipAssetDirInfo) Size() int64        { return 0 }
func (i zipAssetDirInfo) Mode() fs.FileMode  { return fs.ModeDir | 0o555 }
func (i zipAssetDirInfo) ModTime() time.Time { return time.Time{} }
func (i zipAssetDirInfo) IsDir() bool        { return true }
func (i zipAssetDirInfo) Sys() any           { return nil }
