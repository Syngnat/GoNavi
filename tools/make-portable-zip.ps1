# 生成 Windows Portable.zip。
#
# 打包前先用 UPX(LZMA) 压缩一份 GoNavi.exe 副本：ZIP 只支持 deflate，对 100MB
# 级别的 Go 可执行文件只能压到约 38MB；先 UPX 到约 28MB 再打包，最终 ZIP 约
# 27MB，安装包与更新下载都少 ~11MB。
#
# 只影响 ZIP 内的副本：SFX 便携版与 MSI 仍打包未修改的原始 exe，避免 UPX 的
# 杀软误报影响主安装包。UPX 下载/压缩失败时自动回退为原始 exe，ZIP 照常生成。
#
# 用法(仓库根目录):
#   pwsh tools/make-portable-zip.ps1 -SourceExe build/bin/GoNavi.exe -OutputZip dist/GoNavi.zip -LicenseFile LICENSE -NoticeFile NOTICE
param(
    [Parameter(Mandatory = $true)][string]$SourceExe,
    [Parameter(Mandatory = $true)][string]$OutputZip,
    [string]$LicenseFile,
    [string]$NoticeFile,
    [string]$WorkDir = (Join-Path ([IO.Path]::GetTempPath()) "gonavi-portable-zip"),
    [string]$UpxVersion = "5.0.2",
    [string]$UpxExe
)
$ErrorActionPreference = 'Stop'

# upx-<version>-win64.zip 的 SHA256（GitHub Releases，github.com/upx/upx）。
# 升级版本时同步更新 URL 与哈希。
$UpxZipSha256 = "1cff6d6ee01c404d4a1ae56003056bd4cfa28d0a5cea1d0950daaf872a4facc9"
$UpxDownloadUrl = "https://github.com/upx/upx/releases/download/v$UpxVersion/upx-$UpxVersion-win64.zip"

function Resolve-UpxExe {
    if ($UpxExe) {
        if (-not (Test-Path -LiteralPath $UpxExe)) {
            throw "UPX 可执行文件不存在: $UpxExe"
        }
        return (Resolve-Path -LiteralPath $UpxExe).Path
    }
    $cacheDir = Join-Path $WorkDir "upx-$UpxVersion"
    $cached = Join-Path $cacheDir "upx-$UpxVersion-win64/upx.exe"
    if (Test-Path -LiteralPath $cached) {
        return $cached
    }
    New-Item -ItemType Directory -Path $cacheDir -Force | Out-Null
    $zipPath = Join-Path $cacheDir "upx.zip"
    $errors = New-Object System.Collections.Generic.List[string]
    for ($attempt = 1; $attempt -le 3; $attempt++) {
        try {
            Write-Host "   下载 UPX $UpxVersion（第 $attempt/3 次）: $UpxDownloadUrl"
            Invoke-WebRequest -Uri $UpxDownloadUrl -OutFile $zipPath -TimeoutSec 120
            break
        } catch {
            $errors.Add($_.Exception.Message)
            if ($attempt -eq 3) {
                throw "下载 UPX 失败: $($errors -join ' | ')"
            }
            Start-Sleep -Seconds ([Math]::Pow(2, $attempt))
        }
    }
    $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $zipPath).Hash.ToLower()
    if ($actual -ne $UpxZipSha256) {
        Remove-Item -LiteralPath $zipPath -Force -ErrorAction SilentlyContinue
        throw "UPX 下载包哈希不匹配: $actual"
    }
    Expand-Archive -LiteralPath $zipPath -DestinationPath $cacheDir -Force
    if (-not (Test-Path -LiteralPath $cached)) {
        throw "UPX 解压后未找到 upx.exe: $cached"
    }
    return $cached
}

$work = Join-Path $WorkDir "package"
if (Test-Path -LiteralPath $work) {
    Remove-Item -LiteralPath $work -Recurse -Force
}
New-Item -ItemType Directory -Path $work -Force | Out-Null

$sourcePath = (Resolve-Path -LiteralPath $SourceExe).Path
$appPath = Join-Path $work "GoNavi.exe"
Copy-Item -LiteralPath $sourcePath -Destination $appPath -Force
$rawBytes = (Get-Item -LiteralPath $appPath).Length

$packed = $false
try {
    $upx = Resolve-UpxExe
    Write-Host "🗜️ 使用 UPX $UpxVersion 压缩 ZIP 内的 GoNavi.exe..."
    & $upx --best --lzma --force $appPath | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "upx 压缩失败，退出码 $LASTEXITCODE"
    }
    & $upx -t $appPath | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "upx 自检失败，退出码 $LASTEXITCODE"
    }
    $packed = $true
} catch {
    Write-Host "::warning title=ZIP 未使用 UPX::UPX 压缩不可用，ZIP 将包含原始 exe。原因: $($_.Exception.Message)"
    Copy-Item -LiteralPath $sourcePath -Destination $appPath -Force
}

$files = @($appPath)
foreach ($extra in @($LicenseFile, $NoticeFile)) {
    if ($extra -and (Test-Path -LiteralPath $extra)) {
        $target = Join-Path $work (Split-Path -Leaf $extra)
        Copy-Item -LiteralPath $extra -Destination $target -Force
        $files += $target
    }
}

$outputPath = [IO.Path]::GetFullPath($OutputZip)
New-Item -ItemType Directory -Path (Split-Path -Parent $outputPath) -Force | Out-Null
Compress-Archive -LiteralPath $files -DestinationPath $outputPath -CompressionLevel Optimal -Force

$packedBytes = (Get-Item -LiteralPath $appPath).Length
$zipBytes = (Get-Item -LiteralPath $outputPath).Length
Write-Host ("✅ Portable ZIP 生成完成：exe {0:N1}MB -> {1:N1}MB（upx={2}），zip {3:N1}MB" -f `
    ($rawBytes / 1MB), ($packedBytes / 1MB), $packed, ($zipBytes / 1MB))
