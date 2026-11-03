# 7zSD.sfx（随仓库提交的 SFX 模块）

## 这是什么

`7zSD.sfx` 是 7-Zip 的 **自解压安装器模块**：把 7z 归档追加到它后面，就得到一个
双击即可静默自解压并运行的 `.exe`。GoNavi 的 Windows「便携版 EXE」就是这样
打出来的（见 `tools/make-portable-sfx.ps1`）。

## 来源

| 项 | 值 |
|---|---|
| 出自 | 7-Zip **LZMA SDK 25.01** 的 `bin/7zSD.sfx` |
| 官方地址 | <https://www.7-zip.org/a/lzma2501.7z> |
| 归档 SHA256 | `cbc3babd589d971e45971d787ff100be8aaa5eab15b2694497ec3e447009e1f2` |
| 本文件 SHA256 | `18b4c189f195d55fe1e6c08d6a186d31c89d6c3c55afe122a55230078f7ea294` |
| 大小 | 128000 字节 |

## 为什么放进仓库

这个文件**版本固定、内容永不变化**，以前每次 CI 都去 `www.7-zip.org` 重新下载
1.5MB 的整个 SDK，只为取出其中这一个 125KB 的模块。结果是：

- GitHub Windows runner 上出现过 DNS 解析失败（`No such host is known`）；
- 国内网络访问该站点也出现过 TLS 失败（`SSL_ERROR_SYSCALL`）。

把确定性产物变成网络依赖没有任何收益。现在构建直接读仓库内文件，**零网络依赖**。
`make-portable-sfx.ps1` 仍保留下载回退路径，仅在文件缺失或哈希不符时启用。

## 许可

LZMA SDK 由 Igor Pavlov 置于 **public domain**。`DOC/installer.txt` 明确写明：

> LZMA SDK is written and placed in the public domain by Igor Pavlov.
> It's allowed to join 7-Zip SFX module with another software.
> It's allowed to change resources of 7-Zip's SFX modules.

因此把模块与 GoNavi 的归档拼接、以及修改其资源（脚本会给它注入
`asInvoker` 清单以避免无谓的 UAC 提权）都是许可允许的。

## 升级版本时

1. 从新版本 SDK 取出 `bin/7zSD.sfx`，替换本文件；
2. 更新本页的「出自 / 归档 SHA256 / 本文件 SHA256 / 大小」；
3. 同步更新 `make-portable-sfx.ps1` 里的 `$LzmaSdkSha256` 与 `$SfxModuleSha256`；
4. 跑 `python3 tools/windows-release-artifacts.test.py` 确认校验通过。
