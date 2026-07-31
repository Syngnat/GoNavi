$ErrorActionPreference = 'Stop'

$Source = $env:GONAVI_UPDATE_SOURCE
$Target = $env:GONAVI_UPDATE_TARGET
$CurrentTarget = $env:GONAVI_UPDATE_CURRENT_TARGET
$UpdatesDir = $env:GONAVI_UPDATE_ROOT_DIR
$StagedDir = $env:GONAVI_UPDATE_STAGED_DIR
$LogPath = $env:GONAVI_UPDATE_LOG_PATH
$MaintenanceEventName = $env:GONAVI_UPDATE_MAINTENANCE_EVENT_NAME
$HandoffEventName = $env:GONAVI_UPDATE_HANDOFF_EVENT_NAME
$HostProcessId = 0
$TargetOld = $null
$ReplacementPrepared = $false
$PreviousTargetBackedUp = $false
$TargetWriteStarted = $false
$LaunchSucceeded = $false
$HostExited = $false
$SourceMatchesTarget = $false
$RollbackSucceeded = $true
$MaintenanceEvent = $null
$HandoffEvent = $null
$MaintenanceLockReleased = $false

function Write-UpdateLog {
    param([string]$Message)

    if ([string]::IsNullOrWhiteSpace($LogPath)) {
        return
    }
    try {
        $timestamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss.fff'
        Add-Content -LiteralPath $LogPath -Value "[$timestamp] $Message" -Encoding UTF8
    } catch {
        # Logging must never hide the original updater error.
    }
}

function Release-UpdateMaintenanceLock {
    if ($MaintenanceLockReleased) {
        return $true
    }
    try {
        if ($null -eq $MaintenanceEvent) {
            $script:MaintenanceLockReleased = $true
            return $true
        }
        $script:MaintenanceEvent.Dispose()
        $script:MaintenanceEvent = $null
        $script:MaintenanceLockReleased = $true
        return $true
    } catch {
        Write-UpdateLog ("maintenance lock release failed: " + $_.Exception.Message)
        return $false
    }
}

function Test-SamePath {
    param(
        [string]$Left,
        [string]$Right
    )

    if ([string]::IsNullOrWhiteSpace($Left) -or [string]::IsNullOrWhiteSpace($Right)) {
        return $false
    }
    return [StringComparer]::OrdinalIgnoreCase.Equals(
        [IO.Path]::GetFullPath($Left),
        [IO.Path]::GetFullPath($Right)
    )
}

function Restore-PreviousTarget {
    try {
        if ($PreviousTargetBackedUp -and -not (Test-Path -LiteralPath $TargetOld -PathType Leaf)) {
            Write-UpdateLog 'rollback failed: previous executable backup is missing'
            return $false
        }
        if (($TargetWriteStarted -or $ReplacementPrepared) -and (Test-Path -LiteralPath $Target -PathType Leaf)) {
            Remove-Item -LiteralPath $Target -Force
        }
        if ($PreviousTargetBackedUp -and (Test-Path -LiteralPath $TargetOld -PathType Leaf)) {
            Move-Item -LiteralPath $TargetOld -Destination $Target -Force
        }
        return $true
    } catch {
        Write-UpdateLog ("rollback failed: " + $_.Exception.Message)
        return $false
    }
}

function Remove-UpdateArtifact {
    param([string]$Path)

    if ([string]::IsNullOrWhiteSpace($Path)) {
        return
    }
    try {
        if (Test-Path -LiteralPath $Path) {
            Remove-Item -LiteralPath $Path -Force -Recurse
        }
    } catch {
        Write-UpdateLog ("cleanup failed for " + $Path + ": " + $_.Exception.Message)
    }
}

