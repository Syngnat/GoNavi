# 将 GoNavi.exe 打包为 7-Zip SFX 静默自解压便携版:
# 双击 -> 后台解压到临时目录(无任何弹窗/进度窗) -> 运行 GoNavi.exe -> 退出后自动清理临时文件。
#
# 误报最小化策略(在产品要求"双击无感启动"的约束下):
#   - SFX 模块固定使用 7-Zip 官方 LZMA SDK 的 7zSD.sfx 安装器模块(public domain,
#     版本与 SHA256 双重锁定,来源 www.7-zip.org);
#   - 已注入 asInvoker 内嵌清单,避免被 Windows"安装器启发式检测"自动提权(弹 UAC);
#   - 不自删除 SFX 本体、不写注册表、不做任何启动项/计划任务操作;
#   - SFX 内嵌的是未修改的原始 exe；Portable.zip 内为减小体积会换用 UPX 压缩副本
#     （见 tools/make-portable-zip.ps1），两者的扫描面因此不同；
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

# 脚本自身所在目录的上一级即仓库根（tools/ 的父目录）。
$repoRoot = Split-Path -Parent $PSScriptRoot

# 7-Zip 25.01 LZMA SDK(installer.txt 所载安装器模块的官方来源)与 7zr.exe 的
# SHA256(www.7-zip.org);升级版本时同步更新
$LzmaSdkSha256 = "cbc3babd589d971e45971d787ff100be8aaa5eab15b2694497ec3e447009e1f2"
# 仓库内 tools/sfx/7zSD.sfx 的哈希（取自上述 SDK）。下载回退路径也校验它，
# 保证两条路径拿到的是同一个模块。
$SfxModuleSha256 = "18b4c189f195d55fe1e6c08d6a186d31c89d6c3c55afe122a55230078f7ea294"
$SevenZrSha256 = "ad4c82fadcbdf93c03b4fc440f300509c7d60c5c2f4d183e35d9d70d6957037d"
$SevenZipDownloadBase = "https://www.7-zip.org/a"
# 官方站点偶发 DNS 解析失败（GitHub runner 侧）：www 与裸域是两条独立解析
# 记录，一条挂了另一条通常还能用。两者路径规则相同，可直接替换主机名。
$SevenZipDownloadMirrors = @(
    "https://www.7-zip.org/a",
    "https://7-zip.org/a"
)

<#
.SYNOPSIS
带重试与镜像回退的文件下载。

.DESCRIPTION
官方站点在 GitHub runner 上偶发 "No such host is known"（DNS 解析失败）。
单次 Invoke-WebRequest 失败就让整个 Windows 打包挂掉代价太大，因此：
- 每个地址最多重试 $Attempts 次，指数退避；
- 官方地址全部失败后依次尝试镜像；
- 仍失败则抛出，由调用方决定是降级还是中止。

下载完成后由调用方做 SHA256 校验，不在这里做——镜像的路径规则不同，
校验只在拿到文件后进行。
#>
function Invoke-DownloadWithRetry {
    param(
        [Parameter(Mandatory = $true)][string]$RelativePath,
        [Parameter(Mandatory = $true)][string]$OutFile,
        [int]$Attempts = 3,
        [int]$TimeoutSec = 120
    )
    $errors = New-Object System.Collections.Generic.List[string]
    foreach ($base in $SevenZipDownloadMirrors) {
        $uri = "$base/$RelativePath"
        for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
            try {
                Write-Host "   下载 $uri（第 $attempt/$Attempts 次）..."
                Invoke-WebRequest -Uri $uri -OutFile $OutFile -TimeoutSec $TimeoutSec
                if (Test-Path -LiteralPath $OutFile) { return }
                throw "下载完成但文件不存在: $OutFile"
            } catch {
                $errors.Add("$uri -> $($_.Exception.Message)")
                if ($attempt -lt $Attempts) {
                    Start-Sleep -Seconds ([Math]::Pow(2, $attempt))
                }
            }
        }
    }
    $detail = ($errors | Select-Object -Last 4) -join "`n  "
    throw "下载 $RelativePath 失败（已尝试 $($SevenZipDownloadMirrors.Count) 个源）:`n  $detail"
}

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
        Invoke-DownloadWithRetry -RelativePath "7zr.exe" -OutFile $sevenZipExe
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

