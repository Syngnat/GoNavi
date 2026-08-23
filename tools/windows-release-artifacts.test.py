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
        self.assertNotIn("Icon", start_menu_shortcut.attrib)
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
        self.assertNotIn("Icon", desktop_shortcut.attrib)
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
