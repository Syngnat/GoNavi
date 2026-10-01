#!/usr/bin/env python3
"""Pin wails.json `build:tags` to the WebKitGTK API the current job builds against.

背景：`wails build` 会把 wails.json 的 `build:tags` 与命令行 `-tags` **合并**
（wails v2.15 `cmd/wails/build.go`：`append(projectTags, userTags...)`），命令行
无法覆盖项目标签。因此 wails.json 里的默认值决定了「裸跑 wails build」会去
链接哪套 WebKitGTK，必须由构建方在构建前显式校准。

wails.json 不支持环境变量插值，preBuildHook 又晚于 tags 解析（tags 在
`build.Build` 之前就已固化），当次构建无法改标签：本机构建由 preBuildHook
按已装的 WebKitGTK 改写 wails.json 并提示重跑，CI 则用本脚本在构建前显式
校准。默认值为 `webkit2_41`，4.0 任务显式传 `4.0`。
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

USAGE = "usage: ci-apply-wails-webkit-tags.py <4.0|4.1|>"

# 每个取值对应的 wails 构建标签。4.0/空 都不需要额外标签：wails 在未声明
# webkit2_41 时默认走 webkit2gtk-4.0 的 pkg-config。
TAGS_BY_WEBKIT = {
    "": "",
    "4.0": "",
    "4.1": "webkit2_41",
}

DESCRIPTION_BY_WEBKIT = {
    "": "cleared",
    "4.0": "cleared",
    "4.1": "set to webkit2_41",
}


def main() -> int:
    if len(sys.argv) != 2:
        print(USAGE, file=sys.stderr)
        return 2

    webkit = sys.argv[1].strip()
    if webkit not in TAGS_BY_WEBKIT:
        print(f"{USAGE}\nunsupported WebKitGTK API: {webkit!r}", file=sys.stderr)
        return 2

    path = Path("wails.json")
    data = json.loads(path.read_text(encoding="utf-8"))
    tags = TAGS_BY_WEBKIT[webkit]
    if data.get("build:tags", "") == tags:
        print(f"wails.json build:tags already {DESCRIPTION_BY_WEBKIT[webkit]} for WebKitGTK {webkit or 'default'}")
        return 0

    data["build:tags"] = tags
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"{DESCRIPTION_BY_WEBKIT[webkit]} wails.json build:tags for WebKitGTK {webkit or 'default'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
