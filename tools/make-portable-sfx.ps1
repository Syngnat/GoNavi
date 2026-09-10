# 将 GoNavi.exe 打包为 7-Zip SFX 静默自解压便携版:
# 双击 -> 后台解压到临时目录(无任何弹窗/进度窗) -> 运行 GoNavi.exe -> 退出后自动清理临时文件。
#
# 误报最小化策略(在产品要求"双击无感启动"的约束下):
#   - SFX 模块固定使用 7-Zip 官方 LZMA SDK 的 7zSD.sfx 安装器模块(public domain,
#     版本与 SHA256 双重锁定,来源 www.7-zip.org);
#   - 已注入 asInvoker 内嵌清单,避免被 Windows"安装器启发式检测"自动提权(弹 UAC);
#   - 不自删除 SFX 本体、不写注册表、不做任何启动项/计划任务操作;
#   - 解压出来的 GoNavi.exe 与现在的 Portable.zip 内容完全一致,扫描面不变;
#   - 解压失败时仍会弹出错误框,静默只发生在成功路径上。
#
# 用法(仓库根目录):
#   pwsh tools/make-portable-sfx.ps1 -SourceExe build/bin/GoNavi.exe -OutputExe dist/GoNavi-Portable.exe
#   # 可选:-SfxModulePath / -SevenZipExe 直接指定本地 7-Zip 资源,跳过下载
param(
    [Parameter(Mandatory = $true)][string]$SourceExe,
    [Parameter(Mandatory = $true)][string]$OutputExe,
    [string]$LicenseFile,
    [string]$NoticeFile,
    [string]$SfxModulePath,
    [string]$SevenZipExe,
    [string]$WorkDir = (Join-Path ([IO.Path]::GetTempPath()) "gonavi-sfx-build"),
    [string]$SevenZipVersion = "7z2501"
)
$ErrorActionPreference = 'Stop'

# 7-Zip 25.01 LZMA SDK(installer.txt 所载安装器模块的官方来源)与 7zr.exe 的
# SHA256(www.7-zip.org);升级版本时同步更新
$LzmaSdkSha256 = "cbc3babd589d971e45971d787ff100be8aaa5eab15b2694497ec3e447009e1f2"
$SevenZrSha256 = "ad4c82fadcbdf93c03b4fc440f300509c7d60c5c2f4d183e35d9d70d6957037d"
$SevenZipDownloadBase = "https://www.7-zip.org/a"

function Resolve-SevenZip {
    param([string]$Requested, [string]$WorkDir, [string]$Version)
    if ($Requested) {
        if (-not (Test-Path $Requested)) { throw "指定的 7z 可执行不存在: $Requested" }
        return $Requested
    }
    $installed = "C:\Program Files\7-Zip\7z.exe"
    if (Test-Path $installed) { return $installed }
    Write-Host "   未找到已安装的 7-Zip,下载官方 $Version 便携工具链..."
    $sevenZipExe = Join-Path $WorkDir "7zr.exe"
    if (-not (Test-Path $sevenZipExe)) {
        Invoke-WebRequest -Uri "$SevenZipDownloadBase/7zr.exe" -OutFile $sevenZipExe -TimeoutSec 120
    }
    Verify-FileHash -Path $sevenZipExe -Expected $SevenZrSha256
    return $sevenZipExe
}

function Verify-FileHash {
    param([string]$Path, [string]$Expected)
    $actual = (Get-FileHash -Path $Path -Algorithm SHA256).Hash.ToLower()
    if ($actual -ne $Expected) {
        throw "SHA256 校验失败: $Path`n  期望 $Expected`n  实际 $actual"
    }
}

