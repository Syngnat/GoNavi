#!/usr/bin/env python3
import unittest
import xml.etree.ElementTree as ET
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
WORKFLOWS = (
    ROOT / ".github" / "workflows" / "release.yml",
    ROOT / ".github" / "workflows" / "dev-build.yml",
)
PUBLISH_WORKFLOW = ROOT / ".github" / "workflows" / "publish-release.yml"
INSTALLER = ROOT / "build" / "windows" / "installer.wxs"
LOCAL_RELEASE_SCRIPT = ROOT / "build-release.sh"
WIX_NAMESPACE = "http://wixtoolset.org/schemas/v4/wxs"
UPGRADE_CODE = "CDD6BF2F-ED1E-4345-A0AB-DCDB7E15FB23"
AMD64_COMPONENT_GUID = "0BCEE70B-9CF2-449C-9ADE-190188493234"
ARM64_COMPONENT_GUID = "7F4C7757-329F-42B0-B312-D4B8AD50415E"
AMD64_DESKTOP_SHORTCUT_COMPONENT_GUID = "114030DD-DB5F-460A-9CAC-997680E9F938"
ARM64_DESKTOP_SHORTCUT_COMPONENT_GUID = "3CF7DCD2-2658-432D-8677-AB6BB34A9659"


class WindowsReleaseArtifactsTest(unittest.TestCase):
    def test_release_workflows_publish_portable_and_msi_assets(self) -> None:
        for workflow in WORKFLOWS:
            with self.subTest(workflow=workflow.name):
                source = workflow.read_text(encoding="utf-8")
                windows_packaging = source.split("# Windows Packaging", 1)[1].split("# Linux Packaging", 1)[0]
                self.assertIn("Package Windows Portable ZIP, bridge EXE, and MSI", source)
                self.assertIn("-Portable.exe", source)
                self.assertIn("-Portable.zip", source)
                self.assertIn("-Installer.msi", source)
                self.assertIn("GoNavi-*.zip", source)
                self.assertIn("GoNavi-*.msi", source)
                self.assertIn('$portableApp = Join-Path $portableDir "GoNavi.exe"', source)
                self.assertIn('$portableLicense = Join-Path $portableDir "LICENSE"', source)
                self.assertIn('$portableNotice = Join-Path $portableDir "NOTICE"', source)
                self.assertIn(
                    "Compress-Archive -LiteralPath $portableFiles -DestinationPath $portableZipPath -CompressionLevel Optimal -Force",
                    source,
                )
                self.assertIn("dotnet tool install wix --tool-path $wixTools --version $wixVersion", source)
                self.assertIn('WixToolset.UI.wixext/$wixVersion', source)
                self.assertIn('WixToolset.UI.wixext/6.0.2', source)
                self.assertIn("-arch $wixArch", source)
                self.assertIn("TestExpectedAssetNameForWindowsInstallMode", source)
                self.assertIn("TestBuildWindowsLaunchCommandUsesHiddenPowerShellFile", source)
                self.assertIn("TestPortableUpdatePackageAcceptsZipAndLegacyExe", source)
                self.assertIn("TestResolveReusableStagedUpdateForPlatformReusesPortableZipInsideStagedDir", source)
                self.assertIn("TestResolveWindowsUpdateFinalTargetPathMapsDownloadedPortableZipToExe", source)
                self.assertIn("TestInstallUpdateAndRestartMSI", source)
                self.assertIn("TestShouldEnableWindowsMSISingleInstanceOnlyForInstalledMainGUI", source)
                self.assertIn("TestAcquireWindowsMSISingleInstance", source)
                self.assertIn("TestAcquireWindowsUpdateMaintenance", source)
                self.assertIn("TestPrepareWindowsUpdateHandoff", source)
                self.assertIn("TestWindowsUpdateRequiresExplicitCloseConfirmation", source)
                self.assertIn("TestInstallUpdateAndRestartRequiresCloseConfirmationOnWindows", source)
                self.assertIn("TestInstallUpdateAndRestartSkipsCloseConfirmationForSingleWindowsInstance", source)
                self.assertIn("TestFindOtherWindowsUpdateInstances", source)
                self.assertIn("TestCloseWindowsUpdateInstances", source)
                self.assertIn("TestInstallUpdateAndRestartClosesOtherTargetInstances", source)
                self.assertIn("TestBuildWindowsMSIUpdatePowerShellScript", source)
                self.assertIn('-d "ProductName=GoNavi"', source)
                self.assertIn(f'-d "UpgradeCode={UPGRADE_CODE}"', source)
                self.assertIn('-d "InstallFolderName=GoNavi"', source)
                self.assertIn('-d "RegistryKeyName=GoNavi"', source)
                self.assertIn(f'"{AMD64_COMPONENT_GUID}"', source)
                self.assertIn(f'"{ARM64_COMPONENT_GUID}"', source)
                self.assertIn(f'"{AMD64_DESKTOP_SHORTCUT_COMPONENT_GUID}"', source)
                self.assertIn(f'"{ARM64_DESKTOP_SHORTCUT_COMPONENT_GUID}"', source)
                self.assertIn(
                    f'$desktopShortcutComponentGuid = if ($archName -eq "Arm64") {{\n'
                    f'              "{ARM64_DESKTOP_SHORTCUT_COMPONENT_GUID}"\n'
                    f'          }} else {{\n'
                    f'              "{AMD64_DESKTOP_SHORTCUT_COMPONENT_GUID}"',
                    source,
                )
                self.assertIn('-d "DesktopShortcutComponentGuid=$desktopShortcutComponentGuid"', source)
                self.assertIn('$installMarkerPath = Join-Path $env:RUNNER_TEMP ".gonavi-msi-install"', source)
                self.assertIn('-d "InstallMarker=$installMarkerPath"', source)
                self.assertIn('$licenseFile = (Resolve-Path -LiteralPath "..\\\\..\\\\LICENSE").Path', source)
                self.assertIn('$noticeFile = (Resolve-Path -LiteralPath "..\\\\..\\\\NOTICE").Path', source)
                self.assertIn('-d "LicenseFile=$licenseFile"', source)
                self.assertIn('-d "NoticeFile=$noticeFile"', source)
                self.assertIn("wails build -s -skipbindings -trimpath", source)
                self.assertNotIn("Install UPX (Windows)", source)
                self.assertNotIn("upx", windows_packaging.lower())
                self.assertNotIn('-d "ProductName=GoNavi Dev"', source)
                self.assertNotIn('-d "InstallFolderName=GoNavi Dev"', source)
                self.assertNotIn('-d "RegistryKeyName=GoNavi Dev"', source)
                self.assertNotIn("DA3DACF2-1E4B-428C-8E6F-A37D3A05CAF7", source)
                self.assertNotIn(
                    '$finalExeName = "GoNavi-$version-${{ matrix.os_name }}-${{ matrix.arch_name }}${{ matrix.artifact_suffix }}.exe"',
                    source,
                )

        dev_source = WORKFLOWS[1].read_text(encoding="utf-8")
        self.assertIn('$productVersion = "255.0.$runNumber"', dev_source)
        self.assertNotIn('$productVersion = "0.0.$runNumber"', dev_source)

        publish_source = PUBLISH_WORKFLOW.read_text(encoding="utf-8")
        for arch in ("Amd64", "Arm64"):
            self.assertIn(f"GoNavi-${{version}}-Windows-{arch}-Portable.exe", publish_source)
            self.assertIn(f"GoNavi-${{version}}-Windows-{arch}-Portable.zip", publish_source)

    def test_sfx_failure_degrades_to_warning(self) -> None:
        # SFX 便携版要联网下载官方 LZMA SDK，偶发 DNS 解析失败。
        # 它是附加产物，失败必须降级为警告，否则同一次的 ZIP 与 MSI 一起挂掉。
        for workflow in WORKFLOWS:
            with self.subTest(workflow=workflow.name):
                source = workflow.read_text(encoding="utf-8")
                self.assertIn("$sfxOk = $false", source)
                self.assertIn("SFX 便携版已跳过", source)
                self.assertIn("ZIP 与 MSI 继续构建", source)
                # 降级后不能再有「SFX 生成失败就 throw」的硬失败路径。
                self.assertNotIn('throw "SFX 便携版 EXE 生成失败', source)

    def test_portable_sfx_downloads_retry_across_mirrors(self) -> None:
        # 单次 Invoke-WebRequest 失败会让整个 Windows 打包挂掉；
        # 官方 www 与裸域是两条独立 DNS 记录，需要重试与回退。
        source = (ROOT / "tools" / "make-portable-sfx.ps1").read_text(encoding="utf-8")
        self.assertIn("function Invoke-DownloadWithRetry", source)
        self.assertIn("https://www.7-zip.org/a", source)
        self.assertIn("https://7-zip.org/a", source)
        self.assertIn("Invoke-DownloadWithRetry -RelativePath \"7zr.exe\"", source)
        self.assertIn("Invoke-DownloadWithRetry -RelativePath \"lzma", source)
        # 两处下载都必须走带重试的封装，不能再裸调 Invoke-WebRequest。
        self.assertEqual(source.count("Invoke-WebRequest -Uri"), 1)

    def test_portable_sfx_runs_root_gonavi_exe(self) -> None:
        source = (ROOT / "tools" / "make-portable-sfx.ps1").read_text(encoding="utf-8")
        self.assertIn('RunProgram="GoNavi.exe"', source)
        self.assertIn('Copy-Item -LiteralPath $SourceExe -Destination (Join-Path $stageDir "GoNavi.exe") -Force', source)
        self.assertIn("$archivePath = New-PortableArchive -SevenZip $sevenZip -WorkDir $WorkDir -SourceExe $SourceExe -LicenseFile $LicenseFile -NoticeFile $NoticeFile", source)
        self.assertIn("Assert-PortableArchiveLayout -SevenZip $SevenZip -WorkDir $WorkDir -ArchivePath $archivePath -ExpectedNames $stagedNames", source)
        self.assertIn("SFX 归档根目录缺少", source)
        self.assertIn("SFX 归档里的可执行文件必须是根目录 GoNavi.exe", source)
        # CI 产物名是 gonavi-build-windows-*.exe。直接把这个绝对路径交给 7z 时，
        # 归档叶子名不是 GoNavi.exe，SFX 会报「系统找不到指定的文件」。
        self.assertNotIn("$archivePath, $SourceExe", source)
        archive_args = source.split("$archiveArgs = ", 1)[1].split("\n", 1)[0]
        self.assertNotIn("$SourceExe", archive_args)
        self.assertIn("$stagedNames", archive_args)

    def test_local_windows_release_keeps_unpacked_trimmed_executables(self) -> None:
        source = LOCAL_RELEASE_SCRIPT.read_text(encoding="utf-8")
        windows_builds = source.split("# --- Windows AMD64", 1)[1].split("# --- Linux AMD64", 1)[0]

        self.assertIn("wails build -trimpath -platform windows/amd64", windows_builds)
        self.assertIn("wails build -trimpath -platform windows/arm64", windows_builds)
        self.assertNotIn("upx", windows_builds.lower())

    def test_installer_declares_upgrade_shortcuts_and_uninstall_metadata(self) -> None:
        root = ET.parse(INSTALLER).getroot()
        ns = {"wix": WIX_NAMESPACE}
        package = root.find("wix:Package", ns)
        self.assertIsNotNone(package)
        assert package is not None
        self.assertEqual(package.attrib["Scope"], "perMachine")
        self.assertEqual(package.attrib["InstallerVersion"], "500")
        self.assertEqual(package.attrib["ProductCode"], "*")
        major_upgrade = package.find("wix:MajorUpgrade", ns)
        self.assertIsNotNone(major_upgrade)
        assert major_upgrade is not None
        self.assertEqual(major_upgrade.attrib["AllowDowngrades"], "yes")
        self.assertEqual(major_upgrade.attrib["Schedule"], "afterInstallInitialize")
        self.assertNotIn("AllowSameVersionUpgrades", major_upgrade.attrib)
        self.assertNotIn("DowngradeErrorMessage", major_upgrade.attrib)
        reinstall_mode = package.find("wix:Property[@Id='REINSTALLMODE']", ns)
        self.assertIsNotNone(reinstall_mode)
        assert reinstall_mode is not None
        self.assertEqual(reinstall_mode.attrib["Value"], "amus")
        self.assertIsNotNone(package.find("wix:MediaTemplate", ns))
        self.assertIsNotNone(package.find("wix:Property[@Id='ARPPRODUCTICON']", ns))
        desktop_property = package.find("wix:Property[@Id='INSTALLDESKTOPSHORTCUT']", ns)
        self.assertIsNotNone(desktop_property)
        assert desktop_property is not None
        self.assertEqual(desktop_property.attrib["Value"], "1")
        self.assertEqual(desktop_property.attrib["Secure"], "yes")
        self.assertIsNotNone(package.find("wix:SetProperty[@Id='ARPINSTALLLOCATION']", ns))

        main_feature = package.find("wix:Feature[@Id='MainFeature']", ns)
        self.assertIsNotNone(main_feature)
        assert main_feature is not None
        self.assertIsNotNone(main_feature.find("wix:ComponentRef[@Id='DesktopShortcutComponent']", ns))

        executable = package.find(".//wix:File[@Id='GoNaviExe']", ns)
        self.assertIsNotNone(executable)
        assert executable is not None
        start_menu_shortcut = executable.find("wix:Shortcut[@Id='StartMenuShortcut']", ns)
        self.assertIsNotNone(start_menu_shortcut)
        assert start_menu_shortcut is not None
        # A fresh install must show the packaged icon before GoNavi's first
        # launch rewrites the shortcut to the user's persisted brand ICO.
        self.assertEqual(start_menu_shortcut.attrib["Icon"], "GoNaviIcon")
        self.assertIsNone(executable.find("wix:Shortcut[@Id='DesktopShortcut']", ns))

        desktop_component = package.find("wix:Component[@Id='DesktopShortcutComponent']", ns)
        self.assertIsNotNone(desktop_component)
        assert desktop_component is not None
        self.assertEqual(desktop_component.attrib["Directory"], "DesktopFolder")
        self.assertEqual(desktop_component.attrib["Guid"], "$(var.DesktopShortcutComponentGuid)")
        self.assertEqual(desktop_component.attrib["Bitness"], "always64")
        self.assertEqual(desktop_component.attrib["Condition"], "INSTALLDESKTOPSHORTCUT = 1")
        desktop_shortcut = desktop_component.find("wix:Shortcut[@Id='DesktopShortcut']", ns)
        self.assertIsNotNone(desktop_shortcut)
        assert desktop_shortcut is not None
        self.assertEqual(desktop_shortcut.attrib["Icon"], "GoNaviIcon")
        self.assertEqual(desktop_shortcut.attrib["Target"], "[#GoNaviExe]")
        self.assertEqual(desktop_shortcut.attrib["WorkingDirectory"], "INSTALLFOLDER")
        desktop_key_path = desktop_component.find("wix:RegistryValue[@KeyPath='yes']", ns)
        self.assertIsNotNone(desktop_key_path)
        assert desktop_key_path is not None
        self.assertEqual(desktop_key_path.attrib["Root"], "HKLM")
        self.assertEqual(desktop_key_path.attrib["Key"], r"Software\Syngnat\$(var.RegistryKeyName)")
        self.assertEqual(desktop_key_path.attrib["Name"], "DesktopShortcutInstalled")
        self.assertEqual(desktop_key_path.attrib["Value"], "1")
        self.assertEqual(desktop_key_path.attrib["Type"], "integer")
        marker = package.find(".//wix:RegistryValue[@Name='InstallType']", ns)
        self.assertIsNotNone(marker)
        assert marker is not None
        self.assertEqual(marker.attrib["Value"], "MSI")
        install_path = package.find(".//wix:RegistryValue[@Name='InstallPath']", ns)
        self.assertIsNotNone(install_path)
        assert install_path is not None
        self.assertEqual(install_path.attrib["Value"], "[INSTALLFOLDER]GoNavi.exe")
        file_marker = package.find(".//wix:File[@Id='GoNaviMsiInstallMarker']", ns)
        self.assertIsNotNone(file_marker)
        assert file_marker is not None
        self.assertEqual(file_marker.attrib["Source"], "$(var.InstallMarker)")
        self.assertEqual(file_marker.attrib["Name"], ".gonavi-msi-install")
        apply_script = package.find(".//wix:File[@Id='GoNaviApplyBrandIconScript']", ns)
        self.assertIsNotNone(apply_script)
        assert apply_script is not None
        self.assertEqual(apply_script.attrib["Source"], "$(var.ApplyBrandIconScript)")
        self.assertEqual(apply_script.attrib["Name"], "apply-brand-icon.ps1")

        # Install-time brand icon restore: the deferred SYSTEM action rewrites
        # the freshly created default-icon shortcuts to the user's persisted
        # brand icon before the first launch (the in-app restore only runs
        # once GoNavi starts). Failures must be ignored, and the action must
        # never run on uninstall.
        set_apply_cmd = package.find("wix:CustomAction[@Id='SetApplyPersistedBrandIconCmd']", ns)
        self.assertIsNotNone(set_apply_cmd)
        assert set_apply_cmd is not None
        self.assertEqual(set_apply_cmd.attrib["Property"], "ApplyPersistedBrandIcon")
        command_value = set_apply_cmd.attrib["Value"]
        for token in (
            "powershell.exe",
            "[INSTALLFOLDER]apply-brand-icon.ps1",
            '-ApplicationDataFolder "[AppDataFolder]." >> -ApplicationDataFolder "[AppDataFolder]"'.split(" >> ")[0],
            '-StartMenuShortcut "[ProgramMenuFolder]$(var.ProductName).lnk"',
            '-DesktopShortcut "[DesktopFolder]$(var.ProductName).lnk"',
        ):
            self.assertIn(token, command_value)
        # [AppDataFolder] ends with a backslash; quoted raw it escapes the
        # closing quote and swallows every remaining argument (observed: the
        # whole action silently did nothing). The trailing "." is load-bearing.
        self.assertNotIn('[AppDataFolder]"', command_value)
        apply_action = package.find("wix:CustomAction[@Id='ApplyPersistedBrandIcon']", ns)
        self.assertIsNotNone(apply_action)
        assert apply_action is not None
        self.assertEqual(apply_action.attrib["Directory"], "SystemFolder")
        self.assertEqual(apply_action.attrib["Execute"], "deferred")
        self.assertEqual(apply_action.attrib["Impersonate"], "no")
        self.assertEqual(apply_action.attrib["Return"], "ignore")
        self.assertEqual(apply_action.attrib["ExeCommand"], "[ApplyPersistedBrandIcon]")
        sequence = package.find("wix:InstallExecuteSequence", ns)
        self.assertIsNotNone(sequence)
        assert sequence is not None
        set_apply_entry = sequence.find("wix:Custom[@Action='SetApplyPersistedBrandIconCmd']", ns)
        self.assertIsNotNone(set_apply_entry)
        assert set_apply_entry is not None
        self.assertEqual(set_apply_entry.attrib["After"], "InstallFiles")
        self.assertEqual(set_apply_entry.attrib["Condition"], "NOT REMOVE")
        apply_entry = sequence.find("wix:Custom[@Action='ApplyPersistedBrandIcon']", ns)
        self.assertIsNotNone(apply_entry)
        assert apply_entry is not None
        self.assertEqual(apply_entry.attrib["Before"], "InstallFinalize")
        self.assertEqual(apply_entry.attrib["Condition"], "NOT REMOVE")

        # Genuine-uninstall cleanup: removes the migrated user-layer Start
        # Menu shortcut and the taskbar pins that keep launching the removed
        # executable. UPGRADINGPRODUCTCODE must exclude the major-upgrade
        # teardown so an update never unpins the user.
        set_cleanup_cmd = package.find("wix:CustomAction[@Id='SetUninstallBrandCleanupCmd']", ns)
        self.assertIsNotNone(set_cleanup_cmd)
        assert set_cleanup_cmd is not None
        self.assertEqual(set_cleanup_cmd.attrib["Property"], "UninstallBrandCleanup")
        cleanup_value = set_cleanup_cmd.attrib["Value"]
        for token in (
            "powershell.exe",
            "[INSTALLFOLDER]apply-brand-icon.ps1",
            "-UninstallCleanup",
            '-ApplicationDataFolder "[AppDataFolder]."',
            '-ExpectedTarget "[INSTALLFOLDER]GoNavi.exe"',
        ):
            self.assertIn(token, cleanup_value)
        self.assertNotIn('[AppDataFolder]"', cleanup_value)
        cleanup_action = package.find("wix:CustomAction[@Id='UninstallBrandCleanup']", ns)
        self.assertIsNotNone(cleanup_action)
        assert cleanup_action is not None
        self.assertEqual(cleanup_action.attrib["Directory"], "SystemFolder")
        self.assertEqual(cleanup_action.attrib["Execute"], "deferred")
        self.assertEqual(cleanup_action.attrib["Impersonate"], "no")
        self.assertEqual(cleanup_action.attrib["Return"], "ignore")
        self.assertEqual(cleanup_action.attrib["ExeCommand"], "[UninstallBrandCleanup]")
        set_cleanup_entry = sequence.find("wix:Custom[@Action='SetUninstallBrandCleanupCmd']", ns)
        self.assertIsNotNone(set_cleanup_entry)
        assert set_cleanup_entry is not None
        self.assertEqual(set_cleanup_entry.attrib["After"], "InstallValidate")
        self.assertEqual(set_cleanup_entry.attrib["Condition"], "REMOVE AND NOT UPGRADINGPRODUCTCODE")
        cleanup_entry = sequence.find("wix:Custom[@Action='UninstallBrandCleanup']", ns)
        self.assertIsNotNone(cleanup_entry)
        assert cleanup_entry is not None
        self.assertEqual(cleanup_entry.attrib["After"], "InstallInitialize")
        self.assertEqual(cleanup_entry.attrib["Condition"], "REMOVE AND NOT UPGRADINGPRODUCTCODE")
        license_file = package.find(".//wix:File[@Id='GoNaviLicense']", ns)
        self.assertIsNotNone(license_file)
        assert license_file is not None
        self.assertEqual(license_file.attrib["Source"], "$(var.LicenseFile)")
        self.assertEqual(license_file.attrib["Name"], "LICENSE.txt")
        notice_file = package.find(".//wix:File[@Id='GoNaviNotice']", ns)
        self.assertIsNotNone(notice_file)
        assert notice_file is not None
        self.assertEqual(notice_file.attrib["Source"], "$(var.NoticeFile)")
        self.assertEqual(notice_file.attrib["Name"], "NOTICE.txt")


if __name__ == "__main__":
    unittest.main()
