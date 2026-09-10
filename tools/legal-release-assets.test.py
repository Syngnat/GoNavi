#!/usr/bin/env python3

import json
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
WORKFLOWS = (
    ROOT / ".github" / "workflows" / "release.yml",
    ROOT / ".github" / "workflows" / "dev-build.yml",
)
DOCKERFILES = (
    ROOT / "Dockerfile.mcp-server",
    ROOT / "Dockerfile.web-server",
    ROOT / "Dockerfile.build-env",
)


class LegalReleaseAssetsTest(unittest.TestCase):
    def test_notice_identifies_project_and_upstream_notices(self) -> None:
        notice = (ROOT / "NOTICE").read_text(encoding="utf-8")

        self.assertTrue(notice.startswith("GoNavi\nCopyright 2026 Syngnat\n"))
        for component in (
            "Apache RocketMQ",
            "Apache IoTDB",
            "Apache Thrift",
            "Eclipse Paho MQTT Go",
            "Vendored HighGo pq-sm3",
            "Vendored InterSystems IRIS/Caché native driver",
        ):
            with self.subTest(component=component):
                self.assertIn(component, notice)

    def test_project_metadata_declares_the_license_and_copyright(self) -> None:
        wails = json.loads((ROOT / "wails.json").read_text(encoding="utf-8"))
        frontend = json.loads((ROOT / "frontend" / "package.json").read_text(encoding="utf-8"))

        self.assertEqual(wails["author"], {"name": "Syngnat", "email": "yangguofeng919@gmail.com"})
        self.assertEqual(wails["info"]["copyright"], "Copyright 2026 Syngnat")
        self.assertEqual(frontend["license"], "Apache-2.0")

    def test_release_workflows_bundle_legal_documents(self) -> None:
        for workflow in WORKFLOWS:
            with self.subTest(workflow=workflow.name):
                source = workflow.read_text(encoding="utf-8")

                self.assertIn('cp ../../LICENSE "$APP_NAME/Contents/Resources/LICENSE"', source)
                self.assertIn('cp ../../NOTICE "$APP_NAME/Contents/Resources/NOTICE"', source)
                self.assertIn('tar -czvf "$TAR_NAME" "$TARGET" -C ../.. LICENSE NOTICE', source)
                self.assertIn("AppDir/usr/share/doc/gonavi", source)
                self.assertIn("cp ../../LICENSE AppDir/usr/share/doc/gonavi/LICENSE", source)
                self.assertIn("cp ../../NOTICE AppDir/usr/share/doc/gonavi/NOTICE", source)
                self.assertIn('run: install -m 0644 LICENSE NOTICE release-assets/', source)
                self.assertIn('-d "LicenseFile=$licenseFile"', source)
                self.assertIn('-d "NoticeFile=$noticeFile"', source)

    def test_docker_images_include_legal_documents(self) -> None:
        for dockerfile in DOCKERFILES:
            with self.subTest(dockerfile=dockerfile.name):
                source = dockerfile.read_text(encoding="utf-8")
                self.assertIn("/usr/share/doc/gonavi", source)
                self.assertIn("LICENSE", source)
                self.assertIn("NOTICE", source)


if __name__ == "__main__":
    unittest.main()