function Add-SfxManifest {
    param([string]$TargetExe)
    $manifest = @'
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <assemblyIdentity version="1.0.0.0" processorArchitecture="*" name="GoNavi.Portable" type="win32"/>
  <description>GoNavi portable edition</description>
  <trustInfo xmlns="urn:schemas-microsoft-com:asm.v3">
    <security>
      <requestedPrivileges>
        <requestedExecutionLevel level="asInvoker" uiAccess="false"/>
      </requestedPrivileges>
    </security>
  </trustInfo>
  <compatibility xmlns="urn:schemas-microsoft-com:compatibility.v1">
    <application>
      <supportedOS Id="{8e0f7a12-bfb3-4fe8-b9a5-48fd50a15a9a}"/>
    </application>
  </compatibility>
</assembly>
'@
    if (-not ('GoNaviSfx.ResourceUpdater' -as [type])) {
        Add-Type -TypeDefinition @'
namespace GoNaviSfx
{
    using System;
    using System.Runtime.InteropServices;

    public static class ResourceUpdater
    {
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern IntPtr BeginUpdateResource(string fileName, bool deleteExistingResources);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool UpdateResource(IntPtr handle, IntPtr type, IntPtr name, ushort language, byte[] data, uint dataSize);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool EndUpdateResource(IntPtr handle, bool discard);

        // RT_MANIFEST = 24, resource id 1, LANG_NEUTRAL -> 0x0409 (US English)
        public static void WriteManifest(string exePath, byte[] manifestBytes)
        {
            IntPtr handle = BeginUpdateResource(exePath, false);
            if (handle == IntPtr.Zero) throw new InvalidOperationException("BeginUpdateResource failed: " + Marshal.GetLastWin32Error());
            if (!UpdateResource(handle, (IntPtr)24, (IntPtr)1, 0x0409, manifestBytes, (uint)manifestBytes.Length))
            {
                int err = Marshal.GetLastWin32Error();
                EndUpdateResource(handle, true);
                throw new InvalidOperationException("UpdateResource failed: " + err);
            }
            if (!EndUpdateResource(handle, false))
            {
                throw new InvalidOperationException("EndUpdateResource failed: " + Marshal.GetLastWin32Error());
            }
        }
    }
}
'@
    }
    $bytes = [Text.Encoding]::UTF8.GetBytes($manifest)
    [GoNaviSfx.ResourceUpdater]::WriteManifest($TargetExe, $bytes)
    Write-Host "   已注入 asInvoker 清单(避免安装器启发式提权)"
}

New-Item -ItemType Directory -Path $WorkDir -Force | Out-Null
$SourceExe = (Resolve-Path $SourceExe).Path
if (-not (Test-Path $SourceExe)) { throw "找不到源 exe: $SourceExe" }

# --- 1. 准备 7z 可执行(用于压缩与解出 SFX 模块) ---
$sevenZip = Resolve-SevenZip -Requested $SevenZipExe -WorkDir $WorkDir -Version $SevenZipVersion

# --- 2. 准备官方 7zSD.sfx 安装器模块(LZMA SDK 固定版本 + 哈希校验;public domain) ---
$sfxModule = $SfxModulePath
if (-not $sfxModule) {
    $sdkArchive = Join-Path $WorkDir "lzma-$SevenZipVersion.7z"
    if (-not (Test-Path $sdkArchive)) {
        Write-Host "   下载 7-Zip 官方 LZMA SDK $SevenZipVersion ..."
        Invoke-WebRequest -Uri "$SevenZipDownloadBase/lzma$($SevenZipVersion.Substring(2)).7z" -OutFile $sdkArchive -TimeoutSec 120
    }
    Verify-FileHash -Path $sdkArchive -Expected $LzmaSdkSha256
    $sdkFiles = Join-Path $WorkDir "lzma-$SevenZipVersion"
    if (-not (Test-Path (Join-Path $sdkFiles "bin\7zSD.sfx"))) {
        New-Item -ItemType Directory -Path $sdkFiles -Force | Out-Null
        & $sevenZip x -y -o"$sdkFiles" $sdkArchive | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "解压 LZMA SDK 失败(退出码 $LASTEXITCODE)" }
    }
    $sfxModule = Join-Path $sdkFiles "bin\7zSD.sfx"
}
if (-not (Test-Path $sfxModule)) { throw "找不到 SFX 模块: $sfxModule" }

