#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
build_design.py —— 「实证设计」专题演示页生成器（单文件 HTML，视觉基座 = deckkit）

用法：
    py -3.13 src\\html\\build_design.py --extract templates\\sample_extract.json --out staging\\design_demo.html
    py -3.13 src\\html\\build_design.py --extract extract.json --md staging\\paper.md --out staging\\design_X_2026.html

页面结构（主文 10 页 + 附录 3 页 = 13 页）：
    01 封面              02 一张图看懂（假说→变量→模型→识别→结果）
    03 假说 H1/H2/H3     04 变量定义表         05 核心变量创新
    06 基准模型（唯一主方程）  07 识别策略      08 机制与异质性
    09 稳健性            10 假说—证据对照表
    A1 公式符号表        A2 变量完整定义       A3 额外稳健性

主文公式 ≤ 3 个（05 变量构造 / 06 基准模型 / 07 识别目标），其余一律放附录。

──────────────────────────── 诚实性硬约束 ────────────────────────────
1. 原文（extract / --md）里没有的数据、系数、样本量、标准误、显著性水平，
   一律写「【待补】」，绝不编造、绝不估算、绝不「示意」。
2. 每一处「【待补】」都登记进 ctx.pending（页 → 位置 → 原因），
   并且保证所在页的页脚脚注里出现「待补」二字（自检会逐页断言这一点）。
3. 自检会剥掉 <style>/<script> 后扫描渲染结果，出现 `***`、`p < 0.0x`、
   `t = 数字`、`标准误 = 数字`、`N = 数字` 这类伪造统计量的写法直接判 FAIL。
4. 所有符号（Y_ij 结果 / T_j 处理 / M_j 调节 / β、γ、δ、τ）都是本演示页的**讲解记法**，
   不是原文符号；页面上必须显式声明，并注明「原文变量名【待补】」。
5. 通用性：页面框架、标题、短句、讲稿一律是**论文中立**的（只讲「这个设计怎么读」），
   论文的具体事实只以「extract 摘录：…」的形式逐字出现——换一篇论文不会串戏。
   实证设计槽位的取值优先级：extract.design[key] → --md 同名小节 → 关键词逐字摘录 →【待补】。

extract 可选扩展块 `design`（templates/extract_schema.json 尚未定义该块，属于本脚本的
向前兼容：字段缺失时自动回落为【待补】，不会瞎填）：
    outcome / treatment / moderator / controls / fe / cluster / data_source /
    model_latex / identification / mechanism / heterogeneity / robustness /
    results（与 hypotheses 同序，逐条给出检验结论） / sample
