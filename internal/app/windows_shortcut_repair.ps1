function Write-ShortcutRepairLog {
    param([string]$Message)

    # Brand-icon repair runs outside the updater, where Write-UpdateLog does
    # not exist. Persist failures next to the icon selection so a silently
    # skipped taskbar pin can be diagnosed after the fact.
    try {
        if (Get-Command -Name Write-UpdateLog -CommandType Function -ErrorAction SilentlyContinue) {
            Write-UpdateLog $Message
            return
        }
        $logPath = [string]$env:GONAVI_BRAND_REPAIR_LOG
        if (-not [string]::IsNullOrWhiteSpace($logPath)) {
            $logDirectory = Split-Path -Parent $logPath
            if (-not [string]::IsNullOrWhiteSpace($logDirectory) -and -not (Test-Path -LiteralPath $logDirectory -PathType Container)) {
                [void](New-Item -ItemType Directory -Path $logDirectory -Force)
            }
            Add-Content -LiteralPath $logPath -Value ("[" + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + "] " + $Message)
        }
    } catch {
        # Shortcut repair logging must never affect the update.
    }
}

function Get-NormalizedFilePath {
    param([string]$Path)

    if ([string]::IsNullOrWhiteSpace($Path)) {
        return $null
    }
    try {
        $expandedPath = [Environment]::ExpandEnvironmentVariables($Path.Trim())
        return [IO.Path]::GetFullPath($expandedPath)
    } catch {
        return $null
    }
}

function Test-SameFilePath {
    param(
        [string]$Left,
        [string]$Right
    )

    $normalizedLeft = Get-NormalizedFilePath $Left
    $normalizedRight = Get-NormalizedFilePath $Right
    if ([string]::IsNullOrWhiteSpace($normalizedLeft) -or [string]::IsNullOrWhiteSpace($normalizedRight)) {
        return $false
    }
    return [string]::Equals($normalizedLeft, $normalizedRight, [StringComparison]::OrdinalIgnoreCase)
}

function Test-LegacyMissingMSIIcon {
    param(
        [object]$Shortcut,
        [string]$WindowsInstallerDirectory
    )

    $iconLocation = [string]$Shortcut.IconLocation
    if ([string]::IsNullOrWhiteSpace($iconLocation)) {
        return $false
    }

    $iconPath = $iconLocation.Trim()
    $indexedIcon = [regex]::Match($iconPath, '^(?<path>.+),\s*-?\d+$')
    if ($indexedIcon.Success) {
        $iconPath = $indexedIcon.Groups['path'].Value.Trim()
    }
    $iconPath = $iconPath.Trim('"')

    $normalizedIconPath = Get-NormalizedFilePath $iconPath
    $normalizedInstallerDirectory = Get-NormalizedFilePath $WindowsInstallerDirectory
    if ([string]::IsNullOrWhiteSpace($normalizedIconPath) -or [string]::IsNullOrWhiteSpace($normalizedInstallerDirectory)) {
        return $false
    }

    $installerPrefix = $normalizedInstallerDirectory
    if (-not $installerPrefix.EndsWith([IO.Path]::DirectorySeparatorChar)) {
        $installerPrefix += [IO.Path]::DirectorySeparatorChar
    }
    if (-not $normalizedIconPath.StartsWith($installerPrefix, [StringComparison]::OrdinalIgnoreCase)) {
        return $false
    }

    $relativeIconPath = $normalizedIconPath.Substring($installerPrefix.Length)
    $relativeParts = $relativeIconPath -split '[\\/]'
    if ($relativeParts.Count -lt 2 -or $relativeParts[0] -notmatch '^\{[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\}$') {
        return $false
    }
    if (-not [string]::Equals([IO.Path]::GetFileName($normalizedIconPath), 'GoNaviIcon', [StringComparison]::OrdinalIgnoreCase)) {
        return $false
    }

    return -not (Test-Path -LiteralPath $normalizedIconPath -PathType Leaf)
}

function Test-GoNaviShortcutWritable {
    param([string]$ShortcutPath)

    # Shortcuts in shared Start Menu directories are created by the installer with
    # administrator rights, so a standard user can only read them. Probe writability
    # first so one unwritable entry cannot fail the whole shortcut update batch.
    # Only an explicit permission denial counts as read-only. Sharing violations and
    # other errors must propagate, otherwise a temporarily locked shortcut would be
    # silently skipped and the update recorded as completed.
    try {
        $stream = [IO.File]::Open(
            $ShortcutPath,
            [IO.FileMode]::Open,
            [IO.FileAccess]::ReadWrite,
            [IO.FileShare]::Read
        )
        $stream.Close()
        return $true
    } catch [System.UnauthorizedAccessException] {
        return $false
    }
}

function Get-GoNaviDesktopDirectories {
    return @(
        [Environment]::GetFolderPath([Environment+SpecialFolder]::DesktopDirectory),
        [Environment]::GetFolderPath([Environment+SpecialFolder]::CommonDesktopDirectory)
    )
}

function Save-GoNaviDesktopShortcutState {
    param(
        [string]$TargetPath,
        [string]$BackupDirectory,
        [string[]]$DesktopDirectories
    )

    if ($null -eq $DesktopDirectories -or $DesktopDirectories.Count -eq 0) {
        $DesktopDirectories = @(Get-GoNaviDesktopDirectories)
    }

    $state = [pscustomobject]@{
        Succeeded = $true
        InstallValue = '0'
        Entries = @()
    }
    try {
        if ([string]::IsNullOrWhiteSpace($BackupDirectory)) {
            throw 'desktop shortcut backup directory is missing'
        }
        if (-not (Test-Path -LiteralPath $BackupDirectory -PathType Container)) {
            [void](New-Item -ItemType Directory -Path $BackupDirectory -Force -ErrorAction Stop)
        }
        $shell = New-Object -ComObject WScript.Shell
        $entryIndex = 0
        foreach ($desktopDirectory in $DesktopDirectories) {
            if ([string]::IsNullOrWhiteSpace($desktopDirectory)) {
                continue
            }
            $shortcutPath = Join-Path $desktopDirectory 'GoNavi.lnk'
            if (-not (Test-Path -LiteralPath $shortcutPath -PathType Leaf)) {
                continue
            }
            try {
                $shortcut = $shell.CreateShortcut($shortcutPath)
                $matchesTarget = Test-SameFilePath $shortcut.TargetPath $TargetPath
                $backupPath = Join-Path $BackupDirectory (('desktop-shortcut-{0}.lnk' -f $entryIndex))
                Copy-Item -LiteralPath $shortcutPath -Destination $backupPath -Force -ErrorAction Stop
                $state.Entries += [pscustomobject]@{
                    Path = $shortcutPath
                    BackupPath = $backupPath
                    MatchesTarget = $matchesTarget
                }
                if ($matchesTarget) {
                    $state.InstallValue = '1'
                }
                $entryIndex++
            } catch {
                $state.Succeeded = $false
                $state.InstallValue = '1'
                Write-ShortcutRepairLog ("desktop shortcut backup failed for " + $shortcutPath + ": " + $_.Exception.Message)
            }
        }
    } catch {
        $state.Succeeded = $false
        $state.InstallValue = '1'
        Write-ShortcutRepairLog ("desktop shortcut state backup failed: " + $_.Exception.Message)
    }
    return $state
}

