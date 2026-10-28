#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""origins.py — 按「理论出身」决定整套设计语言

元素不止颜色和印章。一个国家/学派可以同时决定：
  配色 · 标题字体 · 正文字体 · 分隔线型 · 编号形式 · 底纹 · 印章 · 留白节奏

这样同一套内容，美国实证传统的卡和法国理论传统的卡，读起来是两种气质，
而不只是换个色。

用法：
    from origins import style_for
    st = style_for(card)      # 返回完整风格字典，缺省回落 ink
"""

from marks import DEFAULT, MARKS, SCHOOL_MARKS, palette

ROMAN = ["", "Ⅰ", "Ⅱ", "Ⅲ", "Ⅳ", "Ⅴ", "Ⅵ", "Ⅶ", "Ⅷ", "Ⅸ", "Ⅹ", "Ⅺ", "Ⅻ"]
CN_NUM = "〇一二三四五六七八九十"


def fmt_num(n: int, style: str) -> str:
    """编号形式：01 / Ⅰ / ① / 一"""
    if style == "roman":
        return ROMAN[n] if 0 < n < len(ROMAN) else f"{n:02d}"
    if style == "cn":
        return CN_NUM[n] if 0 < n < len(CN_NUM) else f"{n:02d}"
    if style == "circled":
        return chr(0x2460 + n - 1) if 0 < n < 21 else f"{n:02d}"
    return f"{n:02d}"


# 底纹：极淡，只提供材质，不抢字
TEXTURE = {
    "dots": "radial-gradient(rgba(0,0,0,.055) 1px,transparent 1px)",
    "grid": ("linear-gradient(rgba(0,0,0,.045) 1px,transparent 1px),"
             "linear-gradient(90deg,rgba(0,0,0,.045) 1px,transparent 1px)"),
    "rules": "repeating-linear-gradient(to bottom,transparent 0 27px,rgba(0,0,0,.05) 27px 28px)",
    "none": None,
}
TEXTURE_SIZE = {"dots": "18px 18px", "grid": "24px 24px", "rules": "100% 28px", "none": "auto"}

BASE = {
    "palette": {},
    "display_font": '"Noto Serif SC",serif',
    "body_font": '"Noto Serif SC",serif',
    "label_font": '"Noto Sans SC",sans-serif',
    "rule": "1px solid",
    "rule_weight": "1px",
    "num_style": "zero",
    "texture": "none",
    "leading": "1.75",
    "tracking": ".01em",
}

# 各国/学派的完整设计语言
STYLES = {
    # 美国：实证与期刊传统 —— 无衬线标题、严格细线、两位编号、点阵
    "美国": {
        "display_font": '"Noto Sans SC",sans-serif',
        "body_font": '"Noto Serif SC",serif',
        "rule": "1px solid",
        "num_style": "zero",
        "texture": "dots",
        "leading": "1.72",
        "tracking": ".005em",
    },
    # 法国：理论传统 —— 高对比衬线、大留白、罗马数字、无底纹
    "法国": {
        "display_font": '"Noto Serif SC",serif',
        "body_font": '"Noto Serif SC",serif',
        "rule": "1px solid",
        "num_style": "roman",
        "texture": "none",
        "leading": "1.85",
        "tracking": ".04em",
    },
    # 德国：体系与表格 —— 无衬线、粗线、网格底纹、两位编号
    "德国": {
        "display_font": '"Noto Sans SC",sans-serif',
        "body_font": '"Noto Sans SC",sans-serif',
        "rule": "2px solid",
        "num_style": "zero",
        "texture": "grid",
        "leading": "1.7",
        "tracking": "0",
    },
    # 英国：古典政治经济学 —— 衬线、双线、横线纸底纹、罗马数字
    "英国": {
        "display_font": '"Noto Serif SC",serif',
        "body_font": '"Noto Serif SC",serif',
        "rule": "3px double",
        "num_style": "roman",
        "texture": "rules",
        "leading": "1.78",
        "tracking": ".02em",
    },
    # 中国：宋体标题、细线、中文数字、点阵
    "中国": {
        "display_font": '"Noto Serif SC",serif',
        "body_font": '"Noto Serif SC",serif',
        "rule": "1px solid",
        "num_style": "cn",
        "texture": "dots",
        "leading": "1.8",
        "tracking": ".06em",
    },
    "奥地利": {
        "display_font": '"Noto Serif SC",serif',
        "body_font": '"Noto Serif SC",serif',
        "rule": "2px solid",
        "num_style": "roman",
        "texture": "none",
        "leading": "1.75",
        "tracking": ".03em",
    },
}


def _country(card) -> str:
    c = str(card.get("origin_country") or "").strip()
    if c in STYLES:
        return c
    s = str(card.get("school") or "").strip()
    m = SCHOOL_MARKS.get(s)
    return m if m in STYLES else ""


def style_for(card) -> dict:
    """返回完整风格：调色板 + 字体 + 线型 + 编号 + 底纹 + 印章。"""
    st = dict(BASE)
    country = _country(card)
    if country:
        st.update(STYLES.get(country, {}))
    st["palette"] = palette(card)

    # 卡片自己的 style 覆盖：颜色进 palette，字体/行距进 st
    ov = card.get("style")
    if isinstance(ov, dict):
        pal_keys = {"cover", "cover_dim", "accent", "num", "paper", "page",
                    "line", "soft", "desk"}
        for k, v in ov.items():
            if k in pal_keys:
                st["palette"][k] = v
            elif k in st:
                st[k] = v
    st["emblem"] = MARKS.get(country, DEFAULT) if country else DEFAULT
    st["origin"] = country or "无明确提出者"
    st["texture_css"] = TEXTURE.get(st["texture"])
    st["texture_size"] = TEXTURE_SIZE.get(st["texture"], "auto")
    return st
