#!/usr/bin/env python3
"""Render a private Hive auth overlay without changing or restarting Hive."""

import argparse
import os
from pathlib import Path
import xml.etree.ElementTree as ET

STAGES = (
    "binary-gssapi", "http-spnego", "binary-tls", "http-tls",
    "binary-gssapi-tls", "http-spnego-tls",
)


def stage_properties(stage, private):
    tls = stage.endswith("-tls")
    kerberos = "gssapi" in stage or "spnego" in stage
    values = {
        "hive.server2.transport.mode": "http" if stage.startswith("http") else "binary",
        "hive.server2.authentication": "KERBEROS" if kerberos else "NONE",
        "hive.server2.enable.doAs": "false",
        "hive.server2.use.SSL": str(tls).lower(),
        "hive.server2.thrift.sasl.qop": "auth",
    }
    if kerberos:
        values.update({
            "hadoop.security.authentication": "kerberos",
            "hive.server2.authentication.kerberos.principal": "hive/hive.gonavi.test@GONAVI.TEST",
            "hive.server2.authentication.kerberos.keytab": "/run/gonavi-auth/hive.keytab",
            "hive.server2.authentication.spnego.principal": "HTTP/hive.gonavi.test@GONAVI.TEST",
            "hive.server2.authentication.spnego.keytab": "/run/gonavi-auth/hive.keytab",
        })
    else:
        values["hadoop.security.authentication"] = "simple"
    if tls:
        password = (private / "hive" / "keystore.password").read_text().strip()
        if not password:
            raise ValueError("empty private keystore password")
        values.update({
            "hive.server2.keystore.path": "/run/gonavi-auth/hive.jks",
            "hive.server2.keystore.password": password,
            "hive.ssl.protocol.blacklist": "SSLv2,SSLv3,TLSv1,TLSv1.1",
        })
    return values


def write_private_xml(path, root):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "wb") as stream:
        ET.indent(root, space="  ")
        ET.ElementTree(root).write(stream, encoding="utf-8", xml_declaration=True)
    os.chmod(path, 0o600)
    if os.name == "posix" and os.getuid() == 0:
        os.chown(path, 1000, 1000)


def render(base, private, stage):
    root = ET.parse(base).getroot()
    values = stage_properties(stage, private)
    for prop in list(root.findall("property")):
        name = prop.findtext("name", "")
        if name in values or name.startswith("hive.server2.authentication.") or name.startswith("hive.server2.keystore."):
            root.remove(prop)
    for name, value in values.items():
        prop = ET.SubElement(root, "property")
        ET.SubElement(prop, "name").text = name
        ET.SubElement(prop, "value").text = value
    destination = private / "overrides" / stage
    destination.mkdir(parents=True, exist_ok=True, mode=0o700)
    path = destination / "hive-site.xml"
    write_private_xml(path, root)
    # UGI initializes before HiveConf; Hadoop must see Kerberos in core-site.xml.
    core = ET.Element("configuration")
    for name, value in {
        "hadoop.security.authentication": values["hadoop.security.authentication"],
        "hadoop.security.auth_to_local": "DEFAULT",
    }.items():
        prop = ET.SubElement(core, "property")
        ET.SubElement(prop, "name").text = name
        ET.SubElement(prop, "value").text = value
    write_private_xml(destination / "core-site.xml", core)
    if os.name == "posix" and os.getuid() == 0:
        os.chown(destination, 1000, 1000)
    return path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("stage", choices=STAGES)
    parser.add_argument("--base", type=Path, default=Path("/opt/gonavi-db-lab/hive-1584/hive-site.xml"))
    parser.add_argument("--private", type=Path, default=Path("/opt/gonavi-db-lab/hive-1584/auth/private"))
    args = parser.parse_args()
    print(render(args.base, args.private, args.stage))


if __name__ == "__main__":
    main()
