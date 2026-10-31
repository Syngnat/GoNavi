import os
from pathlib import Path
import tempfile
import unittest
import xml.etree.ElementTree as ET

from render_hive_auth import STAGES, render


class RenderHiveAuthTest(unittest.TestCase):
    def test_all_stages_preserve_warehouse_and_protect_private_output(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            base = root / "base.xml"
            original = (
                "<configuration>"
                "<property><name>hive.execution.engine</name><value>mr</value></property>"
                "<property><name>hive.server2.authentication</name><value>NONE</value></property>"
                "<property><name>hive.server2.authentication</name><value>stale</value></property>"
                "<property><name>hive.server2.keystore.password</name><value>stale</value></property>"
                "</configuration>"
            )
            base.write_text(original)
            private = root / "private"
            (private / "hive").mkdir(parents=True)
            (private / "hive" / "keystore.password").write_text("fixture-not-a-real-credential\n")
            for stage in STAGES:
                with self.subTest(stage=stage):
                    path = render(base, private, stage)
                    props = ET.parse(path).getroot().findall("property")
                    values = {prop.findtext("name"): prop.findtext("value") for prop in props}
                    self.assertEqual(len(values), len(props))
                    self.assertEqual(values["hive.execution.engine"], "mr")
                    kerberos = "gssapi" in stage or "spnego" in stage
                    self.assertEqual(values["hive.server2.authentication"], "KERBEROS" if kerberos else "NONE")
                    core = ET.parse(path.with_name("core-site.xml")).getroot().findall("property")
                    bootstrap = {prop.findtext("name"): prop.findtext("value") for prop in core}
                    self.assertEqual(bootstrap["hadoop.security.authentication"], "kerberos" if kerberos else "simple")
                    self.assertEqual(values["hive.server2.use.SSL"], str(stage.endswith("-tls")).lower())
                    if stage.endswith("-tls"):
                        self.assertEqual(values["hive.server2.keystore.password"], "fixture-not-a-real-credential")
                    else:
                        self.assertNotIn("hive.server2.keystore.password", values)
                    if os.name == "posix":
                        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertEqual(base.read_text(), original)

    def test_tls_requires_nonempty_private_password(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "hive").mkdir()
            (root / "hive" / "keystore.password").write_text("\n")
            base = root / "base.xml"
            base.write_text("<configuration/>")
            with self.assertRaisesRegex(ValueError, "empty private"):
                render(base, root, "binary-tls")


if __name__ == "__main__":
    unittest.main()
