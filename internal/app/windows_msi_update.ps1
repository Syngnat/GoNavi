$ErrorActionPreference = 'Stop'

$Source = $env:GONAVI_UPDATE_SOURCE
$Target = $env:GONAVI_UPDATE_TARGET
$UpdatesDir = $env:GONAVI_UPDATE_ROOT_DIR
$StagedDir = $env:GONAVI_UPDATE_STAGED_DIR
$LogPath = $env:GONAVI_UPDATE_LOG_PATH
$MSILogPath = $env:GONAVI_UPDATE_MSI_LOG_PATH
$MSIExecPath = $env:GONAVI_UPDATE_MSIEXEC_PATH
$MaintenanceEventName = $env:GONAVI_UPDATE_MAINTENANCE_EVENT_NAME
$HandoffEventName = $env:GONAVI_UPDATE_HANDOFF_EVENT_NAME
$HostProcessId = 0
$HostExited = $false
$InstallSucceeded = $false
$LaunchSucceeded = $false
$DesktopShortcutDirectories = @()
$DesktopShortcutState = $null
$DesktopShortcutInstallValue = '1'
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
function Quote-NativeArgument {
    param([string]$Value)

    return '"' + $Value.Replace('"', '\"') + '"'
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

try {
    foreach ($requiredPath in @($Source, $Target, $UpdatesDir, $StagedDir, $LogPath, $MSILogPath, $MSIExecPath, $MaintenanceEventName, $HandoffEventName)) {
        if ([string]::IsNullOrWhiteSpace($requiredPath)) {
            throw 'missing required MSI updater path'
        }
    }
    if (-not [int]::TryParse($env:GONAVI_UPDATE_PID, [ref]$HostProcessId) -or $HostProcessId -le 0) {
        throw 'invalid host process id'
    }
    if (-not (Test-Path -LiteralPath $Source -PathType Leaf)) {
        throw 'MSI package not found'
    }
    if (-not [string]::Equals([IO.Path]::GetExtension($Source), '.msi', [StringComparison]::OrdinalIgnoreCase)) {
        throw 'update package is not an MSI file'
    }
    if (-not (Test-Path -LiteralPath $MSIExecPath -PathType Leaf)) {
        throw 'msiexec.exe not found'
    }

    $TargetDir = [IO.Path]::GetDirectoryName($Target)
    if ([string]::IsNullOrWhiteSpace($TargetDir) -or -not (Test-Path -LiteralPath $TargetDir -PathType Container)) {
        throw 'target directory does not exist'
    }

    $MaintenanceEvent = [Threading.EventWaitHandle]::OpenExisting($MaintenanceEventName)
    $HandoffEvent = [Threading.EventWaitHandle]::OpenExisting($HandoffEventName)
    [void]$HandoffEvent.Set()
    $HandoffEvent.Dispose()
    $HandoffEvent = $null
    Write-UpdateLog 'MSI updater started'
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
    Start-Sleep -Seconds 2

    $DesktopShortcutDirectories = @(Get-GoNaviDesktopDirectories)
    $DesktopShortcutState = Save-GoNaviDesktopShortcutState -TargetPath $Target -BackupDirectory $StagedDir -DesktopDirectories $DesktopShortcutDirectories
    if (-not $DesktopShortcutState.Succeeded) {
        throw 'desktop shortcut state could not be backed up'
    }
    $DesktopShortcutInstallValue = $DesktopShortcutState.InstallValue
    Write-UpdateLog ("desktop shortcut install value: " + $DesktopShortcutInstallValue)
    $MsiArguments = @(
        '/i',
        (Quote-NativeArgument $Source),
        ('INSTALLFOLDER=' + (Quote-NativeArgument $TargetDir)),
        ('INSTALLDESKTOPSHORTCUT=' + $DesktopShortcutInstallValue),
        '/passive',
        '/norestart',
        '/L*v',
        (Quote-NativeArgument $MSILogPath)
    )
    Write-UpdateLog ("launching msiexec; verbose log: " + $MSILogPath)
    $InstallerProcess = Start-Process -FilePath $MSIExecPath -Verb RunAs -ArgumentList $MsiArguments -Wait -PassThru -ErrorAction Stop
    $InstallerExitCode = $InstallerProcess.ExitCode
    Write-UpdateLog ("msiexec exit code: " + $InstallerExitCode)
    if ($InstallerExitCode -notin @(0, 1641, 3010)) {
        throw ("msiexec failed with exit code " + $InstallerExitCode)
    }
    $InstallSucceeded = $true

    if (-not (Test-Path -LiteralPath $Target -PathType Leaf)) {
        throw 'installed application executable not found'
    }
    if ($DesktopShortcutInstallValue -eq '0') {
        if (-not (Remove-GoNaviDesktopShortcutsForTarget -TargetPath $Target -DesktopDirectories $DesktopShortcutDirectories)) {
            throw 'unexpected desktop shortcut could not be removed'
        }
    }
    if (-not (Restore-GoNaviDesktopShortcutState -State $DesktopShortcutState -OnlyForeign)) {
        throw 'desktop shortcut state could not be restored'
    }
    [void](Repair-LegacyGoNaviTaskbarPins -TargetPath $Target)
    if (-not (Release-UpdateMaintenanceLock)) {
        throw 'update maintenance lock could not be released before relaunch'
    }
    Write-UpdateLog ("launching installed application: " + $Target)
    $NewProcess = Start-Process -FilePath $Target -WorkingDirectory $TargetDir -PassThru -ErrorAction Stop
    Start-Sleep -Milliseconds 1500
    $NewProcess.Refresh()
    if ($NewProcess.HasExited) {
        throw 'updated application exited immediately after launch'
    }
    $LaunchSucceeded = $true

    Remove-UpdateArtifact $Source
    Write-UpdateLog 'MSI update finished'

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
    Write-UpdateLog ("MSI updater failed: " + $_.Exception.Message)
    Write-UpdateLog 'MSI package retained for manual install'
    if ($DesktopShortcutInstallValue -eq '0') {
        [void](Remove-GoNaviDesktopShortcutsForTarget -TargetPath $Target -DesktopDirectories $DesktopShortcutDirectories)
    }
    [void](Restore-GoNaviDesktopShortcutState -State $DesktopShortcutState)
    [void](Release-UpdateMaintenanceLock)
    if ($HostExited -and -not $LaunchSucceeded -and $MaintenanceLockReleased -and (Test-Path -LiteralPath $Target -PathType Leaf)) {
        try {
            $TargetDir = [IO.Path]::GetDirectoryName($Target)
            Start-Process -FilePath $Target -WorkingDirectory $TargetDir -ErrorAction Stop | Out-Null
            if ($InstallSucceeded) {
                Write-UpdateLog 'installed application relaunched after updater failure'
            } else {
                Write-UpdateLog 'previous application relaunched after MSI failure'
            }
        } catch {
            Write-UpdateLog ("application relaunch failed: " + $_.Exception.Message)
        }
    }
    exit 1
}