function Remove-GoNaviDesktopShortcutsForTarget {
    param(
        [string]$TargetPath,
        [string[]]$DesktopDirectories
    )

    if ($null -eq $DesktopDirectories -or $DesktopDirectories.Count -eq 0) {
        $DesktopDirectories = @(Get-GoNaviDesktopDirectories)
    }
    $succeeded = $true
    try {
        $shell = New-Object -ComObject WScript.Shell
        foreach ($desktopDirectory in $DesktopDirectories) {
            if ([string]::IsNullOrWhiteSpace($desktopDirectory)) {
                continue
            }
            $shortcutPath = Join-Path $desktopDirectory 'GoNavi.lnk'
            if (-not (Test-Path -LiteralPath $shortcutPath -PathType Leaf)) {
                continue
            }
            try {
                $shortcut = $shell.CreateShortcut($shortcutPath)
                if (Test-SameFilePath $shortcut.TargetPath $TargetPath) {
                    Remove-Item -LiteralPath $shortcutPath -Force -ErrorAction Stop
                    Write-ShortcutRepairLog ("removed unexpected desktop shortcut: " + $shortcutPath)
                }
            } catch {
                $succeeded = $false
                Write-ShortcutRepairLog ("desktop shortcut removal failed for " + $shortcutPath + ": " + $_.Exception.Message)
            }
        }
    } catch {
        $succeeded = $false
        Write-ShortcutRepairLog ("desktop shortcut removal failed: " + $_.Exception.Message)
    }
    return $succeeded
}

function Restore-GoNaviDesktopShortcutState {
    param(
        [object]$State,
        [switch]$OnlyForeign
    )

    if ($null -eq $State) {
        return $true
    }
    $succeeded = $true
    foreach ($entry in @($State.Entries)) {
        if ($OnlyForeign.IsPresent -and $entry.MatchesTarget) {
            continue
        }
        try {
            Copy-Item -LiteralPath $entry.BackupPath -Destination $entry.Path -Force -ErrorAction Stop
            Write-ShortcutRepairLog ("restored desktop shortcut: " + $entry.Path)
        } catch {
            $succeeded = $false
            Write-ShortcutRepairLog ("desktop shortcut restore failed for " + $entry.Path + ": " + $_.Exception.Message)
        }
    }
    return $succeeded
}

function Ensure-GoNaviShortcutShellNotificationType {
    if ('GoNaviShortcutShellNotification' -as [type]) {
        return
    }
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class GoNaviShortcutShellNotification
{
    private const uint SHCNE_UPDATEITEM = 0x00002000;
    private const uint SHCNE_UPDATEDIR = 0x04000000;
    private const uint SHCNF_PATHW = 0x0005;
    private const uint SHCNF_FLUSH = 0x1000;

    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    private static extern void SHChangeNotify(uint eventId, uint flags, string item1, IntPtr item2);

    public static void NotifyItemUpdated(string path)
    {
        SHChangeNotify(SHCNE_UPDATEITEM, SHCNF_PATHW | SHCNF_FLUSH, path, IntPtr.Zero);
    }

    public static void NotifyDirectoryUpdated(string path)
    {
        SHChangeNotify(SHCNE_UPDATEDIR, SHCNF_PATHW | SHCNF_FLUSH, path, IntPtr.Zero);
    }
}
'@
}

function Send-ShellItemUpdatedNotification {
    param([string]$Path)

    try {
        Ensure-GoNaviShortcutShellNotificationType
        [GoNaviShortcutShellNotification]::NotifyItemUpdated($Path)
    } catch {
        Write-ShortcutRepairLog ("shell shortcut refresh failed for " + $Path + ": " + $_.Exception.Message)
    }
}

function Send-ShellDirectoryUpdatedNotification {
    # The Start menu keeps its own per-folder icon snapshot and ignores
    # UPDATEITEM for a single .lnk (observed on Windows 11 26200: the all-apps
    # entry kept the previous brand icon after in-place IconLocation rewrites).
    # UPDATEDIR on the containing folder is the documented folder-level refresh
    # that StartMenuExperienceHost honours.
    param([string]$Path)

    try {
        Ensure-GoNaviShortcutShellNotificationType
        [GoNaviShortcutShellNotification]::NotifyDirectoryUpdated($Path)
    } catch {
        Write-ShortcutRepairLog ("shell directory refresh failed for " + $Path + ": " + $_.Exception.Message)
    }
}

function Send-ShellAssociationChangedNotification {
    # RETIRED: with whole-file shortcut replacement the per-item/per-folder
    # notifications cover every observed surface, and the global flush this
    # performs redraws the entire desktop (visible flash on each switch).
    # Kept for a surface that provably needs the global flush; not called.
    # Windows 11 keeps drawing a pinned taskbar button from its in-memory
    # copy. UPDATEITEM refreshes a desktop .lnk; the taskbar needs the
    # association flush before it shows the new IconLocation.
    try {
        if (-not ('GoNaviShortcutShellAssociation' -as [type])) {
            Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class GoNaviShortcutShellAssociation
{
    private const uint SHCNE_ASSOCCHANGED = 0x08000000;
    private const uint SHCNF_IDLIST = 0x0000;
    private const uint SHCNF_FLUSH = 0x1000;

    [DllImport("shell32.dll")]
    private static extern void SHChangeNotify(uint eventId, uint flags, System.IntPtr item1, System.IntPtr item2);

    public static void NotifyAssociationChanged()
    {
        SHChangeNotify(SHCNE_ASSOCCHANGED, SHCNF_IDLIST | SHCNF_FLUSH, System.IntPtr.Zero, System.IntPtr.Zero);
    }
}
'@
        }
        [GoNaviShortcutShellAssociation]::NotifyAssociationChanged()
    } catch {
        Write-ShortcutRepairLog ("shell association refresh failed: " + $_.Exception.Message)
    }
}

function Restart-GoNaviStartMenuHost {
    # The Win11 Start menu all-apps list snapshots each shortcut's icon into
    # its own database and ignores every notification: per-item, per-folder
    # and the global ASSOCCHANGED flush alike (observed on Windows 11 26200:
    # after whole-file replacement the list kept the old icon, and only a
    # reboot refreshed it). Restarting the list's host process is the only
    # reliable real-time refresh: the system respawns it on demand, only the
    # Start menu itself blinks (reloading instantly when open); desktop and
    # taskbar are unaffected.
    try {
        $startMenuHost = Get-Process -Name 'StartMenuExperienceHost' -ErrorAction SilentlyContinue
        if ($null -ne $startMenuHost) {
            Stop-Process -InputObject $startMenuHost -Force -ErrorAction SilentlyContinue
            Write-ShortcutRepairLog ("restarted StartMenuExperienceHost to refresh the all-apps list")
        }
    } catch {
        Write-ShortcutRepairLog ("StartMenuExperienceHost restart failed: " + $_.Exception.Message)
    }
}

