#!/usr/bin/env python3

import importlib.util
import pathlib
import tempfile
import unittest


MODULE_PATH = pathlib.Path(__file__).with_name("complete-driver-release-assets.py")
SPEC = importlib.util.spec_from_file_location("complete_driver_release_assets", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


class CompleteDriverReleaseAssetsTests(unittest.TestCase):
    def test_prefers_public_release_download_url(self):
        asset = {
            "name": "GoNavi-DriverAgents.zip",
            "url": "https://api.github.test/releases/assets/1",
            "browser_download_url": "https://github.test/releases/download/dev-latest/GoNavi-DriverAgents.zip",
        }
        self.assertEqual(
            MODULE.asset_download_url(asset),
            "https://github.test/releases/download/dev-latest/GoNavi-DriverAgents.zip",
        )

    def test_falls_back_to_api_asset_url_when_public_url_is_absent(self):
        self.assertEqual(
            MODULE.asset_download_url({"url": "https://api.github.test/releases/assets/1"}),
            "https://api.github.test/releases/assets/1",
        )

    def test_download_asset_uses_public_url_without_authorization_header(self):
        asset = {
            "name": "GoNavi-DriverAgents.zip",
            "url": "https://api.github.test/releases/assets/1",
            "browser_download_url": "https://github.test/releases/download/dev-latest/GoNavi-DriverAgents.zip",
        }
        requests = []
        original_urlopen = MODULE.urllib.request.urlopen

        class Response:
            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def read(self, _size=-1):
                return b""

        def fake_urlopen(request, timeout):
            requests.append((request.full_url, dict(request.header_items()), timeout))
            return Response()

        with tempfile.TemporaryDirectory() as tmp:
            try:
                MODULE.urllib.request.urlopen = fake_urlopen
                destination = pathlib.Path(tmp) / "driver-bundle.zip"
                MODULE.download_asset(asset, destination)
            finally:
                MODULE.urllib.request.urlopen = original_urlopen

        self.assertEqual(requests[0][0], asset["browser_download_url"])
        self.assertNotIn("Authorization", requests[0][1])

    def test_requires_registry_driver_assets_only_on_declared_platforms(self):
        required = set(MODULE.required_assets())
        # 描述表驱动未声明平台时发布全部六个平台。
        for platform_dir, name in [
            ("Windows", "tidb-driver-agent-windows-amd64.exe"),
            ("Windows", "tidb-driver-agent-windows-arm64.exe"),
            ("MacOS", "meilisearch-driver-agent-darwin-arm64"),
            ("Linux", "zookeeper-driver-agent-linux-arm64"),
        ]:
            self.assertIn((platform_dir, name), required)
        # 崖山、GBase 8s 只声明了 linux/amd64、linux/arm64、windows/amd64。
        self.assertIn(("Linux", "yashandb-driver-agent-linux-arm64"), required)
        self.assertIn(("Windows", "gbase8s-driver-agent-windows-amd64.exe"), required)
        self.assertNotIn(("MacOS", "yashandb-driver-agent-darwin-arm64"), required)
        self.assertNotIn(("Windows", "gbase8s-driver-agent-windows-arm64.exe"), required)

    def test_prefers_7z_bundle_and_keeps_legacy_zip_bundle(self):
        self.assertEqual(MODULE.BUNDLE_NAMES, ("GoNavi-DriverAgents.7z", "GoNavi-DriverAgents.zip"))

    def test_copies_only_missing_required_assets_from_7z_bundle(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            drivers = root / "drivers"
            (drivers / "Windows").mkdir(parents=True)
            (drivers / "Linux").mkdir(parents=True)
            (drivers / "Windows" / "mariadb-driver-agent-windows-amd64.exe").write_bytes(b"bundled-windows")
            (drivers / "Linux" / "mariadb-driver-agent-linux-arm64").write_bytes(b"bundled-linux")
            (drivers / "Linux" / "unrelated-file").write_bytes(b"ignored")
            bundle = root / "GoNavi-DriverAgents.7z"
            from driver_bundle_7z import create_bundle

            create_bundle(
                bundle,
                drivers,
                [
                    "Windows/mariadb-driver-agent-windows-amd64.exe",
                    "Linux/mariadb-driver-agent-linux-arm64",
                    "Linux/unrelated-file",
                ],
                [],
            )

            target = root / "target"
            (target / "Linux").mkdir(parents=True)
            existing = target / "Linux" / "mariadb-driver-agent-linux-arm64"
            existing.write_bytes(b"freshly-built")

            copied = MODULE.copy_missing_from_bundle(bundle, target)

            self.assertEqual(copied, 1)
            self.assertEqual(
                (target / "Windows" / "mariadb-driver-agent-windows-amd64.exe").read_bytes(),
                b"bundled-windows",
            )
            self.assertEqual(existing.read_bytes(), b"freshly-built")
            self.assertFalse((target / "Linux" / "unrelated-file").exists())


if __name__ == "__main__":
    unittest.main()
