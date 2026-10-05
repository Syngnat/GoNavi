package app

import (
	"archive/zip"
	"bytes"
	"io"
	"os"
	"path/filepath"
	"testing"
)

// zip bomb 护栏：解析侧（InspectDriverPackage）与安装侧（installOptionalDriverAgentFromLocalArchive、
// extractZipFileToPath）必须用同一套限值，任一入口都不能成为绕过点。

func buildZipEntryFile(t *testing.T, name string, payload []byte) *zip.File {
	t.Helper()

	var buf bytes.Buffer
	writer := zip.NewWriter(&buf)
	entry, err := writer.Create(name)
	if err != nil {
		t.Fatalf("创建条目失败: %v", err)
	}
	if _, err := entry.Write(payload); err != nil {
		t.Fatalf("写入条目失败: %v", err)
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("关闭 zip writer 失败: %v", err)
	}

	reader, err := zip.NewReader(bytes.NewReader(buf.Bytes()), int64(buf.Len()))
	if err != nil {
		t.Fatalf("读取 zip 失败: %v", err)
	}
	if len(reader.File) != 1 {
		t.Fatalf("期望 1 个条目，实际 %d", len(reader.File))
	}
	return reader.File[0]
}

func TestGuardDriverPackageFileAllowsNormalBinary(t *testing.T) {
	// 真实驱动二进制不可压缩，声明压缩比接近 1，必须放行。
	// 夹具用伪随机字节：byte(i*31) 这类周期序列会被 deflate 压到 1/50 以下，不具代表性。
	payload := make([]byte, 64<<10)
	seed := uint32(0x9e3779b9)
	for i := range payload {
		seed ^= seed << 13
		seed ^= seed >> 17
		seed ^= seed << 5
		payload[i] = byte(seed)
	}
	if err := guardDriverPackageFile(buildZipEntryFile(t, "MacOS/mariadb-driver-agent-darwin-arm64", payload)); err != nil {
		t.Fatalf("正常条目不应被拦下：%v", err)
	}
}

func TestGuardDriverPackageFileRejectsHighCompressionRatio(t *testing.T) {
	// 零字节流压缩比极高：必须在解压前按声明体积拦下。
	payload := make([]byte, 8<<20)
	file := buildZipEntryFile(t, "MacOS/mariadb-driver-agent-darwin-arm64", payload)
	if file.CompressedSize64 >= file.UncompressedSize64 {
		t.Fatalf("夹具不具高压缩比：compressed=%d uncompressed=%d", file.CompressedSize64, file.UncompressedSize64)
	}
	if err := guardDriverPackageFile(file); err == nil {
		t.Fatal("高压缩比条目应被拦下")
	}
}

func TestGuardDriverPackageFileSkipsNilAndEmpty(t *testing.T) {
	if err := guardDriverPackageFile(nil); err != nil {
		t.Fatalf("nil 条目不应报错：%v", err)
	}
	// 空文件压缩比为 0/0，不应误判为炸弹。
	if err := guardDriverPackageFile(buildZipEntryFile(t, "MacOS/empty", nil)); err != nil {
		t.Fatalf("空条目不应被拦下：%v", err)
	}
}

func TestExtractZipFileToPathRejectsBombBeforeWriting(t *testing.T) {
	target := filepath.Join(t.TempDir(), "duckdb.dll")
	payload := make([]byte, 8<<20)
	file := buildZipEntryFile(t, "Windows/duckdb.dll", payload)

	err := extractZipFileToPath(file, target)
	if err == nil {
		t.Fatal("超高压缩比条目应被拒绝解压")
	}
	// 关键断言：拦在写盘之前，目标路径与临时文件都不应残留。
	if _, statErr := os.Stat(target); !os.IsNotExist(statErr) {
		t.Fatalf("被拒绝的条目不应产生目标文件: %v", statErr)
	}
	if _, statErr := os.Stat(target + ".tmp"); !os.IsNotExist(statErr) {
		t.Fatalf("被拒绝的条目不应残留临时文件: %v", statErr)
	}
}

func TestExtractZipFileToPathWritesNormalEntry(t *testing.T) {
	payload := []byte("duckdb-binary")
	file := buildZipEntryFile(t, "Windows/duckdb.dll", payload)

	target := filepath.Join(t.TempDir(), "nested", "duckdb.dll")
	if err := extractZipFileToPath(file, target); err != nil {
		t.Fatalf("正常条目解压失败：%v", err)
	}
	got, err := os.ReadFile(target)
	if err != nil {
		t.Fatalf("读取解压结果失败：%v", err)
	}
	if !bytes.Equal(got, payload) {
		t.Fatalf("解压内容不一致：want=%q got=%q", payload, got)
	}
}

func TestCopyDriverZipEntryEnforcesLimitAgainstLyingHeader(t *testing.T) {
	// 声明值说谎（声明 0、实际超限）时，限额读取必须兜底拦下。
	oversized := io.LimitReader(zeroReader{}, int64(driverPackageMaxEntryUncompressedBytes)+1024)
	err := copyDriverZipEntry(io.Discard, oversized, "MacOS/lying-header")
	if err == nil {
		t.Fatal("超过上限的流应被拦下")
	}
}

func TestCopyDriverZipEntryAllowsContentAtLimit(t *testing.T) {
	// 边界值：刚好等于上限必须放行，避免把合法大包误判为炸弹。
	exact := io.LimitReader(zeroReader{}, int64(driverPackageMaxEntryUncompressedBytes))
	if err := copyDriverZipEntry(io.Discard, exact, "MacOS/at-limit"); err != nil {
		t.Fatalf("恰好等于上限的条目不应被拦下：%v", err)
	}
}

func TestInstallOptionalDriverAgentFromLocalZipRejectsBomb(t *testing.T) {
	workDir := t.TempDir()
	zipPath := filepath.Join(workDir, "bomb.zip")
	out, err := os.Create(zipPath)
	if err != nil {
		t.Fatalf("创建测试包失败: %v", err)
	}
	writer := zip.NewWriter(out)
	entry, err := writer.Create(optionalDriverBundleEntryPathForVersion("duckdb", ""))
	if err != nil {
		t.Fatalf("创建条目失败: %v", err)
	}
	if _, err := io.Copy(entry, io.LimitReader(zeroReader{}, 8<<20)); err != nil {
		t.Fatalf("写入条目失败: %v", err)
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("关闭测试包失败: %v", err)
	}
	if err := out.Close(); err != nil {
		t.Fatalf("关闭测试包文件失败: %v", err)
	}

	executablePath := filepath.Join(workDir, "duckdb-driver-agent")
	definition := driverDefinition{Type: "duckdb", Name: "DuckDB"}
	if _, err := installOptionalDriverAgentFromLocalArchive(zipPath, definition, executablePath, ""); err == nil {
		t.Fatal("行内导入的炸弹包应被拒绝")
	}
	// 拦在写盘之前：不应留下任何二进制或临时文件。
	if _, statErr := os.Stat(executablePath); !os.IsNotExist(statErr) {
		t.Fatalf("被拒绝的安装不应产生二进制: %v", statErr)
	}
	if _, statErr := os.Stat(executablePath + ".tmp"); !os.IsNotExist(statErr) {
		t.Fatalf("被拒绝的安装不应残留临时文件: %v", statErr)
	}
}
