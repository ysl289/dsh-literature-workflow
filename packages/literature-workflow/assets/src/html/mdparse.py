#!/usr/bin/env python3
# -*- coding: utf-8 -*-
r"""
mdparse —— 两个 deck 生成器共用的 md / 资产解析层

为什么要有这一层：
    v1 里 build_design 和 build_lecture 各自写了一套 `_txt/_clip/_ident`，字段口径不一致；
    而且 md 只被当成「找不到时随便抄一段」的兜底。实际上 pdf2md 产出的 md 里有几样
    extract.json 里根本没有、但 deck 很需要的东西：

        * 作者与单位（封面「作者单位：【待补】」就是这里能补的）
        * 图注 / 表注（「图 2 平行趋势假设评估」这种，是给图配文的唯一线索）
        * 章节层级（用来定位「识别策略」「稳健性」在哪一段）
        * 脚注与参考文献
        * 页码锚点（`<!-- pdf2md: page N -->`，用于来源角标）

本模块只做**解析**，不做语义改写：抓到什么给什么，抓不到就是空。

用法：
    from mdparse import load_md, load_assets
    md = load_md(r"staging\chen2004.md")
    md["sections"]["Identification"]      # 章节正文
    md["title_block"]["affiliation"]      # 作者单位
    md["captions"]                        # [{kind, num, text, page}]
    assets = load_assets(r"staging\assets\chen2004")
"""

from __future__ import annotations

import json
import re
from pathlib import Path

__all__ = ["load_md", "load_assets"]

_HEAD_RE = re.compile(r"^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$")
_PAGE_RE = re.compile(r"<!--\s*pdf2md:\s*page\s+(\d+)\s*-->", re.I)
_CAP_RE = re.compile(
    r"^\s*(?:#{1,6}\s*)?"
    r"(图|表|Figure|Table|Fig\.?)\s*"
    r"([0-9]{1,2}|[IVX]{1,4}|[A-Z][0-9]?)\b"
    r"[\s\.、:：\-—]*(.*)$",
    re.I,
)
_AFFIL_RE = re.compile(
    r"(大学|学院|研究院|研究所|研究中心|University|Universit[äe]|College|School|Institute|Department|Faculty)",
    re.I,
)
# 中文期刊的单位行是「北京大学经济学院」这种整行就是机构名。
# 不能用 _AFFIL_RE 直接扫：中文论文标题「…改善大学科研创新效率」里也含「大学」，
# 会把标题当成单位印到封面上。所以要求关键词落在行尾。
_EN_AFFIL_RE = re.compile(
    r"(University|Universit[äe]|College|School of|Institute of|Department of|Faculty of)", re.I
)
_CN_AFFIL_RE = re.compile(
    r"^([\u4e00-\u9fa5（）()·\s]{2,24}(?:大学|学院|研究院|研究所|研究中心|科学院|党校))$"
)
# 作者单位最常出现在首页脚注里，形如
#   "Chen, Norohna, and Singal are from University of Central Florida, Arizona State
#    University West, and Virginia Tech, respectively."
# 这种句子长度远超「单位行」的直觉上限，靠 _AFFIL_RE + 长度阈值会全部漏掉。
_AFFIL_FROM_RE = re.compile(
    r"(?:are|is)\s+(?:from|at|with)\s+(.{8,180}?)(?:,\s*respectively|\.\s|\.$|$)", re.I
)
# 页眉页脚里的页码：只认两种形态——整行就是一个数（「1901」），
# 或者行首是数后接空格（「1902 The Journal of Finance」）。
# 正文里「…政策出台时点 2015」这种行尾数字绝不能当页码，否则整页图注会被指到错误页。
_PAGENUM_RE = re.compile(r"^\s*(\d{1,4})\s*$|^\s*(\d{1,4})\s+\S")
_JOURNAL_RE = re.compile(
    r"(学报|期刊|杂志|评论|Journal|Review|Economic|Economics|Finance|Letters|Quarterly|"
    r"American|European|China)",
    re.I,
)
_YEAR_RE = re.compile(r"\b(19|20)\d{2}\b")