function Select-PortableExecutable {
    param(
        [string]$ExtractDir,
        [string]$TargetPath,
        [string]$PackagePath
    )

    $ExecutableCandidates = @(Get-ChildItem -LiteralPath $ExtractDir -Recurse -File |
        Where-Object { $_.Extension -ieq '.exe' })
    if ($ExecutableCandidates.Count -eq 0) {
        throw 'no executable found in portable zip; package retained for manual install'
    }

    $TargetFileName = [IO.Path]::GetFileName($TargetPath)
    $ExactTargetMatches = @($ExecutableCandidates | Where-Object {
        [string]::Equals($_.Name, $TargetFileName, [StringComparison]::OrdinalIgnoreCase)
    })
    if ($ExactTargetMatches.Count -eq 1) {
        return $ExactTargetMatches[0].FullName
    }
    if ($ExactTargetMatches.Count -gt 1) {
        throw 'ambiguous portable zip: multiple executables match current target filename; package retained for manual install'
    }

    $PackageExecutableName = [IO.Path]::GetFileNameWithoutExtension($PackagePath) + '.exe'
    $PackageNameMatches = @($ExecutableCandidates | Where-Object {
        [string]::Equals($_.Name, $PackageExecutableName, [StringComparison]::OrdinalIgnoreCase)
    })
    if ($PackageNameMatches.Count -eq 1) {
        return $PackageNameMatches[0].FullName
    }
    if ($PackageNameMatches.Count -gt 1) {
        throw 'ambiguous portable zip: multiple executables match package filename; package retained for manual install'
    }

    $GoNaviMatches = @($ExecutableCandidates | Where-Object {
        $_.Name.StartsWith('GoNavi', [StringComparison]::OrdinalIgnoreCase)
    })
    if ($GoNaviMatches.Count -eq 1) {
        return $GoNaviMatches[0].FullName
    }

    if ($ExecutableCandidates.Count -eq 1) {
        return $ExecutableCandidates[0].FullName
    }

    throw ("ambiguous portable zip: found " + $ExecutableCandidates.Count + " executable candidates; package retained for manual install")
}

