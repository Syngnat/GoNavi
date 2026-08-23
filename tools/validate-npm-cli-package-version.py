#!/usr/bin/env python3
"""Validate that a stable tag matches the npm CLI package version."""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path


PACKAGE_NAME = "@syngnat/gonavi-cli"
STABLE_TAG_RE = re.compile(r"^v(\d+\.\d+\.\d+)$")
VERSION_RE = re.compile(r"^\d+\.\d+\.\d+$")
DEFAULT_PACKAGE_JSON = Path(__file__).resolve().parents[1] / "npm" / "gonavi-cli" / "package.json"


def stable_version(tag: str) -> str:
    """Return the semantic version represented by a stable ``v`` tag."""
    match = STABLE_TAG_RE.fullmatch(tag)
    if not match:
        raise ValueError(f"stable tag must match vX.Y.Z exactly: {tag!r}")
    return match.group(1)


def validate_package_version(tag: str, package_json: Path = DEFAULT_PACKAGE_JSON) -> str:
    """Validate the package identity and return its version."""
    expected_version = stable_version(tag)
    try:
        package = json.loads(package_json.read_text(encoding="utf-8"))
    except OSError as error:
        raise ValueError(f"cannot read npm package metadata: {package_json}: {error}") from error
    except json.JSONDecodeError as error:
        raise ValueError(f"npm package metadata is not valid JSON: {package_json}: {error}") from error

    if not isinstance(package, dict) or package.get("name") != PACKAGE_NAME:
        actual_name = package.get("name") if isinstance(package, dict) else None
        raise ValueError(f"npm package name must be {PACKAGE_NAME!r}, got {actual_name!r}")
    actual_version = package.get("version")
    if not isinstance(actual_version, str) or not VERSION_RE.fullmatch(actual_version):
        raise ValueError(f"npm package version must be X.Y.Z, got {actual_version!r}")
    if actual_version != expected_version:
        raise ValueError(
            f"npm package version {actual_version} does not match stable tag {tag} ({expected_version})"
        )
    return actual_version


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tag", required=True, help="stable release tag, for example v0.9.3")
    parser.add_argument("--package-json", type=Path, default=DEFAULT_PACKAGE_JSON)
    args = parser.parse_args()
    try:
        version = validate_package_version(args.tag, args.package_json)
    except ValueError as error:
        print(f"npm CLI package version validation failed: {error}", file=sys.stderr)
        return 2
    print(f"npm CLI package {PACKAGE_NAME} matches stable tag {args.tag}: {version}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