# --- 2.5 给模块副本注入 asInvoker 清单 ---
# 7zSD.sfx 没有内嵌清单,会被 Windows"安装器启发式检测"自动提权(便携版弹 UAC,
# 杀软对提权自解压也更敏感)。LZMA SDK 官方明确允许修改 SFX 模块资源;这里在
# 拼接【之前】给模块副本注入 RT_MANIFEST(asInvoker)。必须先注入再拼接:
# EndUpdateResource 重建 PE 时会丢弃 overlay(追加的配置+归档),反过来做会得到
# 只有 0.1MB 的空壳。
$sfxModulePrepared = Join-Path $WorkDir "7zSD-asInvoker.sfx"
Copy-Item $sfxModule $sfxModulePrepared -Force
Add-SfxManifest -TargetExe $sfxModulePrepared
$sfxModule = $sfxModulePrepared

# --- 3. 压缩 7z 包(GoNavi.exe + LICENSE + NOTICE,与 Portable.zip 内容一致) ---
$archivePath = Join-Path $WorkDir "gonavi-portable.7z"
Remove-Item $archivePath -Force -ErrorAction SilentlyContinue
$archiveArgs = @('a', '-t7z', '-mx=9', '-y', '--', $archivePath, $SourceExe)
foreach ($extra in @($LicenseFile, $NoticeFile)) {
    if ($extra -and (Test-Path $extra)) { $archiveArgs += (Resolve-Path $extra).Path }
}
& $sevenZip @archiveArgs | Out-Null
if ($LASTEXITCODE -ne 0) { throw "创建 7z 归档失败(退出码 $LASTEXITCODE)" }

# --- 4. 写安装器配置(UTF-8 无 BOM;文档:LZMA SDK DOC/installer.txt) ---
# 静默无感:不配 BeginPrompt(不弹确认框),Progress="no"(不弹解压进度窗)。
$configLines = @(
    ';!@Install@!UTF-8!',
    'Progress="no"',
    'RunProgram="GoNavi.exe"',
    ';!@InstallEnd@!'
)
$configPath = Join-Path $WorkDir "installer-config.txt"
[IO.File]::WriteAllText($configPath, ($configLines -join "`r`n") + "`r`n", (New-Object System.Text.UTF8Encoding($false)))

# --- 5. 二进制拼接:SFX 模块 + 配置 + 归档 ---
$OutputExe = Join-Path (Split-Path $OutputExe -Parent) (Split-Path $OutputExe -Leaf)
$parent = Split-Path $OutputExe -Parent
if ($parent) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
$output = [IO.File]::Create($OutputExe)
try {
    foreach ($part in @($sfxModule, $configPath, $archivePath)) {
        $bytes = [IO.File]::ReadAllBytes($part)
        $output.Write($bytes, 0, $bytes.Length)
    }
}
finally { $output.Close() }

# --- 6. 自检:确认清单与安装器配置都已就位 ---
$fileText = [Text.Encoding]::ASCII.GetString([IO.File]::ReadAllBytes($OutputExe))
if (-not $fileText.Contains('requestedExecutionLevel')) { throw "清单注入失败: 输出中找不到 requestedExecutionLevel" }
if (-not $fileText.Contains('!@Install@!UTF-8!')) { throw "安装器配置缺失: 输出中找不到 Install 配置标记" }

$sizeMB = [math]::Round((Get-Item $OutputExe).Length / 1MB, 1)
$srcMB = [math]::Round((Get-Item $SourceExe).Length / 1MB, 1)
Write-Host "   SFX 生成完成: $OutputExe ($srcMB MB -> $sizeMB MB)"
