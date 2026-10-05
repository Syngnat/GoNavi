#!/usr/bin/env python3
"""为数据源描述表里还没有图标文件的类型生成字母徽标 SVG（frontend/public/db-icons/<type>.svg）。

徽标只是占位：品牌色圆角方块 + 1–3 个字母（描述 ui.icon.text，缺省取显示名前两个字符）。
已存在的图标文件（官方 logo）一律不覆盖；替换成官方 logo 时直接覆盖同名文件即可。
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from xml.sax.saxutils import escape

REPO_ROOT = Path(__file__).resolve().parent.parent
SPECS_DIR = REPO_ROOT / "internal" / "datasource" / "specs"
ICONS_DIR = REPO_ROOT / "frontend" / "public" / "db-icons"
DEFAULT_COLOR = "#4B5563"


def monogram_svg(text: str, color: str) -> str:
    font_size = {1: 34, 2: 28, 3: 21}.get(len(text), 21)
    return (
        '<!-- GoNavi placeholder monogram; replace with the official logo when available -->\n'
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">'
        f'<rect width="64" height="64" rx="14" fill="{escape(color)}"/>'
        f'<text x="32" y="{32 + font_size * 0.36:.1f}" text-anchor="middle" '
        'font-family="Segoe UI, Helvetica Neue, Arial, sans-serif" '
        f'font-size="{font_size}" font-weight="700" fill="#ffffff">{escape(text)}</text>'
        '</svg>\n'
    )


def main() -> int:
    created = []
    for path in sorted(SPECS_DIR.glob("*.json")):
        spec = json.loads(path.read_text(encoding="utf-8"))
        icon = (spec.get("ui") or {}).get("icon") or {}
        if icon.get("asset"):
            continue
        target = ICONS_DIR / f"{spec['type']}.svg"
        if target.exists():
            continue
        text = (icon.get("text") or spec["displayName"][:2]).strip()[:3]
        target.write_text(monogram_svg(text, icon.get("color") or DEFAULT_COLOR), encoding="utf-8", newline="\n")
        created.append(target.name)
    print("created: " + (", ".join(created) if created else "(none)"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
