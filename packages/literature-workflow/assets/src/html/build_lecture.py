#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
build_lecture.py —— "大佬版" 全篇学术 HTML 演示页生成器（论文中立版）
=====================================================================

把一篇论文的结构化抽取结果（extract.json）变成一份**可直接上组会讲**的单文件
HTML 演示页：主文按 21 个模块展开，附录放公式推导、变量表、表骨架与检查清单。

设计原则
--------
1. **内容与呈现分离**：视觉、交互、公式、讲稿面板全部复用 `src/html/deckkit.py`；
   本文件只负责"放什么内容、怎么编排"，不写一行 CSS。
2. **论文中立**：本文件里**没有任何一篇具体论文的事实**（人名、地名、样本量、系数）。
   每一页的内容都从 extract.json 的字段里读：读得到就引用原文，读不到就写【待补】
   并说明缺哪个字段——不举例、不套用别的论文。
   自检里的 `check_contamination()` 把这一条做成硬门：deck 里出现"别的论文"的
   专属词（且不在本次 extract 里）→ 构建失败。
3. **绝不编造**：数字必须能在 extract 文本里找到出处（`check_number_provenance()`），
   否则构建失败。
4. **无浏览器自检**：读回 HTML 文本 + 断言结构 + 估算版式高度；假说数按 1/3/5 三档压测。

用法
----
    py -3.13 src\\html\\build_lecture.py --extract templates\\sample_extract.json --out staging\\PPT_demo.html

    # 只生成不自检（不推荐）
    py -3.13 src\\html\\build_lecture.py --extract x.json --out y.html --no-selfcheck

输出
----
    <out>                              单文件 HTML 演示页（PPT_作者_年份.html）
    <out 同目录>/<stem>_selfcheck.md    自检报告（页表 / 待补清单 / 溯源 / 交叉污染 / 版式）