try {
    foreach ($requiredPath in @($Source, $Target, $CurrentTarget, $UpdatesDir, $StagedDir, $LogPath, $MaintenanceEventName, $HandoffEventName)) {
        if ([string]::IsNullOrWhiteSpace($requiredPath)) {
            throw 'missing required updater path'
        }
    }
    if (-not [int]::TryParse($env:GONAVI_UPDATE_PID, [ref]$HostProcessId) -or $HostProcessId -le 0) {
        throw 'invalid host process id'
    }

    $TargetOld = $Target + '.old'
    $TargetDir = [IO.Path]::GetDirectoryName($Target)
    if ([string]::IsNullOrWhiteSpace($TargetDir) -or -not (Test-Path -LiteralPath $TargetDir -PathType Container)) {
        throw 'target directory does not exist'
    }
    if (-not (Test-Path -LiteralPath $Source -PathType Leaf)) {
        throw 'source file not found'
    }

    $MaintenanceEvent = [Threading.EventWaitHandle]::OpenExisting($MaintenanceEventName)
    $HandoffEvent = [Threading.EventWaitHandle]::OpenExisting($HandoffEventName)
    [void]$HandoffEvent.Set()
    $HandoffEvent.Dispose()
    $HandoffEvent = $null
    Write-UpdateLog 'updater started'
    $waitedSeconds = 0
    while (Get-Process -Id $HostProcessId -ErrorAction SilentlyContinue) {
        if ($waitedSeconds -ge 90) {
            throw 'host process still running after 90 seconds'
        }
        Start-Sleep -Seconds 1
        $waitedSeconds++
    }
    $HostExited = $true
    Write-UpdateLog 'host process exited'

    Start-Sleep -Seconds 3
    Write-UpdateLog 'cooldown finished, starting file replace'

    $SourceExe = $Source
    if ([string]::Equals([IO.Path]::GetExtension($Source), '.zip', [StringComparison]::OrdinalIgnoreCase)) {
        $ExtractDir = [IO.Path]::Combine($StagedDir, '_extract')
        if (Test-Path -LiteralPath $ExtractDir) {
            Remove-Item -LiteralPath $ExtractDir -Recurse -Force
        }
        [IO.Directory]::CreateDirectory($ExtractDir) | Out-Null
        Expand-Archive -LiteralPath $Source -DestinationPath $ExtractDir -Force

        $SourceExe = Select-PortableExecutable -ExtractDir $ExtractDir -TargetPath $Target -PackagePath $Source
        Write-UpdateLog ("selected portable executable: " + $SourceExe)
    }

    $SourceMatchesTarget = Test-SamePath $SourceExe $Target
    if ($SourceMatchesTarget) {
        Write-UpdateLog 'downloaded executable already at target path, skipping replace'
        $ReplacementPrepared = $true
    } else {
        for ($attempt = 0; $attempt -lt 15; $attempt++) {
            $PreviousTargetBackedUp = $false
            $TargetWriteStarted = $false
            try {
                if (Test-Path -LiteralPath $TargetOld) {
                    Remove-Item -LiteralPath $TargetOld -Force
                }
                if (Test-Path -LiteralPath $Target -PathType Leaf) {
                    Move-Item -LiteralPath $Target -Destination $TargetOld -Force
                    $PreviousTargetBackedUp = $true
                }
                $TargetWriteStarted = $true
                Copy-Item -LiteralPath $SourceExe -Destination $Target -Force
                $ReplacementPrepared = $true
                break
            } catch {
                Write-UpdateLog ("replace attempt " + ($attempt + 1) + " failed: " + $_.Exception.Message)
                if ($PreviousTargetBackedUp -or $TargetWriteStarted) {
                    $RollbackSucceeded = Restore-PreviousTarget
                    if (-not $RollbackSucceeded) {
                        throw 'replace failed and previous executable could not be restored'
                    }
                }
                if ($attempt -ge 14) {
                    break
                }
                $waitSeconds = 1
                if ($attempt -ge 8) {
                    $waitSeconds = 5
                } elseif ($attempt -ge 5) {
                    $waitSeconds = 3
                } elseif ($attempt -ge 2) {
                    $waitSeconds = 2
                }
                Start-Sleep -Seconds $waitSeconds
            }
        }
    }

    if (-not $ReplacementPrepared) {
        throw 'replace failed after retries; package kept for manual install'
    }

    if (-not (Release-UpdateMaintenanceLock)) {
        throw 'update maintenance lock could not be released before relaunch'
    }
    Write-UpdateLog ("launching target: " + $Target)
    $NewProcess = Start-Process -FilePath $Target -WorkingDirectory $TargetDir -PassThru -ErrorAction Stop
    Start-Sleep -Milliseconds 1500
    $NewProcess.Refresh()
    if ($NewProcess.HasExited) {
        throw 'updated application exited immediately after launch'
    }
    $LaunchSucceeded = $true

    Remove-UpdateArtifact $TargetOld
    if (-not (Test-SamePath $CurrentTarget $Target)) {
        Remove-UpdateArtifact $CurrentTarget
    }
    if (-not (Test-SamePath $Source $Target)) {
        Remove-UpdateArtifact $Source
    }
    Write-UpdateLog 'update finished'

    $CleanupCommand = 'Start-Sleep -Seconds 2; Remove-Item -LiteralPath $env:GONAVI_UPDATE_ROOT_DIR -Recurse -Force -ErrorAction SilentlyContinue'
    $EncodedCleanupCommand = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($CleanupCommand))
    $CleanupWorkingDirectory = [IO.Path]::GetTempPath()
    try {
        Start-Process -FilePath 'powershell.exe' -WorkingDirectory $CleanupWorkingDirectory -WindowStyle Hidden -ArgumentList @(
            '-NoProfile',
            '-NonInteractive',
            '-ExecutionPolicy',
            'Bypass',
            '-EncodedCommand',
            $EncodedCleanupCommand
        ) -ErrorAction Stop | Out-Null
    } catch {
        Write-UpdateLog ("cleanup scheduler failed: " + $_.Exception.Message)
    }
    exit 0
} catch {
    Write-UpdateLog ("updater failed: " + $_.Exception.Message)
    if ($ReplacementPrepared -and -not $LaunchSucceeded -and -not $SourceMatchesTarget) {
        $RollbackSucceeded = Restore-PreviousTarget
    }
    [void](Release-UpdateMaintenanceLock)
    if ($HostExited -and -not $LaunchSucceeded -and -not $SourceMatchesTarget -and $RollbackSucceeded -and $MaintenanceLockReleased) {
        try {
            if (Test-Path -LiteralPath $CurrentTarget -PathType Leaf) {
                $CurrentTargetDir = [IO.Path]::GetDirectoryName($CurrentTarget)
                Start-Process -FilePath $CurrentTarget -WorkingDirectory $CurrentTargetDir -ErrorAction Stop | Out-Null
                Write-UpdateLog 'previous application relaunched after update failure'
            }
        } catch {
            Write-UpdateLog ("previous application relaunch failed: " + $_.Exception.Message)
        }
    }
    exit 1
}
