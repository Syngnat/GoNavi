#!/usr/bin/env python3
"""向 internal/db/data_source_capability_contract.json 追加能力集与驱动映射（文本插入，不重排已有内容）。

用法：
  capability-contract-add.py --profile <name> --from <existing-profile> [--set ui.userManagement=false ...]
  capability-contract-add.py --driver <type>=<profile> [--driver ...]

--profile 以已有能力集为模板复制并按 --set 覆盖字段（布尔/字符串）；--driver 把驱动类型映射到能力集。
已存在的名字会被拒绝。写回后用 json 解析校验，失败不落盘。
"""

from __future__ import annotations

import argparse
import copy
import json
import sys
from pathlib import Path

CONTRACT = Path(__file__).resolve().parent.parent / "internal" / "db" / "data_source_capability_contract.json"
LF = chr(10)
CRLF = chr(13) + chr(10)


def parse_value(text: str):
    lowered = text.lower()
    if lowered in ("true", "false"):
        return lowered == "true"
    return text


def apply_sets(profile: dict, assignments: list[str]) -> None:
    for assignment in assignments:
        path, _, raw = assignment.partition("=")
        node = profile
        keys = path.split(".")
        for key in keys[:-1]:
            node = node.setdefault(key, {})
        node[keys[-1]] = parse_value(raw)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--profile")
    parser.add_argument("--from", dest="template")
    parser.add_argument("--set", action="append", default=[])
    parser.add_argument("--driver", action="append", default=[])
    args = parser.parse_args()

    raw = CONTRACT.read_bytes().decode("utf-8")
    eol = CRLF if CRLF in raw else LF
    document = json.loads(raw)
    text = raw

    if args.profile:
        if args.profile in document["profiles"]:
            sys.exit(f"profile {args.profile} already exists")
        if args.template not in document["profiles"]:
            sys.exit(f"template profile {args.template} not found")
        profile = copy.deepcopy(document["profiles"][args.template])
        apply_sets(profile, args.set)
        anchor = '"profiles":  {'
        if text.count(anchor) != 1:
            sys.exit("profiles anchor not found")
        block = json.dumps(profile, ensure_ascii=False)
        text = text.replace(anchor, anchor + eol + f'                     "{args.profile}":  {block},', 1)

    for mapping in args.driver:
        driver, _, profile_name = mapping.partition("=")
        if driver in document["drivers"]:
            sys.exit(f"driver {driver} already mapped")
        anchor = '"drivers":  {'
        if text.count(anchor) != 1:
            sys.exit("drivers anchor not found")
        text = text.replace(anchor, anchor + eol + f'                    "{driver}":  "{profile_name}",', 1)

    json.loads(text)
    CONTRACT.write_bytes(text.encode("utf-8"))
    print("contract updated")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