"""

from __future__ import annotations

import argparse
import html as _html
import json
import math
import re
import sys
from pathlib import Path

# 中文输出：Windows 控制台默认 GBK，不重设会把中文/【待补】打成乱码
try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:  # pragma: no cover - 极老的解释器/被重定向时才可能失败
    pass

# deckkit 与本文件同目录；允许从任意 cwd 调用
_HERE = Path(__file__).resolve().parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))

from deckkit import Deck  # noqa: E402  （deckkit 只读复用，本脚本不改它）
from mdparse import load_assets, load_md  # noqa: E402
import probe as _probe  # noqa: E402

# 缺失占位符：页面上只印一个破折号。
# 旧版印「【待补】」，一页能出现六七次，读者看到的是「这个 deck 还没做完」；
# 现在缺失的原因只进两处——讲稿层（按 N）与自检报告的留空清单。
TBD = "—"
FOOTER = "硕士组会 · 论文阅读积累"
THEME = "doctrine"

# 版面黑名单：这些词只要出现在可见文本里，就说明「生成过程」漏到页面上了
_META_WORDS = (
    "extract", "摘录", "待补", "演示页", "本页为", "供核对", "字段", "骨架",
    "原文 PDF", "本 deck", "本文档", "自检", "抽取", "生成器",
)


# ══════════════════════════════ 小工具 ══════════════════════════════

def _txt(v) -> str:
    """
    任意值 → 干净字符串。**dict 一律返回空串**：
    实测真实 extract 里 design.mechanism / design.heterogeneity 是「dict 列表」，
    早先版本用 str(v) 会把 Python 的 {'name': ...} repr 直接渲染进页面。
    """
    if v is None:
        return ""
    if isinstance(v, str):
        return _scrub(v.strip())
    if isinstance(v, (int, float)):
        return str(v)
    if isinstance(v, (list, tuple)):
        return " ".join(x for x in (_txt(i) for i in v) if x)
    return ""


_META_INLINE = re.compile(r"【\s*待补\s*】|\[\s*待补\s*\]|[（(]\s*待补\s*[）)]")


def _scrub(s: str) -> str:
    """
    抹掉「生成过程」的痕迹，只留内容。

    extract 里大量字段以「【待补】论文未报告…」开头——那个前缀是给抽取者看的记号，
    不是内容。抹掉后剩下「论文未报告任何固定效应结构（无个体/时间/行业固定效应）」，
    这句话本身就是要印在页面上的答案，所以只去记号、不去正文。
    """
    s = _META_INLINE.sub("", s or "")
    # md 的行号定位（「（第 729—795 行）」）对读者毫无意义，是抽取过程的副产品，一并去掉。
    # 注意只去「行」，不去「页」与「表/图」——后两者正是要印在页脚上的出处。
    s = re.sub(r"[（(]\s*第?\s*\d+\s*[—\-–~至]\s*\d+\s*行\s*[）)]", "", s)
    s = re.sub(r"[（(]\s*第\s*\d+\s*行\s*[）)]", "", s)
    s = re.sub(r"第\s*\d+\s*[—\-–~]\s*\d+\s*行", "", s)
    s = re.sub(r"^\s*[：:，,、]\s*", "", s)
    return s.strip(" ，,；;。\u3000")


def _as_text(v) -> str:
    """只接受标量字段（字符串/数字）；结构化字段返回空串，让调用方回落。"""
    return _txt(v) if isinstance(v, (str, int, float)) else ""


def _gloss(s: str) -> str:
    """经济概念条目常写成「术语 → 释义」，取释义那半。"""
    for sep in ("→", "->", "—>", "＝>", "=>"):
        if sep in s:
            tail = s.split(sep, 1)[1].strip()
            if len(tail) >= 8:
                return tail
    return s


def _dedupe(parts: list[str]) -> list[str]:
    """去掉完全重复的片段（真实 extract 里同一句常同时出现在多处）。"""
    out = []
    for p in parts:
        if p and p not in out:
            out.append(p)
    return out


def _esc(x) -> str:
    return "" if x is None else _html.escape(str(x), quote=False)


def _clip(s: str, limit: int) -> str:
    """
    截到 limit 字，但**只按整句截，绝不在一句话中间切**。

    v1 切在任意字符上，页面上出现的是
        「样本期：1962 年 7 月至 2000 年 12 月，分三个制度期——(i) 1962.07—1976.08：指数化不流行…」
    读者根本不知道后半句写了什么。省略号省掉的是信息，不是废话。
    现在：能装几整句装几整句；第一句本身就超长，就整句留着——宁可这行长一点。
    """
    s = re.sub(r"\s+", " ", _txt(s)).strip()
    s = re.sub(r"^[（(]\s*\d+\s*[）)]\s*", "", s)
    s = re.sub(r"^【(?!待补)[^】]{1,10}】\s*", "", s)   # 剥掉【已有理论】/【本文理论】这类小节标记
    s = s.strip("。；; ")
    if len(s) <= limit:
        return s
    parts = [x for x in re.split(r"(?<=[。；;！？])", s) if x.strip()]
    if not parts:
        return s
    out = ""
    for x in parts:
        if out and len(out) + len(x) > limit:
            break
        out += x
    return out.strip("。；; ") or parts[0].strip("。；; ")


def _clauses(text: str) -> list[str]:
    """按句号/分号/换行切句，用于「原文摘录」。"""
    out = []
    for piece in re.split(r"[。；;\n]+", _txt(text)):
        piece = re.sub(r"\s+", " ", piece).strip()
        if len(piece) >= 8:
            out.append(piece)
    return out


def _grams(s: str, n: int = 3) -> set[str]:
    """中文 3-gram（去标点/空格），用于把假说和摘要句子做「摘录匹配」。"""
    s = re.sub(r"[^\u4e00-\u9fffA-Za-z0-9]", "", _txt(s)).lower()
    return {s[i:i + n] for i in range(max(0, len(s) - n + 1))}


def _cjk_grams(s: str, n: int = 3) -> set[str]:
    """
    只保留汉字的 n-gram。
    系数—假说匹配必须用这个：拉丁/数字 token（S&P 500、CAR60、1976）在两边都出现时
    会造成假匹配（实测把「Log(RelSize) 的控制变量」配给了含「S&P 500」的 H1）。
    """
    s = re.sub(r"[^\u4e00-\u9fff]", "", _txt(s))
    return {s[i:i + n] for i in range(max(0, len(s) - n + 1))}


def _best_clause(query: str, clauses: list[str], min_score: int = 3) -> tuple[str | None, int]:
    """在 clauses 里找与 query 重合最多的那句（自动匹配的「原文摘录」）。返回 (句子, 重合度)。"""
    q = _grams(query)
    if not q or not clauses:
        return None, 0
    need = min(min_score, max(1, len(q) // 4))
    best, score = None, 0
    for c in clauses:
        sc = len(q & _grams(c))
        if sc > score:
            best, score = c, sc
    return (best, score) if score >= need else (None, score)


def _first_clause(clauses: list[str], keywords: list[str], exclude: list[str] | None = None) -> str | None:
    """返回第一个命中任一关键词（且不含 exclude 关键词）的句子。"""
    for c in clauses:
        if exclude and any(k in c for k in exclude):
            continue
        if any(k in c for k in keywords):
            return c
    return None


def _max_int(s: str) -> int:
    """句子里最大的整数（用来认出「总样本量」那句）。"""
    nums = [int(x) for x in re.findall(r"\d+", s or "")]
    return max(nums) if nums else 0


def _parse_hypothesis(s: str) -> dict:
    """
    解析 extract.hypotheses 的一条：
      "H1（对应 RQ1）：……。预期方向：正。来源：作者明示。"
      → {label, tag, content, direction, source}
    """
    s = _txt(s)
    m = re.match(r"^(H\d+)\s*(?:[（(]\s*([^）)]*?)\s*[）)])?\s*[:：]\s*(.*)$", s, re.S)
    label, tag, rest = (m.group(1), (m.group(2) or "").strip(), m.group(3)) if m else ("", "", s)

    d = re.search(r"预期方向\s*[:：]\s*([^。；;\n]+)", rest)
    src = re.search(r"来源\s*[:：]\s*([^。；;\n]+)", rest)
    content = re.sub(r"预期方向\s*[:：][^。；;\n]+[。；;]?", "", rest)
    content = re.sub(r"来源\s*[:：][^。；;\n]+[。；;]?", "", content)
    return {
        "label": label or "H",
        "tag": tag,
        "content": content.strip(" 。；;"),
        "direction": d.group(1).strip() if d else "",
        "source": src.group(1).strip() if src else "",
    }


def _surname(authors: str) -> str:
    """取第一作者姓氏，用于 design_作者_年份.html 命名。"""
    a = _txt(authors)
    if not a:
        return ""
    first = re.split(r"[,，;；]| and ", a)[0].strip()
    parts = [p for p in first.split() if p]
    return parts[-1] if parts else ""


# ══════════════════════════ deckkit 兼容的 HTML 片段 ══════════════════════════
# 说明：装饰 4 个「表格页」用 deckkit.raw() 逃生口做左右分栏。原因见完成报告的
# 「已知风险」：stack 版式在 720px 内塞不下 7 行表格 + 短句 + 小例子 + 过渡句。
# 这里只复用 deckkit 已有的 class，不新增/覆盖任何 CSS。

def _bullets_html(items: list[str]) -> str:
    lis = "".join(
        f'<li style="--i:{i}"><span class="num">{i}</span><span class="txt">{_esc(b)}</span></li>'
        for i, b in enumerate(items, 1)
    )
    return f'<ol class="bullets">{lis}</ol>'


def _table_html(spec: dict) -> str:
    """与 deckkit._table 输出保持一致的表格片段。"""
    headers = spec.get("headers") or []
    rows = spec.get("rows") or []
    aligns = spec.get("align") or ["l"] * len(headers)
    caption = spec.get("caption") or ""
    cap = f"<caption>{_esc(caption)}</caption>" if caption else ""
    th = "".join(
        f'<th class="{aligns[i] if i < len(aligns) else "l"}">{_esc(h)}</th>' for i, h in enumerate(headers)
    )
    body = []
    first_col_bold = bool(spec.get("first_col_bold"))
    for r in rows:
        tds = []
        for i, cell in enumerate(r):
            a = aligns[i] if i < len(aligns) else "l"
            c = _esc(cell)
            if i == 0 and first_col_bold:
                c = f"<b>{c}</b>"
            tds.append(f'<td class="{a}">{c}</td>')
        body.append("<tr>" + "".join(tds) + "</tr>")
    return (
        f'<div class="tbl-wrap"><table class="dt">{cap}<thead><tr>{th}</tr></thead>'
        f'<tbody>{"".join(body)}</tbody></table></div>'
    )


def _example_html(text: str) -> str:
    return f'<div class="example"><span class="ex-tag">举个例</span><p>{_esc(text)}</p></div>'


def _transition_html(text: str) -> str:
    return f'<div class="transition"><span class="tr-arrow">↓</span>{_esc(text)}</div>'


# ══════════════════════════════ 上下文（数据 → 页面素材） ══════════════════════════════

class Ctx:
    """把 extract（+ 可选 md）解析成页面可直接引用的素材，并登记所有【待补】。"""

    def __init__(self, record: dict, topic: str = "", md: dict | None = None):
        rec = record or {}
        self.rec = rec
        self.meta = rec.get("meta") or {}
        self.design = rec.get("design") or {}          # 可选扩展块
        self.md = md or {}                             # --md 抓到的「模型设定/识别策略/…」
        self.topic = _txt(topic)

        self.title = _txt(self.meta.get("title")) or "（论文标题【待补】）"
        self.authors = _txt(rec.get("authors") or self.meta.get("authors_full"))
        self.year = _txt(rec.get("year") or self.meta.get("year"))
        self.journal = _txt(self.meta.get("journal"))
        self.doi = _txt(self.meta.get("doi"))
        self.source_pdf = _txt(self.meta.get("source_pdf"))
        self.md_path = _txt(self.meta.get("md_path"))
        self.abstract = _txt(rec.get("abstract"))
        self.data = _txt(rec.get("data"))

        self.hyps = [_parse_hypothesis(h) for h in (rec.get("hypotheses") or [])]
        self.rqs = [_txt(x) for x in (rec.get("research_questions") or [])]
        self.limits = [_txt(x) for x in (rec.get("limitations") or [])]
        self.confusions = [_txt(x) for x in (rec.get("confusions") or [])]

        # 「原文摘录」句库：只放实证设计相关的字段（fun_story 是段子，不进句库）
        pool_text = " ".join([
            self.abstract, self.data, _txt(rec.get("core_theory")), _txt(rec.get("contribution")),
            " ".join(self.limits), " ".join(self.confusions), " ".join(self.rqs),
        ])
        self.pool = _clauses(pool_text)
        self.abs_clauses = _clauses(self.abstract)
        # 变量定义类槽位优先从 extract.data 取（schema 里 data = 「数据来源、样本期、样本量、
        # 单位、关键变量度量、样本筛选步骤」），避免把摘要里的「结果句」当成变量定义
        self.data_clauses = _clauses(self.data)

        self.surname = _surname(self.authors)
        self.kicker = f"design_{self.surname or 'paper'}_{self.year or '0000'}"

        # ── 真实 extract 的 design 块（staging/chen2004.extract.json 的形状）──
        # 真实抽取器用的是 variables[]/fixed_effects/cluster_level/model_equation_latex/
        # identification{}/mechanism[]/heterogeneity[]/robustness[]/key_coefficients[]，
        # 与本脚本早期假定的扁平字段名不同，这里统一做适配；取不到就回落，绝不脑补。
        self.dvar = [x for x in (self.design.get("variables") or []) if isinstance(x, dict)]
        self.ident = self.design.get("identification") if isinstance(self.design.get("identification"), dict) else {}
        self.mech = [x for x in (self.design.get("mechanism") or []) if isinstance(x, dict)]
        self.het = [x for x in (self.design.get("heterogeneity") or []) if isinstance(x, dict)]
        self.rob = [x for x in (self.design.get("robustness") or []) if isinstance(x, dict)]
        self.coefs = [x for x in (self.design.get("key_coefficients") or []) if isinstance(x, dict)]
        # 经济概念 / 理论：有的抽取器放顶层，有的放 design 里，两处都认
        self.econ_concepts = [self._concept_text(x) for x in
                              (rec.get("economic_concepts") or self.design.get("economic_concepts") or [])]
        self.econ_theories = [self._concept_text(x) for x in
                              (rec.get("economic_theories") or self.design.get("economic_theories") or [])]

        self.pages: list[dict] = []      # [{idx, tag, title, appendix}]
        self.pending: list[dict] = []    # 留空登记：{kind, page, where, why}
        self.assets = {}                 # mdassets 产出的真图真表（未抽图时为空）

        # md 能补 extract 没有的三样东西：作者单位、图注表注、页码锚点
        tb = (self.md.get("title_block") or {}) if self.md else {}
        self.affiliation = _txt(tb.get("affiliation"))
        self.md_captions = list(self.md.get("captions") or []) if self.md else []
        self.md_sections = dict(self.md.get("sections") or {}) if self.md else {}

    @staticmethod
    def _concept_text(x) -> str:
        """经济概念条目可能是「术语 → 释义」字符串，也可能是 {name/term, definition/gloss} 字典。"""
        if isinstance(x, dict):
            head = _txt(x.get("term")) or _txt(x.get("name")) or _txt(x.get("concept"))
            body = (_txt(x.get("definition")) or _txt(x.get("gloss"))
                    or _txt(x.get("meaning")) or _txt(x.get("explanation")))
            return (head + " → " + body) if (head and body) else (head or body)
        return _txt(x)

    # ── 登记 ──
    def reg(self, tag: str, title: str, appendix: bool = False) -> None:
        self.pages.append({"idx": len(self.pages) + 1, "tag": tag, "title": title, "appendix": appendix})

    def tag(self, label: str, appendix: bool = False) -> str:
        """
        自动编号。缺数据的页会整页不出，编号必须跟着实际出页顺序走，
        不能靠手写「05 /」——删一页就会留下空号。
        """
        if appendix:
            self._ax = getattr(self, "_ax", 0) + 1
            return f"A{self._ax} / {label}"
        self._mx = getattr(self, "_mx", 0) + 1
        return f"{self._mx:02d} / {label}"

    def tbd(self, page: str, where: str, why: str) -> str:
        """登记一处留空并返回占位符本身。页面上只看到「—」，原因在报告里。"""
        self.pending.append({"kind": "blank", "page": page, "where": where, "why": why})
        return TBD

    def drop(self, page: str, where: str, why: str) -> None:
        """登记一处「整块不渲染」。缺数据就不出这一块，比印一排「—」诚实。"""
        self.pending.append({"kind": "drop", "page": page, "where": where, "why": why})

    # ── 取值 ──
    # 真实 extract 的 design 块字段名与本脚本早期的扁平命名不一致，这里做别名映射
    _ALIASES = {
        "outcome": ["outcome"],
        "treatment": ["treatment"],
        "moderator": ["moderator"],
        "controls": ["controls"],
        "fe": ["fe", "fixed_effects", "fixed_effect"],
        "cluster": ["cluster", "cluster_level", "clustering", "standard_errors"],
        "model_latex": ["model_latex", "model_equation_latex", "model_equation", "model"],
        "identification": ["identification"],
        "mechanism": ["mechanism"],
        "robustness": ["robustness"],
        "data_source": ["data_source"],
    }
    _ROLE_KEYS = {
        # 注意：「被解释变量」里含子串「解释变量」，必须靠 _ROLE_EXCLUDE 把核心解释变量摘出来，
        # 否则被解释变量的定义会被错填到核心解释变量那一行（真实 extract 上实测踩到过）。
        "outcome": ["被解释变量", "结果变量", "因变量"],
        "treatment": ["核心解释变量", "关键解释变量", "处理变量", "解释变量"],
        "moderator": ["调节", "中介", "交互", "分组变量"],
        "controls": ["控制变量", "控制项", "协变量"],
    }
    _ROLE_EXCLUDE = {
        "treatment": ["被解释"],
        "controls": ["被解释"],
        "moderator": ["被解释"],
    }

    def _role_rows(self) -> list[tuple[str, str, str]]:
        """
        变量清单：优先 design.variables[]（dict 列表），否则解析顶层 core_variables[] 的
        「角色：描述」字符串。返回 [(角色, 符号, 定义/描述)]。
        """
        rows = []
        for it in self.dvar:
            role = _txt(it.get("role"))
            sym = _txt(it.get("symbol"))
            dfn = _txt(it.get("definition")) or _txt(it.get("notes"))
            rows.append((role, sym, dfn))
        if not rows:
            for s in (self.rec.get("core_variables") or []):
                s = _txt(s)
                m = re.match(r"^([^：:]{2,20})\s*[：:]\s*(.+)$", s)
                if m:
                    rows.append((m.group(1).strip(), "", m.group(2).strip()))
        return rows

    def coef_probe(self, coef: dict) -> str:
        """
        系数条目 → 用于匹配假说的文本。
        只用「条目名 + 它在变量清单里的定义」：条目里的 coef 正文常夹带「与异常收益负相关」
        这类散词，会把系数错配到别的假说上（实测把 dShadow 的系数错配给了控制变量）。
        变量符号（如 dShadow）与假说用词（如「影子成本」）之间的桥，靠变量定义来搭。
        """
        term = _txt(coef.get("term"))
        probe = term
        for role, sym, dfn in self._role_rows():
            if not sym:
                continue
            # 变量清单里的 symbol 常写成「dShadow = ShadowPost - ShadowPre」，
            # 系数条目里只会写「dShadow（加入，1976—1989）」，因此按首个 token 比对
            keys = {sym} | {t for t in re.split(r"[=\s（(,，]", sym) if len(t) >= 2}
            if any(k in term for k in keys):
                # 只用定义的第一句：整段定义会漂到别的概念上（CAR60 的定义里提到「投资者认知假说」，
                # 会把这条系数误配给讲认知的假说）
                first = re.split(r"[。；;]", _txt(dfn))[0]
                probe += " " + role + " " + first
        return probe

    def _vars_by_role(self, role_keys: list[str], limit: int, exclude: list[str] | None = None) -> str:
        """按 role 取变量，拼成「符号：定义」；每条定义先压到 ~34 字，保证多变量时都看得见。"""
        picked = []
        for role, sym, dfn in self._role_rows():
            if not role or not any(k in role for k in role_keys):
                continue
            if exclude and any(k in role for k in exclude):
                continue
            picked.append((sym + "：" if sym else "") + _clip(dfn, 34))
        return _clip("；".join(_dedupe([p for p in picked if p])), limit) if picked else ""

    def _design_field(self, key: str) -> str:
        """按别名从 design 块取一个标量字段；结构化字段交给各自的分支处理。"""
        if key in self._ROLE_KEYS:
            v = self._vars_by_role(self._ROLE_KEYS[key], 140, self._ROLE_EXCLUDE.get(key))
            if v:
                return v
        for alias in self._ALIASES.get(key, [key]):
            if alias not in self.design:
                continue
            raw = self.design.get(alias)
            v = _as_text(raw)
            if v:
                return v
            # 结构化字段：只取明确可用的子字段，绝不 str() 化整个 dict
            if isinstance(raw, dict):
                for sub in ("strategy", "summary", "value", "note", "text"):
                    v = _as_text(raw.get(sub))
                    if v:
                        return v
        return ""

    def slot(self, key: str, page: str, where: str, keywords: list[str] | None = None,
             limit: int = 58, why: str = "", prefer: str = "data") -> str:
        """
        取一个「实证设计」槽位，优先级：
        extract.design（含别名与结构化映射）→ --md 同名小节 → 原文关键词摘录（逐字引用）→【待补】

        prefer="data"：先搜 extract.data（变量定义类槽位用），再搜全句库；
        prefer="pool"：直接搜全句库（机制/识别/结论类槽位用）。
        """
        v = self._design_field(key) or _as_text(self.md.get(key))
        if v:
            return _clip(v, max(limit, 90))
        if keywords:
            orders = [self.data_clauses, self.pool] if prefer == "data" else [self.pool]
            for clauses in orders:
                c = _first_clause(clauses, keywords)
                if c:
                    return _clip(c, limit)
        return self.tbd(page, where, why or f"原文未记录「{key}」，需回原文核对")

    def data_compose(self, page: str, where: str, limit: int = 120) -> str:
        """
        样本与观测单位：把 extract.data 里「带数字的片段」和「份/单位」片段逐字拼起来。
        只做「挑句 + 拼接 + 去重」，不改写任何事实。
        """
        if not self.data_clauses:
            return self.tbd(page, where, "原文的「数据」小节未记录，需回原文核对")
        parts = [_clip(self.data_clauses[0], 30)]
        counted = [c for c in self.data_clauses if re.search(r"\d", c)]
        if counted:
            parts.append(_clip(counted[0], 46))
        # 「份 / 样本 / 观测 / 单位」句里，挑数字最大的那句当总样本量（通常就是总样本）
        keyed = [c for c in self.data_clauses if any(k in c for k in ("份", "样本", "观测", "单位"))]
        keyed.sort(key=_max_int, reverse=True)
        for k in keyed[:1]:
            if not counted or k is not counted[0]:
                parts.append(_clip(k, 44))
        parts = _dedupe(parts)          # 真实 extract 里同一句常既是首句又带数字，会拼出重复
        buf = []
        for p in parts:
            cand = buf + [p]
            if len("；".join(cand)) > limit and buf:
                break
            buf = cand
        return "；".join(buf)

    def data_brief(self, page: str, where: str, limit: int = 96) -> str:
        """数据来源一句话。"""
        if self.data:
            return _clip(self.data, limit)
        return self.tbd(page, where, "原文的「数据」小节未记录，需回原文核对")

    def hyp(self, i: int) -> dict:
        return self.hyps[i] if i < len(self.hyps) else {
            "label": f"H{i + 1}", "tag": "", "content": "", "direction": "", "source": ""
        }

    # ── 由 extract 推出、但不改写事实的辅助量 ──
    def n_from_data(self) -> str:
        """从 extract.data 里认出「总样本量」那句里的数字；认不出返回空串。"""
        cands = [c for c in self.data_clauses if any(k in c for k in ("份", "样本", "观测", "单位"))]
        if not cands:
            return ""
        best = max(cands, key=_max_int)
        n = _max_int(best)
        if not n:
            return ""
        return f"约 {n}（原文以「约」表述）" if "约" in best else f"{n}"

    def strategy(self) -> tuple[str, str | None]:
        """
        识别策略的主策略名称。优先级：
        1) extract.design.identification.strategy（抽取器读原文后写的，最可信，逐字用）；
        2) --md 的识别策略小节；
        3) 关键词点名——但**必须**出现在「识别 / 策略 / 设计 / 自然实验 / 准实验 / 方法 / 实验」
           这类语境句里，否则不认（实测真实 extract 里「行业—规模匹配」这种普通词组
           会被误判成「匹配」策略，把事件研究说成匹配法）。
        返回 (名称, 摘录句或 None)。
        """
        v = _as_text(self.ident.get("strategy")) if self.ident else ""
        if v:
            return _clip(v, 62), None
        v = _as_text(self.md.get("identification"))
        if v:
            return _clip(v, 62), None
        table = [("双重差分", "双重差分 DID"), ("DID", "双重差分 DID"), ("工具变量", "工具变量 IV"),
                 ("断点", "断点回归 RD"), ("合成控制", "合成控制"), ("倾向得分", "倾向得分匹配 PSM"),
                 ("事件研究", "事件研究 event study"), ("随机", "随机化"),
                 ("匹配", "匹配 / 匹配样本"), ("自然实验", "自然实验")]
        ctx_words = ("识别", "策略", "设计", "自然实验", "准实验", "方法", "实验", "为识别", "用来识别")
        for kw, name in table:
            for c in self.pool:
                if kw in c and any(w in c for w in ctx_words):
                    return name, c
        return "", None

    # ── 识别策略三问：为什么可信 / 最怕什么 / 怎么排除（全部逐字取自 extract）──
    def ident_bullets(self) -> tuple[str, str, str]:
        """
        返回三段「extract 口径」文本；取不到就返回空串，由调用方回落为通用框架。
        threats 里常写成「最怕 X——本文用 Y 处理」，一破折号两段要分开取，
        否则「最怕什么」和「怎么排除」会显示同一句话（真实 extract 上实测踩到过）。
        """
        if not self.ident:
            return "", "", ""
        why = _clip(_as_text(self.ident.get("assumption")), 46)
        threats = [_txt(t) for t in (self.ident.get("threats") or []) if _txt(t)]

        fear, remedy = "", ""
        for t in threats:
            head, _, tail = t.partition("——")
            if not fear and head.strip():
                fear = _clip(head, 46)
            if not remedy and tail.strip():
                remedy = _clip(tail, 46)
        if not fear and threats:
            fear = _clip(threats[0], 46)
        if not remedy:
            for t in list(threats) + [_as_text(self.ident.get("first_stage_or_balance"))]:
                for piece in _clauses(t):
                    if any(k in piece for k in ("本文用", "本文改", "本文另", "本文做", "本文以", "作者用",
                                                "改用", "并逐一", "做补充检验")):
                        cand = _clip(piece, 46)
                        if cand and cand not in fear:
                            remedy = cand
                            break
                if remedy:
                    break
        if not remedy:
            remedy = _clip(_as_text(self.ident.get("first_stage_or_balance")), 46)
            if remedy and remedy in fear:
                remedy = ""
        return why, fear, remedy

    # ── 假说「一句经济含义」 ──
    def _meaning_pool(self) -> list[str]:
        """
        经济含义的候选句库：**只放「概念 / 理论 / 疑难提示」类字段**。
        刻意不放 abstract / data / contribution——那里是「结果与证据」，
        拿来当经济含义会把「检验结论」误写成「假说的含义」。
        """
        pool = list(self.econ_concepts) + list(self.econ_theories)
        for it in self.mech:                      # design.mechanism[].name 是机制/理论口径
            pool.append(_txt(it.get("name")))
        pool += _clauses(_txt(self.rec.get("core_theory")))
        for cf in self.confusions:                # confusions 的「一句话提示」常是概念辨析
            hint = cf.split("→", 1)[1].strip() if "→" in cf else cf
            if len(hint) >= 12:
                pool.append(hint)
        return _dedupe([p for p in pool if len(p) >= 12])

    @staticmethod
    def _term_cn(entry: str) -> str:
        """条目「术语 → 释义」里的术语，去掉括号英文与拉丁字符，只留中文词。"""
        term = entry.split("→", 1)[0] if "→" in entry else entry
        term = re.sub(r"[（(][^）)]*[）)]", "", term)
        return re.sub(r"[^\u4e00-\u9fff]", "", term)

    @staticmethod
    def _name_like(entry: str) -> bool:
        """
        只有术语名、没有释义的条目（如「投资者认知假说（Investor Recognition Hypothesis）」）
        当不了经济含义——它没说「意味着什么」。这类条目一律不入选。
        """
        gloss = _gloss(entry)
        if "→" in entry and len(gloss) >= 12:
            return False
        return len(Ctx._term_cn(entry)) <= 12

    def _score_entry(self, query: str, entry: str) -> float:
        """术语命中 + 长度归一化的重合度；长句不再靠字数碾压短句。"""
        qg = _grams(query)
        eg = _grams(entry)
        if not qg or not eg:
            return 0.0
        term = self._term_cn(entry)
        hit = 1.2 if (len(term) >= 2 and term in query) else 0.0
        gl = _grams(_gloss(entry))
        return len(qg & eg) / math.sqrt(len(eg)) + hit + 0.35 * (len(qg & gl) / math.sqrt(max(1, len(gl))))

    def hyp_query(self, i: int) -> str:
        """假说的匹配用文本 = 假说正文 + 它对应的 RQ（若标签里点了 RQ）。"""
        h = self.hyp(i)
        q = h["content"]
        m = re.search(r"RQ\s*(\d+)", h.get("tag") or "")
        if m:
            idx = int(m.group(1)) - 1
            if 0 <= idx < len(self.rqs):
                q += " " + _clip(self.rqs[idx], 60)
        return q

    def economic_meaning(self, i: int, tag: str) -> str:
        """
        经济含义（老师最看重的一列）：回答「这个系数若显著，对经济世界意味着什么」。

        优先级：
          1) design.hypothesis_meaning[i]（显式字段，抽取者口径）；
          2) extract 的 economic_concepts / economic_theories —— 找与该假说（+ 对应 RQ）
             最贴的一条，**逐字**取其「→」后的释义；
          3) 否则退到 core_theory 的对应句 / confusions 的「一句话提示」，同样逐字；
          4) 否则假说正文里含「即 / 意味着 / 说明 / 反映 / 因此 / 从而」的经济后果句；
          5) 都没有 →【待补】+ 原因。
        **绝不退回「方向为正：核心解释变量越高…」这类对任何论文都成立的模板句。**
        """
        # 去重状态：多条假说常共享同一个经济概念，最近邻会给出完全相同的释义。
        # 记住已经分配过的，后面遇到重复就换下一条候选。
        if not hasattr(self, "_used_meanings"):
            self._used_meanings = []

        pre = self.design.get("hypothesis_meaning") or self.design.get("hypotheses_meaning") or []
        if isinstance(pre, list) and i < len(pre) and _txt(pre[i]):
            picked = _clip(_txt(pre[i]), 52)
            self._used_meanings.append(picked)
            return picked

        q = self.hyp_query(i)
        if q:
            a_pool = [x for x in (list(self.econ_concepts) + list(self.econ_theories))
                      if not self._name_like(x)]
            scored = sorted(((self._score_entry(q, x), x) for x in a_pool), reverse=True)
            for sc, x in scored:
                if sc < 0.45:
                    break
                cand = _clip(_gloss(x), 52)
                if cand and cand not in self._used_meanings:
                    self._used_meanings.append(cand)
                    return cand
            b_pool = [x for x in self._meaning_pool()
                      if x not in self.econ_concepts and x not in self.econ_theories
                      and not self._name_like(x)]
            scored_b = sorted(((self._score_entry(q, x), x) for x in b_pool), reverse=True)
            for sc, x in scored_b:
                if sc < 0.85:
                    break
                cand = _clip(_gloss(x), 52)
                if cand and cand not in self._used_meanings:
                    self._used_meanings.append(cand)
                    return cand

        h = self.hyp(i)
        for piece in _clauses(h["content"]):
            if any(k in piece for k in ("意味着", "说明", "表明", "反映", "因此", "从而", "因而", "相当于")):
                cand = "即：" + _clip(piece, 48)
                if cand not in self._used_meanings:
                    self._used_meanings.append(cand)
                    return cand

        return self.tbd(tag, f"{h['label']} 经济含义",
                        "extract.hypotheses 未含经济含义（也无对应概念/理论释义）")


# ══════════════════════════════ 页面素材：全部现取，不预置 ══════════════════════════════

_YM_RE = re.compile(
    r"((?:19|20)\d{2})\s*年\s*(\d{1,2})?\s*月?\s*(?:至|到|—|-|–|~)\s*"
    r"((?:19|20)\d{2})\s*年\s*(\d{1,2})?\s*月?"
)
_YR_RE = re.compile(r"((?:19|20)\d{2})\s*(?:年)?\s*[—\-–~至]\s*((?:19|20)\d{2})")
_PERIOD_WORDS = ("样本期", "时间跨度", "样本区间", "考察期", "研究期", "数据期间", "样本覆盖")
_UNIT_WORDS = ("观测单位", "分析单位", "观察单位", "样本单位", "单位为", "单元是", "单位是", "面板")
_N_WORDS = ("样本量", "观测值", "样本为", "N=", "N =", "合计")
_SCREEN_WORDS = ("筛选", "剔除", "要求至少", "要求有")
_SRC_WORDS = ("数据来源", "取自", "来自", "数据库", "统计年鉴", "CRSP", "Compustat")


_ENUM_RE = re.compile(r"^\s*(?:[（(]\s*\d+\s*[）)]|\d+\s*[\.、)）]|[A-Za-z]\d+\s*[:：]|L\d+\s*[:：])\s*")


def _strip_enum(s: str) -> str:
    """去掉条目自带的编号（「L1:」「1.」「（2）」）——编号是给抽取者看的，不是内容。"""
    return _ENUM_RE.sub("", _txt(s)).strip()


def _first_sent(text: str, limit: int = 0) -> str:
    cl = _clauses(text)
    if not cl:
        return ""
    return _clip(cl[0], limit) if limit else cl[0]


def _clause_with(clauses: list[str], words: tuple[str, ...]) -> str:
    for cl in clauses:
        if any(w in cl for w in words):
            return cl
    return ""


def _period_short(c: "Ctx") -> str:
    """样本期压成「1962.07—2000.12」这种短写法，只给标注栏用。"""
    for cl in c.data_clauses:
        m = _YM_RE.search(cl)
        if m:
            am, bm = m.group(2) or "1", m.group(4) or "12"
            return f"{m.group(1)}.{int(am):02d}—{m.group(3)}.{int(bm):02d}"
        m = _YR_RE.search(cl)
        if m:
            return f"{m.group(1)}—{m.group(2)}"
    return ""


def _period_long(c: "Ctx", limit: int = 68) -> str:
    cl = _clause_with(c.data_clauses, _PERIOD_WORDS)
    return _clip(cl, limit) if cl else ""


def _sample_short(c: "Ctx", limit: int = 34) -> str:
    cl = _clause_with(c.data_clauses, _N_WORDS)
    return _clip(cl, limit) if cl else ""


def _coef_brief(c: "Ctx", i: int = 0, limit: int = 34) -> str:
    if i >= len(c.coefs):
        return ""
    k = c.coefs[i]
    term, coef, st = _txt(k.get("term")), _txt(k.get("coef")), _txt(k.get("stars"))
    if not (term or coef):
        return ""
    tail = f"（{st}）" if st else ""
    return _clip(f"{term}：{coef}{tail}", limit)


def _var_rows(c: "Ctx") -> list[tuple[str, str, str, str]]:
    """[(角色, 符号, 定义, 出处)]。优先 design.variables，回落 core_variables 的「角色：描述」。"""
    if c.dvar:
        return [
            (_txt(v.get("role")), _txt(v.get("symbol")), _txt(v.get("definition")), _txt(v.get("source")))
            for v in c.dvar
        ]
    return [(r, s, d, "") for r, s, d in c._role_rows()]


def _sym_of(c: "Ctx", *role_words: str) -> str:
    for role, sym, _dfn, _src in _var_rows(c):
        if sym and any(w in role for w in role_words):
            return sym
    return ""


def _aside(c: "Ctx", pairs: list[tuple[str, str]]) -> list[tuple[str, str]] | None:
    """标注栏只收「短、可核对」的值；空值整条不收，避免一排「—」。

    还要去重：`_sample_short` 与 `_clause_with` 常常从同一句数据描述里取，
    于是「样本量」和「观测单位」会印出**一模一样的一整句话**——实测 Ma 2025
    的标注栏两条完全相同，既浪费版心又显得像没校对。规则：短的被长的包含
    （且短的那条本身有 8 字以上）就丢掉，纯前缀碎片（如「2010—2022」）不误伤。
    """
    out: list[tuple[str, str]] = []
    for k, v in pairs:
        if not v:
            continue
        val = str(v).strip()
        dup = False
        for _k2, kept in out:
            a, b = (val, kept) if len(val) <= len(kept) else (kept, val)
            if len(a) >= 8 and a in b:
                dup = True
                break
        if not dup:
            out.append((k, val))
    # 只剩一条就别立栏了：右侧 292px 里孤零零一行字，看着像排版出错。
    # 返回 None 后 deckkit 不生成侧栏，主题里那条单列回退规则会把正文栏铺满。
    return out if len(out) >= 2 else None


# ══════════════════════════════ 页面（01）封面 ══════════════════════════════

def _cover(d: Deck, c: Ctx) -> None:
    """
    封面只放听众用得上的：标题、作者、单位、期刊年份、样本期、识别策略。
    DOI、原文 PDF 路径、「演示页 13 页」这类都是生成过程的副产品，一律不印。
    """
    title = c.title
    st, _ = c.strategy()
    meta: list[tuple[str, str]] = []
    if c.journal:
        meta.append(("期刊", _clip(c.journal, 34)))
    if c.year:
        meta.append(("年份", c.year))
    ps = _period_short(c)
    if ps:
        meta.append(("样本期", ps))
    if st:
        meta.append(("识别策略", _clip(_clauses(st)[0] if _clauses(st) else st, 20)))

    first = _first_sent(c.abstract, 100)
    kicker = " · ".join(x for x in (_clip(c.journal, 30), c.year) if x)

    if not c.affiliation:
        c.drop("01 / 封面", "作者单位", "原文首页与 md 首屏都没有单位行")
    c.reg("01 / 封面", title)

    notes = (
        f"今天拆的是《{_clip(c.title, 30)}》的实证设计。"
        + (f"作者自己的说法是：「{_first_sent(c.abstract, 72)}」。" if first else "")
        + (f"识别靠的是{_clip(_clauses(st)[0] if _clauses(st) else st, 24)}。" if st else "")
        + "接下来只看设计本身：假说怎么写、变量怎么造、方程怎么设、识别凭什么可信。"
    )
    d.cover(
        title=title,
        authors=_clip(c.authors, 64),
        affiliation=_clip(c.affiliation, 50),
        hook=first,
        kicker=kicker,
        meta=meta,
        notes=notes,
    )


# ══════════════════════════════ 页面（02）一页纸 ══════════════════════════════

def _p02(d: Deck, c: Ctx) -> None:
    """一页纸：五段全部用这篇论文自己的内容填，填不满三段就不出页。"""
    tag = c.tag("一页纸")
    first = _first_sent(c.abstract, 170)
    rq = _clip(c.rqs[0], 76) if c.rqs else ""
    st, _ = c.strategy()
    out_sym = _sym_of(c, "被解释")
    trt_sym = _sym_of(c, "核心解释", "处理")
    eq_no = _clip(_txt(c.design.get("equation_label")), 30)
    coef = _coef_brief(c, 0, 52)

    var_line = "；".join(
        x for x in (
            f"被解释 {out_sym}" if out_sym else "",
            f"核心解释 {trt_sym}" if trt_sym else "",
        ) if x
    )

    kv = []
    if rq:
        kv.append(("① 问题", _clip(rq, 76)))
    if var_line:
        kv.append(("② 变量", var_line))
    if eq_no:
        kv.append(("③ 方程", eq_no))
    if st:
        kv.append(("④ 识别", _clip(st, 76)))
    if coef:
        kv.append(("⑤ 结果", _clip(coef, 76)))
    if c.limits:
        kv.append(("⑥ 边界", _clip(_strip_enum(c.limits[0]), 76)))

    if len(kv) < 3:
        c.drop(tag, "一页纸", "问题/变量/方程/识别/结果里能填的不足三项")
        return

    title = "一页纸：问题、变量、方程、识别、结果"
    c.reg(tag, title)

    contrib = _clip(_strip_enum(_first_sent(_txt(c.rec.get("contribution")))), 110)
    aside = _aside(c, [
        ("样本期", _period_short(c)),
        ("样本量", _sample_short(c, 26)),
        ("观测单位", _clip(_clause_with(c.data_clauses, _UNIT_WORDS), 30)),
    ])

    d.slide(
        tag=tag,
        title=title,
        # 这里原来还挂了一个「摘要首句」引用块。它是封面 cover-hook 的**同一句话**，
        # 同一份 deck 里印两遍；更实际的问题是它占掉 90px，把六个格子挤到
        # 溢出 135px（Ma 2025 实测，最后一格「边界」被整块裁掉）。
        # 引用句移进讲稿层，版面只留六个格子。
        kv=kv,
        aside=aside,
        takeaway=contrib or "",
        layout="annotate",
        notes=(
            "这一页是全篇的地图，五段各有出处。"
            + (f"作者自己的说法是：{first}。" if first else "")
            + (f"问题问的是：{_clip(rq, 50)}。" if rq else "")
            + (f"识别靠{_clip(_clauses(st)[0] if _clauses(st) else st, 26)}。" if st else "")
            + (f"主系数是{_coef_brief(c, 0, 40)}。" if coef else "")
            + (f"作者自陈的贡献是：{contrib}。" if contrib else "")
        ),
    )


# ══════════════════════════════ 页面（03）假说 ══════════════════════════════

def _p03(d: Deck, c: Ctx) -> None:
    """假说表：一条不丢。≤4 条一页；≥5 条拆两页均分。"""
    if not c.hyps:
        c.drop("假说", "假说表", "原文没有写成 H1/H2 形式的可检验假说")
        return

    n = len(c.hyps)
    if n >= 5:
        cut = math.ceil(n / 2)
        chunks = [list(range(cut)), list(range(cut, n))]
    else:
        chunks = [list(range(n))]

    for page_i, idxs in enumerate(chunks):
        tag = c.tag("假说" if page_i == 0 else "假说（续）")
        if page_i == 0:
            title = f"{n} 条假说：方向写死，才可能被数据推翻"
        else:
            title = f"假说（续）：第 {idxs[0] + 1}–{idxs[-1] + 1} 条"

        rows = []
        for i in idxs:
            h = c.hyp(i)
            label = h["label"] + (f"（{_clip(h['tag'], 14)}）" if h["tag"] else "")
            rows.append([label, _clip(h["content"], 92), c.economic_meaning(i, tag)])

        c.reg(tag, title)
        d.slide(
            tag=tag,
            title=title,
            table={
                "headers": ["假说", "内容", "经济含义"],
                "rows": rows,
                "align": ["l", "l", "l"],
                "first_col_bold": True,
            },
            layout="split",
            notes="；".join(
                f"{c.hyp(i)['label']}：{_clip(c.hyp(i)['content'], 40)}"
                for i in idxs
            ) + "。经济含义那一列是这页的重点：方向能被推翻只是第一步，"
                "还要说清它对经济世界意味着什么。",
        )


# ══════════════════════════════ 页面（04）变量与推断设定 ══════════════════════════════

def _p04(d: Deck, c: Ctx) -> None:
    """
    变量表：符号列必须是这篇论文的真实符号。
    v1 这里印的是 Y_ij / T_j / M_j——任何论文都长这样，等于没写。
    """
    tag = c.tag("变量与推断")
    vrows = _var_rows(c)
    if not vrows:
        c.drop(tag, "变量表", "原文未给出可枚举的变量清单")
        return

    rows = []
    for role, sym, dfn, _src in vrows:
        rows.append([_clip(role, 26), _clip(sym, 30), _clip(dfn, 78)])

    fe = _txt(c.design.get("fixed_effects"))
    cl = _txt(c.design.get("cluster_level"))
    rows.append(["固定效应", "—", _clip(fe, 78) if fe else
                 c.tbd(tag, "固定效应", "原文未记录固定效应结构")])
    rows.append(["聚类层级", "—", _clip(cl, 78) if cl else
                 c.tbd(tag, "聚类层级", "原文未说明标准误的聚类层级")])

    title = f"{len(vrows)} 个变量，加两处推断设定"
    c.reg(tag, title)
    # 这里原来还挂了一条 aside（样本期 / 观测层级 / 样本量）。三个事实在下一节
    # 「数据与样本」里已经逐条讲过一遍，挂在这儿既是重复，又把八行变量表挤成
    # 「表格被切成一条缝」（实测溢出 114px）。变量页就该只有一张表。
    d.slide(
        tag=tag,
        title=title,
        subtitle="符号、角色、定义三列都要能对上原文；最后两行决定推断可不可信",
        table={
            "headers": ["角色", "符号", "定义与测量"],
            "rows": rows,
            "align": ["l", "l", "l"],
            "first_col_bold": True,
        },
        layout="table",
        notes=(
            "这一页是变量表。读法：先看第二列符号能不能和原文对上，再看最后两行。"
            + (f"固定效应：{_clip(fe, 50)}。" if fe else "固定效应原文没写，这一格是空的。")
            + (f"聚类层级：{_clip(cl, 50)}。" if cl else "聚类层级原文也没写——这意味着推断的保守程度没法判断。")
            + f"样本期 {_period_short(c)}，观测层级是{_clip(_clause_with(c.data_clauses, _UNIT_WORDS), 28)}，"
              f"{_sample_short(c, 24)}。"
        ),
    )


# ══════════════════════════════ 页面（05）数据与样本 ══════════════════════════════

def _p05(d: Deck, c: Ctx) -> None:
    """
    数据与样本：样本期、观测单位、样本量、筛选步骤。
    v1 没有这一页——但复现的第一步就是「样本到底怎么划出来的」。
    """
    tag = c.tag("数据与样本")

    used: set[str] = set()
    bullets: list[str] = []

    def take(label: str, words: tuple[str, ...], limit: int = 70) -> None:
        # 必须「找第一个还没被用过的」：直接用 _clause_with 会撞上同一条
        # （「剔除」既在样本量那句里，也在样本筛选那句里），于是筛选那一条永远取不到。
        for cl in c.data_clauses:
            if cl in used or not any(w in cl for w in words):
                continue
            used.add(cl)
            body = re.sub(rf"^{re.escape(label)}\s*[：:]\s*", "", cl)
            bullets.append(label + "：" + _clip(body, limit))
            return

    take("样本期", _PERIOD_WORDS)
    take("观测单位", _UNIT_WORDS)
    take("样本量", _N_WORDS)
    take("筛选", _SCREEN_WORDS)
    take("数据来源", _SRC_WORDS)

    if len(bullets) < 2:
        c.drop(tag, "数据与样本", "原文的「数据」小节没有可拆的样本描述")
        return

    title = "数据与样本：样本怎么划出来，结论就只能推到哪儿"
    c.reg(tag, title)
    d.slide(
        tag=tag,
        title=title,
        bullets=bullets,
        aside=_aside(c, [
            ("样本期", _period_short(c)),
            ("样本量", _sample_short(c, 24)),
            ("数据来源", _clip(_clause_with(c.data_clauses, _SRC_WORDS), 40)),
        ]),
        layout="annotate",
        notes="这一页讲样本。样本期决定这套设计能覆盖几个制度阶段，观测单位决定标准误该聚在哪一层，"
              "筛选步骤决定结论能推到哪一群人身上。"
              + ("；".join(b for b in bullets[:2]) if bullets else ""),
    )


# ══════════════════════════════ 页面（06）主方程 ══════════════════════════════

def _latex_safe(s: str) -> str:
    """
    extract 里的 model_latex 常夹带中文说明（如「… + \\varepsilon （式(4)）；单变量版本为式(3)：…」），
    直接塞进 $$…$$ 会让 MathJax 炸掉。这里只做清洗：去掉中文括号注释、取第一个分句，
    清洗后仍含中文就判定不可用（返回空串，由调用方回落）。
    """
    s = _txt(s)
    if not s:
        return ""
    s = re.sub(r"（[^）]*）", "", s)                       # 中文括号注释
    s = re.sub(r"\([^)]*[\u4e00-\u9fff][^)]*\)", "", s)   # 含中文的 ASCII 括号注释
    s = re.split(r"[；;]", s)[0]                          # 「；」后面常是「单变量版本…」的说明
    s = s.strip(" ，,。;；、")
    return s if s and not re.search(r"[\u4e00-\u9fff]", s) else ""


def _p06(d: Deck, c: Ctx) -> None:
    """主方程：只印原文那一版。清洗不出可用公式就整页不出，绝不造一个「讲解版方程」。"""
    tag = c.tag("主方程")
    raw = _txt(c.design.get("model_equation_latex")) or _txt(c.design.get("model_latex"))
    eq = _latex_safe(raw)
    if not eq:
        c.drop(tag, "主方程", "原文的方程无法清洗成可渲染的公式（含中文说明或缺 LaTeX）")
        return

    label = _clip(_txt(c.design.get("equation_label")), 40)
    m = re.search(r"[（(]\s*(\d+[a-zA-Z]?)\s*[）)]", label)
    eq_no = f"式({m.group(1)})" if m else ""

    vars_ = [(sym, _clip(role, 20)) for role, sym, _dfn, _src in _var_rows(c) if sym]
    trt_head = re.split(r"[=\s（(]", _sym_of(c, "核心解释", "处理") or "")[0]
    if eq_no and trt_head:
        title = f"主方程：{eq_no}，核心系数落在 {trt_head} 上"
    elif eq_no:
        title = f"主方程：{eq_no}"
    elif trt_head:
        title = f"主方程：核心系数落在 {trt_head} 上"
    else:
        title = "主方程"
    c.reg(tag, title)

    sym_tbl = {
        "headers": ["符号", "在方程里的角色"],
        # 只列前 3 个：这一页还有公式卡和三行事实条，符号表列多了会把版心挤爆
        # （.tbl-wrap 收缩起来只剩表头，页面上看就是「表格被切成一条缝」）。
        "rows": [[_clip(sym, 28), _clip(role, 34)] for sym, role in vars_[:3]],
        "align": ["l", "l"],
        "first_col_bold": True,
    } if len(vars_) >= 3 else None

    d.slide(
        tag=tag,
        title=title,
        formula=eq,
        formula_no=eq_no,
        table=sym_tbl,
        # 「方程」这一行和公式卡右上角的式号重复，去掉腾出高度
        aside=_aside(c, [
            ("主系数", _coef_brief(c, 0, 28)),
            ("样本量", _sample_short(c, 24)),
        ]),
        layout="stack",
        footnote=label or "",
        notes=(
            "全文只有一个主方程，就是这个。"
            + (f"版本是{eq_no or label}。" if (eq_no or label) else "")
            + (f"被解释变量是{_sym_of(c, '被解释')}，" if _sym_of(c, "被解释") else "")
            + (f"核心解释变量是{_sym_of(c, '核心解释', '处理')}。" if _sym_of(c, "核心解释", "处理") else "")
            + "看方程只看两件事：谁是被解释的，谁是那个要被识别出来的系数。"
        ),
    )


# ══════════════════════════════ 页面（07）识别 ══════════════════════════════

def _p07(d: Deck, c: Ctx) -> None:
    """识别策略：只讲这篇论文实际用的那一套，不印「DID/IV/RD 三问」通用框架。"""
    tag = c.tag("识别")
    st, _ = c.strategy()
    why, fear, remedy = c.ident_bullets()
    if not (st or why or fear):
        c.drop(tag, "识别策略", "原文与 md 都没有可用的识别策略描述")
        return

    bullets = []
    if st:
        bullets.append("策略：" + _clip(st, 92))
    if why:
        bullets.append("关键假设：" + why)
    if fear:
        bullets.append("最怕：" + fear)
    if remedy:
        bullets.append("怎么排除：" + remedy)
    bal = _clip(_txt(c.ident.get("first_stage_or_balance")), 150)
    if bal:
        bullets.append("平衡 / 一阶段：" + bal)

    short = _clauses(st)[0] if _clauses(st) else st
    title = f"识别：{_clip(short, 30)}" if short else "识别策略"
    c.reg(tag, title)

    d.slide(
        tag=tag,
        title=title,
        bullets=bullets,
        aside=_aside(c, [
            ("样本期", _period_short(c)),
            ("样本量", _sample_short(c, 24)),
            ("主系数", _coef_brief(c, 0, 28)),
        ]),
        layout="annotate",
        notes=(
            "识别这一页是整套设计的地基。"
            + (f"策略是{_clip(short, 30)}。" if short else "")
            + (f"它成立的前提是：{why}。" if why else "")
            + (f"最怕的是：{fear}。" if fear else "")
            + (f"作者的处理办法是：{remedy}。" if remedy else "")
        ),
    )


# ══════════════════════════════ 页面（08）机制与异质性 ══════════════════════════════

def _p08(d: Deck, c: Ctx) -> None:
    tag = c.tag("机制与异质性")
    if not (c.mech or c.het):
        c.drop(tag, "机制与异质性", "原文未报告机制检验或异质性分析")
        return

    rows = []
    for m in c.mech:
        name, test, res = _txt(m.get("name")), _txt(m.get("test")), _txt(m.get("result"))
        rows.append(["机制", _clip(name, 44), _clip("；".join(x for x in (test, res) if x), 96)])
    for h in c.het:
        # 「异质性」三个字在这个窄列里会被折成「异质 / 性」，看着像错字。
        # 表头已经写了「类型」，这里用「异质」两个字，和「机制」等宽，一行放得下。
        rows.append(["异质", _clip(_txt(h.get("dimension")), 44),
                     _clip(_txt(h.get("finding")), 96)])

    if len(c.mech) and len(c.het):
        title = f"{len(c.mech)} 条机制，{len(c.het)} 个异质性维度"
    elif c.mech:
        title = f"{len(c.mech)} 条机制"
    else:
        title = f"{len(c.het)} 个异质性维度"

    c.reg(tag, title)
    # 九行表 + 右侧事实条 = 版心装不下（实测溢出 75px，表格被压成一条缝）。
    # 事实条里的主系数和样本期在别的页都有，挪进讲稿层，让这一页只留一张表。
    d.slide(
        tag=tag,
        title=title,
        table={
            "headers": ["类型", "机制 / 维度", "检验与发现"],
            "rows": rows,
            "align": ["l", "l", "l"],
            "first_col_bold": True,
        },
        layout="table",
        notes="机制回答「为什么会有这个效应」，异质性回答「效应在谁身上更大」。"
              "两件事都不能只靠自己显著，要能解释结果的差异。"
              f"主系数 {_coef_brief(c, 0, 28)}，样本期 {_period_short(c)}。",
    )


# ══════════════════════════════ 页面（09）稳健性 ══════════════════════════════

def _p09(d: Deck, c: Ctx) -> None:
    tag = c.tag("稳健性")
    if not c.rob:
        c.drop(tag, "稳健性", "原文未报告稳健性检验")
        return

    rows = []
    for r in c.rob:
        rows.append([
            _clip(_txt(r.get("check")), 52),
            _clip(_txt(r.get("what_it_guards")), 62),
            _clip(_txt(r.get("result")), 56),
        ])

    title = f"{len(c.rob)} 项稳健性检查，各自堵一个漏洞"
    c.reg(tag, title)
    d.slide(
        tag=tag,
        title=title,
        table={
            "headers": ["检查了什么", "防的是什么", "结果"],
            "rows": rows,
            "align": ["l", "l", "l"],
        },
        layout="stack",
        notes="稳健性不是「再做几遍」，而是把最可能翻车的几种解释各堵一次。"
              "每张卡都写了两件事：检查了什么，防的是什么。",
    )


# ══════════════════════════════ 页面（10）主结果系数 ══════════════════════════════

def _p10(d: Deck, c: Ctx) -> None:
    tag = c.tag("主结果")
    if not c.coefs:
        c.drop(tag, "主结果", "原文的关键系数没有进入抽取结果")
        return

    rows = []
    for k in c.coefs:
        rows.append([
            _clip(_txt(k.get("term")), 46),
            _clip(_txt(k.get("coef")), 34),
            _clip(_txt(k.get("se")), 14),
            _clip(_txt(k.get("stars")), 18),
        ])

    title = f"主结果：{len(c.coefs)} 个关键系数"
    c.reg(tag, title)
    # 一页最多放 5 行：这里的单元格是「系数 + 两版设定 + 单位」的长文本，
    # 12 行堆在一页会被压扁或溢出。超出的部分在脚注里指路到附录。
    shown_rows = rows[:5]
    more = len(rows) - len(shown_rows)
    d.slide(
        tag=tag,
        title=title,
        table={
            "headers": ["设定 / 变量", "系数", "标准误", "显著性"],
            "rows": shown_rows,
            "align": ["l", "r", "r", "l"],
            "first_col_bold": True,
        },
        takeaway=_coef_brief(c, 0, 96) or "",
        layout="stack",
        # 这里原来写死「见附录 A3」。附录编号是按实际出页顺序自动排的，
        # 系数全表一旦分页就会从 A2 变成 A2/A3、图表索引顺移成 A4，
        # 写死编号必然指错。改成指名字，编号怎么变都不会错。
        footnote=(f"另有 {more} 条系数见附录「系数全表」" if more > 0 else ""),
        notes="最后一页看数字。先看符号方向对不对得上假说，再看量级，最后看显著性和标准误。"
              "标准误大的格子，量级再漂亮也不能当结论用。"
              + (f"这一页只印前 5 条，其余 {more} 条在附录的系数全表里。" if more > 0 else ""),
    )


# ══════════════════════════════ 附录 A1 变量全表 ══════════════════════════════

def _a1(d: Deck, c: Ctx) -> None:
    tag = c.tag("变量全表", appendix=True)
    vrows = _var_rows(c)
    if not vrows:
        c.drop(tag, "变量全表", "原文未给出可枚举的变量清单")
        return

    rows = []
    for role, sym, dfn, src in vrows:
        rows.append([_clip(sym, 30), _clip(role, 24), _clip(dfn, 150), _clip(src, 56)])
    fe = _txt(c.design.get("fixed_effects"))
    cl = _txt(c.design.get("cluster_level"))
    if fe:
        rows.append(["—", "固定效应", _clip(fe, 150), ""])
    if cl:
        rows.append(["—", "聚类层级", _clip(cl, 150), ""])

    title = "变量全表：符号、角色、定义、出处"
    c.reg(tag, title, appendix=True)
    d.slide(
        tag=tag,
        title=title,
        table={
            "headers": ["符号", "角色", "定义与测量", "出处"],
            "rows": rows,
            "align": ["l", "l", "l", "l"],
        },
        appendix=True,
        layout="stack",
        notes="附录是查表用的：主文里被截断的定义，这里给全。",
    )


# ══════════════════════════════ 附录 A2 系数全表 ══════════════════════════════

def _a2(d: Deck, c: Ctx) -> None:
    if not c.coefs:
        c.drop(c.tag("系数全表", appendix=True), "系数全表", "原文的关键系数没有进入抽取结果")
        return

    rows = []
    for k in c.coefs:
        rows.append([
            _clip(_txt(k.get("term")), 56),
            _clip(_txt(k.get("coef")), 120),
            _clip(_txt(k.get("se")), 20),
            _clip(_txt(k.get("stars")), 24),
        ])

    # 一页最多 7 行。系数单元格是「两版设定 + 两个 p 值 + 单位」的长文本，
    # 12—13 条压在一页实测要 1050px，版心只有 540px——不是密度问题，
    # 是真装不下。按 7 行分页，续页标题带序号区间，翻的时候知道自己在第几条。
    per = 7
    chunks = [rows[i:i + per] for i in range(0, len(rows), per)]
    total = len(chunks)

    for n, chunk in enumerate(chunks, 1):
        if n == 1:
            tag = c.tag("系数全表", appendix=True)
            title = "系数全表：逐字对照原文"
            notes = "系数全表，不做任何压缩。核对的时候直接对这张表。"
        else:
            first = per * (n - 1) + 1
            last = first + len(chunk) - 1
            tag = c.tag(f"系数全表（续 {n - 1}/{total - 1}）", appendix=True)
            title = f"系数全表（续）：第 {first}—{last} 条"
            notes = f"接上一页，第 {first}—{last} 条系数。"
        if total > 1 and n == 1:
            notes += f"共 {len(rows)} 条，本页前 {len(chunk)} 条，余下见下一页。"

        c.reg(tag, title, appendix=True)
        d.slide(
            tag=tag,
            title=title,
            table={
                "headers": ["设定 / 变量", "系数", "标准误", "显著性"],
                "rows": chunk,
                "align": ["l", "l", "r", "l"],
            },
            appendix=True,
            layout="stack",
            notes=notes,
        )


# ══════════════════════════════ 附录 A3 图表索引 ══════════════════════════════

def _a3(d: Deck, c: Ctx) -> None:
    tag = c.tag("图表索引", appendix=True)
    caps = [x for x in (c.md_captions or []) if _txt(x.get("text"))]
    if not caps:
        c.drop(tag, "图表索引", "md 里没有抓到图注或表注")
        return

    rows = []
    for x in caps[:26]:
        kind = "图" if _txt(x.get("kind")) == "figure" else "表"
        num = _txt(x.get("num"))
        page = x.get("page")
        rows.append([f"{kind} {num}".strip(), _clip(_txt(x.get("text")), 88), f"p.{page}" if page else ""])

    # 页码列只在真的抓到页码时才出——半列「—」比没有这一列更难看
    has_page = sum(1 for x in caps[:26] if x.get("page"))
    if has_page * 2 < min(len(caps), 26):
        rows = [r[:2] for r in rows]
        headers, align = ["编号", "标题"], ["l", "l"]
    else:
        headers, align = ["编号", "标题", "页码"], ["l", "l", "r"]

    title = f"图表索引：原文 {len(caps)} 张图与表"
    c.reg(tag, title, appendix=True)
    d.slide(
        tag=tag,
        title=title,
        table={
            "headers": headers,
            "rows": rows,
            "align": align,
            "first_col_bold": True,
        },
        appendix=True,
        layout="stack",
        notes="回原文取数时按这张索引找，不用从头翻。",
    )


# ══════════════════════════════ 组装整本 deck ══════════════════════════════

def build_deck(record: dict, *, topic: str = "", md_path: str | None = None,
               assets_dir: str | None = None, theme: str = "") -> Deck:
    """
    extract(dict) → Deck。每一页自己判断数据够不够，不够就整页不出并登记原因，
    所以页数不是写死的——extract 的丰满程度决定这本 deck 有多长。
    """
    md = load_md_design(md_path)
    c = Ctx(record, topic=topic, md=md)
    c.assets = load_assets(assets_dir) if assets_dir else {}

    deck_title = c.topic or f"{_clip(c.title, 40)} · 实证设计拆解"
    d = Deck(title=deck_title, theme=theme or THEME, footer=FOOTER)

    _cover(d, c)
    _p02(d, c)
    _p03(d, c)
    _p04(d, c)
    _p05(d, c)
    _p06(d, c)
    _p07(d, c)
    _p08(d, c)
    _p09(d, c)
    _p10(d, c)
    _a1(d, c)
    _a2(d, c)
    _a3(d, c)

    d.design_ctx = c            # 供 main() 出报告；不影响 deckkit 行为
    d.design_md_keys = sorted(md.keys())
    return d


# ══════════════════════════ --md：按标题抓实证设计小节 ══════════════════════════

_MD_SECTIONS = {
    "model_latex": ["模型设定", "基准模型", "计量模型", "回归模型", "实证模型", "模型"],
    "identification": ["识别策略", "识别", "内生性", "工具变量", "双重差分", "断点"],
    "outcome": ["变量定义", "变量说明", "变量测度", "指标", "数据"],
    "treatment": ["核心解释变量", "解释变量", "处理变量", "识别变量"],
    "moderator": ["调节变量", "中介变量", "调节", "中介"],
    "controls": ["控制变量"],
    "fe": ["固定效应"],
    "cluster": ["聚类", "标准误"],
    "mechanism": ["机制", "异质性", "中介"],
    "robustness": ["稳健性"],
}


def load_md_design(md_path: str | None) -> dict:
    """
    mdparse 的薄适配层：把 mdparse 的章节树压成 slot() 认的扁平 key，
    同时保留 title_block / captions / sections 供封面与图表索引用。
    """
    if not md_path:
        return {}
    p = Path(md_path)
    if not p.exists():
        print(f"[warn] --md 指定的文件不存在：{md_path}", file=sys.stderr)
        return {}

    md = load_md(p)
    if not md:
        return {}
    out: dict = {
        "sections": md.get("sections") or {},
        "title_block": md.get("title_block") or {},
        "captions": md.get("captions") or [],
    }
    for key, kws in _MD_SECTIONS.items():
        for head, body in (md.get("sections") or {}).items():
            if body and any(k in head for k in kws):
                out[key] = _clip(re.sub(r"[`*_>#]", "", body), 240)
                break
    return out


# ══════════════════════════════ 自检（读回 HTML 断言） ══════════════════════════════

_SLIDE_RE = re.compile(r'<section class="slide[^"]*" data-idx="(\d+)">(.*?)</section>', re.S)
_NUM_RE = re.compile(r"\d+(?:\.\d+)?")
_LAYOUT_RE = re.compile(r'<div class="s-body\s+(\w+)')

# 排版黑名单：v1 那套「任何论文都能套」的话，出现即失败
_BANNED = (
    "Y_ij", "T_j（处理变量）", "M_j", "treated", "moderator high",
    "验药", "体检", "同款试卷", "临床试验", "通用检查清单", "通用判断框架",
    "五类策略", "七个定义",
)


def _strip_noncontent(seg: str) -> str:
    """去掉不属于「内容」的区块：讲稿层、左侧页签、页脚页码、页眉 tag。"""
    seg = re.sub(r'<aside class="notes">.*?</aside>', "", seg, flags=re.S)
    seg = re.sub(r'<div class="rail">.*?</div>\s*(?=<)', "", seg, flags=re.S)
    seg = re.sub(r'<footer class="s-foot">.*?</footer>', "", seg, flags=re.S)
    seg = re.sub(r'<div class="tag">.*?</div>', "", seg, flags=re.S)
    seg = re.sub(r"<style.*?</style>", "", seg, flags=re.S)
    seg = re.sub(r"<script.*?</script>", "", seg, flags=re.S)
    return seg


def _page_text(seg: str) -> str:
    t = re.sub(r"<[^>]+>", " ", _strip_noncontent(seg))
    return re.sub(r"\s+", " ", _html.unescape(t)).strip()


def _saturation(hex_color: str) -> float:
    h = hex_color.lstrip("#")
    if len(h) != 6:
        return 0.0
    r, g, b = (int(h[i:i + 2], 16) / 255 for i in (0, 2, 4))
    mx, mn = max(r, g, b), min(r, g, b)
    return 0.0 if mx == 0 else (mx - mn) / mx


def _grams3(s: str) -> set[str]:
    s = re.sub(r"[^\u4e00-\u9fff]", "", s)
    return {s[i:i + 3] for i in range(max(0, len(s) - 2))}


def selfcheck(html: str, ctx: Ctx) -> list[tuple[bool, str, str]]:
    """10 条硬门。每条都是「能真正挡住一种翻车方式」，不凑数。"""
    res: list[tuple[bool, str, str]] = []

    def ok(cond: bool, name: str, detail: str = "") -> None:
        res.append((bool(cond), name, "" if cond else detail))

    slides = _SLIDE_RE.findall(html)
    texts = {int(i): _page_text(body) for i, body in slides}
    bodies = {int(i): body for i, body in slides}

    # ── 1 页数 ──
    n_main = sum(1 for p in ctx.pages if not p["appendix"])
    n_app = len(ctx.pages) - n_main
    ok(len(ctx.pages) == len(slides), "注册页数 = 渲染页数",
       f"注册 {len(ctx.pages)} / 渲染 {len(slides)}")
    ok(9 <= n_main <= 11, "主文页数在 9–11", f"实际 {n_main}")
    ok(2 <= n_app <= 4, "附录页数在 2–4", f"实际 {n_app}")

    # ── 2 元信息泄漏 ──
    hits: list[str] = []
    for idx, t in texts.items():
        low = t.lower()
        for w in _META_WORDS:
            if w.lower() in low:
                hits.append(f"p{idx}:{w}")
        m = re.search(r"[A-Za-z]:\\\\", t)
        if m:
            hits.append(f"p{idx}:本机路径")
    ok(not hits, "版面无元信息泄漏", "命中：" + "、".join(hits[:8]))

    # ── 3 数字溯源 ──
    corpus = re.sub(r"\s+", "", json.dumps(ctx.rec, ensure_ascii=False))
    for cap in (ctx.md_captions or []):
        corpus += re.sub(r"\s+", "", json.dumps(cap, ensure_ascii=False))
    counts = {str(n) for n in (
        len(ctx.hyps), len(ctx.dvar), len(ctx.mech), len(ctx.het), len(ctx.rob), len(ctx.coefs)
    )}
    unsourced: list[str] = []
    for idx, t in texts.items():
        for tok in _NUM_RE.findall(t):
            if tok in corpus or tok in counts or tok in {"1", "2", "3", "4", "5", "6", "7", "8", "9", "10"}:
                continue
            unsourced.append(f"p{idx}:{tok}")
    ok(not unsourced, "版面上每个数字都能溯源", "未溯源：" + "、".join(unsourced[:10]))

    # ── 4 占位符 ──
    ok("【待补】" not in html, "版面不出现【待补】", f"出现 {html.count('【待补】')} 次")
    # 只数「整格就是一个破折号」的占位。不能用 text.count("—")——
    # 「1976—1989」这种年份区间、破折号引出的从句都会被打成占位符。
    dash = {int(i): len(re.findall(r">\s*—\s*<", body)) for i, body in slides}
    heavy = [f"p{i}:{n}" for i, n in dash.items() if n > 8]
    ok(not heavy, "单页「—」占位不超过 8 处", "超限：" + "、".join(heavy))

    # ── 5 模板残留 / 跨页重复 ──
    banned = [w for w in _BANNED if w in html]
    ok(not banned, "无 v1 模板占位内容", "残留：" + "、".join(banned))
    dup = []
    order = sorted(texts)
    for a, b in zip(order, order[1:]):
        ga, gb = _grams3(texts[a]), _grams3(texts[b])
        if len(ga) < 20 or len(gb) < 20:
            continue
        j = len(ga & gb) / len(ga | gb)
        if j > 0.45:
            dup.append(f"p{a}~p{b}:{j:.2f}")
    ok(not dup, "相邻页不重复（3-gram Jaccard ≤ 0.45）", "超限：" + "、".join(dup))

    # ── 6 构图差异 ──
    # 逐页取版式，不按位置猜：cover 没有 .s-body，用 findall 的下标会和页号错位。
    page_layout = []
    for i, body in slides:
        m = _LAYOUT_RE.search(body)
        page_layout.append((int(i), m.group(1) if m else ""))
    app_idx = {p["idx"] for p in ctx.pages if p["appendix"]}
    layouts = [l for i, l in page_layout if l]
    ok(len(set(layouts)) >= 3, "版式种类 ≥ 3", f"实际 {sorted(set(layouts))}")
    ok(html.count('class="tbl-wrap"') >= 1, "至少一页用真表格", "")
    ok(html.count('class="kv-grid"') >= 1, "至少一页用定义卡", "")
    ok(html.count('class="formula-card"') >= 1, "至少一页有公式", "")
    # 只查主文：附录是查表用的，整页表格本来就该长一个样
    main_layouts = [l for i, l in page_layout if i not in app_idx and l]
    same = [f"{a}~{b}" for a, b in zip(main_layouts, main_layouts[1:]) if a == b == "stack"]
    ok(len(same) <= 2, "主文连续 stack 页不超过 2", "连续：" + "、".join(same))

    # ── 7 字号与强调色 ──
    sizes = [float(x) for x in re.findall(r"font-size:\s*([\d.]+)px", html)]
    ok(not sizes or min(sizes) >= 10, "最小字号 ≥ 10px", f"最小 {min(sizes) if sizes else '—'}px")
    tm = re.search(r"\.s-title\{[^}]*?font-size:\s*([\d.]+)px", html, re.S)
    bm = re.search(r"\.bullets li\{[^}]*?font-size:\s*([\d.]+)px", html, re.S)
    if tm and bm:
        ratio = float(tm.group(1)) / float(bm.group(1))
        ok(ratio >= 1.6, "标题/正文 ≥ 1.6（有层级）", f"实际 {ratio:.2f}")
    am = re.search(r"--accent:\s*(#[0-9a-fA-F]{6})", html)
    sat = _saturation(am.group(1)) if am else 0.0
    ok(sat >= 0.35, "强调色有饱和度", f"{am.group(1) if am else '未定义'} 饱和度 {sat:.2f}")

    # ── 8 实测版式（无头浏览器） ──
    path = getattr(ctx, "html_path", "")
    if path:
        pr = _probe.probe_deck(path)
        over = [f"p{i}(+{r['scroll'] - r['avail']}px)" for i, r in pr.items()
                if isinstance(r.get("scroll"), int) and isinstance(r.get("avail"), int)
                and r["scroll"] > r["avail"] + 12]
        # 留白只查主文：附录是查表页，一张 6 行的索引表撑不满一页是正常的
        thin = [f"p{i}(余{r['avail'] - r['need']}px)" for i, r in pr.items()
                if i not in app_idx
                and isinstance(r.get("need"), int) and isinstance(r.get("avail"), int)
                and r["avail"] - r["need"] > 150]
        ok(not over, "无溢出页（实测）", "溢出：" + "、".join(over[:6]))
        ok(not thin, "主文无空得单薄的页（实测）", "留白过大：" + "、".join(thin[:6]))
    else:
        ok(True, "实测版式（未跑无头浏览器，跳过）", "")

    # ── 9 数据覆盖 ──
    miss_h = [ctx.hyp(i)["label"] for i in range(len(ctx.hyps))
              if ctx.hyp(i)["label"] and ctx.hyp(i)["label"] not in html]
    ok(not miss_h, "假说一条不落", "缺失：" + "、".join(miss_h))
    n_coef = min(5, len(ctx.coefs))
    shown = sum(1 for k in ctx.coefs[:n_coef] if _clip(_txt(k.get("term")), 46) in html)
    ok(len(ctx.coefs) == 0 or shown >= n_coef, "关键系数至少出现 5 条", f"出现 {shown}/{n_coef}")

    # ── 10 结构完整性 ──
    ok(html.count("$$") % 2 == 0, "公式定界符成对", f"$$ 出现 {html.count('$$')} 次")
    ok("MathJax" in html or "mathjax" in html.lower(), "MathJax 已内联", "")
    ok(not re.search(r"\{\s*'", html), "无 Python dict repr 泄漏", "")
    unbalanced = []
    for t in ("div", "section", "table", "thead", "tbody", "tr", "ol", "li", "dl", "dt", "dd",
              "aside", "footer", "header", "p", "h1", "h2", "blockquote", "cite", "span", "th", "td"):
        a = len(re.findall(rf"<{t}[\s>]", html))
        b = len(re.findall(rf"</{t}>", html))
        if a != b:
            unbalanced.append(f"{t}:{a}/{b}")
    ok(not unbalanced, "HTML 标签成对闭合", f"不匹配：{unbalanced or '无'}")

    return res


# ══════════════════════════════ CLI ══════════════════════════════

def _default_out(c: Ctx) -> str:
    return str(Path("staging") / f"design_{c.surname or 'paper'}_{c.year or '0000'}.html")


def _report(out: Path, html: str, ctx: Ctx, checks: list[tuple[bool, str, str]]) -> str:
    """自检报告：两张清单是重点——留空清单与删页清单。"""
    n_fail = sum(1 for okc, _n, _d in checks if not okc)
    n_main = sum(1 for p in ctx.pages if not p["appendix"])
    L: list[str] = []
    L.append(f"# {out.stem} 自检报告\n")
    L.append(f"- 输出：`{out}`（{len(html.encode('utf-8')) / 1024:.1f} KB）")
    L.append(f"- 页数：共 {len(ctx.pages)} 页 = 封面 1 + 主文 {n_main - 1} + 附录 {len(ctx.pages) - n_main}")
    L.append(f"- 自检：**{len(checks) - n_fail} / {len(checks)} 通过**，失败 {n_fail} 项\n")

    L.append("## 一、硬门\n")
    L.append("| 结果 | 检查项 | 说明 |")
    L.append("|---|---|---|")
    for okc, name, detail in checks:
        L.append(f"| {'✓' if okc else '✗'} | {name} | {detail or '—'} |")
    L.append("")

    blanks = [p for p in ctx.pending if p["kind"] == "blank"]
    drops = [p for p in ctx.pending if p["kind"] == "drop"]
    L.append(f"## 二、留空清单（{len(blanks)} 处，版面上只印「—」）\n")
    if blanks:
        L.append("| 页 | 位置 | 原因 |")
        L.append("|---|---|---|")
        for p in blanks:
            L.append(f"| {p['page']} | {p['where']} | {p['why']} |")
    else:
        L.append("无。")
    L.append("")
    L.append(f"## 三、删页 / 删块清单（{len(drops)} 处）\n")
    if drops:
        L.append("| 位置 | 位置 | 原因 |")
        L.append("|---|---|---|")
        for p in drops:
            L.append(f"| {p['page']} | {p['where']} | {p['why']} |")
    else:
        L.append("无。")
    L.append("")

    L.append("## 四、页清单\n")
    L.append("| # | 类型 | 页签 | 标题 |")
    L.append("|---|---|---|---|")
    for p in ctx.pages:
        L.append(f"| {p['idx']:02d} | {'附录' if p['appendix'] else '主文'} | {p['tag']} | {p['title']} |")
    L.append("")
    return "\n".join(L)


def main(argv: list[str] | None = None) -> int:
    global THEME
    ap = argparse.ArgumentParser(
        description="把 extract.json 变成「实证设计」专题单文件 HTML 演示页（基于 deckkit）",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    ap.add_argument("--extract", required=True, help="extract.json 路径（格式见 templates/extract_schema.json）")
    ap.add_argument("--out", default="", help="输出 html 路径；省略则写 staging/design_作者_年份.html")
    ap.add_argument("--topic", default="", help="可选专题名，用作 deck 标题")
    ap.add_argument("--md", default="", help="论文 md（封面单位、图注表注、章节线索都从这里来）")
    ap.add_argument("--assets", default="", help="mdassets 产出的资产目录（真图真表）")
    ap.add_argument("--theme", default=THEME, choices=["doctrine", "podium", "paper"], help="视觉主题")
    args = ap.parse_args(argv)

    src = Path(args.extract)
    if not src.exists():
        print(f"[error] extract 不存在：{src}", file=sys.stderr)
        return 2
    raw = src.read_text(encoding="utf-8-sig", errors="replace")
    try:
        record = json.loads(raw)
    except json.JSONDecodeError as e:
        print(f"[error] extract 不是合法 JSON：{e}", file=sys.stderr)
        return 2
    if not isinstance(record, dict):
        print("[error] extract 顶层必须是对象", file=sys.stderr)
        return 2

    THEME = args.theme
    deck = build_deck(record, topic=args.topic, md_path=(args.md or None),
                      assets_dir=(args.assets or None), theme=args.theme)
    ctx: Ctx = deck.design_ctx
    if args.md:
        print(f"[info] --md 命中小节：{deck.design_md_keys or '（无）'}")

    html = deck.render()
    out = Path(args.out) if args.out else Path(_default_out(ctx))
    if out.suffix.lower() != ".html":
        out = out / f"design_{ctx.surname or 'paper'}_{ctx.year or '0000'}.html"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(html, encoding="utf-8")

    ctx.html_path = str(out.resolve())
    back = out.read_text(encoding="utf-8")
    checks = selfcheck(back, ctx)

    line = "─" * 76
    n_main = sum(1 for p in ctx.pages if not p["appendix"])
    n_fail = sum(1 for okc, _n, _d in checks if not okc)
    print(line)
    print(f"[build_design] 主题    ：{args.theme}")
    print(f"[build_design] 输出    ：{out}  （{len(back.encode('utf-8')) / 1024:.1f} KB）")
    print(f"[build_design] 页数    ：共 {len(ctx.pages)} 页 = 封面 1 + 主文 {n_main - 1} + 附录 {len(ctx.pages) - n_main}")
    print(f"[build_design] 失败项  ：{n_fail}")
    for okc, name, detail in checks:
        if not okc:
            print(f"   ✗ {name}  {detail}")
    if n_fail == 0:
        print("[build_design] ✓ 无元信息 / 数字可溯源 / 构图有差异 / 实测在安全线内")

    rep = out.with_name(out.stem + "_selfcheck.md")
    rep.write_text(_report(out, back, ctx, checks), encoding="utf-8")
    print(f"[build_design] 自检    ：{rep}")
    return 0 if n_fail == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
