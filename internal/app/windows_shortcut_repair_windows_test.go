package app

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestWindowsShortcutRepairOnlyMigratesMissingMSIIconForCurrentTarget(t *testing.T) {
	powerShell, err := exec.LookPath("powershell.exe")
	if err != nil {
		t.Skip("powershell.exe is unavailable")
	}

	tempDir := t.TempDir()
	targetPath := filepath.Join(tempDir, "install", "GoNavi.exe")
	foreignTargetPath := filepath.Join(tempDir, "foreign", "GoNavi.exe")
	pinsDirectory := filepath.Join(tempDir, "pins")
	installerDirectory := filepath.Join(tempDir, "Windows", "Installer")
	desktopDirectory := filepath.Join(tempDir, "desktop")
	commonDesktopDirectory := filepath.Join(tempDir, "common-desktop")
	for _, directory := range []string{
		filepath.Dir(targetPath),
		filepath.Dir(foreignTargetPath),
		pinsDirectory,
		installerDirectory,
		desktopDirectory,
		commonDesktopDirectory,
	} {
		if err := os.MkdirAll(directory, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	for _, path := range []string{targetPath, foreignTargetPath} {
		if err := os.WriteFile(path, []byte("test"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	existingIconPath := filepath.Join(installerDirectory, "{22222222-2222-2222-2222-222222222222}", "GoNaviIcon")
	if err := os.MkdirAll(filepath.Dir(existingIconPath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(existingIconPath, []byte("icon"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(filepath.Dir(targetPath), ".gonavi-msi-install"), []byte("MSI"), 0o644); err != nil {
		t.Fatal(err)
	}

	harness := windowsShortcutRepairPowerShellScript + `
$ErrorActionPreference = 'Stop'
$shell = New-Object -ComObject WScript.Shell
$shellApplication = New-Object -ComObject Shell.Application

function New-TestShortcut {
    param(
        [string]$Path,
        [string]$TargetPath,
        [string]$IconLocation
    )

    $shortcut = $shell.CreateShortcut($Path)
    $shortcut.TargetPath = $TargetPath
    if (-not [string]::IsNullOrEmpty($IconLocation)) {
        $shortcut.IconLocation = $IconLocation
    }
    $shortcut.Save()
}

function Test-ShortcutIconLocation {
    param(
        [string]$IconLocation,
        [string]$ExpectedPath
    )

    $indexedIcon = [regex]::Match($IconLocation, '^(?<path>.+),\s*(?<index>-?\d+)$')
    if (-not $indexedIcon.Success -or $indexedIcon.Groups['index'].Value -ne '0') {
        return $false
    }
    return Test-SameFilePath $indexedIcon.Groups['path'].Value.Trim('"') $ExpectedPath
}

$target = $env:GONAVI_TEST_TARGET
$foreignTarget = $env:GONAVI_TEST_FOREIGN_TARGET
$pins = $env:GONAVI_TEST_PINS
$installer = $env:GONAVI_TEST_INSTALLER
$desktop = $env:GONAVI_TEST_DESKTOP
$commonDesktop = $env:GONAVI_TEST_COMMON_DESKTOP
$missingIcon = Join-Path $installer '{11111111-1111-1111-1111-111111111111}\GoNaviIcon'
$existingIcon = Join-Path $installer '{22222222-2222-2222-2222-222222222222}\GoNaviIcon'

New-TestShortcut (Join-Path $pins 'missing-icon.lnk') $target ($missingIcon + ',0')
New-TestShortcut (Join-Path $pins 'foreign-target.lnk') $foreignTarget ($missingIcon + ',0')
New-TestShortcut (Join-Path $pins 'existing-icon.lnk') $target ($existingIcon + ',0')
New-TestShortcut (Join-Path $pins 'blank-icon.lnk') $target ''
New-TestShortcut (Join-Path $pins 'other-missing-icon.lnk') $target ((Join-Path $installer '{33333333-3333-3333-3333-333333333333}\OtherIcon') + ',0')
$alternateGoNaviTarget = Join-Path $env:GONAVI_TEST_ROOT 'alternate-install\GoNavi.exe'
New-TestShortcut (Join-Path $pins 'GoNavi.lnk') $alternateGoNaviTarget ''
[void](Set-GoNaviShortcutRelaunchProperties -ShortcutPath (Join-Path $pins 'GoNavi.lnk') -TargetPath $alternateGoNaviTarget -IconPath $missingIcon)
$duplicateGoNaviTarget = Join-Path $env:GONAVI_TEST_ROOT 'alternate-install\GoNavi (2).exe'
New-TestShortcut (Join-Path $pins 'GoNavi (2).lnk') $duplicateGoNaviTarget ''
# A pin left behind by a previous rotated brand identity only ties back to
# GoNavi through its AppUserModel.ID, so MSI repair must recognize every
# identity in the Syngnat.GoNavi family.
New-TestShortcut (Join-Path $pins 'GoNavi-rotated.lnk') $alternateGoNaviTarget ''
[void](Set-GoNaviShortcutRelaunchProperties -ShortcutPath (Join-Path $pins 'GoNavi-rotated.lnk') -TargetPath $alternateGoNaviTarget -IconPath $missingIcon -ApplicationUserModelID 'Syngnat.GoNavi.Icon.deadbeefdeadbeefdeadbeef')
# 系统固定项回归防护：File Explorer 固定项（历史事故中被测试实例误认领）
# 永远不属于 GoNavi 的认领范围。
New-TestShortcut (Join-Path $pins 'File Explorer.lnk') "$env:windir\explorer.exe" ''
[void](Set-GoNaviShortcutRelaunchProperties -ShortcutPath (Join-Path $pins 'File Explorer.lnk') -TargetPath "$env:windir\explorer.exe" -IconPath $missingIcon -ApplicationUserModelID 'Microsoft.Windows.Explorer')
# 外部应用死固定项防护（审查实测复现的事故）：用户卸载其他应用后残留的
# 目标失效 pin，MSI 模式下也绝不能被认领改写为 GoNavi 启动器。
$steamDeadTarget = Join-Path $env:GONAVI_TEST_ROOT 'missing-foreign\Steam\steam.exe'
New-TestShortcut (Join-Path $pins 'Steam.lnk') $steamDeadTarget ''
$steamIconBefore = $shell.CreateShortcut((Join-Path $pins 'Steam.lnk')).IconLocation
$blankIconBefore = $shell.CreateShortcut((Join-Path $pins 'blank-icon.lnk')).IconLocation
$otherMissingIconBefore = $shell.CreateShortcut((Join-Path $pins 'other-missing-icon.lnk')).IconLocation

$repairCount = Repair-LegacyGoNaviTaskbarPins -TargetPath $target -PinsDirectory $pins -WindowsInstallerDirectory $installer
if ($repairCount -ne 1) {
    throw ('unexpected repair count: ' + $repairCount)
}

$missingShortcut = $shell.CreateShortcut((Join-Path $pins 'missing-icon.lnk'))
if (-not (Test-ShortcutIconLocation $missingShortcut.IconLocation $target)) {
    throw ('missing MSI icon was not migrated: ' + $missingShortcut.IconLocation)
}
$foreignShortcut = $shell.CreateShortcut((Join-Path $pins 'foreign-target.lnk'))
if (-not (Test-ShortcutIconLocation $foreignShortcut.IconLocation $missingIcon)) {
    throw ('foreign target was modified: ' + $foreignShortcut.IconLocation)
}
$existingShortcut = $shell.CreateShortcut((Join-Path $pins 'existing-icon.lnk'))
if (-not (Test-ShortcutIconLocation $existingShortcut.IconLocation $existingIcon)) {
    throw ('existing MSI icon was modified: ' + $existingShortcut.IconLocation)
}
$blankShortcut = $shell.CreateShortcut((Join-Path $pins 'blank-icon.lnk'))
if (-not [string]::Equals($blankShortcut.IconLocation, $blankIconBefore, [StringComparison]::OrdinalIgnoreCase)) {
    throw ('blank icon was modified: ' + $blankShortcut.IconLocation)
}
$otherMissingIconShortcut = $shell.CreateShortcut((Join-Path $pins 'other-missing-icon.lnk'))
if (-not [string]::Equals($otherMissingIconShortcut.IconLocation, $otherMissingIconBefore, [StringComparison]::OrdinalIgnoreCase)) {
    throw ('non-GoNavi MSI icon was modified: ' + $otherMissingIconShortcut.IconLocation)
}

$brandIcon = Join-Path $env:GONAVI_TEST_ROOT 'gonavi-brand-test.ico'
[IO.File]::WriteAllBytes($brandIcon, [byte[]](0, 0, 1, 0, 0, 0))
$brandUpdateCount = Set-GoNaviShortcutBrandIcon -TargetPath $target -IconPath $brandIcon -ShortcutDirectories @($pins) -TaskbarDirectory $pins
if ($brandUpdateCount -ne 7) {
    throw ('unexpected brand icon shortcut update count: ' + $brandUpdateCount)
}
foreach ($shortcutName in @('missing-icon.lnk', 'existing-icon.lnk', 'blank-icon.lnk', 'other-missing-icon.lnk')) {
    $updatedShortcut = $shell.CreateShortcut((Join-Path $pins $shortcutName))
    if (-not (Test-ShortcutIconLocation $updatedShortcut.IconLocation $brandIcon)) {
        throw ('brand icon was not applied to ' + $shortcutName + ': ' + $updatedShortcut.IconLocation)
    }
}
if (-not (Test-ShortcutIconLocation $shell.CreateShortcut((Join-Path $pins 'foreign-target.lnk')).IconLocation $missingIcon)) {
    throw 'brand icon update modified a foreign target shortcut'
}
# 外部应用死固定项（目标失效）也不得被劫持：目标与图标都必须原样保留。
$steamShortcut = $shell.CreateShortcut((Join-Path $pins 'Steam.lnk'))
if (-not (Test-SameFilePath $steamShortcut.TargetPath $steamDeadTarget)) {
    throw ('brand icon update hijacked a dead foreign pin target: ' + $steamShortcut.TargetPath)
}
if (-not [string]::Equals([string]$steamShortcut.IconLocation, $steamIconBefore, [StringComparison]::OrdinalIgnoreCase)) {
    throw ('brand icon update hijacked a dead foreign pin icon: ' + $steamShortcut.IconLocation)
}
$alternateShortcut = $shell.CreateShortcut((Join-Path $pins 'GoNavi.lnk'))
if (-not (Test-ShortcutIconLocation $alternateShortcut.IconLocation $brandIcon)) {
    throw ('brand icon was not applied to the alternate GoNavi pin: ' + $alternateShortcut.IconLocation)
}
if (-not (Test-SameFilePath $alternateShortcut.TargetPath $target)) {
    throw ('MSI GoNavi pin target was not repaired: ' + $alternateShortcut.TargetPath)
}
$alternateItem = $shellApplication.Namespace((Split-Path (Join-Path $pins 'GoNavi.lnk') -Parent)).ParseName('GoNavi.lnk')
if ($null -ne $alternateItem) {
	if (-not [string]::Equals([string]$alternateItem.ExtendedProperty('System.AppUserModel.ID'), 'Syngnat.GoNavi', [StringComparison]::OrdinalIgnoreCase)) {
		throw ('MSI GoNavi pin identity was not normalized: ' + $alternateItem.ExtendedProperty('System.AppUserModel.ID'))
	}
	$alternateRelaunchCommand = [string]$alternateItem.ExtendedProperty('System.AppUserModel.RelaunchCommand')
	if (-not [string]::Equals($alternateRelaunchCommand, ('"' + $target + '"'), [StringComparison]::OrdinalIgnoreCase)) {
		throw ('taskbar pin relaunch command did not target GoNavi.exe: ' + $alternateRelaunchCommand)
	}
	$alternateRelaunchIcon = [string]$alternateItem.ExtendedProperty('System.AppUserModel.RelaunchIconResource')
	# RelaunchIconResource 是纯路径（无 ",0" 后缀）——带后缀会让 Explorer 按
	# PE 资源索引提取 .ico 失败，按钮退化为空白文档图标。
	if (-not (Test-SameFilePath ($alternateRelaunchIcon -replace ',\d+$', '') $brandIcon)) {
		throw ('taskbar pin relaunch icon was not updated: ' + $alternateRelaunchIcon)
	}
}
$rotatedShortcut = $shell.CreateShortcut((Join-Path $pins 'GoNavi-rotated.lnk'))
if (-not (Test-ShortcutIconLocation $rotatedShortcut.IconLocation $brandIcon)) {
    throw ('brand icon was not applied to the rotated-identity pin: ' + $rotatedShortcut.IconLocation)
}
if (-not (Test-SameFilePath $rotatedShortcut.TargetPath $target)) {
    throw ('rotated-identity MSI pin target was not repaired: ' + $rotatedShortcut.TargetPath)
}
$rotatedItemBefore = $shellApplication.Namespace($pins).ParseName('GoNavi-rotated.lnk')
if ($null -ne $rotatedItemBefore) {
	if (-not [string]::Equals([string]$rotatedItemBefore.ExtendedProperty('System.AppUserModel.ID'), 'Syngnat.GoNavi', [StringComparison]::OrdinalIgnoreCase)) {
		throw ('rotated pin identity was not normalized: ' + $rotatedItemBefore.ExtendedProperty('System.AppUserModel.ID'))
	}
	if (-not [string]::Equals([string]$rotatedItemBefore.ExtendedProperty('System.AppUserModel.RelaunchCommand'), ('"' + $target + '"'), [StringComparison]::OrdinalIgnoreCase)) {
		throw ('rotated pin relaunch command did not target GoNavi.exe: ' + $rotatedItemBefore.ExtendedProperty('System.AppUserModel.RelaunchCommand'))
	}
}
$duplicateShortcut = $shell.CreateShortcut((Join-Path $pins 'GoNavi (2).lnk'))
if (-not (Test-SameFilePath $duplicateShortcut.TargetPath $target)) {
    throw ('numbered MSI GoNavi pin target was not repaired: ' + $duplicateShortcut.TargetPath)
}

# A later icon selection refreshes IconLocation only. It must not retarget
# the pin through AppUserModel.RelaunchCommand.
$refreshedIcon = Join-Path $env:GONAVI_TEST_ROOT 'gonavi-brand-0123456789abcdef01234567.ico'
[IO.File]::WriteAllBytes($refreshedIcon, [byte[]](0, 0, 1, 0, 0, 0))
$refreshedAumid = 'Syngnat.GoNavi.Icon.0123456789abcdef01234567'
$refreshedBrandCount = Set-GoNaviShortcutBrandIcon -TargetPath $target -IconPath $refreshedIcon -ApplicationUserModelID $refreshedAumid -ShortcutDirectories @($pins) -TaskbarDirectory $pins
if ($refreshedBrandCount -ne 7) {
    throw ('unexpected refreshed brand icon shortcut update count: ' + $refreshedBrandCount)
}
foreach ($shortcutName in @('missing-icon.lnk', 'existing-icon.lnk', 'blank-icon.lnk', 'other-missing-icon.lnk', 'GoNavi.lnk', 'GoNavi (2).lnk', 'GoNavi-rotated.lnk')) {
    $updatedShortcut = $shell.CreateShortcut((Join-Path $pins $shortcutName))
    if (-not (Test-ShortcutIconLocation $updatedShortcut.IconLocation $refreshedIcon)) {
        throw ('refreshed brand icon was not applied to ' + $shortcutName + ': ' + $updatedShortcut.IconLocation)
    }
}
if (-not (Test-ShortcutIconLocation $shell.CreateShortcut((Join-Path $pins 'foreign-target.lnk')).IconLocation $missingIcon)) {
    throw 'refreshed brand icon update modified a foreign target shortcut'
}
$refreshedItem = $shellApplication.Namespace($pins).ParseName('GoNavi-rotated.lnk')
if ($null -ne $refreshedItem -and ([string]$refreshedItem.ExtendedProperty('System.AppUserModel.RelaunchCommand')) -match '(?i)\.ico') {
    throw ('refreshed pin relaunch command was pointed at an icon: ' + $refreshedItem.ExtendedProperty('System.AppUserModel.RelaunchCommand'))
}
if (-not (Test-SameFilePath $shell.CreateShortcut((Join-Path $pins 'GoNavi-rotated.lnk')).TargetPath $target)) {
    throw 'refreshed pin target was cleared'
}

# Portable and development builds can refresh an installed pin's icon without
# redirecting the pin to the currently running executable.
$portableRoot = Join-Path $env:GONAVI_TEST_ROOT 'portable'
$portablePins = Join-Path $portableRoot 'pins'
$portableCurrentDir = Join-Path $portableRoot 'current'
$portableInstalledDir = Join-Path $portableRoot 'installed'
[void](New-Item -ItemType Directory -Path $portablePins, $portableCurrentDir, $portableInstalledDir -Force)
$portableTarget = Join-Path $portableCurrentDir 'GoNavi.exe'
$portableInstalledTarget = Join-Path $portableInstalledDir 'GoNavi.exe'
$portableIcon = Join-Path $portableRoot 'gonavi-brand-portable.ico'
[IO.File]::WriteAllBytes($portableTarget, [byte[]](1))
[IO.File]::WriteAllBytes($portableInstalledTarget, [byte[]](1))
[IO.File]::WriteAllBytes($portableIcon, [byte[]](0, 0, 1, 0, 0, 0))
$portableShortcutPath = Join-Path $portablePins 'GoNavi-history.lnk'
New-TestShortcut $portableShortcutPath $portableInstalledTarget ''
[void](Set-GoNaviShortcutRelaunchProperties -ShortcutPath $portableShortcutPath -TargetPath $portableInstalledTarget -IconPath $missingIcon -ApplicationUserModelID 'Syngnat.GoNavi.Icon.deadbeef')
$portableStablePath = Join-Path $portablePins 'GoNavi-stable.lnk'
New-TestShortcut $portableStablePath $portableTarget ''
[void](Set-GoNaviShortcutRelaunchProperties -ShortcutPath $portableStablePath -TargetPath $portableTarget -IconPath $missingIcon -ApplicationUserModelID 'Syngnat.GoNavi')
$portablePlainPath = Join-Path $portablePins 'GoNavi-plain.lnk'
New-TestShortcut $portablePlainPath $portableTarget ''
$portableUpdateCount = Set-GoNaviShortcutBrandIcon -TargetPath $portableTarget -IconPath $portableIcon -ApplicationUserModelID 'Syngnat.GoNavi.Icon.0123456789abcdef01234567' -ShortcutDirectories @($portablePins) -TaskbarDirectory $portablePins
if ($portableUpdateCount -ne 3) {
    throw ('unexpected portable shortcut update count: ' + $portableUpdateCount)
}
$portableShortcut = $shell.CreateShortcut($portableShortcutPath)
if (-not (Test-SameFilePath $portableShortcut.TargetPath $portableInstalledTarget)) {
    throw ('portable launch redirected an existing GoNavi pin: ' + $portableShortcut.TargetPath)
}
$portableItem = $shellApplication.Namespace($portablePins).ParseName('GoNavi-history.lnk')
if ($null -ne $portableItem) {
    $portableRelaunchCommand = [string]$portableItem.ExtendedProperty('System.AppUserModel.RelaunchCommand')
    if ($portableRelaunchCommand -match '(?i)\.ico') {
        throw ('portable relaunch command was pointed at an icon: ' + $portableRelaunchCommand)
    }
}
$portableStableShortcut = $shell.CreateShortcut($portableStablePath)
if (-not (Test-SameFilePath $portableStableShortcut.TargetPath $portableTarget)) {
    throw ('stable portable pin target changed: ' + $portableStableShortcut.TargetPath)
}
if (-not (Test-ShortcutIconLocation $portableStableShortcut.IconLocation $portableIcon)) {
    throw ('stable portable pin icon was not updated: ' + $portableStableShortcut.IconLocation)
}
$portableStableItem = $shellApplication.Namespace($portablePins).ParseName('GoNavi-stable.lnk')
if ($null -ne $portableStableItem) {
    $stableRelaunchCommand = [string]$portableStableItem.ExtendedProperty('System.AppUserModel.RelaunchCommand')
    if ($stableRelaunchCommand -match '(?i)\.ico') {
        throw ('stable portable relaunch command was pointed at an icon: ' + $stableRelaunchCommand)
    }
}
$portablePlainItem = $shellApplication.Namespace($portablePins).ParseName('GoNavi-plain.lnk')
if ($null -ne $portablePlainItem -and -not [string]::Equals([string]$portablePlainItem.ExtendedProperty('System.AppUserModel.ID'), 'Syngnat.GoNavi', [StringComparison]::OrdinalIgnoreCase)) {
    throw ('portable pin matching the current executable did not receive the stable identity: ' + $portablePlainItem.ExtendedProperty('System.AppUserModel.ID'))
}
$env:GONAVI_BRAND_MATCH_TARGET_ONLY = '1'
$portableMatchedIcon = Join-Path $portableRoot 'gonavi-brand-matched.ico'
[IO.File]::WriteAllBytes($portableMatchedIcon, [byte[]](0, 0, 1, 0, 0, 0))
# 模拟用户机器上另一安装（D:\tools 类）留下的固定项：目标他处、图标与本实例无关
$portableForeignPin = Join-Path $portablePins 'GoNavi-foreign-install.lnk'
New-TestShortcut $portableForeignPin $portableInstalledTarget ''
$matchedOnlyCount = Set-GoNaviShortcutBrandIcon -TargetPath $portableTarget -IconPath $portableMatchedIcon -ShortcutDirectories @($portablePins) -TaskbarDirectory $portablePins
if ($matchedOnlyCount -ne 3) {
	throw ('unexpected portable match-only update count: ' + $matchedOnlyCount)
}
$portableStableAfterMatchOnly = $shell.CreateShortcut($portableStablePath)
if (-not (Test-ShortcutIconLocation $portableStableAfterMatchOnly.IconLocation $portableMatchedIcon)) {
    throw ('match-only portable update skipped the current executable pin: ' + $portableStableAfterMatchOnly.IconLocation)
}
# 归属收窄：指向其他安装、且图标不属于本实例数据目录的固定项，Portable
# 不得改写（历史事故：测试实例曾把用户安装版的固定项图标改写进沙箱目录）。
$foreignPinAfterMatchOnly = $shell.CreateShortcut($portableForeignPin)
if (Test-ShortcutIconLocation $foreignPinAfterMatchOnly.IconLocation $portableMatchedIcon) {
    throw ('match-only portable update hijacked a foreign GoNavi pin: ' + $foreignPinAfterMatchOnly.IconLocation)
}
if (-not (Test-SameFilePath $foreignPinAfterMatchOnly.TargetPath $portableInstalledTarget)) {
    throw ('match-only portable update redirected a foreign pin target: ' + $foreignPinAfterMatchOnly.TargetPath)
}
$env:GONAVI_BRAND_MATCH_TARGET_ONLY = ''

# A pin whose target was replaced with a brand ICO must be pointed back at
# GoNavi.exe. Windows 11 otherwise reports that the pinned item is gone.
$brokenPin = Join-Path $pins 'GoNavi-missing.lnk'
New-TestShortcut $brokenPin (Join-Path $env:GONAVI_TEST_ROOT 'missing\gonavi-brand-old.ico') ''
[void](Set-GoNaviShortcutBrandIcon -TargetPath $target -IconPath $refreshedIcon -ShortcutDirectories @($pins) -TaskbarDirectory $pins)
$brokenShortcut = $shell.CreateShortcut($brokenPin)
if (-not (Test-SameFilePath $brokenShortcut.TargetPath $target)) {
    throw ('broken taskbar pin was not pointed back at GoNavi.exe: ' + $brokenShortcut.TargetPath)
}
if (-not (Test-ShortcutIconLocation $brokenShortcut.IconLocation $refreshedIcon)) {
    throw ('broken taskbar pin icon was not updated: ' + $brokenShortcut.IconLocation)
}

# Removing runtime icon selection migrates existing pins to the EXE resource.
[void](Set-GoNaviShortcutBrandIcon -TargetPath $target -IconPath $target -ShortcutDirectories @($pins) -TaskbarDirectory $pins)
foreach ($pinName in @('GoNavi-missing.lnk', 'missing-icon.lnk', 'existing-icon.lnk')) {
    $migrated = $shell.CreateShortcut((Join-Path $pins $pinName))
    if (-not (Test-SameFilePath $migrated.TargetPath $target)) { throw 'packaged icon migration changed launch target' }
    if (-not (Test-ShortcutIconLocation $migrated.IconLocation $target)) { throw 'packaged icon migration retained custom ICO' }
}
$foreignAfterMigration = $shell.CreateShortcut((Join-Path $pins 'foreign-target.lnk'))
if (-not (Test-ShortcutIconLocation $foreignAfterMigration.IconLocation $missingIcon)) { throw 'packaged icon migration changed foreign shortcut' }

$desktopDirectories = @($desktop, $commonDesktop)
$absentState = Save-GoNaviDesktopShortcutState -TargetPath $target -BackupDirectory (Join-Path $env:GONAVI_TEST_ROOT 'backup-absent') -DesktopDirectories $desktopDirectories
if (-not $absentState.Succeeded -or $absentState.InstallValue -ne '0' -or $absentState.Entries.Count -ne 0) {
    throw 'desktop shortcut should remain absent'
}
New-TestShortcut (Join-Path $desktop 'GoNavi.lnk') $foreignTarget ''
$foreignState = Save-GoNaviDesktopShortcutState -TargetPath $target -BackupDirectory (Join-Path $env:GONAVI_TEST_ROOT 'backup-foreign') -DesktopDirectories $desktopDirectories
if (-not $foreignState.Succeeded -or $foreignState.InstallValue -ne '0' -or $foreignState.Entries.Count -ne 1) {
    throw 'foreign desktop shortcut state was not captured'
}
New-TestShortcut (Join-Path $desktop 'GoNavi.lnk') $target ''
if (-not (Remove-GoNaviDesktopShortcutsForTarget -TargetPath $target -DesktopDirectories $desktopDirectories)) {
    throw 'simulated unexpected desktop shortcut could not be removed'
}
if (-not (Restore-GoNaviDesktopShortcutState -State $foreignState -OnlyForeign)) {
    throw 'foreign desktop shortcut restore reported failure'
}
$restoredForeignShortcut = $shell.CreateShortcut((Join-Path $desktop 'GoNavi.lnk'))
if (-not (Test-SameFilePath $restoredForeignShortcut.TargetPath $foreignTarget)) {
    throw 'foreign desktop shortcut was not restored after simulated MSI overwrite'
}
New-TestShortcut (Join-Path $commonDesktop 'GoNavi.lnk') $target ''
$matchingState = Save-GoNaviDesktopShortcutState -TargetPath $target -BackupDirectory (Join-Path $env:GONAVI_TEST_ROOT 'backup-matching') -DesktopDirectories $desktopDirectories
if (-not $matchingState.Succeeded -or $matchingState.InstallValue -ne '1' -or $matchingState.Entries.Count -ne 2) {
    throw 'matching desktop shortcut should be preserved'
}
Remove-Item -LiteralPath (Join-Path $commonDesktop 'GoNavi.lnk') -Force
if (-not (Restore-GoNaviDesktopShortcutState -State $matchingState)) {
    throw 'matching desktop shortcut restore reported failure'
}
$restoredMatchingShortcut = $shell.CreateShortcut((Join-Path $commonDesktop 'GoNavi.lnk'))
if (-not (Test-SameFilePath $restoredMatchingShortcut.TargetPath $target)) {
    throw 'matching desktop shortcut was not restored after simulated MSI failure'
}
`
	scriptPath := filepath.Join(tempDir, "shortcut-repair-test.ps1")
	if err := os.WriteFile(scriptPath, []byte(strings.ReplaceAll(harness, "\n", "\r\n")), 0o644); err != nil {
		t.Fatal(err)
	}

	command := exec.Command(powerShell, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "RemoteSigned", "-File", scriptPath)
	command.Env = append(os.Environ(),
		"GONAVI_TEST_TARGET="+targetPath,
		"GONAVI_TEST_FOREIGN_TARGET="+foreignTargetPath,
		"GONAVI_TEST_PINS="+pinsDirectory,
		"GONAVI_TEST_INSTALLER="+installerDirectory,
		"GONAVI_TEST_DESKTOP="+desktopDirectory,
		"GONAVI_TEST_COMMON_DESKTOP="+commonDesktopDirectory,
		"GONAVI_TEST_ROOT="+tempDir,
	)
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("shortcut repair integration failed: %v\n%s", err, output)
	}
}

// Shared Start Menu shortcuts under ProgramData may not be writable for a
// standard user. A partially applied batch must fail so the caller does not
// activate an icon while some shortcuts still refer to the previous one.
func TestWindowsShortcutBrandIconFailsOnUnwritableShortcut(t *testing.T) {
	powerShell, err := exec.LookPath("powershell.exe")
	if err != nil {
		t.Skip("powershell.exe is unavailable")
	}

	tempDir := t.TempDir()
	targetPath := filepath.Join(tempDir, "install", "GoNavi.exe")
	// shortcutsDirectory stands in for a ProgramData Start Menu location: plain
	// shortcuts that are not taskbar pins. taskbarDirectory stays separate so the
	// read-only entry exercises the non-taskbar branch.
	shortcutsDirectory := filepath.Join(tempDir, "shortcuts")
	taskbarDirectory := filepath.Join(tempDir, "taskbar")
	if err := os.MkdirAll(filepath.Dir(targetPath), 0o755); err != nil {
		t.Fatal(err)
	}
	for _, directory := range []string{shortcutsDirectory, taskbarDirectory} {
		if err := os.MkdirAll(directory, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(targetPath, []byte("test"), 0o644); err != nil {
		t.Fatal(err)
	}

	harness := windowsShortcutRepairPowerShellScript + `
$ErrorActionPreference = 'Stop'
$shell = New-Object -ComObject WScript.Shell

function New-TestShortcut {
    param([string]$Path, [string]$TargetPath)
    $shortcut = $shell.CreateShortcut($Path)
    $shortcut.TargetPath = $TargetPath
    $shortcut.IconLocation = ',0'
    $shortcut.Save()
}

# Access-control work uses the .NET file APIs rather than Get-Acl/Set-Acl.
# Importing Microsoft.PowerShell.Security inside a non-interactive child process
# can fail on TypeData already being registered (AuditToString/AccessToString),
# and that has nothing to do with what this test verifies.
$currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name

# Capture the repair log so the read-only skip stays observable. Reading the
# shortcut back is not an option after the deny rule: COM resolves an entry the
# user cannot write to an empty shell, so a log assertion is the reliable evidence
# that the read-only branch ran instead of failing the batch.
$script:GoNaviRepairLog = [Collections.Generic.List[string]]::new()
function Write-UpdateLog { param([string]$Message) [void]$script:GoNaviRepairLog.Add([string]$Message) }

$target = $env:GONAVI_TEST_TARGET
$shortcuts = $env:GONAVI_TEST_SHORTCUTS
$taskbar = $env:GONAVI_TEST_TASKBAR
$writableShortcut = Join-Path $shortcuts 'GoNavi.lnk'
$readonlyShortcut = Join-Path $shortcuts 'GoNavi-readonly.lnk'
New-TestShortcut $writableShortcut $target
New-TestShortcut $readonlyShortcut $target

# The read-only entry carries a stale icon location so the script genuinely tries
# to save it. Without a difference the icon already matches, the save branch never
# runs, and the read-only skip path would stay untested.
$readonlyStaleIcon = 'C:\stale-GoNavi-icon.ico,0'
$staleShortcut = $shell.CreateShortcut($readonlyShortcut)
$staleShortcut.IconLocation = $readonlyStaleIcon
$staleShortcut.Save()
$staleReadBack = [string]($shell.CreateShortcut($readonlyShortcut)).IconLocation
if (-not [string]::Equals($staleReadBack, $readonlyStaleIcon, [StringComparison]::OrdinalIgnoreCase)) {
    throw ('stale icon was not persisted before the deny rule: ' + $staleReadBack)
}

# Deny writes for the current user so WScript.Shell.Save fails like it does for
# a ProgramData Start Menu shortcut owned by the installer. The read-only entry
# lives outside the taskbar directory on purpose.
#
# Only WriteData is denied. Denying the broader Write/Modify set would also block
# reading the shortcut, and COM would then resolve it to an empty shell whose empty
# target no longer matches, skipping the entry before the save branch is reached.
$readonlyAcl = [IO.File]::GetAccessControl($readonlyShortcut)
$deny = New-Object System.Security.AccessControl.FileSystemAccessRule(
    $currentUser,
    'WriteData',
    'Deny')
$readonlyAcl.AddAccessRule($deny)
[IO.File]::SetAccessControl($readonlyShortcut, $readonlyAcl)

$denyCount = @([IO.File]::GetAccessControl($readonlyShortcut).Access | Where-Object { $_.AccessControlType -eq 'Deny' }).Count
if ($denyCount -lt 1) {
    throw 'deny rule was not applied to the read-only shortcut'
}
if (Test-GoNaviShortcutWritable $readonlyShortcut) {
    throw 'read-only shortcut was still reported writable'
}
if (-not (Test-GoNaviShortcutWritable $writableShortcut)) {
    throw 'writable shortcut was reported read-only'
}

# Only an explicit permission denial may be treated as read-only. A shortcut that
# is merely locked by another process must surface its error instead of being
# skipped, otherwise the caller records the update as done and never retries.
$probeLock = [IO.File]::Open($writableShortcut, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
$lockThrew = $false
try {
    [void](Test-GoNaviShortcutWritable $writableShortcut)
} catch {
    $lockThrew = $true
}
$probeLock.Close()
if (-not $lockThrew) {
    throw 'a locked shortcut was treated as read-only instead of failing the batch'
}

$brandIcon = Join-Path $env:GONAVI_TEST_ROOT 'gonavi-brand-abcdefabcdefabcdefabcdef.ico'
[IO.File]::WriteAllBytes($brandIcon, [byte[]](0, 0, 1, 0, 0, 0))

# 部分成功语义：只读快捷方式（标准用户写机器级快捷方式被拒的常态）跳过
# 并记录，可写的照常更新——不能让一个只读项拖垮整批（否则 MSI 标准用户
# 场景下所有表面都无法更新）。失败计数必须暴露给调用方。
$script:GoNaviBrandFailureCount = 0
$updatedCount2 = Set-GoNaviShortcutBrandIcon -TargetPath $target -IconPath $brandIcon -ShortcutDirectories @($shortcuts) -TaskbarDirectory $taskbar
if ($updatedCount2 -lt 1) {
    throw ('read-only shortcut suppressed all writable shortcut updates: ' + $updatedCount2)
}
if ([int]$script:GoNaviBrandFailureCount -lt 1) {
    throw 'read-only shortcut failure was not counted for the caller'
}
$updatedShortcut = $shell.CreateShortcut($writableShortcut)
if (-not [string]::Equals([string]$updatedShortcut.IconLocation, ($brandIcon + ',0'), [StringComparison]::OrdinalIgnoreCase)) {
    throw ('writable shortcut icon was not applied: ' + $updatedShortcut.IconLocation)
}
$failureLog = @($script:GoNaviRepairLog | Where-Object { $_ -like '*shortcut is not writable*' })
if ($failureLog.Count -lt 1) {
    throw ('the read-only shortcut failure was not logged: ' + [string]::Join(' | ', $script:GoNaviRepairLog))
}
if (-not ($failureLog[0] -like ('*' + $readonlyShortcut + '*'))) {
    throw ('the failure log did not name the read-only shortcut: ' + $failureLog[0])
}`
	scriptPath := filepath.Join(tempDir, "brand-icon-readonly-test.ps1")
	if err := os.WriteFile(scriptPath, []byte(strings.ReplaceAll(harness, "\n", "\r\n")), 0o644); err != nil {
		t.Fatal(err)
	}

	command := exec.Command(powerShell, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "RemoteSigned", "-File", scriptPath)
	command.Env = append(os.Environ(),
		"GONAVI_TEST_TARGET="+targetPath,
		"GONAVI_TEST_SHORTCUTS="+shortcutsDirectory,
		"GONAVI_TEST_TASKBAR="+taskbarDirectory,
		"GONAVI_TEST_ROOT="+tempDir,
	)
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("read-only shortcut brand icon batch did not fail as expected: %v\n%s", err, output)
	}
}

func TestWindowsShortcutRepairCreatesUserLevelAumidShortcutBesideMachineShortcut(t *testing.T) {
	powerShell, err := exec.LookPath("powershell.exe")
	if err != nil {
		t.Skip("powershell.exe is unavailable")
	}

	tempDir := t.TempDir()
	targetPath := filepath.Join(tempDir, "install", "GoNavi.exe")
	if err := os.MkdirAll(filepath.Dir(targetPath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(targetPath, []byte("test"), 0o644); err != nil {
		t.Fatal(err)
	}
	brandIcon := filepath.Join(tempDir, "gonavi-brand-b00b00b00b00b00b00b00b00.ico")
	if err := os.WriteFile(brandIcon, []byte("icon"), 0o644); err != nil {
		t.Fatal(err)
	}

	harness := windowsShortcutRepairPowerShellScript + `
$ErrorActionPreference = 'Stop'
$shell = New-Object -ComObject WScript.Shell

$target = $env:GONAVI_TEST_TARGET
$brandIcon = $env:GONAVI_TEST_ICON
$userPrograms = Join-Path $env:GONAVI_TEST_ROOT 'aumid-shortcut-programs'
$machinePrograms = Join-Path $env:GONAVI_TEST_ROOT 'aumid-shortcut-common-programs'
[void](New-Item -ItemType Directory -Path $machinePrograms -Force)
$machineShortcut = Join-Path $machinePrograms 'GoNavi.lnk'

# Machine-level shortcut declaring the AUMID: on real MSI installs this lives
# in CommonPrograms and is read-only for a standard user, so the AUMID ensure
# must not treat it as "already satisfied" - Explorer anchors the taskbar
# button to its IconLocation and brand switches would freeze on a stale icon.
$machine = $shell.CreateShortcut($machineShortcut)
$machine.TargetPath = $target
$machine.Save()
[void](Set-GoNaviShortcutRelaunchProperties -ShortcutPath $machineShortcut -TargetPath $target -IconPath $brandIcon)

$created = Ensure-GoNaviAumidShortcut -TargetPath $target -IconPath $brandIcon
if ($created -ne $true) {
    throw 'user-level AUMID shortcut was not created beside the machine shortcut'
}
$userShortcut = Join-Path $userPrograms 'GoNavi.lnk'
if (-not (Test-Path -LiteralPath $userShortcut -PathType Leaf)) {
    throw ('user-level AUMID shortcut is missing: ' + $userShortcut)
}
$readBack = $shell.CreateShortcut($userShortcut)
if (-not [string]::Equals([string]$readBack.TargetPath, $target, [StringComparison]::OrdinalIgnoreCase)) {
    throw ('user-level AUMID shortcut has the wrong target: ' + $readBack.TargetPath)
}
if (-not [string]::Equals([string]$readBack.IconLocation, ($brandIcon + ',0'), [StringComparison]::OrdinalIgnoreCase)) {
    throw ('user-level AUMID shortcut has the wrong icon: ' + $readBack.IconLocation)
}
$namespace = (New-Object -ComObject Shell.Application).Namespace($userPrograms)
$userAumid = [string]$namespace.ParseName('GoNavi.lnk').ExtendedProperty('System.AppUserModel.ID')
if ($userAumid -ne 'Syngnat.GoNavi') {
    throw ('user-level AUMID shortcut does not declare the AUMID: ' + $userAumid)
}
$machineReadBack = $shell.CreateShortcut($machineShortcut)
if (-not [string]::Equals([string]$machineReadBack.IconLocation, ',0', [StringComparison]::OrdinalIgnoreCase)) {
    throw ('machine shortcut was modified: ' + $machineReadBack.IconLocation)
}
$second = Ensure-GoNaviAumidShortcut -TargetPath $target -IconPath $brandIcon
if ($second -ne $false) {
    throw 'second AUMID ensure call did not skip when the user-level shortcut exists'
}`
	scriptPath := filepath.Join(tempDir, "aumid-user-level-test.ps1")
	if err := os.WriteFile(scriptPath, []byte(strings.ReplaceAll(harness, "\n", "\r\n")), 0o644); err != nil {
		t.Fatal(err)
	}

	command := exec.Command(powerShell, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "RemoteSigned", "-File", scriptPath)
	command.Env = append(os.Environ(),
		"GONAVI_TEST_TARGET="+targetPath,
		"GONAVI_TEST_ICON="+brandIcon,
		"GONAVI_TEST_ROOT="+tempDir,
	)
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("user-level AUMID shortcut was not created beside the machine shortcut: %v\n%s", err, output)
	}
}

// 启动期迁移模式（GONAVI_BRAND_MIGRATE_ONLY=1）把机器层 GoNavi 快捷方式按
// 字节移动到用户层：外观与 AppUserModel 属性包必须原样保留，外来目标与
// 被用户层同名条目遮蔽的场景各有明确行为。同时覆盖审查发现的 SFX 死链
// 防护：Ensure 必须跳过位于临时目录的可执行文件。
func TestWindowsMachineShortcutMigrationMovesEntriesToUserScope(t *testing.T) {
	powerShell, err := exec.LookPath("powershell.exe")
	if err != nil {
		t.Skip("powershell.exe is unavailable")
	}

	tempDir := t.TempDir()
	targetPath := filepath.Join(tempDir, "install", "GoNavi.exe")
	foreignTargetPath := filepath.Join(tempDir, "foreign", "GoNavi.exe")
	commonPrograms := filepath.Join(tempDir, "common-programs")
	userPrograms := filepath.Join(tempDir, "user-programs")
	commonDesktop := filepath.Join(tempDir, "common-desktop")
	userDesktop := filepath.Join(tempDir, "user-desktop")
	for _, directory := range []string{
		filepath.Dir(targetPath),
		filepath.Dir(foreignTargetPath),
		commonPrograms,
		userPrograms,
		commonDesktop,
		userDesktop,
	} {
		if err := os.MkdirAll(directory, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(targetPath, []byte("test"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(foreignTargetPath, []byte("test"), 0o644); err != nil {
		t.Fatal(err)
	}
	installerIcon := filepath.Join(tempDir, "installer", "GoNaviIcon.ico")
	if err := os.MkdirAll(filepath.Dir(installerIcon), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(installerIcon, []byte("icon"), 0o644); err != nil {
		t.Fatal(err)
	}

	harness := windowsShortcutRepairPowerShellScript + `
$ErrorActionPreference = 'Stop'
$shell = New-Object -ComObject WScript.Shell
$shellApplication = New-Object -ComObject Shell.Application

function New-TestShortcut {
    param([string]$Path, [string]$TargetPath, [string]$IconLocation)
    $shortcut = $shell.CreateShortcut($Path)
    $shortcut.TargetPath = $TargetPath
    if (-not [string]::IsNullOrEmpty($IconLocation)) { $shortcut.IconLocation = $IconLocation }
    $shortcut.Save()
}

$machineShortcut = Join-Path $env:GONAVI_TEST_COMMON_PROGRAMS 'GoNavi.lnk'
New-TestShortcut $machineShortcut $env:GONAVI_TEST_TARGET ($env:GONAVI_TEST_INSTALLER_ICON + ',0')
[void](Set-GoNaviShortcutRelaunchProperties -ShortcutPath $machineShortcut -TargetPath $env:GONAVI_TEST_TARGET -IconPath $env:GONAVI_TEST_INSTALLER_ICON -ApplicationUserModelID 'Syngnat.GoNavi')
$variantShortcut = Join-Path $env:GONAVI_TEST_COMMON_PROGRAMS 'GoNavi (2).lnk'
New-TestShortcut $variantShortcut $env:GONAVI_TEST_TARGET ''
$foreignNamedShortcut = Join-Path $env:GONAVI_TEST_COMMON_PROGRAMS 'GoNaviElsewhere.lnk'
New-TestShortcut $foreignNamedShortcut $env:GONAVI_TEST_FOREIGN_TARGET ''
$shadowedShortcut = Join-Path $env:GONAVI_TEST_COMMON_DESKTOP 'GoNavi.lnk'
New-TestShortcut $shadowedShortcut $env:GONAVI_TEST_TARGET ''
New-TestShortcut (Join-Path $env:GONAVI_TEST_USER_DESKTOP 'GoNavi.lnk') $env:GONAVI_TEST_TARGET ''

$migrated = Set-GoNaviMachineShortcutMigration -TargetPath $env:GONAVI_TEST_TARGET -CommonDesktopDirectory $env:GONAVI_TEST_COMMON_DESKTOP -CommonProgramsDirectory $env:GONAVI_TEST_COMMON_PROGRAMS -UserDesktopDirectory $env:GONAVI_TEST_USER_DESKTOP -UserProgramsDirectory $env:GONAVI_TEST_USER_PROGRAMS
if ($migrated -ne 3) { throw ('unexpected migration count: ' + $migrated) }

if (Test-Path -LiteralPath $machineShortcut -PathType Leaf) { throw 'machine start menu shortcut was not moved' }
$movedPath = Join-Path $env:GONAVI_TEST_USER_PROGRAMS 'GoNavi.lnk'
$moved = $shell.CreateShortcut($movedPath)
if (-not (Test-SameFilePath $moved.TargetPath $env:GONAVI_TEST_TARGET)) { throw 'moved shortcut lost its target' }
if ($moved.IconLocation -notlike ($env:GONAVI_TEST_INSTALLER_ICON + '*')) { throw ('moved shortcut lost its installer icon: ' + $moved.IconLocation) }
$movedItem = $shellApplication.Namespace((Split-Path -Parent $movedPath)).ParseName('GoNavi.lnk')
if ($null -eq $movedItem) {
    throw 'moved shortcut is not visible to the shell'
}
if (-not [string]::Equals([string]$movedItem.ExtendedProperty('System.AppUserModel.ID'), 'Syngnat.GoNavi', [StringComparison]::OrdinalIgnoreCase)) {
    throw ('moved shortcut lost its AUMID property bag: ' + $movedItem.ExtendedProperty('System.AppUserModel.ID'))
}

if (Test-Path -LiteralPath $variantShortcut -PathType Leaf) { throw 'variant machine shortcut was not moved' }
if (-not (Test-Path -LiteralPath (Join-Path $env:GONAVI_TEST_USER_PROGRAMS 'GoNavi (2).lnk') -PathType Leaf)) { throw 'variant shortcut did not arrive in user scope' }

if (-not (Test-Path -LiteralPath $foreignNamedShortcut -PathType Leaf)) { throw 'foreign-targeted GoNavi-named shortcut must stay untouched' }

if (Test-Path -LiteralPath $shadowedShortcut -PathType Leaf) { throw 'shadowed machine shortcut was not removed' }
$keptUserDesktop = $shell.CreateShortcut((Join-Path $env:GONAVI_TEST_USER_DESKTOP 'GoNavi.lnk'))
if (-not (Test-SameFilePath $keptUserDesktop.TargetPath $env:GONAVI_TEST_TARGET)) { throw 'existing user desktop shortcut was modified' }

# SFX 死链防护：Go 侧检测到 exe 位于临时目录时会设置禁用标记，Ensure
# 必须拒绝创建开始菜单快捷方式（SFX 退出即清理临时目录，创建即死链且
# 永不自愈）。
$env:GONAVI_BRAND_ENSURE_SHORTCUTS_DISABLED = '1'
if (Ensure-GoNaviAumidShortcut -TargetPath $env:GONAVI_TEST_TARGET -IconPath $env:GONAVI_TEST_TARGET) {
    throw 'Ensure must skip when shortcut creation is disabled for temporary executables'
}
`
	scriptPath := filepath.Join(tempDir, "machine-migration-test.ps1")
	if err := os.WriteFile(scriptPath, []byte(strings.ReplaceAll(harness, "\n", "\r\n")), 0o644); err != nil {
		t.Fatal(err)
	}

	command := exec.Command(powerShell, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "RemoteSigned", "-File", scriptPath)
	command.Env = append(os.Environ(),
		"GONAVI_TEST_TARGET="+targetPath,
		"GONAVI_TEST_FOREIGN_TARGET="+foreignTargetPath,
		"GONAVI_TEST_COMMON_PROGRAMS="+commonPrograms,
		"GONAVI_TEST_USER_PROGRAMS="+userPrograms,
		"GONAVI_TEST_COMMON_DESKTOP="+commonDesktop,
		"GONAVI_TEST_USER_DESKTOP="+userDesktop,
		"GONAVI_TEST_INSTALLER_ICON="+installerIcon,
		"GONAVI_TEST_ROOT="+tempDir,
	)
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("machine shortcut migration integration failed: %v\n%s", err, output)
	}
}

// 「所有应用」列表的图标快照只在其宿主进程启动时重建（三项 shell 通知
// 全部无效，用户实测确认），因此切换收尾必须在 UPDATED>0 时重启
// StartMenuExperienceHost；迁移分发同样如此。静态断言防止该调用被误删。
func TestWindowsShortcutScriptRestartsStartMenuHostForAllAppsList(t *testing.T) {
	if !strings.Contains(windowsShortcutRepairPowerShellScript, "function Restart-GoNaviStartMenuHost") {
		t.Fatal("repair script must define Restart-GoNaviStartMenuHost for the all-apps list refresh")
	}
	if !strings.Contains(windowsShortcutRepairPowerShellScript, "Stop-Process -InputObject $startMenuHost -Force") {
		t.Fatal("Restart-GoNaviStartMenuHost must stop the StartMenuExperienceHost process")
	}
	for _, marker := range []string{
		"Restart-GoNaviStartMenuHost",
		"$updated -gt 0",
		"GONAVI_BRAND_RESTART_STARTMENU",
	} {
		if !strings.Contains(windowsShortcutUpdateEpilogue, marker) {
			t.Fatalf("brand update epilogue must restart the Start menu host on update (missing %q)", marker)
		}
	}
	if !strings.Contains(windowsShortcutRepairPowerShellScript, "if ($migrated -gt 0 -and $env:GONAVI_BRAND_RESTART_STARTMENU -ne '0')") {
		t.Fatal("migration mode must restart the Start menu host after moving machine shortcuts")
	}
	// 函数定义 + 迁移分发调用：嵌入脚本中至少出现两次。
	if got := strings.Count(windowsShortcutRepairPowerShellScript, "Restart-GoNaviStartMenuHost"); got < 2 {
		t.Fatalf("Restart-GoNaviStartMenuHost references = %d, want >= 2 (definition + migration dispatch)", got)
	}
}