function New-PortableArchive {
    param(
        [string]$SevenZip,
        [string]$WorkDir,
        [string]$SourceExe,
        [string]$LicenseFile,
        [string]$NoticeFile
    )

    $stageDir = Join-Path $WorkDir "stage"
    if (Test-Path -LiteralPath $stageDir) { Remove-Item -LiteralPath $stageDir -Recurse -Force }
    New-Item -ItemType Directory -Path $stageDir | Out-Null

    $stagedNames = @('GoNavi.exe')
    Copy-Item -LiteralPath $SourceExe -Destination (Join-Path $stageDir "GoNavi.exe") -Force
    foreach ($entry in @(
            @{ Source = $LicenseFile; Name = 'LICENSE' },
            @{ Source = $NoticeFile; Name = 'NOTICE' }
        )) {
        if ($entry.Source -and (Test-Path -LiteralPath $entry.Source)) {
            Copy-Item -LiteralPath $entry.Source -Destination (Join-Path $stageDir $entry.Name) -Force
            $stagedNames += $entry.Name
        }
    }

    $archivePath = Join-Path $WorkDir "gonavi-portable.7z"
    Remove-Item -LiteralPath $archivePath -Force -ErrorAction SilentlyContinue
    # 只用叶子名，且在 stage 目录里调用。把绝对路径交给旧版 7-Zip 时，
    # 归档会带上盘符之后的目录，RunProgram 同样找不到 GoNavi.exe。
    $archiveArgs = @('a', '-t7z', '-mx=9', '-y', '--', $archivePath) + $stagedNames
    Push-Location -LiteralPath $stageDir
    try {
        & $SevenZip @archiveArgs | Out-Null
    }
    finally { Pop-Location }
    if ($LASTEXITCODE -ne 0) { throw "创建 7z 归档失败(退出码 $LASTEXITCODE)" }

    Assert-PortableArchiveLayout -SevenZip $SevenZip -WorkDir $WorkDir -ArchivePath $archivePath -ExpectedNames $stagedNames
    Write-Host "   归档根目录: $($stagedNames -join ', ')"
    return $archivePath
}

function Assert-PortableArchiveLayout {
    param(
        [string]$SevenZip,
        [string]$WorkDir,
        [string]$ArchivePath,
        [string[]]$ExpectedNames
    )

    $verifyDir = Join-Path $WorkDir "verify"
    if (Test-Path -LiteralPath $verifyDir) { Remove-Item -LiteralPath $verifyDir -Recurse -Force }
    New-Item -ItemType Directory -Path $verifyDir | Out-Null
    & $SevenZip x -y -o"$verifyDir" -- $ArchivePath | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "解压校验 7z 归档失败(退出码 $LASTEXITCODE)" }

    $verifyRoot = [IO.Path]::GetFullPath($verifyDir)
    $found = @(Get-ChildItem -LiteralPath $verifyRoot -Recurse -File | ForEach-Object {
            $_.FullName.Substring($verifyRoot.Length).TrimStart('\', '/')
        })
    foreach ($name in $ExpectedNames) {
        $extracted = Join-Path $verifyRoot $name
        if (-not (Test-Path -LiteralPath $extracted -PathType Leaf)) {
            throw "SFX 归档根目录缺少 ${name}。实际文件: $($found -join ', ')"
        }
    }
    $exes = @($found | Where-Object { $_.EndsWith('.exe') })
    if ($exes.Count -ne 1 -or $exes[0] -ne 'GoNavi.exe') {
        throw "SFX 归档里的可执行文件必须是根目录 GoNavi.exe。实际: $($exes -join ', ')"
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
#
# 优先用仓库内随代码提交的 tools/sfx/7zSD.sfx。这个文件取自 LZMA SDK 25.01
# 的 bin/7zSD.sfx，public domain、版本固定，本来就不会变；每次构建现去
# www.7-zip.org 下载只会把一个确定性产物变成网络依赖（该站点在 GitHub
# runner 与国内网络都出现过 DNS/TLS 失败）。
# 只有仓库内文件缺失或哈希不符时才回退到下载。
$sfxModule = $SfxModulePath
if (-not $sfxModule) {
    $vendoredModule = Join-Path $repoRoot "tools\sfx\7zSD.sfx"
    if (Test-Path -LiteralPath $vendoredModule) {
        Verify-FileHash -Path $vendoredModule -Expected $SfxModuleSha256
        Write-Host "   使用仓库内 SFX 模块: tools/sfx/7zSD.sfx"
        $sfxModule = $vendoredModule
    }
}
if (-not $sfxModule) {
    $sdkArchive = Join-Path $WorkDir "lzma-$SevenZipVersion.7z"
    if (-not (Test-Path $sdkArchive)) {
        Write-Host "   下载 7-Zip 官方 LZMA SDK $SevenZipVersion ..."
        Invoke-DownloadWithRetry -RelativePath "lzma$($SevenZipVersion.Substring(2)).7z" -OutFile $sdkArchive
    }
    Verify-FileHash -Path $sdkArchive -Expected $LzmaSdkSha256
    $sdkFiles = Join-Path $WorkDir "lzma-$SevenZipVersion"
    if (-not (Test-Path (Join-Path $sdkFiles "bin\7zSD.sfx"))) {
        New-Item -ItemType Directory -Path $sdkFiles -Force | Out-Null
        & $sevenZip x -y -o"$sdkFiles" $sdkArchive | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "解压 LZMA SDK 失败(退出码 $LASTEXITCODE)" }
    }
    $sfxModule = Join-Path $sdkFiles "bin\7zSD.sfx"
    Verify-FileHash -Path $sfxModule -Expected $SfxModuleSha256
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

# --- 3. 压缩 7z 包(根目录必须是 GoNavi.exe + LICENSE + NOTICE) ---
# CI 产物文件名是 gonavi-build-windows-*.exe。7-Zip 会把这个叶子名写进归档。
# SFX 配置 RunProgram="GoNavi.exe" 只在解压根目录找这个名字，对不上就弹出
# 「系统找不到指定的文件」，程序还没启动。先铺成和 Portable.zip 一样的根目录。
$archivePath = New-PortableArchive -SevenZip $sevenZip -WorkDir $WorkDir -SourceExe $SourceExe -LicenseFile $LicenseFile -NoticeFile $NoticeFile

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