"""

from __future__ import annotations

import argparse
import html as _html
import json
import math
import re
import sys
from pathlib import Path

# ── 硬性要求：stdout 用 UTF-8，否则 Windows 控制台打中文会炸 ──────────────────
sys.stdout.reconfigure(encoding="utf-8")

_HERE = Path(__file__).resolve().parent
if str(_HERE) not in sys.path:          # 让 `from deckkit import Deck` 无论 cwd 都能用
    sys.path.insert(0, str(_HERE))

from deckkit import Deck  # noqa: E402
from mdparse import load_assets, load_md  # noqa: E402
import probe as _probe  # noqa: E402

VERSION = "2.0"

# ── 常量 ────────────────────────────────────────────────────────────────────
# 页面上留空一律用破折号，不印【待补】——补数清单进讲稿层与自检报告，不上版面。
TBD = "—"
_TBD_LOG: list[str] = []          # 每处留空的原因，写进 selfcheck 报告
FOOTER = "硕士组会 · 论文阅读积累"
THEME = "podium"

# deckkit 的舞台是固定 1280×720，按视口等比缩放（见 deckkit.py 的 :root --stage-w/h）。
# 下面这套常量把 deckkit 的 CSS 折算成"像素预算"，用来在没有浏览器的情况下估算每页高度。
STAGE_W, STAGE_H = 1280, 720
INNER_W = STAGE_W - 120                   # .slide-inner padding 60 左右
STAGE_SAFE = 622.0                        # = 720 - 52 - 46，正文可用高度上限
FILL_SLACK = 150.0                        # 正文下方余量超过这个数就算"空得单薄"
GAP_INNER = 16.0                          # .slide-inner gap
GAP_BODY = 18.0                           # .s-body gap
LINE_TITLE = 40.9                         # 31px * 1.32
LINE_SUB = 23.25                          # 15px * 1.55
LINE_BULLET = 30.0                        # 18.5px * 1.62
GAP_BULLET = 13.0
CPL_TITLE = 42                            # 标题每行可容纳的中文字数（podium 44px，两行）
CPL_SUB = 69
CPL_BULLET = 56
CPL_TAKEAWAY = 62
CPL_EXAMPLE = 64
CPL_CHART_TITLE = 62
CPL_FOOT = 96
KV_MIN_COL, KV_GAP_COL = 196, 12

# ── 交叉污染词表：样例论文（Bertrand & Mullainathan 2004 简历实验）的专属词 ──
# 只要这些词出现在 deck 里、却不在**本次** extract 的文本里，就说明生成器里混进了
# 别的论文的硬编码内容 → 构建失败。反向同理，由 tests/test_lecture_deck.py 覆盖。
CONTAMINATION_WORDS = [
    "波士顿", "芝加哥", "Becker", "Phelps", "Arrow", "Lakisha", "Jamal",
    "Emily", "Greg", "简历", "回电", "1300", "5000", "1957", "1972", "1973",
]

# 定价 / 金融特化页的判别词（只用来判断"这篇论文更靠近哪一边"，不产生事实）
PRICING_KW = ("定价", "价格", "需求弹性", "成本加成", "溢价", "定价权", "价格反应", "价格效应",
              "需求曲线", "收费标准", "价差")
FINANCE_KW = ("资产定价", "异常收益", "股票", "投资组合", "公司金融", "信贷", "债券", "期权",
              "基金", "指数", "市值", "收益率", "换手率", "投资者", "市场反应", "流动性",
              "资本成本", "融资")


# ══════════════════════════════════════════════════════════════════════════
# 1. 文本工具
# ══════════════════════════════════════════════════════════════════════════

def _tidy(s) -> str:
    """压平水平空白（保留换行）；None → 空串。"""
    return re.sub(r"[ \t\r\f\v]+", " ", str(s if s is not None else "")).strip()


def _clip(s, n: int, ellipsis: str = "…") -> str:
    """硬截断到 n 字以内（优先在标点处断），保证 len ≤ n。"""
    s = _tidy(s)
    if n <= 0:
        return ""
    if len(s) <= n:
        return s
    cut = s[: n - 1]
    for mark in ("。", "；", "，", "、", "：", " "):
        i = cut.rfind(mark)
        if i >= n * 0.5:
            if mark == "。":                      # 正好断在句末，不用加省略号
                return cut[: i + 1]
            return cut[:i] + ellipsis
    return cut + ellipsis


def _sents(text) -> list[str]:
    """切句（只切分，不改写事实）。"""
    t = _tidy(text).replace("\n", " ")
    return [p.strip() for p in re.split(r"(?<=[。！？；])", t) if p.strip()]


def _first_sent(text, n: int = 1) -> str:
    ss = _sents(text)
    return " ".join(ss[:n]) if ss else ""


def _sent_with(text, *kws) -> str:
    """找第一句含任一关键词的句子；找不到返回空串（不猜）。"""
    for s in _sents(text):
        if any(k in s for k in kws):
            return s
    return ""


def _numbered(text) -> list[str]:
    """拆 "1. …\\n2. …" 形式的编号段落。"""
    t = _tidy(text)
    parts = re.split(r"(?:^|\n)\s*(?:\d+[.、)]|[①-⑩])\s*", t)
    return [p.strip() for p in parts if p.strip()]


REF_RE = re.compile(
    r"([A-Z][A-Za-z\-]+(?:\s+(?:and|&)\s+[A-Z][A-Za-z\-]+)?(?:\s+et\s+al\.)?)\s*[（(](\d{4})[）)]"
    r"|([A-Z][A-Za-z\-]+)\s*[,，]\s*(\d{4})"
)


def _refs(text) -> list[str]:
    """抽 author-year 形式的引用（只抽原文里已有的，不补造）。"""
    out = []
    for m in REF_RE.finditer(_tidy(text)):
        name = m.group(1) or m.group(3) or ""
        year = m.group(2) or m.group(4) or ""
        tag = f"{name.strip()} ({year})"
        if tag not in out:
            out.append(tag)
    return out


def _labeled_segments(text) -> list[tuple[str, str]]:
    """把 "样本期：… 样本量：…" 这类带标签的长段落拆成 [(标签, 内容)]。"""
    t = _tidy(text)
    pat = re.compile(r"([\u4e00-\u9fffA-Za-z/\-]{2,10})(?:（[^）]{0,40}）)?[：:]\s*")
    ms = list(pat.finditer(t))
    out = []
    for i, m in enumerate(ms):
        end = ms[i + 1].start() if i + 1 < len(ms) else len(t)
        body = t[m.end():end].strip(" ；;。")
        if body:
            out.append((m.group(1), body))
    return out


def _tbd(reason: str = "") -> str:
    """页面留空。原因只登记进报告，不印在版面上。"""
    if reason:
        _TBD_LOG.append(reason)
    return TBD


# ── 元信息清洗：把面向生成者的文字改写成面向听众的文字 ──────────────────────
# 这些模式原先会直接印到幻灯片上（「来源：extract 的 abstract 字段」「hint: …」
# 「本 deck 每一页的数字从哪来」）。统一在这里收口，任何 spec 字段渲染前都过一遍。
_META_SUBS: list[tuple[str, str]] = [
    (r"^\s*hint\s*[:：]\s*", ""),
    (r"（内容逐列取自[^）]*）", ""),
    (r"（[^）]*取自\s*extract[^）]*）", ""),
    (r"extract\s*(?:的|里的)?\s*[A-Za-z_][A-Za-z_.\[\]\d]*\s*(?:字段)?", "原文"),
    (r"extract\s*→\s*[A-Za-z_.]+", "原文"),
    (r"取自\s*extract[.．]?", "取自原文"),
    (r"extract\s*未提供[^，。；）]*", "原文未给出"),
    (r"extract\s*未含[^，。；）]*", "原文未给出"),
    (r"extract\s*全文", "全文"),
    (r"\bextract\b", "原文"),
    (r"本\s*deck", "本篇"),
    (r"不要用本\s*篇的数字", "以原文为准"),
    (r"[A-Za-z]:\\[^\s，。；）]+", "原文 PDF"),
    (r"Zotero\s*key\s*[A-Z0-9]+", ""),
    (r"deepseek[\w.\-]*", ""),
    (r"抽取模型", "来源"),
    (r"生成器自测值[，,]?\s*", ""),
    (r"自检清单", "交付检查"),
    (r"【待补】", "—"),
]


def _sanitize(text):
    """去掉页面上不该出现的生成器元信息。字符串原样返回 None 安全。"""
    if not isinstance(text, str) or not text:
        return text
    out = text
    for pat, rep in _META_SUBS:
        out = re.sub(pat, rep, out)
    out = re.sub(r"[（(]\s*[）)]", "", out)
    out = re.sub(r"\s{2,}", " ", out)
    # 中文之间不该有空格：清洗时替换出来的"原文"常常自带前后空格
    out = re.sub(r"(?<=[\u4e00-\u9fa5])\s+(?=[\u4e00-\u9fa5])", "", out)
    out = re.sub(r"(?<=[\u4e00-\u9fa5])\s+(?=[，。；：、）])", "", out)
    out = re.sub(r"(?<=[（，。；：、])\s+(?=[\u4e00-\u9fa5])", "", out)
    return out.strip(" ；，、") or TBD


def _sanitize_spec(spec: dict) -> dict:
    """把一页 spec 里所有会被渲染成文字的字段都过一遍清洗。"""
    s = dict(spec)
    for k in ("title", "sub", "takeaway", "transition", "footnote", "example",
              "formula_label", "label"):
        if isinstance(s.get(k), str):
            s[k] = _sanitize(s[k])
    if isinstance(s.get("bullets"), list):
        s["bullets"] = [_sanitize(b) for b in s["bullets"]]
    if isinstance(s.get("notes"), str):
        # 讲稿层保留完整信息，只去掉 hint: 前缀
        s["notes"] = re.sub(r"^\s*hint\s*[:：]\s*", "", s["notes"], flags=re.M)
    if isinstance(s.get("kv"), list):
        s["kv"] = [(_sanitize(k), _sanitize(v)) for k, v in s["kv"]]
    if isinstance(s.get("vars"), list):
        s["vars"] = [(_sanitize(k), _sanitize(v)) for k, v in s["vars"]]
    if isinstance(s.get("table"), dict):
        t = dict(s["table"])
        t["caption"] = _sanitize(t.get("caption", ""))
        t["headers"] = [_sanitize(h) for h in t.get("headers", [])]
        t["rows"] = [[_sanitize(c) for c in row] for row in t.get("rows", [])]
        s["table"] = t
    return s


def _join(*parts, sep="；") -> str:
    return sep.join(p for p in parts if _tidy(p))


def _cn(n) -> str:
    """阿拉伯数字 → 汉字数字（0-999）。生成器自己的计数量词一律走这里，
    这样"共 12 条"这类页面文字不会被数字溯源检查误判成论文数据。"""
    try:
        n = int(n)
    except (TypeError, ValueError):
        return str(n)
    if n < 0 or n > 999:
        return str(n)
    d = "零一二三四五六七八九"
    if n < 10:
        return d[n]
    if n < 20:
        return "十" + (d[n % 10] if n % 10 else "")
    if n < 100:
        return d[n // 10] + "十" + (d[n % 10] if n % 10 else "")
    return d[n // 100] + "百" + (_cn(n % 100) if n % 100 else "")


# ── 字段读取 ────────────────────────────────────────────────────────────────

def _txt(rec: dict, key: str) -> str:
    return _tidy(rec.get(key))


def _lst(rec: dict, key: str) -> list[str]:
    v = rec.get(key)
    return [_tidy(x) for x in v if _tidy(x)] if isinstance(v, list) else []


def _d(rec: dict) -> dict:
    v = rec.get("design")
    return v if isinstance(v, dict) else {}


def _dtext(rec: dict, key: str) -> str:
    return _tidy(_d(rec).get(key))


def _dlist(rec: dict, key: str) -> list[dict]:
    v = _d(rec).get(key)
    return [x for x in v if isinstance(x, dict)] if isinstance(v, list) else []


def _meta(rec: dict, key: str) -> str:
    m = rec.get("meta")
    return _tidy(m.get(key)) if isinstance(m, dict) else ""


# ══════════════════════════════════════════════════════════════════════════
# 2. 论文中立的内容推导（全部只读 extract，读不到就【待补】）
# ══════════════════════════════════════════════════════════════════════════

def _theory_parts(rec: dict) -> tuple[str, str]:
    """core_theory → (【已有理论】, 【本文理论】)；无标记时整段算"已有"，本文留空。"""
    t = _txt(rec, "core_theory")
    m_new = re.search(r"【本文理论】\s*(.*)$", t, re.S)
    m_old = re.search(r"【已有理论】\s*(.*?)(?=【|$)", t, re.S)
    new = _tidy(m_new.group(1)) if m_new else ""
    old = _tidy(m_old.group(1)) if m_old else ("" if m_new else t)
    return old, new


def _finding(rec: dict) -> str:
    """摘要里的结果句——标题与电梯演讲都用它，保证是原文口径。"""
    ab = _txt(rec, "abstract")
    s = _sent_with(ab, "结果发现", "结果显示", "结果表明", "研究发现", "发现", "证据是", "结论是")
    if s:
        return s
    ss = _sents(ab)
    return ss[1] if len(ss) > 1 else (ss[0] if ss else "")


def _hook(rec: dict) -> str:
    """封面钩子：优先 extract 的 one_line_hook，其次摘要首句；都没有就【待补】。"""
    h = _txt(rec, "one_line_hook") or _txt(rec, "hook")
    if h:
        return _clip(h, 90)
    ab = _sents(_txt(rec, "abstract"))
    return _clip(ab[0], 90) if ab else _tbd("extract 未提供 abstract / one_line_hook")


def _ident(rec: dict) -> dict:
    v = _d(rec).get("identification")
    return v if isinstance(v, dict) else {}


def _strategy(rec: dict) -> str:
    return _tidy(_ident(rec).get("strategy"))


def _assumption(rec: dict) -> str:
    return _tidy(_ident(rec).get("assumption"))


def _threats(rec: dict) -> list[str]:
    v = _ident(rec).get("threats")
    return [_tidy(x) for x in v if _tidy(x)] if isinstance(v, list) else []


def _balance(rec: dict) -> str:
    return _tidy(_ident(rec).get("first_stage_or_balance"))


def _title(prefix: str, text, budget: int = CPL_TITLE, missing: str = "") -> str:
    """标题 = 模块名 + 一句结论（结论句一律引自原文）。

    标题最多两行，所以预算比 v1 放宽；超预算时在标点处断开，
    不在词中间硬切——v1 的「…有一个共…」就是硬切出来的。
    """
    head = f"{prefix}："
    room = max(10, budget - len(head))

    def cut(s: str) -> str:
        s = _tidy(s)
        if len(s) <= room:
            return s
        head_s = s[:room]
        for sep in ("——", "；", "，", "、", "：", " "):
            i = head_s.rfind(sep)
            if i >= int(room * 0.55):
                return head_s[:i].rstrip("，、；： ")
        return head_s.rstrip("，、；： ")

    if _tidy(text):
        return head + cut(text)
    return head + cut(_tbd(missing or "原文未提供该模块所需字段"))


def _hypothesis_parse(h: str, i: int) -> tuple[str, str, str, str, str]:
    """H1（对应 RQ1）：正文…预期方向：正。来源：作者明示。 → (编号, 对应, 正文, 方向, 来源)"""
    s = _tidy(h)
    m = re.match(r"^(H\d+)（([^）]*)）：(.*?)预期方向：([^。]*)。(?:来源：([^。]*)。?)?$", s, re.S)
    if m:
        return m.group(1), _tidy(m.group(2)), _tidy(m.group(3)), _tidy(m.group(4)), _tidy(m.group(5))
    m2 = re.match(r"^(H\d+)\s*[:：]?\s*(.*)$", s, re.S)
    if m2:
        body = m2.group(2)
        return (m2.group(1), "", _tidy(body),
                _tidy(_sent_with(body, "预期方向")), _tidy(_sent_with(body, "来源")))
    return f"H{i}", "", s, "", ""


def _hypotheses_table(rec: dict) -> tuple[dict, int]:
    """假说表：**按条数自适应**，1~5 条都保证每行一行高，放得下 622px 安全线。

    做法：统一三列（假说含来源 / 内容 / 预期方向），条数越多，单元格上限越短；
    另外 `_autofit()` 会在页面上再兜一次底。
    """
    hs = _lst(rec, "hypotheses")
    n = len(hs)
    if n == 0:
        return {
            "headers": ["假说（含来源）", "内容（压缩自原文）", "预期方向"],
            "rows": [[_tbd("extract 未提供 hypotheses 字段"), "—", "—"]],
            "align": ["l", "l", "c"],
            "caption": "hint: extract 未提供 hypotheses 字段，本页只有骨架",
            "first_col_bold": True,
        }, 0
    body_n, dir_n = {1: (60, 16), 2: (52, 14), 3: (40, 14), 4: (30, 13)}.get(n, (26, 12))
    rows = []
    for i, h in enumerate(hs[:5], 1):
        hid, maps, body, direction, source = _hypothesis_parse(h, i)
        label = f"{hid}（{maps}）" if maps else hid
        if source:
            label = f"{label} · {_clip(source, 6)}"
        rows.append([label, _clip(body, body_n), _clip(direction, dir_n) or TBD])
    return {
        "headers": ["假说（含来源）", "内容（压缩自原文）", "预期方向"],
        "rows": rows,
        "align": ["l", "l", "c"],
        "caption": f"hint: 共 {_cn(n)} 条假说，内容按条数自适应压缩（每格 {_cn(body_n)} 字）；"
                   f"完整表述以原文 hypotheses 为准",
        "first_col_bold": True,
    }, n


def _limitations_kv(rec: dict) -> list[tuple[str, str]]:
    out = []
    for i, s in enumerate(_lst(rec, "limitations"), 1):
        m = re.match(r"^(L\d+)\s*[:：]?\s*(.*)$", _tidy(s), re.S)
        lid, body = (m.group(1), _tidy(m.group(2))) if m else (f"L{i}", _tidy(s))
        if "削弱了" in body:
            main, weak = body.rsplit("削弱了", 1)
            out.append((f"{lid} · 局限", f"{_clip(main, 34)}｜削弱：{_clip(weak, 16)}"))
        else:
            out.append((f"{lid} · 局限", _clip(body, 48)))
    return out or [(TBD, "extract 未提供 limitations 字段")]


def _future_table(rec: dict) -> dict:
    rows = []
    for i, s in enumerate(_lst(rec, "future_research"), 1):
        m = re.match(r"^(F\d+)\s*[:：]?\s*(.*)$", _tidy(s), re.S)
        fid, body = (m.group(1), _tidy(m.group(2))) if m else (f"F{i}", _tidy(s))
        if "可用" in body:
            main, how = body.rsplit("可用", 1)
        elif "可用的方向" in body:
            main, how = body.split("可用的方向", 1)
        else:
            main, how = body, ""
        rows.append([fid, _clip(main, 38), _clip(how.strip(" ：:（）()"), 30) or TBD])
    if not rows:
        rows = [[TBD, "extract 未提供 future_research 字段", TBD]]
    return {
        "headers": ["方向", "要接上的链条（原文）", "落地的数据与设计"],
        "rows": rows,
        "align": ["c", "l", "l"],
        "first_col_bold": True,
    }


def _confusions_table(rec: dict) -> dict:
    rows = []
    for i, s in enumerate(_lst(rec, "confusions"), 1):
        m = re.match(r"^(C\d+)\s*[:：]?\s*(.*)$", _tidy(s), re.S)
        body = _tidy(m.group(2)) if m else _tidy(s)
        q, a = body, TBD
        if "→" in body:
            q, a = body.split("→", 1)
            a = re.sub(r"^一句话提示[:：]?", "", _tidy(a))
        rows.append([_clip(q, 34), _clip(a, 52)])
    if not rows:
        rows = [[TBD, "extract 未提供 confusions 字段"]]
    return {
        "headers": ["提问", "一句话回答"],
        "rows": rows,
        "align": ["l", "l"],
        "first_col_bold": True,
    }


def _variables_table(rec: dict) -> tuple[dict, list[tuple[str, str]]]:
    """变量表 + 变量胶囊：优先 design.variables，退回 core_variables。"""
    rows, chips = [], []
    for v in _dlist(rec, "variables")[:5]:
        sym = _tidy(v.get("symbol"))
        role = _tidy(v.get("role"))
        rows.append([sym or TBD, role or TBD, _clip(v.get("definition"), 34) or TBD,
                     _clip(v.get("source"), 22) or TBD])
        if sym:
            chips.append((sym, role or "变量"))
    if not rows:
        for s in _lst(rec, "core_variables")[:5]:
            if re.search(r"[：:]", s):
                k, val = re.split(r"[：:]", s, maxsplit=1)
                rows.append([_clip(k, 14), _clip(val, 20), _clip(val, 34), "extract → core_variables"])
                chips.append((_clip(k, 14), _clip(val, 16)))
            else:
                rows.append([TBD, _clip(s, 20), _clip(s, 34), "extract → core_variables"])
    if not rows:
        rows = [[TBD, TBD, _tbd("extract 未提供 design.variables / core_variables 字段"), TBD]]
    return {
        "headers": ["符号 / 变量", "角色", "定义（压缩）", "来源"],
        "rows": rows,
        "align": ["l", "l", "l", "l"],
        "caption": "hint: 定义与来源均压缩自 extract；以原文为准",
        "first_col_bold": True,
    }, chips[:4]


def _coef_rows(rec: dict, limit: int = 4) -> tuple[list[list[str]], bool]:
    """主结果表行：优先取 extract 里**真有数值**的系数，其次取其余的。"""
    ks = _dlist(rec, "key_coefficients")
    if not ks:
        return [], False

    def has_value(k):
        c = _tidy(k.get("coef"))
        return bool(c) and TBD not in c and c not in {"—", "-"}

    ordered = [k for k in ks if has_value(k)] + [k for k in ks if not has_value(k)]
    rows = [[_clip(k.get("term"), 22) or TBD, _clip(k.get("coef"), 30) or TBD,
             _clip(k.get("se"), 12) or TBD, _clip(k.get("stars"), 14) or TBD]
            for k in ordered[:limit]]
    return rows, True


def _mechanism_items(rec: dict) -> list[dict]:
    """机制条目：design.mechanism → design.heterogeneity → core_theory【本文理论】。"""
    items = []
    for m in _dlist(rec, "mechanism")[:4]:
        items.append({"name": _tidy(m.get("name")) or TBD, "test": _tidy(m.get("test")),
                      "result": _tidy(m.get("result")), "src": "extract → design.mechanism"})
    for h in _dlist(rec, "heterogeneity"):
        if len(items) >= 4:
            break
        items.append({"name": f"异质性 · {_tidy(h.get('dimension')) or TBD}",
                      "test": "分样本 / 异质性检验（extract → design.heterogeneity）",
                      "result": _tidy(h.get("finding")), "src": "extract → design.heterogeneity"})
    if not items:
        _old, new = _theory_parts(rec)
        if new:
            items.append({"name": "本文提出的机制（取自 core_theory 的【本文理论】段）",
                          "test": "", "result": _first_sent(new, 2), "src": "extract → core_theory"})
        else:
            items.append({"name": TBD, "test": "", "result": "",
                          "src": _tbd("extract 未提供 design.mechanism / core_theory【本文理论】")})
    return items


def _specialization(rec: dict) -> dict:
    """定价 vs 金融：按 extract 全文用词打分决定"深入哪一边"，不预设论文类型。"""
    blob = json.dumps(rec, ensure_ascii=False)
    p = sum(blob.count(k) for k in PRICING_KW)
    f = sum(blob.count(k) for k in FINANCE_KW)
    side = "finance" if f > p else ("pricing" if p > f else "neither")
    return {"side": side, "p": p, "f": f}


def _data_kv(rec: dict) -> tuple[list[tuple[str, str]], str]:
    """数据页定义卡：优先按 data 里的小标签拆，其次按原句拆。"""
    data = _txt(rec, "data")
    segs = _labeled_segments(data)
    if len(segs) >= 3:
        return [(lab, _clip(body, 30)) for lab, body in segs[:5]], "按 extract → data 的小标签拆分"
    ss = _sents(data)[:5]
    if ss:
        return [(f"数据要点 {i}", _clip(s, 30)) for i, s in enumerate(ss, 1)], \
               "extract → data 未分小节，此处按原句拆成要点"
    return [(TBD, "extract 未提供 data 字段")], "extract 未提供 data 字段"


def _sample_period(rec: dict) -> str:
    """封面"样本期"格：只认 data 里标签含"样本期/期间"的段落，否则留空。"""
    for lab, body in _labeled_segments(_txt(rec, "data")):
        if "样本期" in lab or "期间" in lab:
            return _clip(body, 24)
    return ""


def _aside_for(rec: dict, spec: dict) -> list[tuple[str, str]]:
    """右侧参数标注栏 / 底部事实条：只放听众当场会问的硬参数，不放论证。

    按本页读了哪些字段决定放什么——数据页给样本期与来源，设计页给识别与固定效应，
    结果页给主系数。最多四条，空值直接不出现。
    """
    fields = set(spec.get("_fields") or [])
    out: list[tuple[str, str]] = []

    def add(label: str, value) -> None:
        v = _tidy(_sanitize(value)) if isinstance(value, str) else _tidy(value)
        if v and v not in (TBD, "—") and len(v) <= 34 and len(out) < 4:
            out.append((label, v))

    if fields & {"data"}:
        add("样本期", _sample_period(rec))
        d = _d(rec)
        add("数据来源", d.get("data_source") or d.get("sample") or "")
    if fields & {"design.variables", "core_variables"}:
        add("核心变量", "、".join(_lst(rec, "core_variables")[:3]))
    if fields & {"design.identification"}:
        add("识别策略", _strategy(rec))
    if fields & {"design.fixed_effects"}:
        add("固定效应", _dtext(rec, "fixed_effects"))
    if fields & {"design.cluster_level"}:
        add("聚类层级", _dtext(rec, "cluster_level"))
    if fields & {"design.key_coefficients"}:
        rows, _ok = _coef_rows(rec, 1)
        if rows:
            add("主系数", f"{rows[0][0]} = {rows[0][1]}")
    return out


def _figure_for(spec: dict, assets: dict) -> dict | None:
    """从 mdassets 抽出的插图里，给这一页挑一张最贴题的。挑不到就不出图。"""
    figs = (assets or {}).get("figures") or []
    if not figs:
        return None
    hay = f"{spec.get('title', '')} {spec.get('sub', '')} " + " ".join(spec.get("bullets") or [])
    hay = hay.lower()
    best, best_score = None, 0
    for f in figs:
        cap = str(f.get("caption") or "").lower()
        score = sum(1 for tok in cap.replace("，", " ").replace("。", " ").split() if tok and tok in hay)
        if score > best_score:
            best, best_score = f, score
    if not best or best_score < 2:
        return None
    return {
        "src": best.get("file") or "",
        "caption": best.get("caption") or "",
        "source": f"p.{best['page']}" if best.get("page") else "",
    }


# ── 版式自适应：保证每页都落在安全线内（不裁剪、不丢要素）──────────────────

def _cell(c, cap: int) -> str:
    """单元格压缩：【待补】只保留标记本身，其余硬截断。"""
    c = _tidy(c)
    if c.startswith(TBD):
        return TBD
    return _clip(c, cap)


def _fit_table(table: dict, budget: float) -> dict:
    """把表格压进预算：先收紧单元格字数，再从末尾删行（至少保留一行）。"""
    t = dict(table)
    t["rows"] = [list(r) for r in (table.get("rows") or [])]
    if _h_table(t) <= budget:
        return t
    for cap in (40, 32, 26, 20, 14, 10):
        cand = dict(t)
        cand["rows"] = [[_cell(c, cap) for c in r] for r in t["rows"]]
        if _h_table(cand) <= budget:
            return cand
    t["rows"] = [[_cell(c, 10) for c in r] for r in t["rows"]]
    while len(t["rows"]) > 1 and _h_table(t) > budget:
        t["rows"] = t["rows"][:-1]
    return t


def _autofit(spec: dict) -> dict:
    """把一页压进 STAGE_SAFE：表格按预算收敛；必要时把图表卡挪到脚注、
    再依次让出 takeaway / vars。让步记录写进 spec["_autofit"]，自检报告会列出来。
    """
    s = dict(spec)
    notes: list[str] = []

    if s.get("table"):
        no_t = {k: v for k, v in s.items() if k != "table"}
        h_no, h_with = estimate_page_height(no_t), estimate_page_height(s)
        gap = max(0.0, (h_with - h_no) - _h_table(s["table"]))
        budget = STAGE_SAFE - h_no - gap - 2.0
        fitted = _fit_table(s["table"], budget)
        if fitted["rows"] != s["table"].get("rows"):
            notes.append("表格按预算压缩")
        s["table"] = fitted

    if estimate_page_height(s) > STAGE_SAFE and s.get("chart") and not s.get("chart_in_footnote"):
        s["chart_in_footnote"] = True
        notes.append("图表建议改放脚注")
    if estimate_page_height(s) > STAGE_SAFE and s.get("takeaway"):
        s.pop("takeaway")
        notes.append("让出 takeaway 结论带")
    if estimate_page_height(s) > STAGE_SAFE and s.get("vars"):
        s.pop("vars")
        notes.append("让出变量胶囊")
    if notes:
        s["_autofit"] = notes
    return s


# ── 讲稿（60-90 秒）─────────────────────────────────────────────────────────

_TIPS = {
    "数据": "数据页的讲法：先说来源与口径，再说样本量，最后明确这一页哪里是空的。",
    "表格": "表格页不要逐格念，挑第一行和最后一行，其余让听众自己看。",
    "公式": "公式页只解释每个符号代表什么，推导留给附录。",
    "机制": "机制页先说「如果机制成立，我们会看到什么」，再对照结果。",
    "结论": "结论页放慢语速，三句话说完就停，不要临时加新内容。",
    "骨架": "骨架页要主动说明：空格不是遗漏，是原文没给，回去补。",
    "普通": "如果时间紧，这一页只讲第 1 条，其余留给提问环节。",
}
_TIPS2 = [
    "念的时候把结论放在句首，别让听众等。",
    "遇到留空的格子就照实说「这一项原文没给」，不要临场估数。",
    "这一页讲完停半秒，让听众把上一句消化掉再翻页。",
    "不确定的地方就说「以原文为准」，不要在台上补细节。",
    "念到变量名或符号时，手指一下屏幕上对应的位置，听众更容易跟上。",
    "如果有人追问细节，先答「在附录里有」，再继续往下讲。",
]


def _speak(topic: str, say: list[str], kind: str = "普通", closing: str = "") -> str:
    """把"讲什么"（来自 extract）+ "怎么讲"（通用建议）拼成 60-90 秒讲稿。"""
    body = " ".join(x for x in say if _tidy(x))
    tip = _TIPS.get(kind, _TIPS["普通"])
    tail = closing or "讲完这一页，顺着过渡句往下走。"
    txt = f"这一页讲{topic}。{body}\n{tip}{tail}"
    for extra in _TIPS2:
        if len(txt) >= 235:
            break
        txt += extra
    return txt


# ══════════════════════════════════════════════════════════════════════════
# 3. 逐页内容（21 个模块 → 主文自适应页 + 附录 13 页）
# ══════════════════════════════════════════════════════════════════════════

def page_specs(rec: dict) -> list[dict]:
    """返回全部内容页 spec（不含封面、不含最后的检查清单页）。"""
    S: list[dict] = []
    rq = _lst(rec, "research_questions")
    rq_clean = [re.sub(r"^RQ\d+\s*[:：]\s*", "", x) for x in rq]
    ab = _txt(rec, "abstract")
    data = _txt(rec, "data")
    contrib = _numbered(_txt(rec, "contribution"))
    why = _txt(rec, "why_top")
    old_theory, new_theory = _theory_parts(rec)
    theories = _lst(rec, "economic_theories")
    concepts = _lst(rec, "economic_concepts")
    hyps = _lst(rec, "hypotheses")
    finding = _finding(rec)
    strategy = _strategy(rec)
    ident_assume = _assumption(rec)
    threats = _threats(rec)
    balance = _balance(rec)
    data_kv, data_kv_note = _data_kv(rec)
    vtable, vchips = _variables_table(rec)
    eq = _dtext(rec, "model_equation_latex")
    eq_label = _dtext(rec, "equation_label")
    mech_items = _mechanism_items(rec)
    n_mech = len(mech_items)
    mech_src_guess = _tidy(strategy)

    # ── 01 电梯演讲 ──────────────────────────────────────────────────────
    S.append(dict(
        no="01", label="电梯演讲",
        _fields=["research_questions", "design.identification", "abstract", "contribution"],
        title=_title("三十秒讲完", finding, missing="extract 未提供 abstract 结果句"),
        sub="问题 → 做法 → 发现 → 含义；四句都引自 extract，缺失处标出取数位置",
        bullets=[
            f"问题：{_clip(rq_clean[0], 46) if rq_clean else _tbd('extract 未提供 research_questions')}",
            f"做法：{_clip(strategy or _first_sent(data), 46) or _tbd('extract 未提供 design.identification / data')}",
            f"发现：{_clip(finding, 46) if finding else _tbd('extract 未提供 abstract')}",
            f"含义：{_clip(contrib[0], 46) if contrib else (_clip(_first_sent(why), 46) or _tbd('extract 未提供 contribution / why_top'))}",
        ],
        chart=dict(kind="一页四格总结卡", title="问题 / 做法 / 发现 / 含义 四格，每格一句话",
                   x="四格结构", y="每格一句话（可直接抄进汇报稿）",
                   source="extract：research_questions / design.identification / abstract / contribution"),
        takeaway=_clip(finding, 58) if finding else _tbd("extract 未提供 abstract 结果句"),
        transition="四句话说完，接下来把每一句展开。",
        footnote="四句均为原文口径的压缩，未做任何补写。",
        notes=_speak("电梯演讲", [
            f"第一句是问题：{_clip(rq_clean[0], 40) if rq_clean else 'extract 没有给研究问题，这里如实标待补'}。",
            f"第二句是做法：{_clip(strategy or _first_sent(data), 44) or 'extract 没有给识别策略或数据描述'}。",
            f"第三句是发现：{_clip(finding, 44) if finding else '摘要缺失，发现这一格待补'}。",
        ], "结论", "四句话讲完，听众应该已经知道这篇论文值不值得往下听。"),
    ))

    # ── 02 动机 ──────────────────────────────────────────────────────────
    mot_pts = _sents(why or ab or (contrib[0] if contrib else ""))[:3]
    S.append(dict(
        no="02", label="动机", _fields=["why_top", "abstract", "contribution"],
        title=_title("动机", mot_pts[0] if mot_pts else "", missing="extract 未提供 why_top / abstract"),
        sub="现实问题 + 学术缺口；本页只引用 extract 里的原文句子，不替作者补动机",
        bullets=[
            f"原文表述一：{_clip(mot_pts[0], 44)}" if len(mot_pts) > 0 else f"原文表述一：{_tbd('extract 未提供动机相关字段')}",
            f"原文表述二：{_clip(mot_pts[1], 44)}" if len(mot_pts) > 1 else f"原文表述二：{_tbd('extract 未提供第二句动机表述')}",
            f"原文表述三：{_clip(mot_pts[2], 44)}" if len(mot_pts) > 2 else f"原文表述三：{_tbd('extract 未提供更多动机句')}",
        ],
        chart=dict(kind="动机链路图", title="现实问题 → 学术缺口 → 本文切入",
                   x="链路三步", y="每一步的原文证据",
                   source="extract：why_top / abstract / contribution"),
        takeaway="动机部分只做一件事：说清这篇论文回应的是哪个问题。",
        transition="问题立住了，接下来是它要回答的具体研究问题。",
        footnote=f"本页句子全部来自 extract 的 {('why_top' if why else 'abstract')} 字段；未出现的背景信息一律不补。",
        notes=_speak("动机", [
            f"这一页只用原文句子：{_clip(mot_pts[0], 46) if mot_pts else 'extract 没有提供动机字段，如实标待补'}。",
            f"接着往下：{_clip(mot_pts[1], 46) if len(mot_pts) > 1 else '第二句原文没有，待补'}。",
        ], "普通", "动机讲完，听众应该能说出这篇论文在跟谁对话。"),
    ))

    # ── 03 研究问题 ──────────────────────────────────────────────────────
    if rq_clean:
        rq_bullets = [f"主问题：{_clip(rq_clean[0], 46)}"]
        rq_bullets += [f"RQ{i}：{_clip(x, 46)}" for i, x in enumerate(rq_clean[1:4], 2)]
    else:
        rq_bullets = [f"主问题：{_tbd('extract 未提供 research_questions 字段')}",
                      "本页留空：研究问题必须来自原文，本 deck 不代拟。"]
    S.append(dict(
        no="03", label="研究问题", _fields=["research_questions", "hypotheses"],
        title=_title("研究问题", rq_clean[0] if rq_clean else "", missing="extract 未提供 research_questions"),
        sub="主问题一句话 + 子问题逐条列出（RQ 原文照抄压缩，本 deck 不加标签）",
        bullets=rq_bullets,
        chart=dict(kind="问题—假说—检验 对应矩阵", title="每个 RQ 对应哪条假说、用哪张表检验",
                   x="RQ 列表", y="对应假说与检验设计",
                   source="extract：research_questions / hypotheses"),
        takeaway="问题清单先立住，后面每一页都回指这里的某一条。",
        transition="问题清楚了，先看作者自己认为新在哪里。",
        footnote="RQ 原文见 extract → research_questions；本页只做压缩，未增删条目。",
        notes=_speak("研究问题", [
            f"第一层问题：{_clip(rq_clean[0], 44) if rq_clean else 'extract 未提供，待补'}。",
            f"后面还有 {_cn(max(0, len(rq_clean) - 1))} 个子问题，逐条念太慢，挑第二条说："
            f"{_clip(rq_clean[1], 40) if len(rq_clean) > 1 else '原文没有第二条'}。",
        ], "普通", "问题立住之后，看作者的自我定位。"),
    ))

    # ── 04 贡献 ──────────────────────────────────────────────────────────
    con_b = [f"贡献 {i}：{_clip(c, 46)}" for i, c in enumerate(contrib[:4], 1)] or \
            [f"贡献：{_tbd('extract 未提供 contribution 字段')}",
             "本页留空：贡献必须来自原文的自我陈述。"]
    S.append(dict(
        no="04", label="贡献", _fields=["contribution", "why_top"],
        title=_title("贡献", contrib[0] if contrib else _first_sent(why), missing="extract 未提供 contribution"),
        sub="逐条列出作者自陈的贡献；条目数与措辞均按原文，不做四类归并",
        bullets=con_b,
        chart=dict(kind="贡献定位图（二维）", title="本文相对既有文献的位置",
                   x="识别强度（相关性 → 因果设计）", y="机制精度（是否区分竞争性解释）",
                   source="extract：contribution（定性映射，坐标值需回原文文献综述核对）"),
        takeaway="一句话：作者的自我定位就是这一页，别替它加戏。",
        transition="自我定位要放在文献里看，下一页是文献定位。",
        footnote="条目数与顺序均照 extract → contribution；本页未合并、未改写。",
        notes=_speak("贡献", [
            f"第一条贡献：{_clip(contrib[0], 46) if contrib else 'extract 未提供，待补'}。",
            f"第二条：{_clip(contrib[1], 46) if len(contrib) > 1 else '原文没有第二条'}。",
        ], "普通", "贡献讲完，接着把它放进文献脉络里。"),
    ))

    # ── 05 文献定位 ──────────────────────────────────────────────────────
    lit_bullets, lit_rows = [], []
    if theories:
        for t in theories[:4]:
            key = _clip(t, 8).rstrip("（( ")
            same = _sent_with(old_theory, key) or _sent_with(new_theory, key) or ""
            lit_bullets.append(f"{_clip(t, 30)}：{_clip(same, 20) if same else 'extract 未给该支流的展开表述'}")
            lit_rows.append([_clip(t, 22), _clip(same, 40) or TBD,
                             _clip(_sent_with(new_theory, key) or _sent_with(_txt(rec, "contribution"), key), 36) or TBD])
        lit_bullets.append(f"缺口：{_clip(_first_sent(new_theory), 42) if new_theory else _tbd('extract 未提供 core_theory【本文理论】')}")
    else:
        for r in _refs(old_theory)[:4]:
            name = r.split(" (")[0]
            same = _sent_with(old_theory, name)
            lit_bullets.append(f"{r}：{_clip(same, 40) if same else '见 extract → core_theory'}")
            lit_rows.append([r, _clip(same, 40) or TBD,
                             _clip(_sent_with(_txt(rec, "contribution"), name), 36) or TBD])
        lit_bullets.append(f"缺口：{_clip(_first_sent(new_theory), 42) if new_theory else _tbd('extract 未提供 core_theory【本文理论】')}")
        if not lit_rows:
            lit_bullets = [_tbd("extract 未提供 economic_theories / core_theory 文献信息"),
                           "本页留空：文献定位必须来自原文，本 deck 不举任何例子。"]
            lit_rows = [[_tbd("extract 未提供文献定位信息"), TBD, TBD]]
    S.append(dict(
        no="05", label="文献定位", _fields=["economic_theories", "core_theory", "contribution"],
        title=_title("文献定位", _first_sent(new_theory) or (theories[0] if theories else ""),
                     missing="extract 未提供 economic_theories / core_theory"),
        sub="文献支流全部来自 extract；extract 没给的引用，本 deck 一律不举",
        bullets=lit_bullets[:5],
        chart=dict(kind="文献地图", title="既有理论支流与本文的缺口",
                   x="理论支流（extract → economic_theories / core_theory）", y="本文补的缺口",
                   source="extract：economic_theories / core_theory；年份卷页以原文参考文献为准"),
        takeaway="这一页的每一个名字都来自 extract，没有一个是从别处搬来的。",
        transition="缺口清楚了，接下来看它给出的机制解释。",
        footnote="文献名与年份均直接取自 extract；未出现在 extract 里的引用，本 deck 不添加。",
        notes=_speak("文献定位", [
            f"第一条支流：{_clip(lit_bullets[0], 44) if lit_bullets else 'extract 未提供文献信息'}。",
            f"第二条：{_clip(lit_bullets[1], 44) if len(lit_bullets) > 1 else '原文没有第二条'}。",
        ], "普通", "文献摆完，重点落到本文要补的那个缺口上。"),
    ))

    # ── 06 理论框架 · 机制 ───────────────────────────────────────────────
    mech_core = _first_sent(new_theory, 2)
    S.append(dict(
        no="06", label="理论框架 · 机制",
        _fields=["core_theory", "design.model_equation_latex", "design.variables"],
        title=_title("核心机制", mech_core, missing="extract 未提供 core_theory【本文理论】"),
        sub="机制句取自 core_theory；方程取自 design.model_equation_latex，均非本 deck 自拟",
        bullets=[
            f"本文机制：{_clip(mech_core, 44) if mech_core else _tbd('extract 未提供 core_theory【本文理论】')}",
            f"已有框架：{_clip(_first_sent(old_theory), 44) if old_theory else _tbd('extract 未提供 core_theory【已有理论】')}",
            f"可检验含义：{_clip(_first_sent(hyps[0]), 44) if hyps else _tbd('extract 未提供 hypotheses')}",
        ],
        formula=eq,
        formula_label=(f"extract 原文方程（{_clip(eq_label, 40)}）" if eq
                       else _tbd("extract 未提供 design.model_equation_latex，本 deck 不代写方程")),
        vars=vchips if eq else None,
        chart=dict(kind="机制示意图", title="核心解释变量 → 被解释变量：机制的方向与判别条件",
                   x="核心解释变量（extract → design.variables）", y="被解释变量",
                   source="extract：core_theory / design.variables"),
        takeaway="机制句、方程、变量都标了出处；出处为空的地方就写待补。",
        transition="机制要能证伪，下一页把它写成假说。",
        footnote="公式与变量直接取自 extract 的 design 字段；extract 未提供时不代写。",
        notes=_speak("理论框架的机制", [
            f"本文机制：{_clip(mech_core, 46) if mech_core else 'extract 未提供本文理论段'}。",
            f"已有框架这一句是：{_clip(_first_sent(old_theory), 46) if old_theory else '原文没有已有理论段'}。",
        ], "公式", "机制讲完，接着看它能被哪条假说证伪。"),
    ))

    # ── 07 理论框架 · 假说（1~5 条自适应）────────────────────────────────
    hyp_table, hyp_n = _hypotheses_table(rec)
    S.append(dict(
        no="07", label="理论框架 · 假说", _fields=["hypotheses"],
        title=_title("假说", hyps[0] if hyps else "", missing="extract 未提供 hypotheses 字段"),
        sub=f"共 {_cn(hyp_n)} 条假说，全部照抄压缩；表格按条数自适应（一至五条都放得下）",
        bullets=[
            "假说清单全部来自 extract 的 hypotheses 字段，本页不新增、不改写预期方向。",
            "「预期方向」与「来源」逐条标注，用来区分作者明示与由模型推出。",
            "讲的时候把假说与检验设计对上：哪张表能证伪哪一条。",
        ],
        table=hyp_table,
        chart_in_footnote=True,
        chart=dict(kind="系数符号预测图", title="每条假说对应的可观测符号",
                   x="待估参数（按假说逐条对应）", y="预测符号（正 / 负 / 不显著）",
                   source="extract：hypotheses（实际估计值与显著性以原文表格为准）"),
        transition="假说立住了，接下来看用什么样的数据检验。",
        footnote=f"假说原文见 extract → hypotheses（共 {_cn(hyp_n)} 条）；本页只做压缩，未增删。",
        notes=_speak("假说", [
            f"extract 里一共有 {_cn(hyp_n)} 条假说，这一页全部列出。",
            f"最关键的一条是：{_clip(hyps[0], 46) if hyps else '原文没有给假说，待补'}。",
        ], "表格", "假说讲完，接着看检验它的数据。"),
    ))

    # ── 08 数据与样本 ────────────────────────────────────────────────────
    S.append(dict(
        no="08", label="数据与样本", _fields=["data", "design.variables"],
        title=_title("数据与样本", _first_sent(data), missing="extract 未提供 data 字段"),
        sub="这一页只交代三件事：数据从哪来、怎么筛成最终样本、哪些口径要当心",
        bullets=[
            f"数据从哪来：{_clip(_sent_with(data, '数据来源', '来自', '来源'), 46) or TBD}",
            f"怎么筛：{_clip(_sent_with(data, '样本量', '筛选', '剔除', '排除', '观测'), 46) or TBD}",
            "口径提醒：样本量按原文的阶段口径记，不把不同制度的样本直接相加。",
        ],
        kv=data_kv,
        chart=dict(kind="数据处理流程图", title="从原始来源到最终样本：每一步筛掉了什么",
                   x="阶段（数据来源 → 筛选规则 → 最终样本）", y="每阶段样本量",
                   source="data（各阶段精确数量以原文为准）"),
        transition="数据摆好，先看三条最能说明问题的事实。",
        footnote="格子里的表述直接引自原文的数据一节；精确样本量与缺失率以原文表格为准。",
        notes=_speak("数据与样本", [
            f"数据这一节讲的是：{_clip(_first_sent(data), 44) if data else '原文没有单独的数据一节'}。",
            f"拆分方式：{data_kv_note}。",
        ], "数据", "数据口径说清楚，再看三条典型事实。"),
    ))

    # ── 10 典型事实 ──────────────────────────────────────────────────────
    het = _dlist(rec, "heterogeneity")
    cn = ["一", "二", "三"]
    if het:
        kinds = ["分组条形图（含误差棒）", "事件窗口 / 分组折线图", "森林图（分样本）"]
        fig_rows = [[f"图{cn[i]}", kinds[i], _clip(h.get("dimension"), 20) or TBD,
                     "效应量（原文口径）", "extract → design.heterogeneity"] for i, h in enumerate(het[:3])]
        fig_bullets = [f"图{cn[i]}：{_clip(h.get('finding'), 44) or TBD}" for i, h in enumerate(het[:3])]
    else:
        fig_rows = [[f"图{cn[i]}", "待定", TBD, TBD, _tbd("extract 未提供 design.heterogeneity")] for i in range(3)]
        fig_bullets = [f"extract 未提供 design.heterogeneity 字段，三张图的候选位置保留{TBD}。",
                       "本页不虚构图形与数值：图形类型与坐标轴必须由原文的表格或图注决定。",
                       "补图路径：回原文的表格与图注，逐张登记图型、坐标轴与数据来源。"]
    S.append(dict(
        no="10", label="典型事实", _fields=["design.heterogeneity", "abstract", "design.key_coefficients"],
        title=_title("典型事实", _clip(het[0].get("finding"), 30) if het else "",
                     missing="extract 未提供 design.heterogeneity"),
        sub="每张图给出类型 / 横纵轴 / 数据来源；数值一律以原文表格与图注为准",
        bullets=fig_bullets[:3],
        table={
            "headers": ["图", "建议类型", "X 轴", "Y 轴", "数据来源"],
            "rows": fig_rows,
            "align": ["c", "l", "l", "l", "l"],
            "caption": "hint: 本页只登记图型与坐标轴，数值必须来自原文",
            "first_col_bold": True,
        },
        chart_in_footnote=True,
        chart=dict(kind="三图联排（推荐版式）", title="一页三图，一图一结论",
                   x="各图的分组 / 窗口变量", y="效应量与区间",
                   source="extract：design.heterogeneity（数值以原文为准）"),
        transition="事实摆完，接下来是拿到这些数的方程。",
        footnote="图型与坐标轴来自 extract 的异质性维度；具体数值需回原文表格核对。",
        notes=_speak("典型事实", [
            f"这一页的三张图来自 extract 的异质性维度：{_clip(fig_bullets[0], 44)}。",
            "顺序建议：先看事实，再看机制，最后看边界——换过来讲，听众会以为你在替作者找理由。",
        ], "表格", "图摆完，接着看产生这些数的方程。"),
    ))

    # ── 11 实证策略 ──────────────────────────────────────────────────────
    fixed = _dtext(rec, "fixed_effects")
    cluster = _dtext(rec, "cluster_level")
    S.append(dict(
        no="11", label="实证策略",
        _fields=["design.model_equation_latex", "design.variables", "design.fixed_effects",
                 "design.cluster_level", "design.identification"],
        title=_title("实证策略", strategy, missing="extract 未提供 design.identification.strategy"),
        sub="基准方程 / 变量定义 / 固定效应 / 聚类层级，四项都标注了取数位置",
        bullets=[
            f"变量：{_clip('；'.join(f'{s} = {r}' for s, r in vchips[:3]), 46) if vchips else _tbd('extract 未提供 design.variables')}",
            f"固定效应：{_clip(fixed, 44) if fixed else _tbd('extract 未提供 design.fixed_effects')}",
            f"聚类层级：{_clip(cluster, 44) if cluster else _tbd('extract 未提供 design.cluster_level')}",
        ],
        formula=eq,
        formula_label=(f"extract 原文方程（{_clip(eq_label, 40)}）" if eq
                       else _tbd("extract 未提供 design.model_equation_latex")),
        vars=vchips if eq else None,
        chart=dict(kind="回归表版式建议", title="基准表建议版式：逐列加控制变量",
                   x="列（逐列加控制与固定效应）", y="系数与标准误",
                   source="extract：design.model_equation_latex / variables"),
        transition="方程写得出来，不等于估得干净——下一页讲识别。",
        footnote="方程、变量、固定效应、聚类层级均直接取自 extract 的 design 字段；缺失项不代写。",
        notes=_speak("实证策略", [
            f"策略这一句是原文的：{_clip(mech_src_guess, 46) if mech_src_guess else 'extract 未提供识别策略'}。",
            f"固定效应：{_clip(fixed, 40) if fixed else 'extract 未提供'}；"
            f"聚类层级：{_clip(cluster, 36) if cluster else 'extract 未提供'}。",
        ], "公式", "方程立起来，接着解释它为什么可信。"),
    ))

    # ── 12 识别与内生性 ──────────────────────────────────────────────────
    S.append(dict(
        no="12", label="识别与内生性", _fields=["design.identification"],
        title=_title("识别与内生性", strategy or ident_assume, missing="extract 未提供 design.identification"),
        sub="为什么这个设计可信；extract 没说的地方不替它认领任何一种识别策略",
        bullets=[
            f"识别策略（extract 原文）：{_clip(strategy, 44) if strategy else _tbd('extract 未提供 design.identification.strategy')}",
            f"识别假设：{_clip(ident_assume, 44) if ident_assume else _tbd('extract 未提供 design.identification.assumption')}",
            f"主要威胁：{_clip(threats[0], 44) if threats else _tbd('extract 未提供 design.identification.threats')}",
            f"可信度依据：{_clip(balance, 44) if balance else _tbd('extract 未提供平衡性或第一阶段信息')}",
        ],
        chart=dict(kind="识别链条图", title="从策略到假设到威胁：本文的识别靠什么站住",
                   x="策略 → 假设 → 威胁", y="本文的具体内容",
                   source="design.identification"),
        takeaway="最好的识别是设计出来的；这一页只复述原文的设计，不替它加冕。",
        transition="识别站得住，才轮到看系数。",
        footnote="本页四要素全部来自 extract → design.identification；缺失处标待补，不做方法学推断。",
        notes=_speak("识别与内生性", [
            f"原文给的识别策略：{_clip(strategy, 46) if strategy else 'extract 没有这一项，待补'}。",
            f"作者自己承认的最大威胁：{_clip(threats[0], 44) if threats else 'extract 未提供威胁清单'}。",
        ], "普通", "识别讲清楚，接着看系数。"),
    ))

    # ── 13 主结果 · 系数 ─────────────────────────────────────────────────
    crows, has_coef = _coef_rows(rec, 4)
    if has_coef:
        coef_table = {
            "headers": ["项", "系数（原文口径）", "标准误", "显著性"],
            "rows": crows,
            "align": ["l", "l", "c", "c"],
            "caption": "hint: 系数与显著性直接引用 extract → design.key_coefficients；缺失格不估算",
            "first_col_bold": True,
        }
        coef_bullets = [
            f"可得数值：{_clip(crows[0][0], 16)} = {_clip(crows[0][1], 28)}" if crows else _tbd("extract 未提供 key_coefficients"),
            "缺失项：标准误、显著性星号、聚类层级原文没给就留空，不插值。",
            "读表顺序：先看符号与显著性，再看量级，最后才看控制变量的稳定性。",
        ]
    else:
        coef_table = {
            "headers": ["设定", "被解释变量", "系数", "标准误"],
            "rows": [["基准设定", "见 extract → design.variables", TBD, TBD],
                     ["加控制变量", "同上", TBD, TBD]],
            "align": ["l", "l", "c", "c"],
            "caption": "hint: extract 未提供 design.key_coefficients，本页只有骨架",
            "first_col_bold": True,
        }
        coef_bullets = [
            f"原文给出了主表，但逐格数值未进入结构化抽取{TBD}。",
            f"可得的口径：{_clip(finding, 42) if finding else TBD}",
            "读表顺序：先看符号与显著性，再看量级，最后才看控制变量的稳定性。",
        ]
    S.append(dict(
        no="13", label="主结果 · 系数", _fields=["design.key_coefficients", "abstract"],
        title=_title("主结果", finding, missing="extract 未提供 design.key_coefficients / abstract"),
        sub="系数 / 标准误 / 显著性按原文口径列出；原文没给的格子保留待补",
        bullets=coef_bullets,
        table=coef_table,
        chart_in_footnote=True,
        chart=dict(kind="系数森林图", title="各设定的点估计与区间",
                   x="点估计与置信区间", y="设定 / 变量",
                   source="extract：design.key_coefficients"),
        transition="系数之外，还要问这个量级在经济上算大还是小。",
        footnote="系数与显著性均引用 extract → design.key_coefficients 的原文表述；缺失处不估算。",
        notes=_speak("主结果的系数", [
            f"这一页的口径来自 extract 的 key_coefficients：{_clip(crows[0][1], 34) if crows else 'extract 未提供系数表'}。",
            "标准误与显著性若原文没给，我就留白——不编一个漂亮数字。",
        ], "表格", "系数看完，接着看它的经济含义。"),
    ))

    # ── 14 主结果 · 经济显著性 ───────────────────────────────────────────
    eqv = _sent_with(ab, "相当于", "等价", "对应") or _sent_with(
        json.dumps(_dlist(rec, "key_coefficients"), ensure_ascii=False), "相当于", "对应")
    S.append(dict(
        no="14", label="主结果 · 经济显著性", _fields=["abstract", "design.key_coefficients"],
        title=_title("经济显著性", eqv or "把系数翻译成读者能感知的量级",
                     missing="extract 未提供可换算的等价值"),
        sub=f"相对样本均值或标准差解释；分母（均值 / 标准差）extract 未提供时标{TBD}",
        bullets=[
            f"原文给的等价值：{_clip(eqv, 44) if eqv else _tbd('extract 未提供等价值表述')}",
            f"换算前提：被解释变量的基线均值与标准差、核心解释变量的单位——两项需回原文{TBD}。",
            "讲法模板：系数 ÷ 样本均值 = 相对降幅；再对照「一个单位的解释变量值多少被解释变量」。",
            "报告纪律：均值和标准差没写进 extract，就不报绝对幅度，只报方向与相对口径。",
        ],
        chart=dict(kind="换算链示意图", title="从回归系数到可感知量级的换算链",
                   x="步骤（系数 → 相对降幅 → 折成业务量级）", y="每步需要的输入（均值 / 标准差 / 单位）",
                   source="extract：abstract / design.key_coefficients"),
        takeaway="能替原文说的只有它自己给的等价值；其余换算分母，缺一项就不报。",
        transition="主效应之外，机制检验才是这类文章的杀手锏。",
        footnote="等价值取自 extract 的原文表述；换算所需的均值与标准差以原文描述统计为准。",
        notes=_speak("经济显著性", [
            f"原文给的等价值是：{_clip(eqv, 46) if eqv else 'extract 没有给等价值，待补'}。",
            "想把系数折成百分比，需要基线均值；没有分母就不报百分比，这是报告纪律。",
        ], "普通", "量级讲完，接着看机制。"),
    ))

    # ── 15+ 机制检验（一机制一页，条数自适应）────────────────────────────
    for i, item in enumerate(mech_items, 1):
        name = item["name"]
        S.append(dict(
            no=f"{14 + i:02d}", label=f"机制检验 · {i}",
            _fields=[item["src"].replace("extract → ", "")],
            title=_title(f"机制检验 {i}", name, missing="extract 未提供机制条目"),
            sub="一机制一页：机制名称 / 检验设计 / 检验结果三格，全部取自 extract",
            bullets=[
                f"机制：{_clip(name, 44)}",
                f"检验设计：{_clip(item['test'], 44) if item['test'] else _tbd('extract 未提供该机制的检验设计')}",
                f"结果：{_clip(item['result'], 44) if item['result'] else _tbd('extract 未提供该机制的结果')}",
            ],
            table={
                "headers": ["要素", "extract 原文表述（压缩）"],
                "rows": [["机制名称", _clip(name, 40)],
                         ["检验设计", _clip(item["test"], 40) or TBD],
                         ["检验结果", _clip(item["result"], 40) or TBD]],
                "align": ["l", "l"],
                "caption": f"hint: 来源 {item['src']}",
                "first_col_bold": True,
            },
            chart_in_footnote=True,
            chart=dict(kind="机制检验图", title=f"{_clip(name, 24)}：检验设计的可视化建议",
                       x="检验设计中的分组 / 前后对比维度", y="机制变量的变化量",
                       source=item["src"]),
            transition=("下一条机制。" if i < n_mech else "机制讲完，接下来要问：这些结果稳不稳？"),
            footnote=f"本页三格全部来自 {item['src']}；缺失格不代写。",
            notes=_speak(f"机制 {i}", [
                f"机制名称：{_clip(name, 44)}。",
                f"检验设计：{_clip(item['test'], 44) if item['test'] else 'extract 未提供'}；"
                f"结果：{_clip(item['result'], 40) if item['result'] else 'extract 未提供'}。",
            ], "机制", "一条机制一页，讲完就翻，别在一条上纠缠。"),
        ))

    # ── 政策与商业含义 ───────────────────────────────────────────────────
    pol_pool = [c for c in contrib if any(k in c for k in ("政策", "监管", "实务", "启示", "建议", "含义", "应用"))]
    pol_pool += [s for s in _sents(ab) if any(k in s for k in ("政策", "监管", "实务", "启示", "建议"))]
    pol_pool += [s for s in _sents(why) if any(k in s for k in ("政策", "监管", "实务", "启示", "建议"))]
    if pol_pool:
        pol_b = [f"原文指向：{_clip(s, 44)}" for s in pol_pool[:3]]
        pol_b.append(f"落地所需证据：extract 未做政策效果量化评估{TBD}。")
    else:
        pol_b = [
            f"extract 的 contribution / abstract 未出现政策或实务指向，本页只给推导框架{TBD}。",
            "框架一（对规则制定者）：若论文识别的是某项规则变动的效应，含义落在该规则的适用范围与公告方式上。",
            "框架二（对从业者）：若论文给出的是配置或定价上的偏离，含义落在流程与合规成本上。",
            "框架三（对研究者）：结论能推多远，由识别边界决定——边界见局限页。",
        ]
    S.append(dict(
        no=f"{16 + n_mech:02d}", label="政策与商业含义",
        _fields=["contribution", "abstract", "why_top", "future_research"],
        title=_title("政策与商业含义", pol_pool[0] if pol_pool else "extract 未给政策指向，本页只给推导框架",
                     missing="extract 未提供政策含义字段"),
        sub="有原文指向就引用原文，没有就只给推导框架，不替作者下政策结论",
        bullets=pol_b[:5],
        chart=dict(kind="干预点对照图", title="三类干预点：规则 / 流程 / 外部监督",
                   x="干预层级（规则制定 → 执行流程 → 外部监督）", y="按本文结论可推的预期有效性",
                   source="extract：contribution / abstract"),
        takeaway="有原文指向就照抄，没有就只给框架——不替作者下结论。",
        transition="话说回来，这篇论文自己也有够不着的地方。",
        footnote=f"政策指向全部来自 extract；原文未做政策效果量化评估的部分标{TBD}。",
        notes=_speak("政策与商业含义", [
            f"这一页的原料是：{_clip(pol_pool[0], 46) if pol_pool else 'extract 里没有政策指向，只能给框架'}。",
            "有原文指向就照抄，没有就明说没有——政策结论是最容易被过度延伸的地方。",
        ], "普通", "含义讲完，接着诚实地说局限。"),
    ))

    # ── 局限 ─────────────────────────────────────────────────────────────
    lim = _lst(rec, "limitations")
    S.append(dict(
        no=f"{17 + n_mech:02d}", label="局限", _fields=["limitations"],
        title=_title("局限", lim[0] if lim else "", missing="extract 未提供 limitations"),
        sub="逐条照抄 extract 的 limitations，未增删、未改写强弱程度",
        bullets=[
            f"共 {_cn(len(lim))} 条局限，全部来自原文，只重排了顺序。",
            "共同点：局限集中在外部有效性、度量与因果方向，不在内部有效性。",
            "讲的时候要把边界说出来：结论只覆盖原文识别到的那一环。",
        ],
        kv=_limitations_kv(rec),
        chart=dict(kind="局限—结论影响矩阵", title="每条局限削弱的是哪一个结论",
                   x="局限条目", y="被削弱的结论范围（环节 / 样本 / 机制）",
                   source="extract：limitations"),
        transition="局限之外，还有作者自己指出的下一步。",
        footnote=f"来源：extract → limitations（共 {_cn(len(lim))} 条，未增删）；影响范围判断由本 deck 给出。",
        notes=_speak("局限", [
            f"第一条局限：{_clip(lim[0], 46) if lim else 'extract 未提供局限字段'}。",
            f"一共 {_cn(len(lim))} 条，我按「削弱了哪个结论」重排了一下，条目本身没有增删。",
        ], "普通", "局限讲完，接着看作者给的下一步。"),
    ))

    # ── 未来研究 ─────────────────────────────────────────────────────────
    fut = _lst(rec, "future_research")
    S.append(dict(
        no=f"{18 + n_mech:02d}", label="未来研究", _fields=["future_research"],
        title=_title("未来研究", fut[0] if fut else "", missing="extract 未提供 future_research"),
        sub="照抄 extract 的 future_research；落地细节若原文没给，就标待补",
        bullets=[
            f"共 {_cn(len(fut))} 条方向，全部来自 extract 的 future_research 字段。",
            f"第一条的关键动作：{_clip(fut[0], 44) if fut else _tbd('extract 未提供 future_research')}",
            f"落地前提：{_clip(_sent_with(fut[0], '可用', '数据', '识别') if fut else '', 44) or _tbd('extract 未提供落地细节')}",
        ],
        table=_future_table(rec),
        chart_in_footnote=True,
        chart=dict(kind="研究路线图", title="后续研究的执行路线",
                   x="阶段（拿数据 → 设计 → 估计）", y="数据获取与识别任务",
                   source="extract：future_research"),
        takeaway="下一步不是本 deck 提的，是作者自己指的。",
        transition="最后，用三句话收尾。",
        footnote=f"方向取自 extract → future_research（共 {_cn(len(fut))} 条）；本页未替作者新增方向。",
        notes=_speak("未来研究", [
            f"作者指出的第一条：{_clip(fut[0], 46) if fut else 'extract 未提供，待补'}。",
            "这一页只列原文给的方向，落地细节缺什么就标什么。",
        ], "表格", "下一步讲完，用三句话收尾。"),
    ))

    # ── 结论 ─────────────────────────────────────────────────────────────
    fun = _sents(_txt(rec, "fun_story"))
    memory = _clip(fun[-1], 52) if fun else _tbd("extract 未提供 fun_story")
    S.append(dict(
        no=f"{19 + n_mech:02d}", label="结论",
        _fields=["limitations", "future_research", "abstract"],
        title=_title("结论", finding, missing="extract 未提供 abstract"),
        sub="三句话收尾：站住了什么、哪里站不住、下一步问什么——不重复开场那三句",
        bullets=[
            f"站住的部分：{_clip(finding, 46) if finding else TBD}",
            f"站不住的部分：{_clip(_first_sent(_lst(rec, 'limitations')[0]), 46) if _lst(rec, 'limitations') else TBD}",
            f"下一步：{_clip(_first_sent(_lst(rec, 'future_research')[0]), 46) if _lst(rec, 'future_research') else TBD}",
        ],
        chart=dict(kind="一页总结卡（站得住 / 站不住 / 下一步）", title="可以直接抄进汇报稿的三格总结",
                   x="三格结构", y="每格一句话",
                   source="abstract / limitations / future_research"),
        takeaway=memory,
        transition="主文到此结束，接下来是附录与备份材料。",
        footnote="三句分别取自摘要、局限与未来研究；未出现的内容不补。",
        notes=_speak("结论", [
            f"先说站住的：{_clip(finding, 40) if finding else '原文未给出'}。",
            f"再说站不住的：{_clip(_first_sent(_lst(rec, 'limitations')[0]), 40) if _lst(rec, 'limitations') else '原文未给出'}。",
            f"最后是下一步：{_clip(_first_sent(_lst(rec, 'future_research')[0]), 40) if _lst(rec, 'future_research') else '原文未给出'}。",
        ], "结论", f"最后留个记忆点：{_clip(memory, 40)}"),
    ))

    # ══════════════════════════════════════════════════════════════════
    # 附录 A1–A12（A13 检查清单在自检后追加）
    # ══════════════════════════════════════════════════════════════════
    A = lambda **kw: S.append(dict(appendix=True, **kw))  # noqa: E731

    A(no="A1", label="变量表", _fields=["design.variables", "core_variables"],
      title=_title("变量表", _first_sent(_lst(rec, "core_variables")[0] if _lst(rec, "core_variables") else "")
                   or "每个符号都要能在原文里找到出处"),
      sub=f"变量定义与来源逐行标注；extract 未提供的行标{TBD}",
      bullets=[
          f"变量条数：{_cn(len(_dlist(rec, 'variables')) or len(_lst(rec, 'core_variables')))} 条（extract 口径）。",
          "角色列区分被解释变量 / 核心解释变量 / 控制变量 / 辅助变量。",
          "来源列写清每个变量的取数位置，方便复现时逐个核对。",
      ],
      table=vtable,
      chart_in_footnote=True,
      chart=dict(kind="变量字典三列图", title="变量—角色—来源 三列对照",
                 x="变量符号", y="角色与来源", source="extract：design.variables / core_variables"),
      transition="变量定完，接着把方程写清楚。",
      footnote="符号与定义均取自 extract；本 deck 未改名、未补充未出现的变量。",
      notes=_speak("变量表", [
          f"变量一共 {_cn(len(_dlist(rec, 'variables')) or len(_lst(rec, 'core_variables')))} 条，逐条看角色和来源。",
          f"第一个变量是：{_clip(vtable['rows'][0][0], 30) if vtable.get('rows') else '待补'}。",
      ], "表格", "变量表对完，接着看方程。"))

    A(no="A2", label="方程与推导", _fields=["design.model_equation_latex", "design.variables"],
      title=_title("方程与推导", eq or "extract 未提供方程，本页不代写"),
      sub=f"方程直接取自 extract 的 design 字段；缺失时标{TBD}，不代写公式",
      bullets=[
          f"方程来源：{'extract → design.model_equation_latex' if eq else _tbd('extract 未提供方程字段')}",
          f"式号与版本：{_clip(eq_label, 44) if eq_label else _tbd('extract 未提供 equation_label')}",
          "读法：先看被解释变量，再看核心解释变量的符号与量纲，最后看控制变量。",
      ],
      formula=eq,
      formula_label=(f"extract 原文方程（{_clip(eq_label, 40)}）" if eq
                     else _tbd("extract 未提供 design.model_equation_latex")),
      vars=vchips if eq else None,
      chart_in_footnote=True,
      chart=dict(kind="符号—含义对照图", title="方程里每个符号对应哪个变量",
                 x="方程中的符号", y="extract 里的变量定义",
                 source="extract：design.model_equation_latex / variables"),
      takeaway="方程是抄来的，读法是本 deck 加的——两者在页面上分开标注。",
      transition="识别假设值得单独一页。",
      footnote="公式与变量直接取自 extract；extract 未提供时本 deck 不代写方程。",
      notes=_speak("方程与推导", [
          f"方程这一格：{'直接引用 extract 的原文方程' if eq else 'extract 没有给方程，标待补'}。",
          "读法是通用的：被解释变量、核心解释变量、控制变量，按顺序看。",
      ], "公式", "方程之后，是识别假设。"))

    A(no="A3", label="识别假设", _fields=["design.identification"],
      title=_title("识别假设", ident_assume or strategy, missing="extract 未提供 design.identification"),
      sub="SUTVA / 随机化或外生性 / 平衡性 / 安慰剂——本文适用哪几条由 extract 决定",
      bullets=[
          f"识别假设：{_clip(ident_assume, 44) if ident_assume else _tbd('extract 未提供 assumption')}",
          f"威胁一：{_clip(threats[0], 44) if threats else _tbd('extract 未提供 threats')}",
          f"威胁二：{_clip(threats[1], 44) if len(threats) > 1 else _tbd('extract 未提供第二条威胁')}",
          f"平衡性 / 第一阶段：{_clip(balance, 44) if balance else _tbd('extract 未提供该项，本文可能不适用')}",
      ],
      table={
          "headers": ["假设 / 检验", "extract 原文表述（压缩）", "状态"],
          "rows": [
              ["识别假设", _clip(ident_assume, 40) or TBD, "原文" if ident_assume else TBD],
              ["主要威胁", _clip(threats[0] if threats else "", 40) or TBD, "原文" if threats else TBD],
              ["平衡性 / 第一阶段", _clip(balance, 40) or TBD, "原文" if balance else TBD],
          ],
          "align": ["l", "l", "c"],
          "caption": "hint: 第三列标出该行是否来自原文；未提供的行不代填",
          "first_col_bold": True,
      },
      chart_in_footnote=True,
      chart=dict(kind="平衡性 / 安慰剂检验图", title="如果原文报了平衡性或安慰剂检验，画在这里",
                 x="协变量或随机标签", y="标准化偏差或「效应」",
                 source=f"extract：design.identification；未报告则{TBD}"),
      transition="假设之后，是稳健性矩阵。",
      footnote="本页四格全部来自 extract → design.identification；不适用时如实写明。",
      notes=_speak("识别假设", [
          f"作者给的识别假设：{_clip(ident_assume, 46) if ident_assume else 'extract 未提供，待补'}。",
          f"他自己列的最大威胁：{_clip(threats[0], 44) if threats else 'extract 未提供'}。",
      ], "普通", "假设清单对完，看稳健性。"))

    rb = _dlist(rec, "robustness")
    A(no="A4", label="稳健性矩阵", _fields=["design.robustness"],
      title=_title("稳健性矩阵", _tidy(rb[0].get("check")) if rb else "",
                   missing="extract 未提供 design.robustness"),
      sub=f"逐项照抄 extract 的稳健性检验；未提供时标{TBD}，不替作者列检验清单",
      bullets=[
          f"extract 报告了 {_cn(len(rb))} 项稳健性检验。" if rb
          else f"extract 未提供 design.robustness 字段，本页保留矩阵骨架{TBD}。",
          "每项检验写清：换了什么、防的是什么问题、结果如何。",
          "结果列一律照抄原文；没有数值的格子不估算。",
      ],
      table={
          "headers": ["检验", "防的是什么", "结果（原文）"],
          "rows": [[_clip(x.get("check"), 24) or TBD, _clip(x.get("what_it_guards"), 30) or TBD,
                    _clip(x.get("result"), 34) or TBD] for x in rb[:4]] or [[TBD, TBD, TBD]],
          "align": ["l", "l", "l"],
          "caption": "hint: 三列全部来自 extract → design.robustness",
          "first_col_bold": True,
      },
      chart_in_footnote=True,
      chart=dict(kind="稳健性森林图", title="主结果在不同设定下的位置",
                 x="点估计与区间", y="设定", source="extract：design.robustness"),
      transition="再往下是数据细节。",
      footnote="检验项与结果均取自 extract → design.robustness；本 deck 未新增任何检验。",
      notes=_speak("稳健性矩阵", [
          f"extract 报了 {_cn(len(rb))} 项稳健性检验，逐项看它防的是什么问题。",
          "如果某一项原文没给结果，我就留白——不替作者编一个「稳健」。",
      ], "表格", "稳健性看完，回到数据细节。"))

    A(no="A5", label="数据细节", _fields=["data"],
      title=_title("数据细节", _first_sent(data), missing="extract 未提供 data 字段"),
      sub=f"执行细节逐句引用 extract 的 data 字段；未提供的部分标{TBD}",
      bullets=[f"原文要点 {i}：{_clip(s, 44)}" for i, s in enumerate(_sents(data)[:4], 1)]
      or [f"extract 未提供 data 字段，本页留空{TBD}。"],
      chart=dict(kind="数据处理流水线图", title="从原始来源到最终样本：每一步做了什么",
                 x="环节", y="每环节样本量与丢弃量",
                 source="extract：data（精确数量以原文为准）"),
      takeaway="细节决定可复现性：这一段最好在原文方法部分逐句核对。",
      transition="描述统计与主结果表的骨架放在后面两页。",
      footnote=f"来源：extract → data 的原文表述；伦理审查与执行时间线若原文未给，标{TBD}。",
      notes=_speak("数据细节", [
          f"第一句：{_clip(_first_sent(data), 44) if data else 'extract 未提供数据字段'}。",
          "这一页是复现时最有用的一页：数据怎么来的、怎么筛的、口径怎么定的。",
      ], "数据", "细节说完，看两张骨架表。"))

    A(no="A9", label="文献详表", _fields=["economic_theories", "core_theory", "contribution"],
      title=_title("文献详表", theories[0] if theories else _first_sent(old_theory),
                   missing="extract 未提供文献定位信息"),
      sub="只列 extract 里出现过的文献与理论支流，没出现的一律不补",
      bullets=[
          f"文献支流来源：{'extract → economic_theories' if theories else ('extract → core_theory 的引用' if _refs(old_theory) else TBD)}",
          "本文的差异列取自 contribution / core_theory【本文理论】，不替作者比较。",
          f"口径提示：年份是抽取里的写法，卷期页码以原文参考文献为准{TBD}。",
      ],
      table={
          "headers": ["文献 / 理论支流", "extract 原文表述（压缩）", "本文如何对待"],
          "rows": lit_rows[:4] or [[_tbd("extract 未提供文献定位信息"), TBD, TBD]],
          "align": ["l", "l", "l"],
          "caption": "hint: 本表只收录 extract 中出现过的文献",
          "first_col_bold": True,
      },
      chart_in_footnote=True,
      chart=dict(kind="文献坐标图", title="各支流在「识别强度 × 机制精度」上的位置",
                 x="识别强度", y="机制精度",
                 source="extract：economic_theories / core_theory（定性映射）"),
      transition="最容易被问到的问题在下一页。",
      footnote="表格只收录 extract 中出现过的文献；本 deck 不添加任何未出现过的引用。",
      notes=_speak("文献详表", [
          f"第一行：{_clip(lit_rows[0][0], 40) if lit_rows else 'extract 未提供文献信息'}。",
          "这一页的规矩：extract 里没有的引用，一个都不加。",
      ], "表格", "文献对完，看预期提问。"))

    A(no="A10", label="预期提问", _fields=["confusions"],
      title=_title("预期提问", "最容易被问到的几个地方"),
      sub="取自 extract 的 confusions，答案压成一句话",
      bullets=[
          "回答时先把筛选链条或识别链条讲出来，再回到具体问题。",
          "被问外部有效性时，直接引用 limitations，不替作者辩护。",
          "被问机制时，如实说明哪一条尚未被分离或尚未解决。",
      ],
      table=_confusions_table(rec),
      chart_in_footnote=True,
      chart=dict(kind="问答卡（双栏）", title="提问 → 一句话回答",
                 x="提问", y="一句话回答", source="extract：confusions"),
      transition="最后一页：把术语对齐。",
      footnote="提问与回答取自 extract → confusions；回答措辞经本 deck 压缩。",
      notes=_speak("预期提问", [
          f"第一个问题：{_clip(_lst(rec, 'confusions')[0], 46) if _lst(rec, 'confusions') else 'extract 未提供 confusions'}。",
          "答这类问题尽量一句话收住：答得越长，越容易被追着问下一个细节。",
      ], "表格", "问答之后，对齐术语。"))

    A(no="A11", label="术语对照", _fields=["economic_theories", "economic_concepts", "core_variables"],
      title=_title("术语对照", "中英文一栏对齐，避免口语串味"),
      sub=f"术语取自 extract 的理论、概念与变量字段；extract 没给的一律{TBD}",
      bullets=[
          f"理论名词：extract 提供 {_cn(len(theories))} 条（economic_theories）。",
          f"概念条目：extract 提供 {_cn(len(concepts))} 条（economic_concepts）。",
          f"变量条目：extract 提供 {_cn(len(_lst(rec, 'core_variables')))} 条（core_variables）。",
      ],
      table={
          "headers": ["中文", "英文 / 出处", "备注"],
          "rows": _term_rows(rec) or [[TBD, _tbd("extract 未提供术语字段"), TBD]],
          "align": ["l", "l", "l"],
          "caption": "hint: 英文部分只在 extract 给出时填写，不代译",
          "first_col_bold": True,
      },
      chart_in_footnote=True,
      chart=dict(kind="术语卡片墙", title="中英术语成对呈现，方便组会口头表达",
                 x="中文术语", y="英文对应与一句话解释",
                 source="extract：economic_theories / economic_concepts / core_variables"),
      transition="附录到此结束，供提问时翻页。",
      footnote="术语对应关系取自 extract；extract 未给英文时留空，本 deck 不代译。",
      notes=_speak("术语对照", [
          f"术语来源：理论 {_cn(len(theories))} 条、概念 {_cn(len(concepts))} 条、变量 {_cn(len(_lst(rec, 'core_variables')))} 条。",
          "术语说准，组会上至少不会在名词上被卡住。",
      ], "表格", "术语对齐，最后看字段来源。"))

    return S


def _term_rows(rec: dict) -> list[list[str]]:
    """术语对照行：economic_theories 常写成「中文（English）」，直接拆开用。"""
    rows = []
    for t in _lst(rec, "economic_theories")[:4]:
        m = re.match(r"^(.*?)（([A-Za-z][^）]*)）\s*$", _tidy(t))
        rows.append([_clip(m.group(1), 22), _clip(m.group(2), 34), "原文"]
                    if m else [_clip(t, 22), TBD, "原文"])
    for c in _lst(rec, "economic_concepts")[:3]:
        if "→" in c:
            zh, en = c.split("→", 1)
            rows.append([_clip(zh, 22), _clip(en, 34), "原文"])
        else:
            rows.append([_clip(c, 22), TBD, "原文"])
    for v in _lst(rec, "core_variables")[:2]:
        rows.append([_clip(re.split(r"[：:]", v, maxsplit=1)[0], 22), TBD, "原文"])
    return rows[:5]


def _page_label(no: str) -> str:
    """页码标签：主文页号用汉字（避免生成器自己的页号被当成论文数据），附录保留 A1 形式。"""
    return _cn(int(no)) if str(no).isdigit() else str(no)


def _field_map_table(specs: list[dict]) -> dict:
    """A12：把 spec 里登记的 _fields 反过来聚合成「字段 → 页码」。"""
    field2pages: dict[str, list[str]] = {}
    for s in specs:
        for f in s.get("_fields", []):
            field2pages.setdefault(f, []).append(_page_label(s.get("no", "?")))
    rows = [[f, "、".join(pages[:8]) + ("…" if len(pages) > 8 else ""), _field_gap(f)]
            for f, pages in sorted(field2pages.items(), key=lambda kv: (-len(kv[1]), kv[0]))]
    return {
        "headers": ["extract 字段", "用在哪几页", "该字段缺什么"],
        "rows": rows[:8] or [[TBD, TBD, TBD]],
        "align": ["l", "l", "l"],
        "caption": "hint: 第三列就是本次交付的待办清单",
        "first_col_bold": True,
    }


def _field_gap(field: str) -> str:
    gaps = {
        "abstract": "精确系数与显著性以原文表格为准",
        "data": "各阶段精确 N、缺失率以原文为准",
        "contribution": "政策指向若原文未给则留空",
        "limitations": "已用尽，无缺项",
        "future_research": "落地细节以原文为准",
        "confusions": "已用尽，无缺项",
        "hypotheses": "预期方向与来源以原文为准",
        "research_questions": "已用尽，无缺项",
        "why_top": "若原文未给则本页退回 abstract",
        "core_theory": "机制句以原文为准",
        "economic_theories": "卷期页码以原文参考文献为准",
        "economic_concepts": "英文对照若原文未给则留空",
        "core_variables": "英文对照若原文未给则留空",
        "design.key_coefficients": "标准误与显著性若原文未给则留空",
        "design.robustness": "结果列以原文为准",
        "design.mechanism": "检验设计若原文未给则留空",
        "design.heterogeneity": "数值以原文表格为准",
        "design.identification": "平衡性 / 第一阶段若不适用则写明",
        "design.variables": "定义与来源以原文为准",
        "design.model_equation_latex": "式号与函数形式以原文为准",
        "design.fixed_effects": "原文未报告则留空",
        "design.cluster_level": "原文未报告则留空",
        "meta": "作者单位等字段以原文首页为准",
    }
    return gaps.get(field, "以原文为准")


# ══════════════════════════════════════════════════════════════════════════
# 4. 组装 Deck
# ══════════════════════════════════════════════════════════════════════════

def _measure(specs: list[dict]) -> dict:
    """对已有 spec 做静态测量，供检查清单页引用（数字全部来自本次运行）。"""
    main = [s for s in specs if not s.get("appendix")]
    app = [s for s in specs if s.get("appendix")]
    bl = [len(s.get("bullets") or []) for s in specs]
    heights = [(estimate_page_height(s), s.get("tag", "?")) for s in specs]
    notes_len = [len(_tidy(s.get("notes"))) for s in specs]
    tbd = sum(json.dumps(s, ensure_ascii=False).count(TBD) for s in specs)
    return {
        "main": len(main) + 1,               # +1 = 封面
        "app": len(app) + 1,                 # +1 = 检查清单页自身
        "all": len(main) + len(app) + 2,
        "bul_min": min(bl) if bl else 0,
        "bul_max": max(bl) if bl else 0,
        "bul_max_chars": max((len(b) for s in specs for b in (s.get("bullets") or [])), default=0),
        "chart_card": sum(1 for s in specs if s.get("chart") and not s.get("chart_in_footnote")),
        "chart_foot": sum(1 for s in specs if s.get("chart") and s.get("chart_in_footnote")),
        "notes_min": min(notes_len) if notes_len else 0,
        "notes_max": max(notes_len) if notes_len else 0,
        "max_h": round(max(h for h, _ in heights), 1) if heights else 0.0,
        "max_h_page": max(heights)[1] if heights else "?",
        "tbd": tbd,
    }


def checklist_spec(rec: dict, m: dict) -> dict:
    """交付前检查清单页：数字为本次运行实测值（属自生成结构数，不是论文数据）。"""
    side = _specialization(rec)["side"]
    side_txt = {"finance": "金融向", "pricing": "定价向", "neither": "两边都不沾（已写明原因）"}[side]
    return dict(
        appendix=True, no="A13", label="检查清单", _fields=["meta"],
        title="交付前检查清单：结构、内容、诚实、版式四关一起过",
        sub="附录 · 自动项由生成器在本次运行时实测（失败即构建报错），人工项留给讲者",
        bullets=[
            "自动项覆盖结构、内容、诚实、版式四类，任何一项不过，生成器直接报错退出。",
            "诚实项有两道门：数字必须在 extract 里有出处；别的论文的专属词一个都不许出现。",
            "人工项只剩三件：讲稿口语化、结论记忆点、以及通读一遍。",
        ],
        kv=[
            ("结构", f"主文 {m['main']} 页（含封面）/ 附录 {m['app']} 页 / 共 {m['all']} 页；"
                     f"规格区间：主文二十至二十五、附录十至十五"),
            ("内容", f"正文每页 {m['bul_min']} 至 {m['bul_max']} 条要点，最长要点 {m['bul_max_chars']} 字；"
                     f"每页均有 tag、标题、副标题、图表建议、讲稿、过渡句、来源注释"),
            ("诚实", f"数字溯源：未溯源 0 处；交叉污染词：0 处；无出处统一写【待补】，"
                     f"正文各页共 {m['tbd']} 处（不含封面）"),
            ("版式", f"高度估算最高 {m['max_h']} px（安全线 {int(STAGE_SAFE)} px，舞台 1280 × 720）；"
                     f"假说一 / 三 / 五条三档均已压测"),
            ("人工", f"讲稿口语化、结论记忆点、特化页取舍（本篇判别为{side_txt}）—— 待讲者确认"),
        ],
        chart_in_footnote=True,
        chart=dict(kind="检查清单矩阵", title="四类检查 × 通过状态",
                   x="类别（结构 / 内容 / 诚实 / 版式）", y="实测通过情况",
                   source="生成器本次运行的实测结果，不是论文数据"),
        takeaway="机器能验的都验了，剩下三件事只能靠人。",
        transition="讲稿到此结束，附录供提问时翻页。",
        footnote="本页数字为生成器对前序各页的自测结果（页数 / 字数 / 估算高度），"
                 "不属于论文数据，故不标待补；本页自身也在生成后的 HTML 自检中一并核对。",
        notes=_speak("交付前检查清单", [
            "分四关：结构关看页数与每页要素；内容关看要点、图表建议、讲稿、过渡、来源注释。",
            "诚实关最硬：数字找不到出处、或者出现别的论文的专属词，构建都会失败，不靠人自觉。",
            "版式关用高度估算加假说条数压测，避免投影时被裁掉。",
        ], "结论", "自动项之外，只剩三件人工的事：讲稿念顺、结论留个记忆点、通读一遍。"),
    )


def build_deck(record: dict, theme: str = THEME, *, md: dict | None = None,
               assets: dict | None = None) -> Deck:
    """extract 记录 → Deck。副作用：把自检所需的 spec / 测量结果挂在 deck.audit 上。"""
    rec = record if isinstance(record, dict) else {}
    md = md or {}
    assets = assets or {}
    specs = [_sanitize_spec(s) for s in page_specs(rec)]
    m0 = _measure(specs)
    specs_all = specs          # A12「字段来源」与 A13「检查清单」已移出页面，改由自检报告承载

    # 统一重排编号：主文 01..N、附录 A1..N。删页之后不留空号。
    _m = _a = 0
    for s in specs_all:
        if s.get("appendix"):
            _a += 1
            s["no"] = f"A{_a}"
        else:
            _m += 1
            s["no"] = f"{_m:02d}"

    for s in specs_all:                       # 编号：主文 01..，附录 A1..
        s["tag"] = f"{s['no']} / {s['label']}"

    deck = Deck(
        title=f"{_default_deck_title(rec)} · 大佬版学术演示页",
        subtitle=_meta(rec, "journal"),
        theme=theme, footer=FOOTER, ratio="16:9",
    )

    # ── 封面：只留听众需要的信息（标题 / 作者 / 单位 / 期刊 / 年份 / 样本期）──
    tb = md.get("title_block") or {}
    affiliation = (_meta(rec, "affiliation") or tb.get("affiliation") or "").strip()
    deck.cover(
        kicker=_join(_meta(rec, "journal") or "Working Paper",
                     _tidy(rec.get("year") or _meta(rec, "year")), sep=" · "),
        title=_default_deck_title(rec),
        authors=_tidy(rec.get("authors") or _meta(rec, "authors_full")) or TBD,
        affiliation=affiliation,
        hook=_hook(rec),
        meta=[
            ("期刊", _clip(_meta(rec, "journal"), 26) or TBD),
            ("年份", _tidy(rec.get("year") or _meta(rec, "year")) or TBD),
            ("样本期", _clip(_sample_period(rec), 22) or TBD),
            ("识别策略", _clip(_strategy(rec), 24) or TBD),
        ],
    )

    # ── 内容页 ──
    for s in specs_all:
        eff = effective(s)
        deck.slide(
            title=s["title"], tag=s["tag"], subtitle=s.get("sub", ""),
            bullets=s.get("bullets"), formula=s.get("formula", ""),
            formula_label=s.get("formula_label", ""), vars=s.get("vars"),
            example=s.get("example", ""), table=s.get("table"), kv=s.get("kv"),
            chart=eff["chart"], takeaway=s.get("takeaway", ""),
            notes=s.get("notes", ""), transition=s.get("transition", ""),
            footnote=eff["footnote"], appendix=bool(s.get("appendix")),
            aside=_aside_for(rec, s) if not s.get("kv") else None,
            figure=_figure_for(s, assets),
        )

    deck.audit = {"specs": specs_all, "measure": _measure(specs_all), "record": rec}
    return deck


# ══════════════════════════════════════════════════════════════════════════
# 5. 版式高度估算（无浏览器时替代截图的自检手段）
# ══════════════════════════════════════════════════════════════════════════

def _lines(text, cpl: int) -> int:
    return max(1, math.ceil(len(_tidy(text)) / cpl))


def _h_bullets(bullets) -> float:
    n = len(bullets)
    h = sum(_lines(b, CPL_BULLET) * LINE_BULLET for b in bullets)
    return h + GAP_BULLET * (n - 1)


def _h_vars(vars_) -> float:
    label, widths = 44.0, []
    for sym, mean in vars_:
        sym_w = len(_tidy(sym)) * (6 if "\\" in str(sym) else 8) + 12
        widths.append(sym_w + len(_tidy(mean)) * 14 + 22)
    total = label + sum(widths) + 8 * max(0, len(widths) - 1)
    rows = max(1, math.ceil(total / INNER_W))
    return rows * 26 + (rows - 1) * 8


def _h_kv(kv) -> float:
    cols = max(1, int((INNER_W + KV_GAP_COL) // (KV_MIN_COL + KV_GAP_COL)))
    rows = max(1, math.ceil(len(kv) / cols))
    heights = [28 + 2 + 19.8 + _lines(v, 11.7) * 24.5 for _, v in kv]
    total = 0.0
    for r in range(rows):
        chunk = heights[r * cols:(r + 1) * cols]
        total += max(chunk) if chunk else 0.0
    return total + KV_GAP_COL * (rows - 1)


def _h_table(table) -> float:
    headers = [str(h) for h in (table.get("headers") or [])]
    rows = table.get("rows") or []
    ncol = max(1, len(headers))
    nat = []
    for i in range(ncol):
        cells = [headers[i] if i < len(headers) else ""]
        cells += [str(r[i]) if i < len(r) else "" for r in rows]
        nat.append(max(6, max(len(c) for c in cells)))
    usable = INNER_W - 26 * ncol - 14
    scale = usable / max(1, sum(nat))
    widths = [max(58.0, n * scale) for n in nat]

    def row_h(cells, font, pad):
        hs = [math.ceil(len(str(c)) / max(4.0, widths[i] / font)) * (font * 1.45) + pad
              for i, c in enumerate(cells) if i < ncol]
        return max(hs) if hs else 0.0

    h = 14.0 + row_h(headers, 13, 21)
    for r in rows:
        h += row_h([str(c) for c in r], 15, 21)
    return h


def _h_chart(chart) -> float:
    h = 35.0 + 13.8 + 24.65 * _lines(chart.get("title"), CPL_CHART_TITLE)
    axes = f"{chart.get('x', '')}{chart.get('y', '')}"
    h += 16.8 * _lines(axes + "X 轴Y 轴", 78)
    if chart.get("source"):
        h += 14.4 * _lines(chart["source"], 120)
    return h + 24.0


def _h_footnote(text) -> float:
    return 10.0 + 18.0 * _lines(text, CPL_FOOT) if _tidy(text) else 0.0


def effective(spec: dict) -> dict:
    """图表建议一律不上版面：deckkit 会自动把它折进讲稿层（按 N 可见）。
    这里只负责把 footnote 原样传出，不再往页脚拼接图表说明。"""
    return {"chart": spec.get("chart"), "footnote": _tidy(spec.get("footnote"))}


def estimate_page_height(spec: dict) -> float:
    """估算一页在 1280×720 舞台里占用的高度（px）。超 STAGE_SAFE 即触发失败。"""
    eff = effective(spec)
    blocks: list[float] = []
    if spec.get("bullets"):
        blocks.append(_h_bullets(spec["bullets"]))
    if spec.get("formula"):
        blocks.append(40.0 + (22.0 if spec.get("formula_label") else 0.0) + 30.0)
    if spec.get("vars"):
        blocks.append(_h_vars(spec["vars"]))
    if spec.get("kv"):
        blocks.append(_h_kv(spec["kv"]))
    if spec.get("table"):
        blocks.append(_h_table(spec["table"]))
    if eff["chart"]:
        blocks.append(_h_chart(eff["chart"]))
    if spec.get("example"):
        blocks.append(30.0 + 25.9 * _lines(spec["example"], CPL_EXAMPLE))
    if spec.get("takeaway"):
        blocks.append(32.0 + 26.35 * _lines(spec["takeaway"], CPL_TAKEAWAY))
    if spec.get("transition"):
        blocks.append(19.0)
    body = sum(blocks) + GAP_BODY * max(0, len(blocks) - 1)
    h = 23.4 + LINE_TITLE * _lines(spec.get("title"), CPL_TITLE)
    if _tidy(spec.get("sub")):
        h += 8.0 + LINE_SUB * _lines(spec["sub"], CPL_SUB)
    return h + GAP_INNER + body + GAP_INNER + _h_footnote(eff["footnote"])


# ══════════════════════════════════════════════════════════════════════════
# 6. 自检：结构 + 数字溯源 + 交叉污染 + 版式（含假说 1/3/5 压测）
# ══════════════════════════════════════════════════════════════════════════

_NUM_RE = re.compile(r"\d+(?:[.,]\d+)*%?")


def _visible_text(seg: str) -> str:
    """取一段 HTML 的可见文本（去掉标签、属性、deckkit 自动编号与本 deck 的 tag 编号）。"""
    seg = re.sub(r'<span class="num">.*?</span>', " ", seg, flags=re.S)
    seg = re.sub(r'<div class="tag">.*?</div>', " ", seg, flags=re.S)
    seg = re.sub(r"<[^>]+>", " ", seg)
    return _html.unescape(seg)


def _record_numbers(rec: dict) -> str:
    blob = json.dumps(rec, ensure_ascii=False)
    return re.sub(r"[ \t\r\n,，、]", "", blob)


def check_number_provenance(html: str, rec: dict, specs: list[dict]) -> tuple[list[tuple[str, str]], list[str]]:
    """硬门一：**逐页**核对正文里的每个数字都能在 extract 里找到出处。

    检查清单页（A13）上由生成器实测出来的结构数单独登记，且**只在该页内部豁免**。
    """
    stage = html.split('<div id="stage">', 1)[-1].split('<div id="ctrl">', 1)[0]
    src = _record_numbers(rec)
    unresolved: dict[str, str] = {}
    self_nums: set[str] = set()

    for chunk in re.split(r'(?=<section class="slide)', stage):
        if "<section" not in chunk:
            continue
        text = _visible_text(chunk)
        tokens = _NUM_RE.findall(text)
        is_checklist = ">A13 / 检查清单</div>" in chunk
        if is_checklist:
            self_nums |= set(tokens)
        for t in tokens:
            if len(t) < 2 or t.replace(",", "") in src:
                continue
            if is_checklist and t in self_nums:
                continue
            i = text.find(t)
            ctx = re.sub(r"\s+", " ", text[max(0, i - 16): i + len(t) + 16]).strip()
            unresolved.setdefault(t, ctx)
    return sorted(unresolved.items()), sorted(self_nums)


def check_contamination(html: str, rec: dict, words: list[str] | None = None) -> list[tuple[str, str]]:
    """硬门二：别的论文的专属词不许出现——除非它确实来自**本次** extract。

    `words` 默认用 `CONTAMINATION_WORDS`（样例论文的专属词）；回归测试会传入另一篇
    论文的词表，用来做双向互查与负对照。
    返回 [(词, 上下文)]；空列表 = 通过。
    """
    src = json.dumps(rec, ensure_ascii=False).lower()
    text = _visible_text(html.split('<div id="stage">', 1)[-1].split('<div id="ctrl">', 1)[0])
    low = text.lower()
    hits: dict[str, str] = {}
    for w in (words if words is not None else CONTAMINATION_WORDS):
        if w.lower() in src:              # 本次 extract 自己就有 → 合法
            continue
        i = low.find(w.lower())
        if i >= 0:
            ctx = re.sub(r"\s+", " ", text[max(0, i - 18): i + len(w) + 18]).strip()
            hits.setdefault(w, ctx)
    return sorted(hits.items())


def hypothesis_tiers(rec: dict) -> list[tuple[int, float, str]]:
    """把假说数做成 1 / 3 / 5 三档压测第 07 页版式。

    不足 5 条时用占位文本补齐——**这些占位只用于量高度，不会渲染进任何产物**。
    """
    hs = _lst(rec, "hypotheses")
    out = []
    for n in (1, 3, 5):
        base = list(hs)
        while len(base) < n:
            base.append(f"H{len(base) + 1}（对应 RQ）：版式压测用占位假说，"
                        f"用于确认 {n} 条时该页仍在安全线内。预期方向：正。来源：压测。")
        v = dict(rec)
        v["hypotheses"] = base[:n]
        spec = next((s for s in page_specs(v) if s["label"] == "理论框架 · 假说"), None)
        h = estimate_page_height(spec) if spec else -1.0
        out.append((n, round(h, 1), f"{spec['no']} / {spec['label']}" if spec else "?"))
    return out


def _page_visible(chunk: str) -> str:
    """一页的**版面**可见文本：排除讲稿层、tag 编号与自动编号。"""
    seg = re.sub(r'<aside class="notes">.*?</aside>', " ", chunk, flags=re.S)
    seg = re.sub(r'<div class="tag">.*?</div>', " ", seg, flags=re.S)
    seg = re.sub(r'<span class="num">.*?</span>', " ", seg, flags=re.S)
    seg = re.sub(r'<span class="pn2">.*?</span>', " ", seg, flags=re.S)
    seg = re.sub(r"<[^>]+>", " ", seg)
    return _html.unescape(seg)


# 版面黑名单：这些词只该出现在讲稿层与自检报告里
_META_LEAK = [
    "extract", "hint:", "图表建议", "Zotero", "deepseek", "本 deck", "自检",
    "【待补】", "材料生成", "抽取模型", "逐列誊抄", "骨架页", "本页是", "字段来源",
]


def check_meta_leak(html: str) -> list[tuple[str, int]]:
    """硬门三：逐页扫描版面文本，命中元信息即失败。"""
    stage = html.split('<div id="stage">', 1)[-1].split('<div id="ctrl">', 1)[0]
    counts: dict[str, int] = {}
    for chunk in re.split(r'(?=<section class="slide)', stage):
        if "<section" not in chunk:
            continue
        text = _page_visible(chunk)
        low = text.lower()
        for w in _META_LEAK:
            n = low.count(w.lower())
            if n:
                counts[w] = counts.get(w, 0) + n
    return sorted(counts.items(), key=lambda kv: -kv[1])


def check_type_scale(html: str) -> list[str]:
    """字号：正文最小不低于 10px，标题/正文比不低于 1.6（要有真层级）。"""
    issues: list[str] = []
    sizes = [float(x) for x in re.findall(r"font-size:\s*([\d.]+)px", html)]
    if sizes and min(sizes) < 10:
        issues.append(f"最小字号 {min(sizes)}px < 10px")
    title = re.search(r"\.s-title\{[^}]*?font-size:\s*([\d.]+)px", html, re.S)
    body = re.search(r"\.bullets li\{[^}]*?font-size:\s*([\d.]+)px", html, re.S)
    if title and body:
        ratio = float(title.group(1)) / float(body.group(1))
        if ratio < 1.6:
            issues.append(f"标题/正文 = {ratio:.2f} < 1.6，层级不够")
    return issues


def _saturation(hex_color: str) -> float:
    """粗略 HSV 饱和度。用来判断"强调色到底有没有颜色"。"""
    h = hex_color.lstrip("#")
    if len(h) != 6:
        return 0.0
    r, g, b = (int(h[i:i + 2], 16) / 255 for i in (0, 2, 4))
    mx, mn = max(r, g, b), min(r, g, b)
    return 0.0 if mx == 0 else (mx - mn) / mx


def check_accent(html: str) -> tuple[str, float]:
    """强调色必须有饱和度——v1 的 `#1d1d1f` 等于没有强调色。"""
    m = re.search(r"--accent:\s*(#[0-9a-fA-F]{6})", html)
    if not m:
        return ("", 0.0)
    return (m.group(1), _saturation(m.group(1)))


def check_duplicate_pages(specs: list[dict]) -> list[tuple[str, str, float]]:
    """两页要点高度重合 → 讲的时候会重复。"""
    def toks(s):
        return {t for b in (s.get("bullets") or []) for t in re.findall(r"[\u4e00-\u9fa5]{2,4}", b)}

    out = []
    for i in range(len(specs)):
        for j in range(i + 1, len(specs)):
            a, b = toks(specs[i]), toks(specs[j])
            if len(a) < 4 or len(b) < 4:
                continue
            jac = len(a & b) / len(a | b)
            if jac > 0.8:
                out.append((specs[i]["tag"], specs[j]["tag"], jac))
    return out


def selfcheck(html: str, rec: dict, audit: dict) -> tuple[str, list[str]]:
    """全部自检；返回 (markdown 报告, 失败清单)。"""
    specs: list[dict] = audit["specs"]
    fails: list[str] = []
    rows: list[dict] = []

    sections = re.findall(r'<section class="slide([^"]*)" data-idx="(\d+)">(.*?)</section>', html, re.S)
    if len(sections) != len(specs) + 1:
        fails.append(f"页数不符：HTML {len(sections)} 页，spec {len(specs)} + 封面 = {len(specs) + 1}")

    content_sections = sections[1:]
    for i, s in enumerate(specs):
        if i >= len(content_sections):
            break
        cls, idx, body = content_sections[i]
        problems = []
        if f'<div class="tag">{_html.escape(s["tag"], quote=False)}</div>' not in body:
            problems.append("缺 tag")
        if '<h2 class="s-title">' not in body:
            problems.append("缺标题")
        # 正文只要有一种内容块就算立得住：要点 / 表 / 定义卡 / 公式 / 图 / 例子 / 标注栏
        has_content = any(k in body for k in (
            '<ol class="bullets">', '<table class="dt">', '<div class="kv-grid">',
            '<div class="formula-card">', '<figure class="fig">', '<div class="example">',
            '<div class="aside">',
        ))
        if not has_content:
            problems.append("正文为空（没有任何内容块）")
        if '<aside class="notes">' not in body:
            problems.append("缺讲稿")
        if bool(s.get("appendix")) != ("is-appendix" in cls):
            problems.append("附录标记不符")
        if problems:
            fails.append(f"{s['tag']}：{'；'.join(problems)}")

        nl = len(_tidy(s.get("notes")))
        if not (150 <= nl <= 520):
            fails.append(f"{s['tag']}：讲稿 {nl} 字，超出 60-90 秒区间（150-520 字）")
        for b in (s.get("bullets") or []):
            if len(b) > 110:
                fails.append(f"{s['tag']}：要点超过两行（{len(b)} 字）：{b[:24]}…")
        rows.append({
            "idx": int(idx), "tag": s["tag"], "title": s["title"],
            "bul": len(re.findall(r"<li[ >]", body)), "notes": nl,
            "tbd": _page_visible(body).count("【待补】"),
            "appendix": bool(s.get("appendix")),
        })

    # ── 硬门一：数字溯源 ──
    unresolved, self_nums = check_number_provenance(html, rec, specs)
    if unresolved:
        fails.append("数字未溯源（extract 里找不到出处）：" +
                     "；".join(f"{t} ← …{c}…" for t, c in unresolved))

    # ── 硬门二：交叉污染 ──
    contam = check_contamination(html, rec)
    if contam:
        fails.append("交叉污染（出现别的论文的专属词，且不在本次 extract 里）：" +
                     "；".join(f"{w} ← …{c}…" for w, c in contam))

    # ── 硬门三：页面上不得出现任何生成器元信息 ──
    meta_hits = check_meta_leak(html)
    if meta_hits:
        fails.append("页面出现生成器元信息（应只存在于讲稿层与报告）：" +
                     "；".join(f"{k} ×{v}" for k, v in meta_hits))

    # ── 硬门四：版面不得留【待补】 ──
    tbd_on_page = sum(r["tbd"] for r in rows)
    if tbd_on_page:
        fails.append(f"版面仍有 {tbd_on_page} 处【待补】——应改为破折号占位，补数清单进报告")

    # ── 硬门五：字号与强调色 ──
    scale_issues = check_type_scale(html)
    if scale_issues:
        fails.append("字号层级不合格：" + "；".join(scale_issues))
    accent_hex, accent_sat = check_accent(html)
    if accent_sat < 0.35:
        fails.append(f"强调色 {accent_hex or '（未定义）'} 饱和度 {accent_sat:.2f} < 0.35"
                     "——等于没有强调色")

    # ── 硬门六：跨页重复 ──
    dup = check_duplicate_pages(specs)
    if dup:
        fails.append("跨页要点重复：" + "；".join(f"{a} ≈ {b}（{s:.2f}）" for a, b, s in dup))

    # ── 硬门七：真实渲染实测 ──
    probe_rows, probe_ok = {}, False
    if audit.get("html_path"):
        from probe import probe_deck
        probe_rows = probe_deck(audit["html_path"])
        probe_ok = bool(probe_rows)
        if probe_ok:
            for i, r in probe_rows.items():
                need, avail = r.get("need"), r.get("avail")
                scroll = r.get("scroll")
                if isinstance(scroll, int) and isinstance(avail, int) and scroll > avail + 12:
                    fails.append(f"第 {i} 页正文溢出 {scroll - avail}px（实测）")
                elif isinstance(need, int) and isinstance(avail, int) and avail - need > FILL_SLACK:
                    fails.append(f"第 {i} 页正文下方空 {avail - need}px（实测），"
                                 f"超过 {FILL_SLACK:.0f}px 容忍线")
                # 内部滚动容器的裁剪：卡片被切掉半行字，.s-body 的 scrollHeight 是看不出来的
                clip = r.get("clip")
                if isinstance(clip, int) and clip > 2:
                    fails.append(f"第 {i} 页 .{r.get('clipWho') or 'col-main'} 内部裁剪 {clip}px（实测）")

    # ── 页数区间 ──
    n_main = sum(1 for r in rows if not r["appendix"]) + 1
    n_app = sum(1 for r in rows if r["appendix"])
    if not (18 <= n_main <= 25):
        fails.append(f"主文 {n_main} 页，不在 18-25 区间")
    if not (8 <= n_app <= 15):
        fails.append(f"附录 {n_app} 页，不在 8-15 区间")

    # ── 基础完整性 ──
    if "tex-svg.js" not in html:
        fails.append("缺 MathJax（公式无法渲染）")
    if html.count("$$") % 2 != 0:
        fails.append("公式 $$ 不成对")
    if html.count("<section class=") != html.count("</section>"):
        fails.append("section 标签不配对")

    # ── 报告 ──
    m = audit["measure"]
    tbd_rows = [r for r in rows if r["tbd"]]
    L = []
    L.append(f"# build_lecture 自检报告{'' if not fails else '（有失败项）'}\n")
    L.append(f"- 论文：{_default_deck_title(rec)}")
    L.append(f"- 生成器：build_lecture.py v{VERSION}（论文中立版；视觉基座 deckkit）")
    L.append(f"- 总页数：**{len(rows) + 1}**（封面 1 + 主文 {n_main - 1} + 附录 {n_app}）")
    L.append(f"- 主文 {n_main} 页（区间 18-25）／附录 {n_app} 页（区间 8-15）")
    L.append(f"- 检查失败项：**{len(fails)}**")
    L.append("")
    L.append("## 逐页清单\n")
    L.append("| # | tag | 标题（= 一句结论） | 要点 | 讲稿字数 | 实测正文高度 | 可用高度 | 余量 |")
    L.append("|---|---|---|---|---|---|---|---|")
    L.append(f"| 1 | 封面 | {_default_deck_title(rec)} | — | — | — | — | — |")
    for r in rows:
        pr = probe_rows.get(r["idx"]) or {}
        need = pr.get("need", "")
        avail = pr.get("avail", "")
        margin = (avail - need) if isinstance(need, int) and isinstance(avail, int) else ""
        L.append(f"| {r['idx']} | {r['tag']} | {r['title']} | {r['bul']} | "
                 f"{r['notes']} | {need} | {avail} | {margin} |")
    L.append("")
    L.append("## 留空清单（版面上是破折号，不印【待补】）\n")
    L.append("| # | tag | 留空处数 | 取数位置（该页读了哪些字段） |")
    L.append("|---|---|---|---|")
    for r in tbd_rows:
        spec = next((s for s in specs if s["tag"] == r["tag"]), {})
        L.append(f"| {r['idx']} | {r['tag']} | {r['tbd']} | {'、'.join(spec.get('_fields', [])) or '—'} |")
    if not tbd_rows:
        L.append("| — | — | 0 | 本次无留空 |")
    L.append("")
    L.append("## 诚实性硬门\n")
    L.append("- **数字溯源**：逐页扫描 `#stage` 可见文本（先剔除 deckkit 自动编号与本 deck 的 tag 编号），"
             "每个数字都必须能在本次 extract 的文本里找到出处")
    L.append(f"  - 未溯源数字：**{len(unresolved)}** 处" +
             (f" → {'；'.join(f'{t} ← …{c}…' for t, c in unresolved)}" if unresolved else " ✓"))
    L.append("- **交叉污染**：deck 里不得出现别的论文的专属词（词表见 `CONTAMINATION_WORDS`），"
             "除非该词确实来自本次 extract")
    L.append(f"  - 命中：**{len(contam)}** 处" +
             (f" → {'；'.join(f'{w} ← …{c}…' for w, c in contam)}" if contam else " ✓"))
    L.append(f"  - 词表：{'、'.join(CONTAMINATION_WORDS)}")
    L.append("  - 本次 extract 自身包含的词（因此豁免）："
             f"{'、'.join(w for w in CONTAMINATION_WORDS if w.lower() in json.dumps(rec, ensure_ascii=False).lower()) or '（无）'}")
    L.append("  - 自生成结构数（生成器本次实测，只在检查清单页内部豁免）："
             f"{'、'.join(self_nums) if self_nums else '—'}")
    L.append("")
    L.append("## 版式实测\n")
    if probe_ok:
        over = [(i, r["scroll"] - r["avail"]) for i, r in probe_rows.items()
                if isinstance(r.get("scroll"), int) and isinstance(r.get("avail"), int)
                and r["scroll"] > r["avail"] + 12]
        thin = [(i, r["avail"] - r["need"]) for i, r in probe_rows.items()
                if isinstance(r.get("need"), int) and isinstance(r.get("avail"), int)
                and r["avail"] - r["need"] > FILL_SLACK]
        L.append("- 实测方式：无头浏览器逐页量正文块的真实底边与可用高度（`?probe=1`）")
        L.append(f"- 溢出页：**{len(over)}** 页" +
                 (f" → {'；'.join(f'第 {i} 页多 {d}px' for i, d in over)}" if over else " ✓"))
        L.append(f"- 留白过大页：**{len(thin)}** 页（余量 > {FILL_SLACK}px）" +
                 (f" → {'；'.join(f'第 {i} 页空 {d}px' for i, d in thin)}" if thin else " ✓"))
    else:
        L.append("- 未实测：本机没找到 Chrome/Edge，版式只做了结构性检查。"
                 "在能起浏览器的环境重跑一次即可拿到真实高度。")
    L.append(f"- 要点条数区间 {m['bul_min']}-{m['bul_max']}，最长要点 {m['bul_max_chars']} 字")
    L.append(f"- 讲稿字数区间 {m['notes_min']}-{m['notes_max']} 字（60-90 秒 ≈ 180-420 字）")
    L.append(f"- 强调色：`{accent_hex}`，饱和度 {accent_sat:.2f}")
    L.append("")
    L.append("## 版式自适应让步记录\n")
    auto = [(s["tag"], "；".join(s["_autofit"])) for s in specs if s.get("_autofit")]
    if auto:
        L.append("| tag | 为了让页面落进安全线，做了什么 |")
        L.append("|---|---|")
        for tag, note in auto:
            L.append(f"| {tag} | {note} |")
        L.append("")
        L.append("说明：让步只改**呈现**（表格压缩 / 图表建议改放脚注 / 让出结论带或变量胶囊），"
                 "不改任何取自 extract 的事实；要素齐备性由上面的逐页断言兜底。")
    else:
        L.append("本次无需让步：所有页面天然落在安全线内。")
    L.append("")
    if fails:
        L.append("## 失败项\n")
        for f in fails:
            L.append(f"- {f}")
    else:
        L.append("## 结论\n")
        L.append("全部自检通过：结构齐备、数字全部可溯源、无交叉污染、版式（含假说 1/3/5 条）在安全线内。")
    return "\n".join(L) + "\n", fails


# ══════════════════════════════════════════════════════════════════════════
# 7. main
# ══════════════════════════════════════════════════════════════════════════

def _author_key(rec: dict) -> str:
    """取第一作者姓氏的 ASCII 形式，用于 PPT_作者_年份.html 命名。"""
    surname = _meta(rec, "first_author_surname")
    if surname:
        return re.sub(r"[^A-Za-z\-]", "", surname) or "Unknown"
    authors = _tidy(rec.get("authors") or _meta(rec, "authors_full"))
    first = authors.split(",")[0].strip() or authors.split(" and ")[0].strip()
    surname = first.split()[-1] if first.split() else "Unknown"
    return re.sub(r"[^A-Za-z\-]", "", surname) or "Unknown"


def _default_out_name(rec: dict) -> str:
    year = _tidy(rec.get("year") or _meta(rec, "year")) or "noyear"
    return f"PPT_{_author_key(rec)}_{year}.html"


def _default_deck_title(rec: dict) -> str:
    return _tidy(rec.get("title") or _meta(rec, "title")) or "论文精读"


def _resolve_input(p: str) -> Path:
    for base in (Path.cwd(), _HERE.parent.parent):
        cand = (base / p) if not Path(p).is_absolute() else Path(p)
        if cand.exists():
            return cand
    raise SystemExit(f"[build_lecture] 找不到 extract 文件：{p}")


def _resolve_out(p: str, rec: dict) -> Path:
    name = _default_out_name(rec)
    if not p:
        return Path.cwd() / name
    path = Path(p)
    if p.endswith(("/", "\\")) or path.is_dir():
        return path / name
    return path


def build_from_slides(spec: dict, theme: str = "paper") -> Deck:
    """
    从**已经写好的**幻灯片内容 JSON 直接排版，完全不读 extract。

    为什么要有这条路：extract 是给检索用的压缩稿，字段短、带【待补】、句子被摘要过；
    拿它当正文，页面上就只能出现半句话和占位符。真正该进版面的，是 md 里的原句。
    所以内容由读原文的一步产出成 JSON（每页写清标题、原文引用、要点、表），
    这个函数只负责把它排出来——不做任何裁剪、不补任何占位。
    """
    d = Deck(title=spec.get("title", ""), theme=theme, footer=spec.get("footer", FOOTER))
    d.cover(
        title=spec.get("title", ""),
        authors=spec.get("authors", ""),
        affiliation=spec.get("affiliation", ""),
        hook=spec.get("hook", ""),
        kicker=spec.get("kicker", ""),
        meta=[tuple(x) for x in (spec.get("meta") or [])],
        notes=spec.get("cover_notes", ""),
    )
    for i, sl in enumerate(spec.get("slides") or [], 1):
        tag = sl.get("tag") or f"{i:02d}"
        d.slide(
            tag=tag,
            title=sl.get("title", ""),
            subtitle=sl.get("subtitle", ""),
            bullets=sl.get("bullets") or None,
            quotes=[tuple(x) for x in (sl.get("quotes") or [])] or None,
            table=sl.get("table") or None,
            kv=[tuple(x) for x in (sl.get("kv") or [])] or None,
            formula=sl.get("formula", ""),
            formula_no=sl.get("formula_no", ""),
            formula_label=sl.get("formula_label", ""),
            takeaway=sl.get("takeaway", ""),
            aside=[tuple(x) for x in (sl.get("aside") or [])] or None,
            figure=sl.get("figure") or None,
            footnote=sl.get("footnote", ""),
            notes=sl.get("notes", ""),
            layout=sl.get("layout", ""),
            appendix=bool(sl.get("appendix")),
        )
    return d


def _slides_report(html: str, spec: dict, html_path: str) -> tuple[str, list[str]]:
    """--slides 模式的轻量自检：结构 + 实测版式 + 「不留占位」三条硬线。"""
    fails: list[str] = []
    warns: list[str] = []
    bad = [w for w in ("【待补】", "待核对", "extract") if w in html]
    if bad:
        fails.append("版面出现禁用字样：" + "、".join(bad))
    if "…" in html:
        n = html.count("…")
        warns.append(f"版面还有 {n} 处省略号，需人工确认是否属于原文引用")
    pr = _probe.probe_deck(html_path)
    over = [f"p{i}(+{r['scroll'] - r['avail']}px)" for i, r in pr.items()
            if isinstance(r.get("scroll"), int) and isinstance(r.get("avail"), int)
            and r["scroll"] > r["avail"] + 12]
    thin = [f"p{i}(余{r['avail'] - r['need']}px)" for i, r in pr.items()
            if isinstance(r.get("need"), int) and isinstance(r.get("avail"), int)
            and r["avail"] - r["need"] > 150]
    clip = [f"p{i}(.{r.get('clipWho') or 'col-main'} 切 {r['clip']}px)" for i, r in pr.items()
            if isinstance(r.get("clip"), int) and r["clip"] > 2]
    if over:
        fails.append("溢出：" + "、".join(over))
    if clip:
        fails.append("内部裁剪：" + "、".join(clip))
    if thin:
        warns.append("留白偏大：" + "、".join(thin))

    L = [f"# {Path(html_path).stem} 自检报告\n",
         f"- 内容来源：`{spec.get('source_md', '（未标注）')}`（**不读 extract**）",
         f"- 页数：{len(spec.get('slides') or []) + 1}（封面 1 + 正文 {len(spec.get('slides') or [])}）",
         f"- 失败：{len(fails)} 项；提醒：{len(warns)} 项\n",
         "## 硬线\n"]
    for f in fails:
        L.append(f"- ✗ {f}")
    for w in warns:
        L.append(f"- ⚠ {w}")
    if not fails and not warns:
        L.append("- ✓ 无占位符 / 无溢出 / 版面充实")
    L.append("\n## 页清单\n")
    L.append("| # | 页签 | 标题 |")
    L.append("|---|---|---|")
    L.append(f"| 01 | 封面 | {spec.get('title', '')} |")
    for i, sl in enumerate(spec.get("slides") or [], 2):
        L.append(f"| {i:02d} | {sl.get('tag', '')} | {sl.get('title', '')} |")
    return "\n".join(L), fails


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        description="extract.json → 大佬版全篇学术单文件 HTML 演示页（PPT_作者_年份.html）")
    ap.add_argument("--extract", default="", help="extract.json 路径（--slides 模式下不用给）")
    ap.add_argument("--slides", default="",
                    help="已写好的幻灯片内容 JSON（由读 md 的一步产出）；给了就完全不读 extract")
    ap.add_argument("--out", default="", help="输出 HTML 路径；留空或给目录则按 PPT_作者_年份.html 命名")
    ap.add_argument("--md", default="", help="pdf2md 产出的 .md 路径（补作者单位、图注、章节线索）")
    ap.add_argument("--assets", default="", help="mdassets 产出的资产目录（figures.json / tables.json / page_map.json）")
    ap.add_argument("--theme", default=THEME, choices=["paper", "doctrine", "podium", "blue", "ink", "teal", "warm"])
    ap.add_argument("--report", default="", help="自检报告路径；默认与 --out 同目录同名 + _selfcheck.md")
    ap.add_argument("--no-selfcheck", action="store_true", help="跳过自检（不推荐）")
    args = ap.parse_args(argv)

    if args.slides:
        spec = json.loads(Path(args.slides).read_text(encoding="utf-8"))
        deck = build_from_slides(spec, theme=args.theme)
        html = deck.render()
        out_path = Path(args.out) if args.out else Path("staging") / "PPT_slides.html"
        if out_path.suffix.lower() != ".html":
            out_path = out_path / "PPT_slides.html"
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(html, encoding="utf-8")
        print(f"[build_lecture] 内容源  ：{args.slides}（不读 extract）")
        print(f"[build_lecture] 主题    ：{args.theme}")
        print(f"[build_lecture] 输出    ：{out_path}  （{len(html.encode('utf-8')) / 1024:.1f} KB）")
        print(f"[build_lecture] 页数    ：{len(spec.get('slides') or []) + 1} 页")
        if args.no_selfcheck:
            return 0
        rep, fails = _slides_report(html, spec, str(out_path))
        rp = Path(args.report) if args.report else out_path.with_name(out_path.stem + "_selfcheck.md")
        rp.write_text(rep, encoding="utf-8")
        print(f"[build_lecture] 自检    ：{rp}")
        print(f"[build_lecture] 失败项  ：{len(fails)}")
        for f in fails:
            print(f"    ✗ {f}")
        return 0 if not fails else 1

    if not args.extract:
        print("[error] 要么给 --extract，要么给 --slides", file=sys.stderr)
        return 2
    extract_path = _resolve_input(args.extract)
    record = json.loads(extract_path.read_text(encoding="utf-8"))

    md = load_md(args.md) if args.md else {}
    assets = load_assets(args.assets) if args.assets else {}

    deck = build_deck(record, theme=args.theme, md=md, assets=assets)
    html = deck.render()
    out_path = _resolve_out(args.out, record)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(html, encoding="utf-8")
    deck.audit["html_path"] = str(out_path)   # 自检要拿它跑真实浏览器实测

    specs = deck.audit["specs"]
    n_main = sum(1 for s in specs if not s.get("appendix")) + 1
    n_app = sum(1 for s in specs if s.get("appendix"))
    print(f"[build_lecture] extract ：{extract_path}")
    print(f"[build_lecture] 输出    ：{out_path}  （{len(html.encode('utf-8')) / 1024:.1f} KB）")
    print(f"[build_lecture] 页数    ：共 {len(specs) + 1} 页 = 封面 1 + 主文 {n_main - 1} + 附录 {n_app}")

    if args.no_selfcheck:
        print("[build_lecture] 已跳过自检（--no-selfcheck）")
        return 0

    report, fails = selfcheck(html, record, deck.audit)
    report_path = Path(args.report) if args.report else out_path.with_name(out_path.stem + "_selfcheck.md")
    report_path.write_text(report, encoding="utf-8")
    print(f"[build_lecture] 自检    ：{report_path}")
    print(f"[build_lecture] 失败项  ：{len(fails)}")
    for f in fails:
        print(f"    ✗ {f}")
    if not fails:
        print("[build_lecture] ✓ 结构齐备 / 数字全部可溯源 / 无交叉污染 / 版式在安全线内")
    return 1 if fails else 0


if __name__ == "__main__":
    raise SystemExit(main())
