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


if __name__ == "__main__":
    unittest.main()
