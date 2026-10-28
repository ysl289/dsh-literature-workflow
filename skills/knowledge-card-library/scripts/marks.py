#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""marks.py — 封面徽记库（国家 → 圆形印章式国旗几何）

为什么不用地标插画：手绘线稿在小尺寸下必然显糙，而且难画准。
国旗是纯几何，线条精确，做成圆形印章后像出版社的藏书印，克制且不糙。

规则：
  1. 有明确提出者 → 用提出者所属国家的徽记（`origin_country`）
  2. 没有明确提出者 → 按学派归属映射（`school`）
  3. 都判断不出 → 中性符号「闸门」，不硬凑

所有图形 viewBox 160×160，stroke=currentColor，由外层控制颜色与透明度。
"""

import math

MARK_LABEL = {}


def _star(cx, cy, R, r=None):
    """五角星路径（外接半径 R，内接半径默认 0.382R）。"""
    r = r or R * 0.382
    pts = []
    for i in range(10):
        ang = -math.pi / 2 + i * math.pi / 5
        rad = R if i % 2 == 0 else r
        pts.append(f"{cx + rad * math.cos(ang):.1f},{cy + rad * math.sin(ang):.1f}")
    return "M" + " L".join(pts) + " Z"


def _emblem(inner: str) -> str:
    return (
        '<svg viewBox="0 0 160 160" fill="none" stroke="currentColor" '
        'stroke-width="1.15" stroke-linejoin="round" stroke-linecap="round">'
        '<defs><clipPath id="kc"><circle cx="80" cy="80" r="69"/></clipPath></defs>'
        f'<g clip-path="url(#kc)">{inner}</g>'
        '<circle cx="80" cy="80" r="69" stroke-width="1.35"/>'
        "</svg>"
    )


MARKS = {}

# 美国：条纹 + 左上角星区
MARKS["美国"] = _emblem(
    '<rect x="11" y="11" width="60" height="42" stroke-width="1"/>'
    '<path d="M11,53 H149 M11,64 H149 M11,75 H149 M11,86 H149 '
    'M11,97 H149 M11,108 H149 M11,119 H149 M11,130 H149 M11,141 H149" '
    'stroke-width=".85" opacity=".85"/>'
    + "".join(f'<circle cx="{20 + i % 5 * 11}" cy="{20 + i // 5 * 12}" r="2.1" '
              f'stroke-width=".9"/>' for i in range(15))
)

# 法国：三色竖分
MARKS["法国"] = _emblem(
    '<path d="M56,10 V150 M104,10 V150" stroke-width="1.05"/>'
)

# 德国：三色横分
MARKS["德国"] = _emblem(
    '<path d="M10,57 H150 M10,103 H150" stroke-width="1.05"/>'
)

# 英国：米字
MARKS["英国"] = _emblem(
    '<path d="M10,10 L150,150 M150,10 L10,150" stroke-width=".85"/>'
    '<path d="M80,10 V150 M10,80 H150" stroke-width="1.5"/>'
)

# 中国：五星
MARKS["中国"] = _emblem(
    f'<path d="{_star(52, 54, 19)}" stroke-width="1.1"/>'
    + "".join(f'<circle cx="{x}" cy="{y}" r="2.4" stroke-width=".9"/>'
              for x, y in [(86, 26), (96, 40), (96, 58), (86, 70)])
)

# 奥地利（学派兜底用）
MARKS["奥地利"] = _emblem(
    '<path d="M10,57 H150 M10,103 H150" stroke-width="1.05"/>'
)

# 默认：闸门（判断不出来源时的中性符号）
DEFAULT = _emblem(
    '<path d="M14,80 H62" stroke-width="1.2"/>'
    '<path d="M62,80 L74,73 L74,87 Z" stroke-width="1.1"/>'
    '<path d="M98,80 H146" stroke-width="1.2"/>'
    '<line x1="82" y1="42" x2="82" y2="118" stroke-width="1.6"/>'
    '<line x1="94" y1="42" x2="94" y2="118" stroke-width="1.6"/>'
    '<path d="M60,132 H140" stroke-width=".9" opacity=".7"/>'
)

MARK_LABEL.update({"美国": "美国", "法国": "法国", "德国": "德国",
                   "英国": "英国", "中国": "中国", "奥地利": "奥地利"})

# 学派 → 国家（没有明确提出者时用）
SCHOOL_MARKS = {
    "新增长理论": "美国",
    "演化经济学与创新研究": "美国",
    "创新经济学": "美国",
    "芝加哥学派": "美国",
    "新古典经济学": "英国",
    "凯恩斯主义": "英国",
    "奥地利学派": "奥地利",
    "历史学派": "德国",
    "重农学派": "法国",
}


def pick_mark(card) -> str:
    """按提出者国家 → 学派 → 默认闸门，依次判断。"""
    country = str(card.get("origin_country") or "").strip()
    if country in MARKS:
        return MARKS[country]
    school = str(card.get("school") or "").strip()
    mapped = SCHOOL_MARKS.get(school)
    if mapped and mapped in MARKS:
        return MARKS[mapped]
    return DEFAULT


def mark_label(card) -> str:
    """版权页用的来源说明。"""
    country = str(card.get("origin_country") or "").strip()
    if country:
        return f"{country} · 提出者所属"
    school = str(card.get("school") or "").strip()
    if school in SCHOOL_MARKS:
        return f"{SCHOOL_MARKS[school]} · 学派归属"
    return "无明确提出者"


# ---------------------------------------------------------------- 主题色板
# 颜色也是元素：理论出身哪个国家，卡片就用那个国家的色系。
PALETTES = {
    "美国": {"cover": "#14273f", "cover_dim": "#8fb3d9", "accent": "#b3352b",
             "num": "#b3352b", "paper": "#fbf9f4", "page": "#fffdf8",
             "line": "#e3dcd0", "soft": "#f2f0ea", "desk": "#a8a49c"},
    "法国": {"cover": "#1c2b4d", "cover_dim": "#9db4d6", "accent": "#b03a48",
             "num": "#b03a48", "paper": "#fbf9f5", "page": "#fffdfa",
             "line": "#e3dcd3", "soft": "#f3f1ec", "desk": "#a9a59d"},
    "德国": {"cover": "#191919", "cover_dim": "#c9a227", "accent": "#b3382c",
             "num": "#b3382c", "paper": "#faf8f3", "page": "#fffdf8",
             "line": "#e2dbce", "soft": "#f2efe7", "desk": "#9f9b93"},
    "英国": {"cover": "#1e2f4d", "cover_dim": "#9fb2cc", "accent": "#a5232f",
             "num": "#a5232f", "paper": "#fbf9f4", "page": "#fffdf9",
             "line": "#e3dcd2", "soft": "#f2f0ea", "desk": "#a7a39b"},
    "中国": {"cover": "#8c1f1a", "cover_dim": "#eccf95", "accent": "#b8862c",
             "num": "#a8791f", "paper": "#fbf7ef", "page": "#fffdf7",
             "line": "#e6dcc8", "soft": "#f6f0e2", "desk": "#b3a894"},
    "奥地利": {"cover": "#8f2226", "cover_dim": "#f0d9d4", "accent": "#8f2226",
               "num": "#8f2226", "paper": "#fbf8f4", "page": "#fffdfa",
               "line": "#e5dbd0", "soft": "#f4efe9", "desk": "#ada49b"},
}


def palette(card) -> dict:
    """按来源取配色；取不到返回空 dict（沿用默认）。"""
    country = str(card.get("origin_country") or "").strip()
    if country in PALETTES:
        return dict(PALETTES[country])
    school = str(card.get("school") or "").strip()
    mapped = SCHOOL_MARKS.get(school)
    return dict(PALETTES.get(mapped, {})) if mapped else {}