function Set-GoNaviShortcutRelaunchProperties {
    param(
        [string]$ShortcutPath,
        [string]$TargetPath,
        [string]$IconPath,
        [string]$ApplicationUserModelID = 'Syngnat.GoNavi'
    )

    if ([string]::IsNullOrWhiteSpace($ApplicationUserModelID)) {
        $ApplicationUserModelID = 'Syngnat.GoNavi'
    }
    try {
        if (-not ('GoNaviShortcutPropertyStore' -as [type])) {
            Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class GoNaviShortcutPropertyStore
{
    private const ushort VT_LPWSTR = 31;
    private static readonly Guid PKEY_AppUserModel = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3");

    [ComImport]
    [Guid("00021401-0000-0000-C000-000000000046")]
    private class ShellLink { }

    [ComImport]
    [Guid("0000010B-0000-0000-C000-000000000046")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IPersistFile
    {
        void GetClassID(out Guid classId);
        [PreserveSig] int IsDirty();
        void Load([MarshalAs(UnmanagedType.LPWStr)] string fileName, uint mode);
        void Save([MarshalAs(UnmanagedType.LPWStr)] string fileName, bool remember);
        void SaveCompleted([MarshalAs(UnmanagedType.LPWStr)] string fileName);
        void GetCurFile([MarshalAs(UnmanagedType.LPWStr)] out string fileName);
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROPERTYKEY
    {
        public Guid fmtid;
        public uint pid;

        public PROPERTYKEY(Guid formatId, uint propertyId)
        {
            fmtid = formatId;
            pid = propertyId;
        }
    }

    [StructLayout(LayoutKind.Explicit)]
    private struct PROPVARIANT
    {
        [FieldOffset(0)] public ushort vt;
        [FieldOffset(8)] public IntPtr pointerValue;
    }

    [ComImport]
    [Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IPropertyStore
    {
        [PreserveSig] int GetCount(out uint count);
        [PreserveSig] int GetAt(uint index, out PROPERTYKEY key);
        [PreserveSig] int GetValue(ref PROPERTYKEY key, IntPtr value);
        [PreserveSig] int SetValue(ref PROPERTYKEY key, ref PROPVARIANT value);
        [PreserveSig] int Commit();
    }

    private static void SetString(IPropertyStore store, PROPERTYKEY key, string value)
    {
        IntPtr text = Marshal.StringToCoTaskMemUni(value ?? String.Empty);
        PROPVARIANT variant = new PROPVARIANT { vt = VT_LPWSTR, pointerValue = text };
        try
        {
            Marshal.ThrowExceptionForHR(store.SetValue(ref key, ref variant));
        }
        finally
        {
            Marshal.FreeCoTaskMem(text);
        }
    }

    public static bool SetRelaunchProperties(string shortcutPath, string targetPath, string iconPath, string applicationUserModelID)
    {
        if (String.IsNullOrWhiteSpace(applicationUserModelID))
        {
            applicationUserModelID = "Syngnat.GoNavi";
        }
        object shellLink = new ShellLink();
        try
        {
            IPersistFile persistence = (IPersistFile)shellLink;
            persistence.Load(shortcutPath, 2);
            IPropertyStore store = (IPropertyStore)shellLink;
            // AppUserModel.ID must be written last. Windows uses that write to
            // notify the taskbar that the preceding relaunch values changed.
            // RelaunchIconResource uses the plain .ico path: a trailing ',0'
            // makes Explorer parse it as a PE resource index, which fails for
            // .ico files and blanks the taskbar button.
            SetString(store, new PROPERTYKEY(PKEY_AppUserModel, 2), "\"" + targetPath + "\"");
            SetString(store, new PROPERTYKEY(PKEY_AppUserModel, 3), iconPath);
            SetString(store, new PROPERTYKEY(PKEY_AppUserModel, 4), "GoNavi");
            SetString(store, new PROPERTYKEY(PKEY_AppUserModel, 5), applicationUserModelID);
            Marshal.ThrowExceptionForHR(store.Commit());
            persistence.Save(shortcutPath, true);
            return true;
        }
        finally
        {
            Marshal.ReleaseComObject(shellLink);
        }
    }
}
'@
        }
        return [GoNaviShortcutPropertyStore]::SetRelaunchProperties($ShortcutPath, $TargetPath, $IconPath, $ApplicationUserModelID)
    } catch {
        Write-ShortcutRepairLog ("shortcut relaunch property update failed for " + $ShortcutPath + ": " + $_.Exception.Message)
        return $false
    }
}

function Repair-LegacyGoNaviTaskbarPins {
    param(
        [string]$TargetPath,
        [string]$PinsDirectory,
        [string]$WindowsInstallerDirectory
    )

    $repairCount = 0
    try {
        $normalizedTargetPath = Get-NormalizedFilePath $TargetPath
        if ([string]::IsNullOrWhiteSpace($normalizedTargetPath) -or -not (Test-Path -LiteralPath $normalizedTargetPath -PathType Leaf)) {
            return $repairCount
        }
        if ([string]::IsNullOrWhiteSpace($PinsDirectory)) {
            $applicationData = [Environment]::GetFolderPath([Environment+SpecialFolder]::ApplicationData)
            $PinsDirectory = Join-Path $applicationData 'Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar'
        }
        if ([string]::IsNullOrWhiteSpace($WindowsInstallerDirectory)) {
            if ([string]::IsNullOrWhiteSpace($env:WINDIR)) {
                return $repairCount
            }
            $WindowsInstallerDirectory = Join-Path $env:WINDIR 'Installer'
        }
        if (-not (Test-Path -LiteralPath $PinsDirectory -PathType Container)) {
            return $repairCount
        }

        $normalizedPinsDirectory = Get-NormalizedFilePath $PinsDirectory
        $applicationData = [Environment]::GetFolderPath([Environment+SpecialFolder]::ApplicationData)
        $knownTaskbarDirectory = Get-NormalizedFilePath (Join-Path $applicationData 'Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar')
        $useTaskbarPropertyStore = Test-SameFilePath $normalizedPinsDirectory $knownTaskbarDirectory

        $shell = New-Object -ComObject WScript.Shell
        $pins = Get-ChildItem -LiteralPath $PinsDirectory -Filter '*.lnk' -File -Force -ErrorAction Stop
        foreach ($pin in $pins) {
            try {
                $shortcut = $shell.CreateShortcut($pin.FullName)
                if (-not (Test-SameFilePath $shortcut.TargetPath $normalizedTargetPath)) {
                    continue
                }
                if (-not (Test-LegacyMissingMSIIcon $shortcut $WindowsInstallerDirectory)) {
                    continue
                }

                if ($useTaskbarPropertyStore) {
                    if (Set-GoNaviShortcutRelaunchProperties -ShortcutPath $pin.FullName -TargetPath $normalizedTargetPath -IconPath $normalizedTargetPath) {
                        Send-ShellItemUpdatedNotification $pin.FullName
                        $repairCount++
                        Write-ShortcutRepairLog ("repaired legacy taskbar pin properties: " + $pin.Name)
                    }
                    continue
                }
                $shortcut.IconLocation = $normalizedTargetPath + ',0'
                $shortcut.Save()
                Send-ShellItemUpdatedNotification $pin.FullName
                $repairCount++
                Write-ShortcutRepairLog ("repaired legacy taskbar pin icon: " + $pin.Name)
            } catch {
                Write-ShortcutRepairLog ("taskbar pin repair failed for " + $pin.Name + ": " + $_.Exception.Message)
            }
        }
    } catch {
        Write-ShortcutRepairLog ("taskbar pin repair failed: " + $_.Exception.Message)
    }
    return $repairCount
}

function Test-ShortcutOwnedByIconDirectory {
    param(
        [string]$ShortcutPath,
        [string]$IconDirectory
    )

    # Ownership by icon directory: a pin belongs to THIS install only when its
    # classic IconLocation or its relaunch icon resource lives inside the
    # running instance's brand-icon directory. Name and AUMID family matches
    # also hit every other GoNavi installation on the machine, so a portable
    # or development build must not use them to claim foreign pins.
    try {
        if ([string]::IsNullOrWhiteSpace($IconDirectory)) {
            return $false
        }
        $iconDirectory = Get-NormalizedFilePath $IconDirectory
        if ([string]::IsNullOrWhiteSpace($iconDirectory)) {
            return $false
        }
        if (-not $iconDirectory.EndsWith([IO.Path]::DirectorySeparatorChar)) {
            $iconDirectory += [IO.Path]::DirectorySeparatorChar
        }
        $shell = New-Object -ComObject WScript.Shell
        $classicIcon = Get-NormalizedFilePath (([string]$shell.CreateShortcut($ShortcutPath).IconLocation) -replace ',\d+$', '')
        if (-not [string]::IsNullOrWhiteSpace($classicIcon) -and $classicIcon.StartsWith($iconDirectory, [StringComparison]::OrdinalIgnoreCase)) {
            return $true
        }
        $folderPath = [IO.Path]::GetDirectoryName($ShortcutPath)
        $fileName = [IO.Path]::GetFileName($ShortcutPath)
        $namespace = (New-Object -ComObject Shell.Application).Namespace($folderPath)
        if ($null -eq $namespace) {
            return $false
        }
        $item = $namespace.ParseName($fileName)
        if ($null -eq $item) {
            return $false
        }
        $relaunchIcon = Get-NormalizedFilePath (([string]$item.ExtendedProperty('System.AppUserModel.RelaunchIconResource')) -replace ',\d+$', '')
        return (-not [string]::IsNullOrWhiteSpace($relaunchIcon) -and $relaunchIcon.StartsWith($iconDirectory, [StringComparison]::OrdinalIgnoreCase))
    } catch {
        return $false
    }
}

function Get-GoNaviShortcutAppUserModelID {
    param([string]$ShortcutPath)

    try {
        $folderPath = [IO.Path]::GetDirectoryName($ShortcutPath)
        $fileName = [IO.Path]::GetFileName($ShortcutPath)
        $namespace = (New-Object -ComObject Shell.Application).Namespace($folderPath)
        if ($null -eq $namespace) {
            return ''
        }
        $item = $namespace.ParseName($fileName)
        if ($null -eq $item) {
            return ''
        }
        return [string]$item.ExtendedProperty('System.AppUserModel.ID')
    } catch {
        return ''
    }
}

function Ensure-GoNaviAumidShortcut {
    param(
        [string]$TargetPath,
        [string]$IconPath,
        [string]$ApplicationUserModelID = 'Syngnat.GoNavi'
    )

    # SFX portable instances extract the exe into a temporary directory that
    # is deleted on exit: a Start Menu shortcut created for it would point at
    # a missing file forever - the non-taskbar branch only rewrites
    # IconLocation, never Target, and the name-occupied guard refuses to
    # rebuild it. The Go side sets GONAVI_BRAND_ENSURE_SHORTCUTS_DISABLED=1
    # when the executable runs from a temporary directory.
    if ($env:GONAVI_BRAND_ENSURE_SHORTCUTS_DISABLED -eq '1') {
        Write-ShortcutRepairLog ("skip AUMID shortcut creation, executable runs from a temporary directory: " + $TargetPath)
        return $false
    }

    # The taskbar button icon comes from the shortcut resolved via AUMID: when
    # no shortcut declares the AUMID, the button falls back to a generic window
    # icon and does not follow WM_SETICON (Win11 26200 observed). MSI installs
    # get their shortcuts from the installer; portable/dev instances have no
    # installer, so create one in the user's Start Menu declaring the AUMID,
    # and let subsequent switches follow via the IconLocation rewrite.
    $programs = [Environment]::GetFolderPath([Environment+SpecialFolder]::Programs)
    $commonPrograms = [Environment]::GetFolderPath([Environment+SpecialFolder]::CommonPrograms)
    if (-not [string]::IsNullOrWhiteSpace($env:GONAVI_TEST_ROOT)) {
        $programs = Join-Path $env:GONAVI_TEST_ROOT 'aumid-shortcut-programs'
        [void](New-Item -ItemType Directory -Path $programs -Force)
        $commonPrograms = Join-Path $env:GONAVI_TEST_ROOT 'aumid-shortcut-common-programs'
        [void](New-Item -ItemType Directory -Path $commonPrograms -Force)
    }
    $userShortcutPath = Join-Path $programs 'GoNavi.lnk'
    $machineShortcutPath = Join-Path $commonPrograms 'GoNavi.lnk'

    foreach ($candidate in @($userShortcutPath, $machineShortcutPath)) {
        if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { continue }
        $app = New-Object -ComObject Shell.Application
        $item = $app.Namespace((Split-Path -Parent $candidate)).ParseName((Split-Path -Leaf $candidate))
        if ($null -eq $item) { continue }
        $existingAumid = ''
        try { $existingAumid = [string]$item.ExtendedProperty('System.AppUserModel.ID') } catch {}
        if ($existingAumid -match '^Syngnat\.GoNavi') {
            if ($candidate -ieq $userShortcutPath) {
                # A writable per-user shortcut already declares the AUMID;
                # brand switches follow through its IconLocation rewrite.
                return $false
            }
            # A per-machine shortcut is read-only for a standard user, and
            # Explorer anchors the taskbar button to its IconLocation, so the
            # button would freeze on a stale brand icon while switches keep
            # failing with "shortcut is not writable" (observed on MSI
            # installs, Win11 26200). Fall through and create the writable
            # per-user shortcut that Explorer resolves first for the AUMID.
        }
    }

    $shortcutPath = $userShortcutPath
    if (Test-Path -LiteralPath $shortcutPath -PathType Leaf) {
        # A same-named shortcut exists but belongs to neither our AUMID family
        # nor an existing declaration; never overwrite a user shortcut.
        Write-ShortcutRepairLog ("skip AUMID shortcut creation, name occupied: " + $shortcutPath)
        return $false
    }

    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($shortcutPath)
    $shortcut.TargetPath = $TargetPath
    $shortcut.WorkingDirectory = [IO.Path]::GetDirectoryName($TargetPath)
    $shortcut.IconLocation = "$IconPath,0"
    $shortcut.Save()
    if (-not (Set-GoNaviShortcutRelaunchProperties -ShortcutPath $shortcutPath -TargetPath $TargetPath -IconPath $IconPath -ApplicationUserModelID $ApplicationUserModelID)) {
        Write-ShortcutRepairLog ("AUMID shortcut relaunch properties failed: " + $shortcutPath)
    }
    Write-ShortcutRepairLog ("created AUMID shortcut: " + $shortcutPath)
    Send-ShellItemUpdatedNotification $shortcutPath
    Send-ShellDirectoryUpdatedNotification ([IO.Path]::GetDirectoryName($ShortcutPath))
    return $true
}

function Set-GoNaviMachineShortcutMigration {
    param(
        [string]$TargetPath,
        [string]$CommonDesktopDirectory,
        [string]$CommonProgramsDirectory,
        [string]$UserDesktopDirectory,
        [string]$UserProgramsDirectory
    )

    # Startup migration mode (GONAVI_BRAND_MIGRATE_ONLY=1): move machine-layer
    # GoNavi shortcuts to the user layer byte-for-byte. Nothing inside the
    # shortcut is rewritten, so the installer appearance and the AppUserModel
    # property bag survive, and the file-replacement mechanism works on them
    # from then on. This closes the installer's per-file Users-Modify grant
    # exposure at first launch instead of the first brand switch, and re-serves
    # every other profile's Start Menu entry after an MSI repair/upgrade
    # recreated the machine shortcuts. Top-level only: the installer creates
    # flat entries, and a nested move would need subdirectory mirroring.
    $pairs = @(
        @{ Machine = $CommonProgramsDirectory; User = $UserProgramsDirectory },
        @{ Machine = $CommonDesktopDirectory; User = $UserDesktopDirectory }
    )
    $migratedCount = 0
    $failureMessages = [Collections.Generic.List[string]]::new()
    $shell = New-Object -ComObject WScript.Shell
    foreach ($pair in $pairs) {
        $machineDirectory = Get-NormalizedFilePath $pair.Machine
        $userDirectory = Get-NormalizedFilePath $pair.User
        if ([string]::IsNullOrWhiteSpace($machineDirectory) -or
            [string]::IsNullOrWhiteSpace($userDirectory) -or
            [string]::Equals($machineDirectory, $userDirectory, [StringComparison]::OrdinalIgnoreCase) -or
            -not (Test-Path -LiteralPath $machineDirectory -PathType Container)) {
            continue
        }
        $machineShortcuts = Get-ChildItem -LiteralPath $machineDirectory -Filter 'GoNavi*.lnk' -File -ErrorAction SilentlyContinue
        foreach ($shortcutFile in $machineShortcuts) {
            try {
                $shortcut = $shell.CreateShortcut($shortcutFile.FullName)
                if (-not (Test-SameFilePath $shortcut.TargetPath $TargetPath)) {
                    # GoNavi-named machine entries targeting a different
                    # executable are not part of this migration; leave them.
                    continue
                }
                $userShortcutPath = Join-Path $userDirectory $shortcutFile.Name
                if (Test-Path -LiteralPath $userShortcutPath -PathType Leaf) {
                    # A same-named user entry already exists (e.g. created by
                    # the Ensure fallback); deleting the machine file still
                    # closes its per-file modify-grant exposure.
                    Remove-Item -LiteralPath $shortcutFile.FullName -Force
                    Write-ShortcutRepairLog ("removed machine shortcut shadowed by user entry: " + $shortcutFile.FullName)
                } else {
                    Move-Item -LiteralPath $shortcutFile.FullName -Destination $userShortcutPath
                    Send-ShellItemUpdatedNotification $userShortcutPath
                    Write-ShortcutRepairLog ("moved machine shortcut to user scope: " + $userShortcutPath)
                }
                Send-ShellDirectoryUpdatedNotification $userDirectory
                Send-ShellDirectoryUpdatedNotification $machineDirectory
                $migratedCount++
            } catch {
                $failureMessages.Add("machine shortcut migration failed for " + $shortcutFile.FullName + ": " + $_.Exception.Message)
            }
        }
    }
    $script:GoNaviBrandFailureCount = $failureMessages.Count
    if ($failureMessages.Count -gt 0) {
        Write-ShortcutRepairLog ([string]::Join('; ', $failureMessages))
    }
    return $migratedCount
}

function Set-GoNaviShortcutBrandIcon {
    param(
        [string]$TargetPath,
        [string]$IconPath,
        [string]$ApplicationUserModelID = 'Syngnat.GoNavi',
        [string[]]$ShortcutDirectories,
        [string]$TaskbarDirectory
    )

    # Keep every GoNavi pin in the installer identity. A per-icon AUMID makes
    # Explorer create a second taskbar button and leaves the old pin behind.
    $ApplicationUserModelID = 'Syngnat.GoNavi'
    # Portable launches must not retouch a pin that points at another copy,
    # such as an MSI install beside the portable exe.
    $onlyMatchingTarget = $env:GONAVI_BRAND_MATCH_TARGET_ONLY -eq '1'
    $updatedCount = 0
    $failureMessages = [Collections.Generic.List[string]]::new()
    try {
        $normalizedTargetPath = Get-NormalizedFilePath $TargetPath
        $normalizedIconPath = Get-NormalizedFilePath $IconPath
        if ([string]::IsNullOrWhiteSpace($normalizedTargetPath) -or
            [string]::IsNullOrWhiteSpace($normalizedIconPath) -or
            -not (Test-Path -LiteralPath $normalizedTargetPath -PathType Leaf) -or
            -not (Test-Path -LiteralPath $normalizedIconPath -PathType Leaf)) {
            throw 'GoNavi shortcut target or icon does not exist'
        }
        $msiMarkerPath = Join-Path ([IO.Path]::GetDirectoryName($normalizedTargetPath)) '.gonavi-msi-install'
        $isMSITarget = Test-Path -LiteralPath $msiMarkerPath -PathType Leaf

        if ($null -eq $ShortcutDirectories -or $ShortcutDirectories.Count -eq 0) {
            $applicationData = [Environment]::GetFolderPath([Environment+SpecialFolder]::ApplicationData)
            $ShortcutDirectories = @(
                [Environment]::GetFolderPath([Environment+SpecialFolder]::DesktopDirectory),
                [Environment]::GetFolderPath([Environment+SpecialFolder]::CommonDesktopDirectory),
                [Environment]::GetFolderPath([Environment+SpecialFolder]::Programs),
                [Environment]::GetFolderPath([Environment+SpecialFolder]::CommonPrograms),
                (Join-Path $applicationData 'Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar')
            )
        }

        if ([string]::IsNullOrWhiteSpace($TaskbarDirectory)) {
            $applicationData = [Environment]::GetFolderPath([Environment+SpecialFolder]::ApplicationData)
            $TaskbarDirectory = Join-Path $applicationData 'Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar'
        }
        $taskbarDirectory = Get-NormalizedFilePath $TaskbarDirectory
        $taskbarPrefix = $taskbarDirectory
        if (-not [string]::IsNullOrWhiteSpace($taskbarPrefix) -and -not $taskbarPrefix.EndsWith([IO.Path]::DirectorySeparatorChar)) {
            $taskbarPrefix += [IO.Path]::DirectorySeparatorChar
        }

        $shell = New-Object -ComObject WScript.Shell
        $visitedDirectories = @{}
        # Set when a machine-level common-desktop shortcut had to be migrated
        # (deleted because its directory denies file creation to standard
        # users); the user-level desktop shortcut is created after the loop.
        $script:GoNaviMigratedCommonDesktop = $false
        $commonDesktopDirectory = Get-NormalizedFilePath ([Environment]::GetFolderPath([Environment+SpecialFolder]::CommonDesktopDirectory))

        # Startup migration mode: converge machine-layer shortcuts to the
        # user layer even when no brand icon was ever selected (closes the
        # installer's cross-user modify grant). The whole icon update flow
        # short-circuits here - migration moves files byte-for-byte and
        # rewrites no properties; Ensure still backfills a missing
        # user-level Start Menu entry (with the executable's own icon).
        if ($env:GONAVI_BRAND_MIGRATE_ONLY -eq '1') {
            $migrated = Set-GoNaviMachineShortcutMigration -TargetPath $normalizedTargetPath `
                -CommonDesktopDirectory $commonDesktopDirectory `
                -CommonProgramsDirectory (Get-NormalizedFilePath ([Environment]::GetFolderPath([Environment+SpecialFolder]::CommonPrograms))) `
                -UserDesktopDirectory (Get-NormalizedFilePath ([Environment]::GetFolderPath([Environment+SpecialFolder]::DesktopDirectory))) `
                -UserProgramsDirectory (Get-NormalizedFilePath ([Environment]::GetFolderPath([Environment+SpecialFolder]::Programs)))
            try {
                Ensure-GoNaviAumidShortcut -TargetPath $normalizedTargetPath -IconPath $normalizedIconPath | Out-Null
            } catch {
                # Creating the AUMID shortcut is an incremental improvement; a
                # failure is logged and never blocks the icon switch.
                Write-ShortcutRepairLog ("AUMID shortcut ensure failed: " + $_.Exception.Message)
            }
            # Migration makes the all-apps list see a machine entry disappear
            # and a user entry appear; the host restart rebuilds both into one
            # correct entry.
            if ($migrated -gt 0 -and $env:GONAVI_BRAND_RESTART_STARTMENU -ne '0') {
                Restart-GoNaviStartMenuHost
            }
            return $migrated
        }

        foreach ($directory in $ShortcutDirectories) {
            $normalizedDirectory = Get-NormalizedFilePath $directory
            if ([string]::IsNullOrWhiteSpace($normalizedDirectory) -or
                $visitedDirectories.ContainsKey($normalizedDirectory) -or
                -not (Test-Path -LiteralPath $normalizedDirectory -PathType Container)) {
                continue
            }
            $visitedDirectories[$normalizedDirectory] = $true
            # Taskbar pins must be fully enumerated because an inaccessible pin
            # would otherwise be mistaken for a completed update. Other roots
            # can contain unrelated protected folders, so preserve their
            # best-effort discovery behavior and fail only when a matching link
            # itself cannot be saved.
            $enumerationErrorAction = if (Test-SameFilePath $normalizedDirectory $taskbarDirectory) { 'Stop' } else { 'SilentlyContinue' }
            $shortcuts = Get-ChildItem -LiteralPath $normalizedDirectory -Filter '*.lnk' -File -Recurse -Force -ErrorAction $enumerationErrorAction
            foreach ($shortcutFile in $shortcuts) {
                try {
                    $shortcut = $shell.CreateShortcut($shortcutFile.FullName)
                    $matchesTarget = Test-SameFilePath $shortcut.TargetPath $normalizedTargetPath
                    $isTaskbarShortcut = -not [string]::IsNullOrWhiteSpace($taskbarPrefix) -and
                        $shortcutFile.FullName.StartsWith($taskbarPrefix, [StringComparison]::OrdinalIgnoreCase)
                    $existingTargetRaw = [string]$shortcut.TargetPath
                    $existingTargetPath = Get-NormalizedFilePath $existingTargetRaw
                    $targetMissing = [string]::IsNullOrWhiteSpace($existingTargetPath) -or -not (Test-Path -LiteralPath $existingTargetPath -PathType Leaf)
                    $targetIsIcon = $existingTargetRaw -match '(?i)\.ico(\s*,\s*-?\d+)?$'
                    # A previous brand-icon update wrote AppUserModel.RelaunchCommand
                    # through the property store. Windows 11 then launches the pin
                    # from that command, and a broken or icon path shows up as
                    # "the item no longer exists" after GoNavi exits.
                    $pinLaunchBroken = $isTaskbarShortcut -and ($targetMissing -or $targetIsIcon)
                    $isGoNaviTaskbarShortcut = $false
                    # Recognize pins created by older releases that rotated the
                    # identity inside the Syngnat.GoNavi family. An MSI launch
                    # repairs those pins to the current installed executable;
                    # development and portable launches preserve a target that
                    # still exists.
                    if (-not $matchesTarget -and $isTaskbarShortcut) {
                        $shortcutName = [IO.Path]::GetFileNameWithoutExtension($shortcutFile.Name)
                        $targetName = [IO.Path]::GetFileName($existingTargetRaw)
                        # Ownership tightened: the pin name must start with GoNavi.
                        # The name is the only reliable ownership signal: system pins
                        # (File Explorer) and other apps' pins are never ours, even if
                        # their icons were rewritten by the historical incident.
                        # (A test instance once claimed the user's File Explorer pin.)
                        $namedGoNaviPin = $shortcutName -match '^GoNavi(?:[-_.].*|\s*\(\d+\))?$'
                        $looksLikeGoNaviPin = $namedGoNaviPin -and (
                            $targetName -match '^GoNavi(?:[-_.].*|\s*\(\d+\))?\.exe$' -or
                            $pinLaunchBroken
                        )
                        # AUMID family matching is only corroborating evidence for
                        # GoNavi-named pins, never a standalone claim condition.
                        $isGoNaviTaskbarShortcut = $looksLikeGoNaviPin -or
                            ($namedGoNaviPin -and
                            ((Get-GoNaviShortcutAppUserModelID $shortcutFile.FullName) -match '^Syngnat\.GoNavi(?:\.Icon\.[0-9a-f]+)?$'))
                    }
                    # Ownership gate. MSI installs are the authoritative owner of
                    # the GoNavi pin family and may repair legacy rotated
                    # identities. A portable or development build may only claim
                    # a pin that targets this executable or whose icon lives in
                    # this instance's icon directory; name or AUMID family
                    # matches alone also hit every other GoNavi installation on
                    # the machine, and claiming those hijacks foreign pins.
                    if ($onlyMatchingTarget -and -not $matchesTarget) {
                        # Cheap prefilter: only GoNavi-named shortcuts can be this
                        # instance's leftover pins; skip the expensive COM ownership
                        # check for every unrelated .lnk on the system.
                        $shortcutName = [IO.Path]::GetFileNameWithoutExtension($shortcutFile.Name)
                        if (-not $shortcutName.StartsWith('GoNavi', [StringComparison]::OrdinalIgnoreCase)) {
                            continue
                        }
                        if (-not (Test-ShortcutOwnedByIconDirectory -ShortcutPath $shortcutFile.FullName -IconDirectory (Split-Path -Parent $normalizedIconPath))) {
                            Write-ShortcutRepairLog ("skip foreign GoNavi shortcut: " + $shortcutFile.FullName)
                            continue
                        }
                    } elseif (-not $matchesTarget -and -not $isGoNaviTaskbarShortcut) {
                        # MSI-mode claims also require GoNavi evidence (name/AUMID).
                        # pinLaunchBroken alone only means the target is dead; letting
                        # it through hijacks dead pins left by uninstalled foreign
                        # apps (e.g. Steam.lnk) as GoNavi launchers (observed).
                        continue
                    }
                    if ($isTaskbarShortcut) {
                        # Keep the launch target valid while normalizing the pin
                        # to the stable GoNavi identity. A plain portable pin
                        # without an existing GoNavi identity must keep its
                        # implicit ID; assigning one can detach it from its
                        # executable.
                        $existingAumid = [string](Get-GoNaviShortcutAppUserModelID $shortcutFile.FullName)
                        $hasGoNaviIdentity = $existingAumid -match '^Syngnat\.GoNavi(?:\.Icon\.[0-9a-fA-F]+)?$'
                        # A matching portable pin may have no explicit AUMID yet.
                        # Normalize it too, otherwise the next launch uses the
                        # executable's implicit identity and creates a second
                        # taskbar button after the current process exits.
                        $shouldWriteIdentity = $isMSITarget -or $matchesTarget -or $hasGoNaviIdentity -or $isGoNaviTaskbarShortcut
                        if ($pinLaunchBroken -or ($isMSITarget -and -not $matchesTarget)) {
                            $shortcut.TargetPath = $normalizedTargetPath
                            $shortcut.WorkingDirectory = [IO.Path]::GetDirectoryName($normalizedTargetPath)
                        }
                        if ($pinLaunchBroken) {
                            $shortcut.Arguments = ''
                        }
                        # Always save. WScript.Shell.Save rewrites the .lnk
                        # without the AppUserModel property bag, which drops a
                        # relaunch command that points at a missing file.
                        $shortcut.IconLocation = $normalizedIconPath + ',0'
                        if (Test-GoNaviShortcutWritable $shortcutFile.FullName) {
                            $shortcut.Save()
                            if ($shouldWriteIdentity -and -not (Set-GoNaviShortcutRelaunchProperties -ShortcutPath $shortcutFile.FullName -TargetPath $shortcut.TargetPath -IconPath $normalizedIconPath -ApplicationUserModelID $ApplicationUserModelID)) {
                                throw ('failed to update taskbar identity: ' + $shortcutFile.FullName)
                            }
                            $updatedCount++
                        } else {
                            Write-ShortcutRepairLog ("failed to save read-only shortcut: " + $shortcutFile.FullName)
                            throw ('shortcut is not writable: ' + $shortcutFile.FullName)
                        }
                        Send-ShellItemUpdatedNotification $shortcutFile.FullName
                        Send-ShellDirectoryUpdatedNotification ([IO.Path]::GetDirectoryName($shortcutFile.FullName))
                        continue
                    }
                    $wantedIconLocation = $normalizedIconPath + ',0'
                    $needsSave = $false
                    if (-not [string]::Equals([string]$shortcut.IconLocation, $wantedIconLocation, [StringComparison]::OrdinalIgnoreCase)) {
                        $shortcut.IconLocation = $wantedIconLocation
                        $needsSave = $true
                    }
                    if ($needsSave) {
                        # A matching shared Start Menu shortcut may be read-only for a
                        # standard user. Surface that failure so the caller cannot
                        # activate an icon while this entry still shows the old one.
                        if (Test-GoNaviShortcutWritable $shortcutFile.FullName) {
                            # The Start menu snapshots each shortcut's icon when it
                            # enumerates the folder and never re-reads an in-place
                            # IconLocation rewrite - not on UPDATEITEM, UPDATEDIR or
                            # ASSOCCHANGED (observed on Windows 11 26200: the all-apps
                            # entry kept the previous brand icon through every
                            # notification, while the same shortcut recreated by the
                            # MSI installer refreshed immediately). Replacing the file
                            # is what the installer does, so do the same: build the
                            # replacement next to the target and move it over. The
                            # replacement inherits the parent directory's ACEs, so a
                            # standard user replacing a machine shortcut keeps write
                            # access through CREATOR OWNER.
                            $replaced = $false
                            $replacementPath = ''
                            try {
                                $replacementPath = Join-Path $normalizedDirectory ($shortcutFile.BaseName + '-gonavi-update-' + [Guid]::NewGuid().ToString('N').Substring(0, 8) + '.lnk')
                                $replacement = $shell.CreateShortcut($replacementPath)
                                $replacement.TargetPath = $shortcut.TargetPath
                                $replacement.Arguments = $shortcut.Arguments
                                $replacement.WorkingDirectory = $shortcut.WorkingDirectory
                                $replacement.WindowStyle = $shortcut.WindowStyle
                                $replacement.Description = $shortcut.Description
                                $replacement.IconLocation = $wantedIconLocation
                                $replacement.Save()
                                Move-Item -LiteralPath $replacementPath -Destination $shortcutFile.FullName -Force
                                $replaced = $true
                            } catch {
                                if ($replacementPath -and (Test-Path -LiteralPath $replacementPath -PathType Leaf)) {
                                    [void](Remove-Item -LiteralPath $replacementPath -Force -ErrorAction SilentlyContinue)
                                }
                                Write-ShortcutRepairLog ("shortcut replacement failed, falling back to in-place save: " + $shortcutFile.FullName + ": " + $_.Exception.Message)
                            }
                            if (-not $replaced) {
                                # Standard users cannot create files in the common
                                # shortcuts' directories (the installer's per-file
                                # grant allows modifying the existing .lnk but the
                                # directories deny CreateFiles by design), so file
                                # replacement is impossible there and an in-place
                                # save can never refresh the Start menu snapshot.
                                # Migrate instead: delete the machine shortcut
                                # (Delete is part of the per-file Modify grant) and
                                # recreate the entry as a user-level shortcut,
                                # which is replaceable. The MSI recreates its
                                # machine shortcuts on the next repair or upgrade,
                                # and the migration repeats on the first switch
                                # after that.
                                $migrated = $false
                                try {
                                    Remove-Item -LiteralPath $shortcutFile.FullName -Force
                                    $migrated = $true
                                    Write-ShortcutRepairLog ("migrated machine shortcut to user scope: " + $shortcutFile.FullName)
                                    if (Test-SameFilePath $normalizedDirectory $commonDesktopDirectory) {
                                        $script:GoNaviMigratedCommonDesktop = $true
                                    }
                                } catch {
                                    Write-ShortcutRepairLog ("machine shortcut migration delete failed: " + $shortcutFile.FullName + ": " + $_.Exception.Message)
                                }
                                if (-not $migrated) {
                                    $shortcut.Save()
                                }
                            }
                            $updatedCount++
                        } else {
                            Write-ShortcutRepairLog ("failed to update read-only shortcut icon: " + $shortcutFile.FullName)
                            throw ('shortcut is not writable: ' + $shortcutFile.FullName)
                        }
                    }
                    # WScript.Shell.Save drops the AppUserModel property bag on every
                    # rewrite, and a replaced file starts without one. The installer
                    # declared System.AppUserModel.ID on these shortcuts, so restore
                    # the identity after the write; matching the target means the
                    # identity belongs to this application. A failure is logged and
                    # never fatal: the icon itself is already updated. A migrated
                    # (deleted) machine shortcut no longer exists, so the bag write
                    # and the per-item notification are skipped for it.
                    if (Test-Path -LiteralPath $shortcutFile.FullName -PathType Leaf) {
                        if (-not (Set-GoNaviShortcutRelaunchProperties -ShortcutPath $shortcutFile.FullName -TargetPath $shortcut.TargetPath -IconPath $normalizedIconPath -ApplicationUserModelID $ApplicationUserModelID)) {
                            Write-ShortcutRepairLog ("shortcut identity restore failed: " + $shortcutFile.FullName)
                        }
                        Send-ShellItemUpdatedNotification $shortcutFile.FullName
                    }
                    Send-ShellDirectoryUpdatedNotification ([IO.Path]::GetDirectoryName($shortcutFile.FullName))
                } catch {
                    # A single failure is logged, never fatal: one read-only system
                    # shortcut must not sink the writable ones with it.
                    $failureMessage = "brand icon update failed for " + $shortcutFile.FullName + ": " + $_.Exception.Message
                    Write-ShortcutRepairLog $failureMessage
                    [void]$failureMessages.Add($failureMessage)
                }
            }
        }
        Send-ShellItemUpdatedNotification $normalizedIconPath
        if ($script:GoNaviMigratedCommonDesktop) {
            # The installer's public-desktop shortcut was migrated (deleted);
            # keep the desktop entry alive as a user-level shortcut, which is
            # replaceable on every future brand switch. Skipped when the user
            # never had one (INSTALLDESKTOPSHORTCUT=0 leaves no machine
            # shortcut to migrate) or already created it.
            $userDesktopDirectory = [Environment]::GetFolderPath([Environment+SpecialFolder]::DesktopDirectory)
            $userDesktopPath = Join-Path $userDesktopDirectory 'GoNavi.lnk'
            if (-not (Test-Path -LiteralPath $userDesktopPath -PathType Leaf)) {
                try {
                    $desktopShortcut = $shell.CreateShortcut($userDesktopPath)
                    $desktopShortcut.TargetPath = $normalizedTargetPath
                    $desktopShortcut.WorkingDirectory = [IO.Path]::GetDirectoryName($normalizedTargetPath)
                    $desktopShortcut.IconLocation = $normalizedIconPath + ',0'
                    $desktopShortcut.Save()
                    if (-not (Set-GoNaviShortcutRelaunchProperties -ShortcutPath $userDesktopPath -TargetPath $normalizedTargetPath -IconPath $normalizedIconPath -ApplicationUserModelID $ApplicationUserModelID)) {
                        Write-ShortcutRepairLog ("user desktop shortcut identity failed: " + $userDesktopPath)
                    }
                    Send-ShellItemUpdatedNotification $userDesktopPath
                    Send-ShellDirectoryUpdatedNotification $userDesktopDirectory
                    Write-ShortcutRepairLog ("created user desktop shortcut after machine shortcut migration: " + $userDesktopPath)
                } catch {
                    Write-ShortcutRepairLog ("user desktop shortcut creation failed: " + $_.Exception.Message)
                }
            }
        }
        # SHCNE_ASSOCCHANGED is intentionally NOT sent: the global icon cache
        # flush makes Explorer redraw every icon on the desktop (a visible
        # flash on each brand switch), and since every shortcut is replaced as
        # a whole file the per-item and per-folder notifications above are
        # enough for the shell to re-read them (observed on Windows 11 26200).
        # Send-ShellAssociationChangedNotification stays available for a
        # surface that provably needs the global flush.
    } catch {
        Write-ShortcutRepairLog ("brand icon shortcut update failed: " + $_.Exception.Message)
        throw
    }
    # A single failure (e.g. a standard user cannot write a machine-level
    # shortcut) does not abort the batch: updated entries stay updated and
    # failures are reported via the script variable and the repair log.
    $script:GoNaviBrandFailureCount = $failureMessages.Count
    if ($failureMessages.Count -gt 0) {
        Write-ShortcutRepairLog ([string]::Join('; ', $failureMessages))
    }
    try {
        Ensure-GoNaviAumidShortcut -TargetPath $normalizedTargetPath -IconPath $normalizedIconPath | Out-Null
    } catch {
            # Creating the AUMID shortcut is an incremental improvement; a
            # failure is logged and never blocks the icon switch.
        Write-ShortcutRepairLog ("AUMID shortcut ensure failed: " + $_.Exception.Message)
    }
    return $updatedCount
}
