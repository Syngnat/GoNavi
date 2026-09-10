// gen-i18n-catalog-zip 将 shared/i18n 的六个语言 JSON 打包成 catalog.zip,
// 供 shared/i18n/catalog.go 以压缩形态嵌入 Go 二进制(六个 JSON 解包后约 6.4MB,
// deflate 后约 1.8MB)。JSON 本体是源文件,前端 vite 直接引用,必须保留。
//
// catalog.zip 是提交进 git 的生成物:修改语言目录后执行 `go generate ./shared/i18n`
// 重新生成;shared/i18n 的测试会逐字节校验 zip 与 JSON 一致,漂移会在 CI 拦下。
//
// 用法:
//	go run ./tools/gen-i18n-catalog-zip            # 在仓库根目录执行
//	go run ../../tools/gen-i18n-catalog-zip -dir . # go:generate 从 shared/i18n 执行
package main

import (
	"bytes"
	"compress/flate"
	"flag"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"time"
	"archive/zip"
)

var languages = []string{"zh-CN", "zh-TW", "en-US", "ja-JP", "de-DE", "ru-RU"}

func main() {
	dir := flag.String("dir", filepath.Join("shared", "i18n"), "语言目录所在路径")
	flag.Parse()

	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	// 固定压缩级别与时间戳,保证内容不变时重复生成的 zip 字节一致,不产生 git 噪声
	zw.RegisterCompressor(zip.Deflate, func(out io.Writer) (io.WriteCloser, error) {
		return flate.NewWriter(out, flate.BestCompression)
	})
	fixedTime := time.Date(1980, 1, 1, 0, 0, 0, 0, time.UTC)

	for _, lang := range languages {
		name := lang + ".json"
		payload, err := os.ReadFile(filepath.Join(*dir, name))
		if err != nil {
			log.Fatalf("读取 %s 失败: %v", name, err)
		}
		// 统一行尾为 LF：Windows 上 core.autocrlf 检出的 CRLF 工作区否则会把
		// CRLF 打进 zip，导致与 CI 的 LF 检出逐字节比较失败。JSON 字符串字面量
		// 不允许裸控制字符，文件中的 CRLF 只能是行分隔符，替换是安全的。
		payload = bytes.ReplaceAll(payload, []byte("\r\n"), []byte("\n"))
		header := &zip.FileHeader{Name: name, Method: zip.Deflate, Modified: fixedTime}
		entry, err := zw.CreateHeader(header)
		if err != nil {
			log.Fatalf("创建 zip 条目 %s 失败: %v", name, err)
		}
		if _, err := entry.Write(payload); err != nil {
			log.Fatalf("写入 zip 条目 %s 失败: %v", name, err)
		}
	}

	if err := zw.Close(); err != nil {
		log.Fatalf("收尾 zip 失败: %v", err)
	}

	outPath := filepath.Join(*dir, "catalog.zip")
	if err := os.WriteFile(outPath, buf.Bytes(), 0o644); err != nil {
		log.Fatalf("写入 %s 失败: %v", outPath, err)
	}
	fmt.Printf("[gen-i18n-catalog-zip] %d 个语言 -> %s: %.2fMB\n",
		len(languages), outPath, float64(buf.Len())/1024/1024)
}
