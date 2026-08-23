#!/usr/bin/env python3
"""Contract tests for the npm GoNavi CLI wrapper."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PACKAGE = ROOT / "npm" / "gonavi-cli"


class NpmCLIWrapperTests(unittest.TestCase):
    def test_package_exposes_gonavi_and_verified_postinstall(self) -> None:
        package = json.loads((PACKAGE / "package.json").read_text(encoding="utf-8"))
        self.assertEqual(package["name"], "@syngnat/gonavi-cli")
        self.assertRegex(package["version"], r"^\d+\.\d+\.\d+$")
        self.assertEqual(package["bin"]["gonavi"], "bin/gonavi.js")
        self.assertEqual(package["scripts"]["postinstall"], "node install.js")

    def test_installer_consumes_independent_checksums_and_fixed_archive(self) -> None:
        installer = (PACKAGE / "install.js").read_text(encoding="utf-8")
        launcher = (PACKAGE / "bin" / "gonavi.js").read_text(encoding="utf-8")
        for token in (
            "gonavi-cli_${version}_checksums.txt",
            "crypto.createHash('sha256')",
            "assertSha256(archive, expected, target.asset)",
            "archiveEntries(archivePath, target.extension, target.binary)",
            "expectedArchiveEntries(binary)",
            "'LICENSE'",
            "'NOTICE'",
            "GONAVI_CLI_RELEASE_BASE_URL",
        ):
            self.assertIn(token, installer)
        self.assertIn("spawn(binaryPath", launcher)
        self.assertNotIn("SHA256SUMS", installer)

    def test_node_sources_parse(self) -> None:
        node = shutil.which("node")
        if node is None:
            self.skipTest("node is not installed")
        for source in (PACKAGE / "install.js", PACKAGE / "bin" / "gonavi.js"):
            result = subprocess.run(
                [node, "--check", str(source)],
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(result.returncode, 0, result.stderr)

    def test_installer_rejects_symlink_and_hardlink_archive_members(self) -> None:
        node = shutil.which("node")
        if node is None:
            self.skipTest("node is not installed")
        if os.name == "nt":
            self.skipTest("creating symlinks is not consistently permitted on Windows runners")

        script = r'''
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { validateExtractedArchive } = require(process.argv[1]);

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gonavi-cli-wrapper-test-'));
const expected = ['gonavi', 'LICENSE', 'NOTICE'];

function populate(directory) {
  fs.mkdirSync(directory);
  for (const entry of expected) {
    fs.writeFileSync(path.join(directory, entry), entry);
  }
}

function expectReject(directory, label) {
  try {
    validateExtractedArchive(directory, 'gonavi');
  } catch (error) {
    return;
  }
  throw new Error(`${label} archive member was accepted`);
}

try {
  const regular = path.join(root, 'regular');
  populate(regular);
  validateExtractedArchive(regular, 'gonavi');

  const symlink = path.join(root, 'symlink');
  populate(symlink);
  fs.rmSync(path.join(symlink, 'LICENSE'));
  fs.symlinkSync('gonavi', path.join(symlink, 'LICENSE'));
  expectReject(symlink, 'symlink');

  const hardlink = path.join(root, 'hardlink');
  populate(hardlink);
  fs.rmSync(path.join(hardlink, 'LICENSE'));
  fs.linkSync(path.join(hardlink, 'gonavi'), path.join(hardlink, 'LICENSE'));
  expectReject(hardlink, 'hardlink');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
'''
        result = subprocess.run(
            [node, "-e", script, str(PACKAGE / "install.js")],
            text=True,
            capture_output=True,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == "__main__":
    unittest.main()