def _clean(s: str) -> str:
    s = re.sub(r"[`*_>#]", "", s or "")
    s = re.sub(r"\s+", " ", s)
    return s.strip()


# 图注质量闸：中文 PDF 转出来的 md 常把表头里的碎句误当成图注
# （「第( 1 ) 列结果说明择优支持式的中国高等教」这种），印到页面上比空着更糟。
_CAP_BAD_HEAD = ("第", "其中", "本文", "从表", "由表", "见表", "见下", "注", "数据", "数测算", "为", "由")
_CAP_BAD_TAIL = ("见", "如下", "为", "的", "，", "、", "和", "与", "：")


def _cap_ok(t: str) -> bool:
    if not (5 <= len(t) <= 160):
        return False
    return not (t.startswith(_CAP_BAD_HEAD) or t.endswith(_CAP_BAD_TAIL))


def load_md(path: str | Path | None) -> dict:
    """把 pdf2md 的 md 解析成 deck 能直接用的结构。文件不存在返回 {}。"""
    if not path:
        return {}
    p = Path(path)
    if not p.exists():
        return {}
    text = p.read_text(encoding="utf-8", errors="replace")
    lines = text.splitlines()

    # YAML front matter（--- … ---）是 pdf2md 的元信息，不是正文。
    # 不剥掉的话，`title:` 那行会被当成作者单位、`---` 会被当成作者名。
    if lines and lines[0].strip() == "---":
        for j in range(1, min(len(lines), 80)):
            if lines[j].strip() == "---":
                lines = lines[j + 1:]
                break

    # ── 章节树 ──────────────────────────────────────────────
    sections: dict[str, str] = {}
    cur: str | None = None
    buf: list[str] = []
    for line in lines:
        m = _HEAD_RE.match(line)
        if m:
            if cur:
                sections[cur] = "\n".join(buf).strip()
            cur, buf = _clean(m.group(2)), []
        elif cur is not None:
            buf.append(line)
    if cur:
        sections[cur] = "\n".join(buf).strip()

    # ── 图注 / 表注：优先从标题行拿，其次从正文行首拿 ──────────────
    # pdf2md 老版本不写 `<!-- pdf2md: page N -->` 锚点，页码只能从页眉页脚的
    # 独立数字（「… Additions and Deletions 1903」「1901」）里认。认不出就是 None，
    # 不猜——页码是给人回原文翻页用的，猜错比空着更糟。
    captions: list[dict] = []
    page = None
    seen: set[tuple[str, str]] = set()
    for i, line in enumerate(lines):
        pm = _PAGE_RE.search(line)
        if pm:
            page = int(pm.group(1))
            continue
        pn = _PAGENUM_RE.match(line)
        if pn:
            num_s = pn.group(1) or pn.group(2) or ""
            rest_of = line[pn.end(1) if pn.group(1) else pn.end(2):].strip()
            # 只认「期刊页码」形态：1800–2100 的四位数，且同行剩余部分要么为空、
            # 要么是英文刊头。中文正文里的「2025 年」「403」一律不认。
            if (num_s.isdigit() and 1800 <= int(num_s) <= 2100
                    and not re.search(r"[\u4e00-\u9fff]", rest_of)
                    and (not rest_of or re.search(r"[A-Za-z]", rest_of))):
                page = int(num_s)
                continue
        m = _CAP_RE.match(line)
        if not m:
            continue
        kind_raw, num, rest = m.group(1).lower(), m.group(2).upper(), _clean(m.group(3))
        rest = rest.lstrip("。．.，,、：:；;—–- ")
        kind = "figure" if kind_raw.startswith(("图", "fig")) else "table"
        if not _cap_ok(rest):
            # 「Table IV」独立成行、标题另起：往回找最近的一行短文本当标题
            # （通常就是上面的 `## Institutional Ownership` 这类小节标题）
            rest = ""
            for back in range(i - 1, max(-1, i - 4), -1):
                cand = _clean(lines[back])
                if not cand or cand.lower().startswith(("table", "figure", "fig")):
                    continue
                if _cap_ok(cand):
                    rest = cand
                break
            if not rest:
                continue
        key = (kind, num)
        if key in seen:
            continue
        seen.add(key)
        captions.append({"kind": kind, "num": num, "text": rest, "page": page})

    # ── 封面要素：只看前 40 行，避免正文里的机构名混进来 ────────────
    head_lines = [l for l in lines[:40] if l.strip()]
    authors = ""
    affiliation = ""
    journal = ""
    year = ""

    # 先试首页脚注那种「A, B, and C are from X, Y, and Z」的长句（Chen 这类老论文都这么写）
    for raw in lines[:60]:
        m = _AFFIL_FROM_RE.search(_clean(raw))
        if m and _AFFIL_RE.search(m.group(1)):
            affiliation = m.group(1).strip(" ，,、")
            break

    for i, raw in enumerate(head_lines):
        s = _clean(raw)
        if not s:
            continue
        if not affiliation:
            cn = _CN_AFFIL_RE.match(s)
            if cn:
                affiliation = cn.group(1).strip()
                if not authors and i > 0:
                    prev = _clean(head_lines[i - 1])
                    if 2 <= len(prev) <= 60 and not _HEAD_RE.match(head_lines[i - 1]):
                        authors = prev
        if not affiliation and _EN_AFFIL_RE.search(s) and len(s) <= 90:
            # 去掉括号与邮编
            affiliation = re.sub(r"^[（(\s]+|[）)\s]+$", "", s)
            affiliation = re.sub(r"[，,]\s*[\u4e00-\u9fa5]{2,8}\s*\d{5,6}", "", affiliation)
            affiliation = affiliation.strip(" ，,、")
            # 上一行常常就是作者名
            if not authors and i > 0:
                prev = _clean(head_lines[i - 1])
                if 2 <= len(prev) <= 60 and not _HEAD_RE.match(head_lines[i - 1]):
                    authors = prev
        if not journal and _JOURNAL_RE.search(s) and len(s) <= 90:
            journal = s
        if not year:
            ym = _YEAR_RE.search(s)
            if ym:
                year = ym.group(0)

    # ── 脚注与参考文献 ────────────────────────────────────────
    footnotes = [l.strip() for l in lines if re.match(r"^\s*\[\^?\d{1,2}\]", l)]
    refs_start = next(
        (i for i, l in enumerate(lines) if re.match(r"^\s*#{1,6}\s*(References|参考文献)\s*$", l, re.I)),
        None,
    )
    refs = []
    if refs_start is not None:
        for l in lines[refs_start + 1:]:
            if _HEAD_RE.match(l):
                break
            s = _clean(l)
            if len(s) > 20:
                refs.append(s)

    return {
        "path": str(p),
        "chars": len(text),
        "sections": sections,
        "captions": captions,
        "footnotes": footnotes[:40],
        "refs": refs[:80],
        "title_block": {
            "authors": authors,
            "affiliation": affiliation,
            "journal": journal,
            "year": year,
        },
    }


def load_assets(path: str | Path | None) -> dict:
    """读 mdassets 产出的资产目录。目录不存在返回 {}。"""
    if not path:
        return {}
    d = Path(path)
    if not d.exists():
        return {}
    out: dict = {"dir": str(d), "figures": [], "tables": [], "page_map": {}}
    for name, key in (("figures.json", "figures"), ("tables.json", "tables"), ("page_map.json", "page_map")):
        f = d / name
        if f.exists():
            try:
                out[key] = json.loads(f.read_text(encoding="utf-8"))
            except (json.JSONDecodeError, OSError):
                pass
    return out
